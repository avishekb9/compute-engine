#!/usr/bin/env node
// Compute Engine — sandboxed R/Python econometrics orchestrator (P1 slice).
//
// Open-source econometrics workbench (EViews/RATS/OxMetrics-style) over the
// project's real research stack. v1 is PARAMETERIZED-ONLY: the user picks a
// method from a fixed registry + params; the runner script is OURS (in r/ or
// py/), never user-supplied — so there is no arbitrary-code-execution surface.
//
// Sandbox: every analysis runs under `bwrap` (bubblewrap) with:
//   --unshare-net      no network (verified: blocks outbound)
//   --ro-bind / /      whole FS read-only (incl. the data + scripts)
//   --tmpfs /tmp ...   fresh writable scratch only
//   --die-with-parent  killed if server dies
//   + wall-clock `timeout` + a JSON-only stdout contract.
//
// Standalone on :3200 (NOT folded into the 14k-line VERALABS proxy).
//
// Usage:  node compute-server.mjs      (PORT, HOST env overridable)

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";   // GCE/Cloud Run metadata server speaks plain HTTP
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { cacheKey, cacheGet, cacheSet, cacheGetStale, rateLimit, acquire, release, concurrencyState, dailyLimit, llmBudget, llmBudgetState, sweep, metrics, countMethod, countEvent, metricsSnapshot, clientIp, logLine } from "./guards.mjs";

// per-IP rate limits (requests/min); /health + /catalog + /metrics unlimited
const RATE = { "/api/compute/run": 20, "/api/chat": 10, "/api/research": 5 };
// per-IP DAILY caps on the paid LLM endpoints (UTC day) — slow-drain prevention on top of /min
const DAILY = { "/api/chat": 50, "/api/research": 20 };
const MAX_BODY_BYTES = 64 * 1024;   // reject oversized POST bodies (memory-abuse guard)
const MAX_MSG_CHARS  = 4000;        // cap chat/research input length before paying for Gemini
const ENGINE_VERSION = "1.0";       // provenance stamp (T1.2)
const WORKBENCH_URL  = "https://avishekb9.github.io/econstellar/research-engine.html";
// T3.2 — privacy-respecting analytics: ONLY these aggregate event names are counted
// (no IP/cookie/PII recorded); anything else is ignored, keeping the map bounded.
const ALLOWED_EVENTS = new Set(["portal","reproduce","changelog","workbench","embed","research-station","demo_run","reproduce_run"]);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = join(__dirname, "..");        // compute-engine/
const R_DIR = join(ENGINE_DIR, "r");
const WEB_DIR = join(ENGINE_DIR, "web");
// Data root holding papers/contagion-channels/data/G20.xlsx. Honor an explicit
// COMPUTE_REPO (set in the Cloud Run image to /app/data-root); else infer the
// monorepo parent for local runs.
const REPO = process.env.COMPUTE_REPO || join(ENGINE_DIR, "..");  // ivy-fineco/ (local) or /app/data-root (container)

const PORT = parseInt(process.env.PORT || "3200", 10);
const HOST = process.env.HOST || "127.0.0.1";
const JOB_TIMEOUT_S = parseInt(process.env.COMPUTE_TIMEOUT_S || "60", 10);
const HAVE_BWRAP = (() => { try { return existsSync("/usr/bin/bwrap") || existsSync("/bin/bwrap"); } catch { return false; } })();
const GEMINI_MODEL = "gemini-2.5-flash";          // fast chat analyst
const RESEARCH_MODEL = "gemini-2.5-pro";          // deep-research assistant (/api/research)
function loadGoogleKey() {
  if (process.env.GOOGLE_API_KEY) return process.env.GOOGLE_API_KEY;
  try {
    const env = join(REPO, "..", ".env.local"); // versiondevs/.env.local
    const line = readFileSync(env, "utf8").split(/\r?\n/).find(l => l.startsWith("GOOGLE_API_KEY="));
    if (line) return line.slice("GOOGLE_API_KEY=".length).replace(/^["']|["']$/g, "").trim();
  } catch {}
  return null;
}
const GOOGLE_KEY = loadGoogleKey();

// ── method registry ───────────────────────────────────────────────────────────
// Each method: runner script + a param schema (for validation + the UI form).
// kind: "r" (Rscript) | "py" (python3). All current methods are R.
const METHODS = {
  unit_root: {
    runner: "r", script: "adf.R",
    label: "Unit Root Test (ADF + KPSS)",
    category: "Time Series · Stationarity",
    desc: "Augmented Dickey-Fuller + KPSS on one return series. EViews 'Unit Root Test'.",
    params: { series: { type: "series", n: 1, required: true }, lags: { type: "int", optional: true } },
    version: "1.0.0", capability: "stationarity", primitives: [], long_running: false, min_obs: 50,
    returns: ["method", "dataset", "series", "n", "adf", "kpss", "interpretation"],
    paper: null, deprecated: false,
    changelog: [{ version: "1.0.0", note: "Initial registry entry" }],
  },
  var_irf: {
    runner: "r", script: "var_irf.R",
    label: "VAR + Impulse Responses",
    category: "Time Series · Multivariate",
    desc: "Vector autoregression with AIC lag selection + orthogonal IRFs. EViews/RATS 'VAR'.",
    params: { series: { type: "series", n: [2, 6], required: true }, p: { type: "int", optional: true }, irf_h: { type: "int", optional: true } },
    version: "1.0.0", capability: "dynamics", primitives: [], long_running: false, min_obs: 100,
    returns: ["method", "dataset", "series", "n", "lag_order", "irf_horizon", "adj_r2", "stable", "max_root", "irf_shock", "irf"],
    paper: null, deprecated: false,
    changelog: [{ version: "1.0.0", note: "Initial registry entry" }],
  },
  dfa_hurst: {
    runner: "r", script: "dfa_hurst.R",
    label: "DFA Hurst Exponent (long memory)",
    category: "Long Memory · Fractal",
    desc: "Detrended Fluctuation Analysis → Hurst exponent. Core NAMH primitive.",
    params: { series: { type: "series", n: 1, required: true }, min_box: { type: "int", optional: true }, max_box: { type: "int", optional: true } },
    version: "1.0.0", capability: "long-memory", primitives: ["P1"], long_running: false, min_obs: 100,
    returns: ["method", "dataset", "series", "n", "hurst", "interpretation", "n_boxes", "box_min", "box_max"],
    paper: null, deprecated: false,
    changelog: [{ version: "1.0.0", note: "Initial registry entry" }],
  },
  garch: {
    runner: "r", script: "garch.R",
    label: "GARCH(1,1) Volatility",
    category: "Volatility · Conditional Heteroskedasticity",
    desc: "GARCH(p,q) conditional-variance model + persistence. EViews/OxMetrics 'GARCH'.",
    params: { series: { type: "series", n: 1, required: true }, p: { type: "int", optional: true }, q: { type: "int", optional: true } },
    version: "1.0.0", capability: "volatility", primitives: [], long_running: false, min_obs: 100,
    returns: ["method", "dataset", "series", "n", "order", "coefficients", "persistence", "high_persistence", "log_likelihood", "current_cond_vol", "mean_cond_vol", "interpretation"],
    paper: null, deprecated: false,
    changelog: [{ version: "1.0.0", note: "Initial registry entry" }],
  },
  wavelet: {
    runner: "r", script: "wavelet.R",
    label: "Wavelet Variance (MODWT)",
    category: "Multi-Scale · Wavelets",
    desc: "MODWT variance decomposition across time scales (d1≈2-4d …). Stage-1 substrate for NAMH/MCPFM/contagion.",
    params: { series: { type: "series", n: 1, required: true }, levels: { type: "int", optional: true } },
    version: "1.0.0", capability: "multi-scale", primitives: ["P2"], long_running: false, min_obs: 256,
    returns: ["method", "dataset", "series", "n", "wavelet", "levels", "scales", "interpretation"],
    paper: null, deprecated: false,
    changelog: [{ version: "1.0.0", note: "Initial registry entry" }],
  },
  wqte: {
    runner: "r", script: "wqte.R",
    label: "Wavelet-Quantile Spillover (WQTE)",
    category: "Contagion · Tail Dependence",
    desc: "Directional wavelet-quantile dependence X→Y at a tail quantile, per scale. contagion-channels / WaveQTE primitive.",
    params: { series: { type: "series", n: 2, required: true }, tau: { type: "num", optional: true }, levels: { type: "int", optional: true } },
    version: "1.0.0", capability: "contagion", primitives: ["P2", "P3"], long_running: false, min_obs: 256,
    returns: ["method", "dataset", "from", "to", "tau", "wavelet", "levels", "n", "per_scale", "aggregate_qte", "interpretation", "note"],
    paper: "arXiv:2606.04113", deprecated: false,
    changelog: [{ version: "1.0.0", note: "Initial registry entry" }],
  },
  soch_profile: {
    runner: "r", script: "soch_profile.R",
    label: "SOCH Scale Profile (published sochcontagion)",
    category: "Contagion · Scale-Ordered (SOCH)",
    desc: "Directed wavelet-quantile transfer-entropy profile by scale, BOTH directions, for a market pair — via the PUBLISHED sochcontagion package (Bhandari & Parida 2026). Returns the SOCH scale profile: peak scale (SOCH-A), shape-symmetry KL (SOCH-B), level asymmetry (SOCH-C). Reproduces the paper's USA->India result (tau=0.05, J=4: agg 0.039, rising d1->d4).",
    params: { series: { type: "series", n: 2, required: true }, tau: { type: "num", optional: true }, levels: { type: "int", optional: true } },
    version: "1.0.0", capability: "contagion", primitives: ["P2", "P3"], long_running: false, min_obs: 256,
    returns: ["method", "dataset", "from", "to", "tau", "wavelet", "levels", "n", "profile_forward", "profile_reverse", "peak_scale_forward", "peak_scale_reverse", "aggregate_forward", "aggregate_reverse", "shape_symmetry_kl", "interpretation", "source"],
    paper: "arXiv:2606.04113", deprecated: false,
    changelog: [{ version: "1.0.0", note: "Initial registry entry" }],
  },
  soch_robustness: {
    runner: "r", script: "soch_robustness.R",
    label: "SOCH-B Robustness Badge (async; published sochcontagion)",
    category: "Robustness · Scale-Ordered (SOCH, async)",
    desc: "Phase-31 badge driver, registered from the deferred set (V4 M1): re-runs the PUBLISHED symmetry test soch_test_symmetry (sochcontagion, the paper's own code) across a (tau × J) nuisance grid on a fixed market group with block-bootstrap nulls. Badge-mode output: pass_rate (the badge confidence WITH its decomposition: per-config holds/n_pairs grid), badge tier (robust ≥0.90 / conditional ≥0.60 / fragile <0.60), and the tau=0.05 baseline anchor (the paper's 28/28 advanced-pair ground truth). This method emits JSON evidence only — BigQuery badge rows are written by the trusted orchestrator, never from the sandbox. Heavy (pairs × grid × bootstrap) — async-only via /api/jobs/submit; rejected by the sync /api/compute/run.",
    params: { group: { type: "enum", values: ["advanced", "emerging", "all"], optional: true }, tau_grid: { type: "num_array", optional: true }, j_grid: { type: "int_array", optional: true }, n_boot: { type: "int", optional: true }, filter: { type: "enum", values: ["la8", "d4", "la16", "haar"], optional: true } },
    version: "1.0.0", capability: "robustness", primitives: ["P2", "P3", "P8"], long_running: true, min_obs: 512,
    returns: ["method", "mode", "target", "group", "grids", "n_grid_points", "baseline", "pass_rate", "badge", "criterion", "source"],
    paper: "arXiv:2606.04113", deprecated: false,
    changelog: [{ version: "1.0.0", note: "M1 Step 6: deferred Phase-31 SOCH-B grid driver registered with badge-mode params (num_array tau_grid); async-only" }],
  },
  channel_attribution: {
    runner: "r", script: "channel_attribution.R",
    label: "Channel Attribution — Table 5 (published contagionchannels)",
    category: "Contagion · Channel Identification",
    desc: "Per-crisis-episode attribution of cross-border contagion to five mutually exclusive transmission channels (Trade / Financial / Geopolitical / Behavioral / Monetary Policy), via the PUBLISHED contagionchannels package (Bhandari, Parida & Sahu 2026) — the paper's own two-stage pipeline (Stage-1 wavelet-quantile transfer-entropy detection + Stage-2 structural IV/2SLS attribution), not a reimplementation. Reproduces the paper's Table 5 over 8 episodes (PreCrisis…MidEastTariffs). Uses the package's BUNDLED data, not the g20 panel.",
    dataset: "contagionchannels_bundled",
    params: {
      episodes: { type: "enum_multi", values: ["PreCrisis", "GFC", "ESDC", "CSC", "PreCOVID", "COVID", "RusUkr", "MidEastTariffs"], optional: true },
      scale: { type: "int", optional: true },
      tau: { type: "num", optional: true },
      edge_quantile: { type: "num", optional: true },
    },
    version: "1.0.0", capability: "contagion", primitives: ["P2", "P3", "P7"], long_running: false, min_obs: null,
    returns: ["method", "source", "paper", "channels", "scale", "tau", "edge_quantile", "threshold", "episodes", "interpretation"],
    paper: "arXiv:2604.26546", deprecated: false,
    changelog: [{ version: "1.0.0", note: "Published contagionchannels::run_contagion_pipeline (v0.1.3); reproduces Table 5 channel shares per episode" }],
  },
  namh_hurst: {
    runner: "r", script: "namh_hurst.R",
    label: "NAMH Hurst Panel (published namh)",
    category: "Long Memory · Network-Adaptive Efficiency (NAMH)",
    desc: "Rolling-window DFA-ℓ Hurst panel (Peng et al. 1994) via the PUBLISHED namh package (Bhandari & Sahu 2026) — the paper's own estimate_hurst_panel, not a reimplementation. Supplies the NAMH node-weight φ(H)=1−2|H−0.5| (local efficiency). Defaults reproduce the canonical paper-v3 panel on g20_24 (window=252, step=252 non-overlapping, DFA-1): bit-exact to 01_hurst_panel.csv (max|Δ|≈5e-9). Per-series summary by default; runs all 24 series if none given.",
    dataset: "g20_24",
    params: { series: { type: "series", n: [1, 24], optional: true }, window: { type: "int", optional: true }, step: { type: "int", optional: true }, order: { type: "int", optional: true }, s_min: { type: "int", optional: true }, n_scales: { type: "int", optional: true } },
    version: "1.0.0", capability: "long-memory", primitives: ["P1"], long_running: false, min_obs: 252,
    returns: ["method", "dataset", "config", "n_series", "n_windows", "per_series", "source"],
    paper: null, deprecated: false,
    changelog: [{ version: "1.0.0", note: "Published namh::estimate_hurst_panel (v0.1.0); reproduces paper-v3 Hurst panel bit-exact (max|Δ|≈5e-9 vs 01_hurst_panel.csv)" }],
  },
  namh_te: {
    runner: "r", script: "namh_te.R",
    label: "NAMH Transfer Entropy — raw magnitude (published namh)",
    category: "Information Flow · Network-Adaptive Efficiency (NAMH)",
    desc: "Per-window raw KSG transfer-entropy magnitude (Kraskov et al. 2004) for all directed market pairs, via the PUBLISHED namh package (Bhandari & Sahu 2026) — the paper's own te_matrix (Euclidean RANN variant; distinct from the engine's max-norm ksg_te), not a reimplementation. DETERMINISTIC (no surrogates) → reproduce-eligible: te_mean/te_sd match 03_te_summary.csv to ≈5e-9. Effective TE / edge p-values need IAAFT surrogates (unseeded → not bit-reproducible) and are NOT computed here. One window ≈10s — pass window_index for a single window; the full 20-window panel exceeds the sync timeout (job-server territory).",
    dataset: "g20_24",
    params: { series: { type: "series", n: [2, 24], optional: true }, window: { type: "int", optional: true }, step: { type: "int", optional: true }, k_nn: { type: "int", optional: true }, lx: { type: "int", optional: true }, ly: { type: "int", optional: true }, window_index: { type: "int", optional: true } },
    version: "1.0.0", capability: "information-flow", primitives: ["P3"], long_running: false, min_obs: 252,
    returns: ["method", "dataset", "config", "n_series", "n_windows", "per_window", "note", "source"],
    paper: null, deprecated: false,
    changelog: [{ version: "1.0.0", note: "Published namh::te_matrix (v0.1.0); raw KSG TE reproduces 03_te_summary.csv te_mean/te_sd to ≈5e-9" }],
  },
  namh_pipeline: {
    runner: "r", script: "namh_pipeline.R",
    label: "NAMH Full Pipeline (async; seeded IAAFT; published namh)",
    category: "Network · Network-Adaptive Efficiency (NAMH, async)",
    desc: "End-to-end published NAMH pipeline (namh::run_namh_pipeline v0.1.0, Bhandari & Sahu 2026): rolling DFA-Hurst → KSG TE (Euclidean RANN) → IAAFT effective TE → Benjamini-Hochberg FDR adjacency → Hurst-weighted TE → NAMH fixed point → Leiden communities → centralities. RNG honesty: the package's IAAFT generator is unseeded, so this runner pins RNGkind L'Ecuyer-CMRG + set.seed(seed, default 42) — results are reproducible for a fixed {seed, n_cores} (verified: same seed twice → identical surrogate p-values; different seed → different). Gate honesty (D1): the paper's own FDR gate is the only gate exposed — at the canonical config it retains 0/552 directed edges in every window, so downstream network surfaces are degenerate by construction and reported as measured. ~552 pairs × (1+n_surrogates) KSG estimates per window (≈24 min at B=200) — async-only via /api/jobs/submit; rejected by the sync /api/compute/run.",
    dataset: "g20_24",
    params: { window: { type: "int", optional: true }, step: { type: "int", optional: true }, k_nn: { type: "int", optional: true }, n_surrogates: { type: "int", optional: true }, fdr_alpha: { type: "num", optional: true }, lambda: { type: "num", optional: true }, seed: { type: "int", optional: true }, n_cores: { type: "int", optional: true }, window_index: { type: "int", optional: true } },
    version: "1.0.0", capability: "network", primitives: ["P1", "P3", "P4", "P5", "P6"], long_running: true, min_obs: 252,
    returns: ["method", "dataset", "config", "n_series", "runtime_s", "per_window", "note", "source"],
    paper: null, deprecated: false,
    changelog: [{ version: "1.0.0", note: "M1 Step 4: published run_namh_pipeline, seeded (L'Ecuyer-CMRG, default seed 42), paper's-own-FDR-gate honesty; async-only" }],
  },
  namh_reproduce: {
    runner: "r", script: "namh_reproduce.R",
    label: "NAMH Reproduce — measured live Δ vs the paper's cached panel",
    category: "Reproducibility · Network-Adaptive Efficiency (NAMH)",
    desc: "D1 honesty bar, measured: recomputes the deterministic NAMH surfaces through the paper's OWN namh package at the canonical config and diffs cell-by-cell against the paper's cached diagnostics (staged byte-identical in r/namh_ref). Emits per-quantity max|Δ| with its argmax: hurst_panel (every finite H cell, 24×20 windows, vs 01_hurst_panel.csv), te_window (deterministic KSG te_mean/te_sd vs 03_te_summary.csv), and fdr_network — ALWAYS amber: empty under the paper's own BH-FDR gate (0/552 in all 20 windows), pending, never green, never magnitude-dressed. green iff max|Δ| ≤ tol (default 1e-8) with zero finite/NA placement mismatches; a red is information. Measured 2026-06-12: same-machine max|Δ| 5.0e-16 (hurst, 440 cells) and 1.7e-16 (te).",
    dataset: "g20_24",
    params: { scope: { type: "enum", values: ["all", "hurst", "te"], optional: true }, window: { type: "int", optional: true }, step: { type: "int", optional: true }, order: { type: "int", optional: true }, s_min: { type: "int", optional: true }, n_scales: { type: "int", optional: true }, k_nn: { type: "int", optional: true }, lx: { type: "int", optional: true }, ly: { type: "int", optional: true }, window_index: { type: "int", optional: true }, tol: { type: "num", optional: true } },
    version: "1.0.0", capability: "reproducibility", primitives: ["P1", "P3"], long_running: false, min_obs: 252,
    returns: ["method", "dataset", "quantities", "verdict", "tol", "note", "source"],
    paper: null, deprecated: false,
    changelog: [{ version: "1.0.0", note: "M1 Step 5: measured Δ-verifier for the NAMH layer; hurst/te green by measurement, FDR network amber by construction" }],
  },
  vecm: {
    runner: "r", script: "vecm.R",
    label: "Cointegration (Johansen VECM)",
    category: "Time Series · Cointegration",
    desc: "Johansen trace-test cointegration rank among 2–6 series (urca::ca.jo). EViews 'Johansen Cointegration Test'.",
    params: { series: { type: "series", n: [2, 6], required: true }, K: { type: "int", optional: true }, ecdet: { type: "enum", values: ["none", "const", "trend"], optional: true } },
    version: "1.0.0", capability: "cointegration", primitives: [], long_running: false, min_obs: 100,
    returns: ["method", "dataset", "series", "n", "K", "ecdet", "test", "rank", "n_series", "eigenvalues", "trace_stat", "crit_5pct", "interpretation"],
    paper: null, deprecated: false,
    changelog: [{ version: "1.0.0", note: "Initial registry entry" }],
  },
  granger: {
    runner: "r", script: "granger.R",
    label: "Granger-Causality Network",
    category: "Time Series · Causality",
    desc: "Pairwise Granger-causality tests over 2–8 series → directed edges + in/out degree. RATS/EViews 'Granger Causality'.",
    params: { series: { type: "series", n: [2, 8], required: true }, lag: { type: "int", optional: true }, alpha: { type: "num", optional: true } },
    version: "1.0.0", capability: "network", primitives: ["P6"], long_running: false, min_obs: 100,
    returns: ["method", "dataset", "series", "n", "lag", "alpha", "n_edges", "edges", "out_degree", "in_degree", "p_matrix", "interpretation"],
    paper: null, deprecated: false,
    changelog: [{ version: "1.0.0", note: "Initial registry entry" }],
  },
  panel_unit_root: {
    runner: "r", script: "panel_unit_root.R",
    label: "Panel Unit Root (IPS + LLC)",
    category: "Panel · Stationarity",
    desc: "Im-Pesaran-Shin and Levin-Lin-Chu panel unit-root tests over 2–18 series (plm::purtest).",
    params: { series: { type: "series", n: [2, 18], required: true }, lags: { type: "enum", values: ["aic", "sic", "hall"], optional: true } },
    version: "1.0.0", capability: "stationarity", primitives: [], long_running: false, min_obs: 100,
    returns: ["method", "dataset", "series", "n_obs", "n_panels", "lags", "ips", "llc", "interpretation"],
    paper: null, deprecated: false,
    changelog: [{ version: "1.0.0", note: "Initial registry entry" }],
  },
  connectedness: {
    runner: "r", script: "connectedness.R",
    label: "Connectedness (Diebold-Yilmaz + Barunik-Krehlik)",
    category: "Contagion · Spillover",
    desc: "Total/directional connectedness from a generalized FEVD (Diebold-Yilmaz 2012) plus a short/medium/long frequency decomposition (Barunik-Krehlik 2018). Core spillover primitive.",
    params: { series: { type: "series", n: [2, 8], required: true }, p: { type: "int", optional: true }, H: { type: "int", optional: true } },
    version: "1.0.0", capability: "contagion", primitives: ["P7"], long_running: false, min_obs: 100,
    returns: ["method", "dataset", "series", "n", "var_lag", "horizon", "total_connectedness", "directional", "frequency_bands", "interpretation"],
    paper: null, deprecated: false,
    changelog: [{ version: "1.0.0", note: "Initial registry entry" }],
  },
  network: {
    runner: "r", script: "network.R",
    label: "Dependency Network (igraph)",
    category: "Network · Topology",
    desc: "Builds a directed Granger network over 3–12 series and returns centralities (degree/betweenness/eigenvector), Walktrap communities, and force-directed layout coordinates for client-side SVG.",
    params: { series: { type: "series", n: [3, 12], required: true }, lag: { type: "int", optional: true }, alpha: { type: "num", optional: true } },
    version: "1.0.0", capability: "network", primitives: ["P5", "P6"], long_running: false, min_obs: 100,
    returns: ["method", "dataset", "series", "n", "lag", "alpha", "n_edges", "density", "reciprocity", "n_communities", "nodes", "edges", "interpretation"],
    paper: null, deprecated: false,
    changelog: [{ version: "1.0.0", note: "Initial registry entry" }],
  },
  rolling_dcc: {
    runner: "r", script: "rolling_dcc.R",
    label: "DCC-GARCH Dynamic Correlation",
    category: "Volatility · Time-Varying Correlation",
    desc: "Engle (2002) DCC-GARCH(1,1) time-varying conditional correlations across 2–4 series (rmgarch); returns the per-pair correlation-path summary.",
    params: { series: { type: "series", n: [2, 4], required: true } },
    version: "1.0.0", capability: "volatility", primitives: [], long_running: false, min_obs: 100,
    returns: ["method", "dataset", "series", "n", "model", "pairs", "interpretation"],
    paper: null, deprecated: false,
    changelog: [{ version: "1.0.0", note: "Initial registry entry" }],
  },
  wavelet_coherence: {
    runner: "r", script: "wavelet_coherence.R",
    label: "Wavelet Coherence (MODWT, by scale)",
    category: "Multi-Scale · Co-movement",
    desc: "Cross-wavelet squared coherence between two return series at each MODWT time-scale (d1≈2-4d … long horizons): how strongly two markets co-move at short vs long horizons. Transparent waveslim realisation.",
    params: { series: { type: "series", n: 2, required: true }, levels: { type: "int", optional: true } },
    version: "1.0.0", capability: "multi-scale", primitives: ["P2"], long_running: false, min_obs: 256,
    returns: ["method", "dataset", "series", "wavelet", "levels", "n", "per_scale", "horizons", "aggregate_coherence", "peak_scale", "interpretation", "note"],
    paper: null, deprecated: false,
    changelog: [{ version: "1.0.0", note: "Initial registry entry" }],
  },
  spillover_rolling: {
    runner: "r", script: "spillover_rolling.R",
    label: "Rolling Connectedness (time-varying Diebold-Yilmaz)",
    category: "Contagion · Spillover (dynamic)",
    desc: "Time-varying Diebold-Yilmaz total connectedness over a sliding window (same GFEVD computation as 'connectedness') across 2-6 markets; returns the TCI time series whose peaks mark systemic-stress episodes.",
    params: { series: { type: "series", n: [2, 6], required: true }, p: { type: "int", optional: true }, H: { type: "int", optional: true }, window: { type: "int", optional: true }, step: { type: "int", optional: true } },
    version: "1.0.0", capability: "contagion", primitives: ["P7"], long_running: false, min_obs: 300,
    returns: ["method", "dataset", "series", "n", "var_lag", "horizon", "window", "step", "windows", "tci_series", "tci_mean", "tci_min", "tci_max", "tci_last", "interpretation"],
    paper: null, deprecated: false,
    changelog: [{ version: "1.0.0", note: "Initial registry entry" }],
  },
  quantile_var: {
    runner: "r", script: "quantile_var.R",
    label: "Quantile VAR (tail dependence)",
    category: "Time Series · Quantile Multivariate",
    desc: "Quantile vector autoregression at tail quantile tau (quantreg): the lag-1 coefficient matrix A1(tau) across 2-6 markets gives directed tail dependence, plus per-market tail driver/receiver scores. tau=0.5 is the median (LAD) VAR.",
    params: { series: { type: "series", n: [2, 6], required: true }, tau: { type: "num", optional: true }, p: { type: "int", optional: true } },
    version: "1.0.0", capability: "tail-dynamics", primitives: [], long_running: false, min_obs: 100,
    returns: ["method", "dataset", "series", "n", "tau", "lag", "var_lag", "coef_matrix_lag1", "directional", "interpretation"],
    paper: null, deprecated: false,
    changelog: [{ version: "1.0.0", note: "Initial registry entry" }],
  },
  live_unit_root: {
    runner: "r", script: "live_adf.R", fetch: true,
    label: "Live Stationarity — Levels vs Returns (ADF + KPSS)",
    category: "Time Series · Live Data",
    desc: "Fetches a LIVE price series from a public source (Yahoo Finance / FRED) and runs ADF+KPSS on price LEVELS and LOG-RETURNS separately. Price levels are I(1)/non-stationary; returns are stationary.",
    params: {
      symbol:    { type: "symbol", required: true },
      source:    { type: "enum", values: ["yahoo", "fred"], optional: true },
      transform: { type: "enum", values: ["levels", "returns", "both"], optional: true },
    },
    version: "1.0.0", capability: "stationarity", primitives: [], long_running: false, min_obs: 50,
    returns: ["method", "symbol", "source", "n_obs", "price_first", "price_last", "levels", "returns", "note"],
    paper: null, deprecated: false,
    changelog: [{ version: "1.0.0", note: "Initial registry entry" }],
  },
  ksg_te: {
    runner: "r", script: "ksg_te.R",
    label: "KSG Transfer Entropy (async; full-panel directed flow)",
    category: "Contagion · Information Flow (async)",
    desc: "Exact Kraskov-Stoegbauer-Grassberger nearest-neighbour conditional-MI transfer entropy (Frenzel-Pompe CMI, max-norm) for directed information flow across markets, with IAAFT source surrogates for significance. Heavy (k-d-tree CMI × surrogates) — runs ONLY as a background job via /api/jobs/submit; discoverable here but rejected by the sync /api/compute/run endpoint.",
    params: { series: { type: "series", n: [2, 18], optional: true }, k: { type: "int", optional: true }, lag: { type: "int", optional: true }, n_surrogates: { type: "int", optional: true } },
    version: "1.0.0", capability: "contagion", primitives: ["P3", "P4"], long_running: true, min_obs: 500,
    returns: ["edges", "top", "n_significant", "provenance"],
    paper: null, deprecated: false,
    changelog: [{ version: "1.0.0", note: "Exact KSG conditional-MI transfer entropy + IAAFT surrogates; async-only" }],
  },
  ksg_robustness: {
    runner: "r", script: "ksg_robustness.R",
    label: "KSG Transfer Entropy — k/lag Robustness (async diagnostic)",
    category: "Contagion · Information Flow (diagnostic)",
    desc: "Sensitivity sweep of the KSG transfer-entropy result over a grid of the neighbour count k and history length lag. Reuses the SAME validated KSG/Frenzel-Pompe point estimator as ksg_te (no surrogates → fast per grid point) and reports how stable the directed-TE magnitudes and rankings are: Spearman rank correlation of the full directed-TE vector vs the (k=4,lag=1) baseline, top-10 directed-edge Jaccard overlap, and the rank of the baseline's #1 edge at every grid point. Checks TE magnitude/ranking stability across (k,lag), NOT significance-count stability (which would need surrogates at each grid point). Heavy on the full 18-market grid (k×lag × all directed pairs) — runs ONLY as a background job via /api/jobs/submit; discoverable here but rejected by the sync /api/compute/run endpoint. BADGE MODE (Phase 31, opt-in via param target=[from,to]): adds the WINDOW and ALPHA axes with IAAFT surrogates at each grid point to grade ONE directed edge's significance-robustness, returning pass_rate + a robust|conditional|fragile|untested badge (the significance-count stability this base sweep omits); written to robustness.badges by the orchestrator.",
    params: { series: { type: "series", n: [2, 18], optional: true }, k_grid: { type: "int_array", optional: true }, lag_grid: { type: "int_array", optional: true }, max_pairs: { type: "int", optional: true } },
    version: "1.0.0", capability: "contagion", primitives: ["P3", "P4"], long_running: true, min_obs: 200,
    returns: ["method", "dataset", "k_grid", "lag_grid", "n_series", "n_obs", "n_pairs", "baseline", "grid", "stability", "runtime_s", "interpretation"],
    paper: null, deprecated: false,
    changelog: [{ version: "1.0.0", note: "k/lag sensitivity sweep of the KSG-TE point estimator (Tier G.3 diagnostic); reuses ksg_te's validated estimator verbatim; async-only" }],
  },
  sri_daily: {
    runner: "r", script: "sri_daily.R",
    label: "Systemic Risk Index — daily (KSG-TE network connectivity)",
    category: "Contagion · Systemic Risk",
    desc: "Daily systemic-risk index = the MEAN KSG/Frenzel-Pompe transfer entropy across all directed pairs over the most-recent rolling window of the g20 panel (the SAME validated estimator as ksg_te, no surrogates → fast). A system-wide nonlinear information-flow / contagion-intensity proxy (higher = more interconnected = more systemic risk). A CONNECTIVITY index — distinct from the MCPFM validation SRI (the AUC=0.915 crisis-discrimination construct); the two are not conflated. Powers the Phase-30 Systemic Risk Observatory (/api/sri/*).",
    params: { series: { type: "series", n: [2, 18], optional: true }, window: { type: "int", optional: true }, k: { type: "int", optional: true }, lag: { type: "int", optional: true }, asof: { type: "string", optional: true } },
    version: "1.0.0", capability: "contagion", primitives: ["P3"], long_running: false, min_obs: 60,
    returns: ["method", "dataset", "date", "window", "k", "lag", "n_markets", "n_pairs", "sri", "sri_total", "top_edges", "runtime_s", "interpretation"],
    paper: null, deprecated: false,
    changelog: [{ version: "1.0.0", note: "daily KSG-TE-network connectivity SRI (Vision Phase 30); reuses ksg_te's validated point estimator over a rolling window" }],
  },
};

// ── panel registry (Tier C.1) ─────────────────────────────────────────────────
// Each stored panel carries provenance metadata so a result is reproducible incl.
// data state: {id, description, markets, frequency, start, end, source, version,
// sha256_hash, access}. The g20 hash is computed once at startup from the actual
// file bytes (node:crypto) and cached — see G20_HASH below. `series` (the 18 names)
// + `n` + `label` are retained for backward compatibility with validate()/provenance().
const G20_SERIES = ["Argentina","Australia","Brazil","Canada","China","France","Germany","India","Indonesia","Italy","Japan","Mexico","Russia","SouthAfrica","SouthKorea","Turkey","UK","USA"];
// NAMH 24-series panel (g20_24): 19 equities + 5 commodity futures. Names match the
// namh package's bundled extdata columns EXACTLY (Korea/SaudiArabia, NOT SouthKorea) —
// used by validate() to accept series for namh_hurst / namh_te.
const G20_24_SERIES = ["Argentina","UK","Australia","Brazil","Canada","China","France","Germany","India","Indonesia","Italy","Japan","Korea","Mexico","Russia","SaudiArabia","USA","Turkey","SouthAfrica","Gold","Silver","NaturalGas","CrudeOil","Copper"];
// Verified sha256 of the namh-bundled g20_24 panel (G20_24_returns_yahoo.rds). The file
// ships inside the installed namh package (read via system.file at method time), so at
// boot we best-effort recompute it from the repo copy, else fall back to this constant.
const G20_24_SHA256 = "b0f93703bbb096f57108098dfd35639f447c4071702753dd598def2d43b64cd1";
const G20_24_HASH = (() => {
  try { return createHash("sha256").update(readFileSync(join(REPO, "papers/namh/code/namh-pkg/inst/extdata/G20_24_returns_yahoo.rds"))).digest("hex"); }
  catch { return G20_24_SHA256; }
})();
// Same path _io.R + the runner sandbox use: COMPUTE_REPO || ivy-fineco root.
const G20_PATH = join(REPO, "papers/contagion-channels/data/G20.xlsx");
// sha256 of the panel bytes, computed once at boot and cached. Degrades to null
// (honest "unknown") rather than crashing if the file is missing on a bad deploy.
const G20_HASH = (() => {
  try { return createHash("sha256").update(readFileSync(G20_PATH)).digest("hex"); }
  catch (e) { console.error(`[panel] could not hash G20.xlsx at ${G20_PATH}: ${e.message}`); return null; }
})();

// contagionchannels package tarball (the bundled-data source for channel_attribution).
// Verified sha256 of contagionchannels_0.1.3.tar.gz. We try to recompute it from the
// build-context copy at boot; on the deployed image the tarball is installed-then-deleted,
// so we fall back to this verified constant rather than reporting null.
const CC_PKG_SHA256 = "1a3822cc524a3ae7fad4df182d820707b8dd115e99be54e83f6a7be4b7cb264e";
const CC_PKG_HASH = (() => {
  for (const c of [join(ENGINE_DIR, "contagionchannels_0.1.3.tar.gz"),
                   join(REPO, "papers/contagion-channels/code/contagionchannels_0.1.3.tar.gz")]) {
    try { if (existsSync(c)) return createHash("sha256").update(readFileSync(c)).digest("hex"); } catch {}
  }
  return CC_PKG_SHA256;   // installed-then-deleted in the image: use the verified hash
})();

const DATASETS = {
  g20: {
    id: "g20",
    label: "G20 equity daily log-returns (18 markets, 2006–2026)",
    description: "G20 equity indices, daily log-returns",
    markets: G20_SERIES.length,        // 18 (names in `series` below)
    series: G20_SERIES,                 // retained: validate() + chat tool enum
    n: 5036,                            // retained: legacy callers
    frequency: "daily",
    start: "2006-01-12",               // first row of G20.xlsx (dd/mm/yyyy 12/01/2006)
    end: "2026-03-18",                 // last row of G20.xlsx (18/03/2026)
    source: "G20 equity indices, daily log-returns",
    version: "2026-06",                // stable tag = vintage of this panel snapshot
    sha256_hash: G20_HASH,             // file-byte sha256, cached at startup
    access: "public",
  },
  // Honest placeholder — NOT a runnable dataset. No `series`, so validate() rejects
  // any run against it. Intraday G20 collection is planned, not provisioned, hence
  // version/hash are null and access is "restricted".
  g20_intraday: {
    id: "g20_intraday",
    label: "G20 equity intraday (planned)",
    description: "G20 equity intraday returns — planned via XIMB Bloomberg collaboration (not yet provisioned)",
    markets: G20_SERIES.length,
    frequency: "intraday",
    start: null,
    end: null,
    source: "Bloomberg (planned, via XIMB collaboration)",
    version: null,
    sha256_hash: null,
    access: "restricted",
  },
  // Package-bundled panel for channel_attribution. NOT the g20 stored panel — the
  // data lives INSIDE the published contagionchannels package (LazyData) and is read
  // by the package's own loader, so there is no `series` selector here. version =
  // package version; sha256 = the package tarball's byte hash. Runnable only via the
  // bundled-data method (no `series` param → exempt from the runnable-panel guard).
  contagionchannels_bundled: {
    id: "contagionchannels_bundled",
    label: "contagionchannels bundled data (G20 returns + channel proxies + crisis periods)",
    description: "contagionchannels package LazyData (g20_returns + channel_proxies + crisis_periods)",
    markets: 18,
    frequency: "daily",
    start: "2006-01-12",
    end: "2026-03-18",
    source: "contagionchannels package LazyData (g20_returns + channel_proxies + crisis_periods)",
    version: "0.1.3",                   // package version = data vintage
    sha256_hash: CC_PKG_HASH,           // sha256 of contagionchannels_0.1.3.tar.gz
    access: "public",
  },
  // NAMH 24-series panel — daily log-returns 2001–2025 (5085 rows), from the namh
  // package's bundled extdata (read via system.file in _io.R). 19 G20 equities + 5
  // commodity futures (Gold/Silver/NaturalGas/CrudeOil/Copper) — a DIFFERENT vintage
  // and wider universe than `g20` (xlsx, 18 equities, no commodities). Powers the
  // namh_hurst / namh_te methods (Bhandari & Sahu 2026).
  g20_24: {
    id: "g20_24",
    label: "NAMH 24-series panel (19 equities + 5 commodities, 2001–2025)",
    description: "NAMH daily log-returns: 19 G20 equity indices + 5 commodity futures (Yahoo/quantmod)",
    markets: G20_24_SERIES.length,      // 24
    series: G20_24_SERIES,
    n: 5085,
    frequency: "daily",
    start: "2001-01-03",
    end: "2025-10-24",
    source: "namh package bundled extdata (G20_24_returns_yahoo.rds)",
    version: "0.1.0",                   // namh package version = data vintage
    sha256_hash: G20_24_HASH,           // sha256 of the bundled rds
    access: "public",
  },
};

// ── param validation (no arbitrary keys pass through) ──────────────────────────
function validate(methodId, params) {
  const m = METHODS[methodId];
  if (!m) throw new Error(`unknown method '${methodId}'`);
  // A method may bind to a non-g20 dataset (e.g. a package-bundled panel) via its
  // `dataset` field; otherwise default to g20. An explicit params.dataset still wins.
  const ds = params.dataset || m.dataset || "g20";
  if (!DATASETS[ds]) throw new Error(`unknown dataset '${ds}'`);
  // Methods that select markets need a runnable panel with a `series` list.
  // Package-bundled methods (no `series` param — data is internal to the package)
  // are exempt: they don't read the stored panel. restricted/unprovisioned panels
  // (e.g. g20_intraday) have no `series`, so they remain catalogue-only.
  const needsSeries = Object.values(m.params).some(s => s.type === "series");
  if (needsSeries && !Array.isArray(DATASETS[ds].series)) throw new Error(`dataset '${ds}' is not available for analysis (access: ${DATASETS[ds].access || "restricted"})`);
  const clean = { dataset: ds };
  for (const [k, spec] of Object.entries(m.params)) {
    const v = params[k];
    if (v == null) { if (spec.required) throw new Error(`missing required param '${k}'`); continue; }
    if (spec.type === "series") {
      const arr = Array.isArray(v) ? v : [v];
      const bad = arr.filter(s => !DATASETS[ds].series.includes(s));
      if (bad.length) throw new Error(`unknown series: ${bad.join(", ")}`);
      const n = spec.n;
      if (Array.isArray(n)) { if (arr.length < n[0] || arr.length > n[1]) throw new Error(`'${k}' needs ${n[0]}-${n[1]} series`); }
      else if (arr.length !== n) throw new Error(`'${k}' needs exactly ${n} series`);
      clean[k] = arr;
    } else if (spec.type === "int") {
      const i = parseInt(v, 10);
      if (!Number.isFinite(i)) throw new Error(`'${k}' must be an integer`);
      clean[k] = i;
    } else if (spec.type === "int_array") {
      // grid param (e.g. ksg_robustness k_grid/lag_grid): one or more positive integers.
      const arr = (Array.isArray(v) ? v : [v]).map(x => parseInt(x, 10));
      if (!arr.length || arr.some(i => !Number.isFinite(i) || i <= 0)) throw new Error(`'${k}' must be an array of positive integers`);
      clean[k] = arr;
    } else if (spec.type === "num_array") {
      // numeric grid param (e.g. soch_robustness tau_grid): one or more finite numbers.
      const arr = (Array.isArray(v) ? v : [v]).map(Number);
      if (!arr.length || arr.some(x => !Number.isFinite(x))) throw new Error(`'${k}' must be an array of finite numbers`);
      clean[k] = arr;
    } else if (spec.type === "num") {
      const x = Number(v);
      if (!Number.isFinite(x)) throw new Error(`'${k}' must be a number`);
      clean[k] = x;
    } else if (spec.type === "symbol") {
      const s = String(v).trim();
      if (!/^[A-Za-z0-9 .^=_&-]{1,32}$/.test(s)) throw new Error(`'${k}' is not a valid ticker/name`);
      clean[k] = s;
    } else if (spec.type === "enum") {
      const s = String(v).trim().toLowerCase();
      if (!spec.values.includes(s)) throw new Error(`'${k}' must be one of: ${spec.values.join(", ")}`);
      clean[k] = s;
    } else if (spec.type === "enum_multi") {
      // multiselect: one or more values, each from the allowed set (case-sensitive
      // — these are named periods like "GFC", "PreCrisis", not free text).
      const arr = (Array.isArray(v) ? v : [v]).map(x => String(x).trim());
      const badv = arr.filter(x => !spec.values.includes(x));
      if (badv.length) throw new Error(`'${k}' has invalid value(s): ${badv.join(", ")} — allowed: ${spec.values.join(", ")}`);
      if (!arr.length) throw new Error(`'${k}' needs at least one value`);
      clean[k] = arr;
    }
  }
  // optional date window passthrough (validated as ISO-ish strings only)
  for (const k of ["start", "end"]) if (typeof params[k] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(params[k])) clean[k] = params[k];
  return { method: m, clean };
}

// ── provenance / permalink — reproducibility stamping (T1.2) ───────────────────
// Every result carries {method, version, revision, params, data_vintage, timestamp,
// permalink}. The permalink encodes method+params in the workbench URL hash so the
// exact analysis re-runs on load — turning a number into a citable artifact.
function permalink(method, clean) {
  const parts = ["method=" + method];
  for (const [k, v] of Object.entries(clean)) {
    if (k === "dataset" && v === "g20") continue;          // g20 is the default
    parts.push(k + "=" + (Array.isArray(v) ? v.join(",") : v));
  }
  return WORKBENCH_URL + "#" + parts.join("&");
}
function provenance(method, spec, clean) {
  const ds = clean.dataset || "g20";
  const panel = DATASETS[ds];
  return {
    method,
    method_version: (spec && spec.version) || null,
    engine_version: ENGINE_VERSION,
    engine_revision: process.env.K_REVISION || "local",
    params: clean,
    // C.4 — panel provenance: which stored panel + its version + byte-hash, so a
    // result is fully reproducible incl. data state. (live-fetch methods read no
    // panel, but we still stamp the requested dataset id per the contract.)
    panel_id: ds,
    panel_version: (panel && panel.version) || null,
    panel_hash: (panel && panel.sha256_hash) || null,
    data_vintage: spec && spec.fetch
      ? "live fetch: " + (clean.symbol || "?") + " (" + (clean.source || "yahoo") + ")"
      : (panel ? panel.label : ds),
    timestamp: new Date().toISOString(),
    permalink: permalink(method, clean),
    // Phase 31 / Pathway C — robustness norm. Graded headline results (e.g. the
    // KSG USA->Japan edge, SOCH-B shape symmetry) carry a robust|conditional|
    // fragile|untested badge + pass_rate in BigQuery robustness.badges, computed
    // by the async grid jobs and written by this trusted orchestrator. The stamp
    // references that table rather than recomputing per call; query by result_id.
    robustness: {
      badge_table: "hopeful-flash-485308-v3.robustness.badges",
      note: "Phase 31 robustness badges for graded headline results — query robustness.badges by result_id",
    },
  };
}

// ── live market-data fetch (TRUSTED orchestrator only) ─────────────────────────
// The R sandbox stays network-isolated (--unshare-net). Only this trusted Node
// layer reaches the net, and only to an allowlisted public host with a validated
// symbol — no arbitrary URL, no arbitrary code. The fetched price series is
// injected into the sandbox as a numeric array.
// Friendly index name -> Yahoo symbol. Yahoo is the PRIMARY source (reachable
// from Cloud Run in ~2s); FRED is a fallback only (FRED's host times out from
// Google egress IPs). So index aliases resolve to Yahoo tickers by default.
const YAHOO_ALIAS = {
  "sp500": "^GSPC", "s&p500": "^GSPC", "s&p 500": "^GSPC", "spx": "^GSPC", "^spx": "^GSPC", "gspc": "^GSPC", "us": "^GSPC", "usa": "^GSPC",
  "nasdaq": "^IXIC", "nasdaqcom": "^IXIC", "ixic": "^IXIC", "ndx": "^NDX", "nasdaq100": "^NDX",
  "dow": "^DJI", "djia": "^DJI", "dow jones": "^DJI", "dji": "^DJI",
  "ftse": "^FTSE", "ftse100": "^FTSE", "uk": "^FTSE",
  "nifty": "^NSEI", "nifty50": "^NSEI", "nifty 50": "^NSEI", "sensex": "^BSESN", "india": "^NSEI",
  "nikkei": "^N225", "japan": "^N225", "dax": "^GDAXI", "germany": "^GDAXI",
  "cac": "^FCHI", "france": "^FCHI", "hangseng": "^HSI", "hang seng": "^HSI", "hsi": "^HSI",
  "vix": "^VIX",
};
// Fallback FRED series ids for the few indices FRED actually carries.
const FRED_ALIAS = {
  "sp500": "SP500", "^gspc": "SP500", "s&p 500": "SP500", "spx": "SP500",
  "nasdaq": "NASDAQCOM", "^ixic": "NASDAQCOM", "dow": "DJIA", "^dji": "DJIA", "vix": "VIXCLS",
};
function httpGet(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: "GET", headers: { "User-Agent": "Mozilla/5.0 (SHSSM-compute-engine)" } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects > 0) {
        r.resume(); return httpGet(new URL(r.headers.location, url).toString(), redirects - 1).then(resolve, reject);
      }
      let b = ""; r.on("data", d => (b += d)); r.on("end", () => resolve({ status: r.statusCode, body: b }));
    });
    req.on("error", reject);
    req.setTimeout(20000, () => req.destroy(new Error("data-source fetch timeout")));
    req.end();
  });
}
async function fetchYahoo(sym) {
  if (!/^[A-Za-z0-9.^=_-]{1,24}$/.test(sym)) throw new Error(`invalid Yahoo symbol: ${sym}`);
  const { status, body } = await httpGet(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=5y&interval=1d`);
  if (status !== 200) throw new Error(`Yahoo HTTP ${status} for ${sym}`);
  let j; try { j = JSON.parse(body); } catch { throw new Error(`Yahoo non-JSON for ${sym} (anti-bot gate?)`); }
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error(`Yahoo: no data for ${sym}${j?.chart?.error?.description ? " — " + j.chart.error.description : ""}`);
  const c = r?.indicators?.adjclose?.[0]?.adjclose || r?.indicators?.quote?.[0]?.close || [];
  const vals = c.filter(v => Number.isFinite(v));
  if (vals.length < 50) throw new Error(`Yahoo gave ${vals.length} usable points for ${sym}`);
  return { series: vals, resolved: r.meta?.symbol || sym, source: "yahoo" };
}
async function fetchFred(id) {
  if (!/^[A-Za-z0-9.^=_-]{1,24}$/.test(id)) throw new Error(`invalid FRED series id: ${id}`);
  const { status, body } = await httpGet(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}`);
  if (status !== 200) throw new Error(`FRED HTTP ${status} for ${id}`);
  if (/^\s*</.test(body)) throw new Error(`FRED returned non-CSV for ${id} (unknown series id?)`);
  const vals = [];
  for (const ln of body.trim().split("\n").slice(1)) {
    const v = parseFloat((ln.split(",")[1] || "").trim());   // FRED uses "." for NA -> NaN
    if (Number.isFinite(v)) vals.push(v);
  }
  if (vals.length < 50) throw new Error(`FRED gave ${vals.length} usable points for ${id} (need >=50)`);
  return { series: vals, resolved: id, source: "fred" };
}
// returns { series:[prices...], resolved, source }. Yahoo is primary (reachable
// from Cloud Run); FRED is fallback (often times out from Google egress).
async function fetchSeries(symbolRaw, sourceRaw) {
  const raw = String(symbolRaw || "").trim();
  if (!raw) throw new Error("missing symbol");
  const key = raw.toLowerCase();
  const explicit = sourceRaw ? String(sourceRaw).toLowerCase() : null;

  if (explicit === "fred") {
    try { return await fetchFred(FRED_ALIAS[key] || raw.toUpperCase()); }
    catch (e) { return await fetchYahoo(YAHOO_ALIAS[key] || raw); }  // fall back to Yahoo
  }
  // default + explicit yahoo: try Yahoo first (resolve friendly index names),
  // then FRED as a backstop for the indices it carries.
  const ysym = YAHOO_ALIAS[key] || raw;
  try { return await fetchYahoo(ysym); }
  catch (e) {
    if (FRED_ALIAS[key]) { try { return await fetchFred(FRED_ALIAS[key]); } catch {} }
    throw e;
  }
}
// build the JSON arg for a run, fetching + injecting live data when method.fetch
// TODO Tier C.2/C.3 — generalised live data. Today only `live_unit_root` (method.fetch)
// pulls a live series; C.3 would let ANY registered method run on a live-fetched panel.
// Intended design (mirrors the live_unit_root path above): the TRUSTED Node orchestrator
// fetches the requested live series here — keeping the R sandbox net-isolated — and injects
// them as numeric arrays before spawning R, with a fetched-data provenance stamp replacing
// the stored panel_hash. C.2 (Bloomberg/intraday import feeding `g20_intraday`) is the data
// source for that path; deferred until the XIMB Bloomberg feed exists.
async function buildArgsJson(method, clean) {
  if (!method.fetch) return JSON.stringify(clean);
  const { series, resolved, source } = await fetchSeries(clean.symbol, clean.source);
  return JSON.stringify({ ...clean, levels: series, symbol: resolved, source });
}

// ── Phase 30.B: live SRI feed (Yahoo → panels.g20_returns → sri_daily → systemic_risk.daily) ──
// Net-isolation preserved: this trusted Node layer fetches Yahoo + reads/writes BigQuery; the
// R sandbox only ever sees an injected panel via panel_inline (never the network).
const SRI_COLS = ["Argentina","Australia","Brazil","Canada","China","France","Germany","India","Indonesia","Italy","Japan","Mexico","Russia","SouthAfrica","SouthKorea","Turkey","UK","USA"];
let _tickerMap = null;
function tickerMap() {
  if (_tickerMap) return _tickerMap;
  try { _tickerMap = JSON.parse(readFileSync(join(ENGINE_DIR, "neuricx/sri/ticker_map.json"), "utf8")); } catch { _tickerMap = {}; }
  return _tickerMap;
}
// Yahoo daily closes keyed by the bar's UTC date (the validated panel convention). Map<iso,close>.
async function fetchYahooDated(sym, range = "3mo") {
  const { status, body } = await httpGet(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=${range}`);
  if (status !== 200) throw new Error(`Yahoo HTTP ${status} for ${sym}`);
  const j = JSON.parse(body); const r = j?.chart?.result?.[0];
  if (!r || !r.timestamp) throw new Error(`Yahoo no data for ${sym}`);
  const ts = r.timestamp, cl = r.indicators?.quote?.[0]?.close || [], m = new Map();
  for (let i = 0; i < ts.length; i++) if (Number.isFinite(cl[i])) m.set(new Date(ts[i] * 1000).toISOString().slice(0, 10), cl[i]);
  return m;
}
// New panel rows (UTC-date log-returns on the S&P trading-day grid, forward-filled, Russia=null)
// for trading dates strictly after lastDateIso. Returns [{date, Argentina..USA}] ascending.
async function buildNewPanelRows(lastDateIso) {
  const tm = tickerMap(), px = {};
  for (const c of SRI_COLS) {
    const sym = tm[c] && tm[c].symbol;
    if (!sym) { px[c] = null; continue; }              // Russia (no Yahoo source) -> null
    try { px[c] = await fetchYahooDated(sym); } catch { px[c] = new Map(); }
  }
  const usa = px["USA"] || new Map();
  const grid = [...usa.keys()].filter(d => d > lastDateIso).sort();   // S&P trading days after last
  if (!grid.length) return [];
  const ffill = (m, D) => { if (!m) return null; let bd = null, bv = null; for (const [d, v] of m) if (d <= D && (bd === null || d > bd)) { bd = d; bv = v; } return bd ? bv : null; };
  return grid.map((D, i) => {
    const Dprev = i === 0 ? lastDateIso : grid[i - 1], row = { date: D };
    for (const c of SRI_COLS) {
      if (!px[c]) { row[c] = null; continue; }
      const cD = ffill(px[c], D), cP = ffill(px[c], Dprev);
      row[c] = (cD && cP && cD > 0 && cP > 0) ? Math.log(cD / cP) : null;
    }
    return row;
  });
}
// BigQuery streaming insert via the kernel SA (metadataToken). rows = array of flat objects.
async function bqInsertAll(dataset, table, rows) {
  const tok = await metadataToken();
  if (!tok) return { ok: false, error: "no metadata token" };
  const payload = Buffer.from(JSON.stringify({ rows: rows.map(r => ({ json: r })), skipInvalidRows: false }));
  const u = new URL(`https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(BQ_PROJECT)}/datasets/${dataset}/tables/${encodeURIComponent(table)}/insertAll`);
  return await new Promise((resolve) => {
    const rq = httpsRequest(u, { method: "POST", headers: { "Authorization": `Bearer ${tok}`, "Content-Type": "application/json", "Content-Length": payload.length }, timeout: 20000 }, (r) => {
      let b = ""; r.on("data", d => (b += d)); r.on("end", () => {
        if (r.statusCode !== 200) return resolve({ ok: false, error: `insertAll ${r.statusCode}: ${b.slice(0, 200)}` });
        let j; try { j = JSON.parse(b); } catch { return resolve({ ok: false, error: "insertAll bad JSON" }); }
        if (j.insertErrors && j.insertErrors.length) return resolve({ ok: false, error: `insertAll rowErrors: ${JSON.stringify(j.insertErrors[0]).slice(0, 220)}` });
        return resolve({ ok: true });
      });
    });
    rq.on("error", e => resolve({ ok: false, error: `insertAll net: ${e.message}` }));
    rq.on("timeout", () => { rq.destroy(); resolve({ ok: false, error: "insertAll timeout" }); });
    rq.write(payload); rq.end();
  });
}

// ── sandboxed runner ───────────────────────────────────────────────────────────
function runSandboxed(method, paramsJson) {
  return new Promise((resolve) => {
    const scriptPath = join(method.runner === "r" ? R_DIR : join(ENGINE_DIR, "py"), method.script);
    const interp = method.runner === "r" ? "Rscript" : "python3";
    const innerCmd = [interp, scriptPath, paramsJson];

    let argv, bin;
    if (HAVE_BWRAP) {
      bin = "bwrap";
      argv = [
        "--ro-bind", "/", "/",          // whole FS read-only
        "--dev", "/dev", "--proc", "/proc",
        "--tmpfs", "/tmp",              // fresh writable scratch
        "--tmpfs", join(process.env.HOME || "/home/ecolex", ".cache"),
        "--unshare-net",               // NO network
        "--die-with-parent",
        "--chdir", "/tmp",
        "timeout", String(JOB_TIMEOUT_S), ...innerCmd,
      ];
    } else {
      // fallback: timeout + unshare-net only (still no network)
      bin = "timeout";
      argv = [String(JOB_TIMEOUT_S), ...innerCmd];
    }

    const env = { COMPUTE_REPO: REPO, HOME: process.env.HOME, PATH: process.env.PATH, LANG: "C.UTF-8" };
    const child = spawn(bin, argv, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", d => (out += d));
    child.stderr.on("data", d => (err += d));
    child.on("error", e => resolve({ ok: false, error: `spawn failed: ${e.message}` }));
    child.on("close", code => {
      if (code === 124) return resolve({ ok: false, error: `timeout after ${JOB_TIMEOUT_S}s` });
      const trimmed = out.trim();
      if (!trimmed) return resolve({ ok: false, error: `no output (exit ${code}): ${err.slice(0, 300)}` });
      try {
        const result = JSON.parse(trimmed);
        if (result.error) return resolve({ ok: false, error: result.error });
        resolve({ ok: true, result, sandbox: HAVE_BWRAP ? "bwrap+timeout(net-isolated,ro-fs)" : "timeout(no-net-isolation;parameterised-only-registry)" });
      } catch (e) {
        resolve({ ok: false, error: `non-JSON output: ${trimmed.slice(0, 300)}` });
      }
    });
  });
}

// ── chatbot (Gemini function-calling → sandboxed analysis → NL summary) ────────
// User types natural language; Gemini maps it to run_analysis(method,series,…)
// against the SAME validated registry the UI uses; we execute in the sandbox;
// Gemini then explains the numbers. No arbitrary code — only registered methods.
function geminiCall(payload, opts = {}) {
  const model = opts.model || GEMINI_MODEL;
  const timeoutMs = opts.timeoutMs || 30000;
  return new Promise((resolve, reject) => {
    if (!GOOGLE_KEY) return reject(new Error("GOOGLE_API_KEY not available"));
    const data = Buffer.from(JSON.stringify(payload));
    const u = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GOOGLE_KEY}`);
    const r = httpsRequest(u, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": data.length } }, res => {
      let b = ""; res.on("data", c => (b += c));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch { reject(new Error("gemini bad JSON")); } });
    });
    r.on("error", reject); r.setTimeout(timeoutMs, () => r.destroy(new Error("gemini timeout")));
    r.write(data); r.end();
  });
}
function chatTools() {
  return [{ functionDeclarations: [{
    name: "run_analysis",
    description: "Run a sandboxed econometric analysis. Stored-panel methods use G20 daily equity LOG-RETURNS (2006-2026, by market name). live_unit_root fetches a LIVE price series from a public source and tests price LEVELS vs LOG-RETURNS. " +
      Object.entries(METHODS).map(([k, m]) => `${k}=${m.label}`).join("; "),
    parameters: { type: "object", properties: {
      method: { type: "string", enum: Object.keys(METHODS) },
      series: { type: "array", items: { type: "string", enum: DATASETS.g20.series }, description: "stored-panel market(s): 1 for most; 2 for wqte (from,to); 2-6 for var_irf. NOT used by live_unit_root." },
      symbol: { type: "string", description: "live_unit_root only: ticker or index, e.g. ^FTSE, ^GSPC, AAPL, RELIANCE.NS, SP500, NASDAQCOM, DJIA" },
      source: { type: "string", enum: ["yahoo", "fred"], description: "live_unit_root data source; default yahoo (FRED auto-used for SP500/NASDAQCOM/DJIA)" },
      transform: { type: "string", enum: ["levels", "returns", "both"], description: "live_unit_root: which to test; default both" },
      tau: { type: "number" }, lags: { type: "integer" }, p: { type: "integer" }, q: { type: "integer" }, irf_h: { type: "integer" }, levels: { type: "integer" },
      K: { type: "integer", description: "vecm: VAR lag order" }, ecdet: { type: "string", enum: ["none", "const", "trend"], description: "vecm: deterministic term" },
      lag: { type: "integer", description: "granger/network: Granger lag order" }, alpha: { type: "number", description: "granger/network: edge significance level" },
      H: { type: "integer", description: "connectedness: GFEVD horizon" },
      window: { type: "integer", description: "spillover_rolling: rolling window length" }, step: { type: "integer", description: "spillover_rolling: window step" },
    }, required: ["method"] },
  }] }];
}
const CHAT_SYS = "You are the SHSSM Econometrics Analyst, a careful financial econometrician at the School of " +
  "Humanities, Social Sciences & Management, IIT Bhubaneswar. You are NOT a generic chatbot; if asked who you " +
  "are, identify yourself as the SHSSM Econometrics Analyst (do not say you are a model trained by Google). You " +
  "answer econometrics/finance questions and run real sandboxed R via the run_analysis tool.\n\n" +
  "CRITICAL STATIONARITY ECONOMICS — never get this wrong:\n" +
  "- Equity PRICE LEVELS are non-stationary: they have a unit root (I(1), random-walk-with-drift). Never call a " +
  "price level stationary.\n" +
  "- LOG-RETURNS = diff(log(price)) are typically stationary (I(0)). Model and report on RETURNS, not price levels.\n" +
  "- The stored G20 panel (methods unit_root, var_irf, dfa_hurst, garch, wavelet, wqte; selected by market NAME " +
  "like India/USA/UK) is ALREADY log-returns, so any 'stationary' verdict there is about RETURNS — always say so " +
  "explicitly (e.g. 'UK equity RETURNS are stationary', never 'the UK equity market is stationary').\n" +
  "- For LIVE data use method=live_unit_root with a symbol (e.g. ^FTSE, ^GSPC, AAPL, RELIANCE.NS, or SP500 via FRED). " +
  "It returns separate results for price LEVELS and LOG-RETURNS; report the contrast — levels non-stationary " +
  "(fails to reject the unit root), returns stationary — and explain that this is exactly why we difference prices " +
  "to returns.\n\n" +
  "Stored-panel markets: " + DATASETS.g20.series.join(", ") + ". After the tool returns numbers, explain them " +
  "concisely for a finance researcher (what each statistic means + the verdict, naming whether it was levels or " +
  "returns). If a request is conceptual, answer directly without a tool call.";
async function chatTurn(message) {
  if (!message.trim()) return { reply: "Ask me to run an analysis, e.g. 'ADF test on India returns' or 'wavelet variance for USA'.", ran: null };
  const contents = [{ role: "user", parts: [{ text: message }] }];
  const r1 = await geminiCall({ systemInstruction: { parts: [{ text: CHAT_SYS }] }, contents, tools: chatTools(), generationConfig: { temperature: 0.2 } });
  const parts = r1?.candidates?.[0]?.content?.parts || [];
  const fc = (parts.find(p => p.functionCall) || {}).functionCall;
  if (!fc) return { reply: parts.map(p => p.text).filter(Boolean).join("") || "I couldn't parse that.", ran: null };
  let v;
  try { v = validate(fc.args.method, fc.args); }
  catch (e) { return { reply: `I tried ${fc.args.method} but the parameters were invalid: ${e.message}`, ran: { method: fc.args.method, error: e.message } }; }
  let run;
  try { run = await runSandboxed(v.method, await buildArgsJson(v.method, v.clean)); }
  catch (e) { run = { ok: false, error: `data fetch failed: ${e.message}` }; }
  if (!run.ok) return { reply: `The ${fc.args.method} analysis failed: ${run.error}`, ran: { method: fc.args.method, error: run.error } };
  const contents2 = [
    ...contents,
    { role: "model", parts: [{ functionCall: fc }] },
    { role: "function", parts: [{ functionResponse: { name: "run_analysis", response: { result: run.result } } }] },
  ];
  const r2 = await geminiCall({ systemInstruction: { parts: [{ text: CHAT_SYS }] }, contents: contents2, generationConfig: { temperature: 0.3 } });
  const reply = (r2?.candidates?.[0]?.content?.parts || []).map(p => p.text).filter(Boolean).join("") || "(analysis complete)";
  return { reply, ran: { method: fc.args.method, params: v.clean, result: run.result, ms: run.ms } };
}

// ── deep-research assistant (/api/research) ───────────────────────────────────
// Gemini 2.5 PRO (not Flash) positioned as a post-doctoral computational
// economist with the full research context injected. Two robust phases:
//   A. agentic run_analysis loop — run live econometrics where the question admits it
//   B. grounded synthesis — google_search for REAL citations, final co-author answer
// Tools aren't combined in one request (a known API fragility); the executed
// analyses are summarised into Phase B as context instead.
const RESEARCH_SYS =
  "You are a post-doctoral research fellow in computational economics and financial econometrics, " +
  "collaborating with Dr. Avishek Bhandari at SHSSM, IIT Bhubaneswar. Your expertise spans network " +
  "econometrics, information-theoretic finance, wavelet analysis, systemic risk, and AI-economics. You reason " +
  "at publication standard — every claim grounded, every result verified, every interpretation precise. You give " +
  "the honest expert view a co-author would give, not an agreeable chatbot answer. If asked who you are, identify " +
  "as the SHSSM post-doctoral research fellow (never say you are a model trained by Google).\n\n" +
  "You can execute LIVE econometric analyses via the run_analysis tool against a sandboxed R engine over a G20 " +
  "daily equity panel (2006-2026, already LOG-RETURNS). A live result beats a theoretical answer — run one when " +
  "the question admits it. Available methods: " + Object.entries(METHODS).map(([k, m]) => `${k} (${m.label})`).join("; ") + ". " +
  "Stored-panel markets: " + DATASETS.g20.series.join(", ") + ".\n\n" +
  "=== 8-PRIMITIVE SUBSTRATE (methodological core threaded through every framework) ===\n" +
  "1. Long-memory estimation (DFA / GPH / Qu) — fractal scaling, Hurst exponent.\n" +
  "2. MODWT wavelet decomposition — variance across time scales (d1 approx 2-4d ... long horizons).\n" +
  "3. Transfer entropy (KSG / binned / quantile) — directional, nonlinear information flow.\n" +
  "4. Surrogate inference (IAAFT / bootstrap) — significance vs nonlinearity-preserving nulls.\n" +
  "5. Community detection (Leiden / Walktrap / CNM) — meso-scale network structure.\n" +
  "6. Network-formation game theory — endogenous edge-formation models.\n" +
  "7. Structural attribution (IV / 2SLS / LASSO / local projections) — causal channel identification.\n" +
  "8. Classifier validation (ROC / DeLong) — out-of-sample discriminative power with inference.\n\n" +
  "=== 5 FRAMEWORKS (verified artifacts only — never invent a citation) ===\n" +
  "- NAMH (Network Adaptive Market Hypothesis): working paper, internal. Adaptive markets x network econometrics.\n" +
  "- MCPFM (Multi-Channel Path Following Model): arXiv:2507.08065. Systemic-risk index; SRI AUC 0.915 (US/COVID), 0.581 (India/trade-war).\n" +
  "- contagion-channels: arXiv:2604.26546; CRAN package contagionchannels v0.1.3. Channel-level contagion identification.\n" +
  "- WaveQTE (wavelet-quantile transfer entropy): working paper; CRAN WaveQTE + WaveQTEX. Scale- and tail-resolved spillover.\n" +
  "- commodity: working paper; CRAN commodityFC (WIP). Commodity forecasting on the same substrate.\n\n" +
  "=== VERIFIED EMPIRICAL RESULTS (immutable — quote exactly, never alter) ===\n" +
  "- India equity-returns ADF = -49.18 (stationary).  - UK equity-returns ADF = -52.64 (stationary).\n" +
  "- GARCH(1,1) India: alpha+beta = 0.991 (near-unit persistence).  - MODWT India: d1 = 47.07% of return variance.\n" +
  "- WQTE USA->India: tau=0.05 aggregate = 0.039.  - VAR(India,USA,UK): lag=7, stable, max root = 0.705.\n" +
  "- MCPFM SRI AUC: 0.915 (US/COVID), 0.581 (India/trade-war).\n\n" +
  "=== STATIONARITY RULE (never violate) ===\n" +
  "Equity PRICE LEVELS are I(1) / non-stationary (unit root, random walk with drift). LOG-RETURNS = diff(log price) " +
  "are typically I(0) / stationary. Never call a price level stationary. The stored G20 panel is ALREADY log-returns, " +
  "so any 'stationary' verdict there is about RETURNS — say so explicitly (e.g. 'UK equity RETURNS are stationary').\n\n" +
  "=== INTEGRITY ===\n" +
  "Cite only literature you can verify exists (use search). Never fabricate an author, year, journal, DOI, or finding. " +
  "If uncertain, say so. If a claim cannot be grounded, label it as your reasoning, not an established result. Flag any " +
  "inconsistency you notice between a new result and the verified results above.";

async function researchTurn(query, userContext) {
  if (!query || !query.trim()) return { error: "empty query" };
  let ctxPrefix = userContext && String(userContext).trim() ? `Context from the researcher: ${userContext}\n\n` : "";
  const analyses = [];

  // 29.4 — literature pre-search: retrieve REAL papers/claims from literature.papers
  // and inject them so the model cites the graph rather than inventing sources.
  // Best-effort: any failure (or empty) degrades silently — never breaks /api/research.
  try {
    const litCtx = await buildLiteratureContext({ text: query });
    const block = literatureContextBlock(litCtx);
    if (block) ctxPrefix += block;
    else logLine({ path: "/api/research", event: "literature_skip", status: litCtx?.status || "unknown", reason: litCtx?.reason || null });
  } catch (e) { logLine({ path: "/api/research", event: "literature_error", error: e.message }); }

  // ── Phase A: agentic run_analysis loop (function tool only) ──
  const contents = [{ role: "user", parts: [{ text: ctxPrefix + query }] }];
  const MAX_STEPS = 3;
  for (let step = 0; step < MAX_STEPS; step++) {
    let r1;
    try { r1 = await geminiCall({ systemInstruction: { parts: [{ text: RESEARCH_SYS }] }, contents, tools: chatTools(), generationConfig: { temperature: 0.2 } }, { model: RESEARCH_MODEL, timeoutMs: 55000 }); }
    catch (e) { break; }   // network/timeout — proceed to synthesis with whatever we have
    const parts = r1?.candidates?.[0]?.content?.parts || [];
    const calls = parts.filter(p => p.functionCall).map(p => p.functionCall);
    contents.push({ role: "model", parts });
    if (!calls.length) break;                              // model is done running analyses
    const respParts = [];
    for (const fc of calls) {
      try {
        const v = validate(fc.args.method, fc.args);
        const run = await runSandboxed(v.method, await buildArgsJson(v.method, v.clean));
        if (run.ok) { analyses.push({ method: fc.args.method, params: v.clean, result: run.result, ms: run.ms }); respParts.push({ functionResponse: { name: "run_analysis", response: { result: run.result } } }); }
        else { analyses.push({ method: fc.args.method, params: v.clean, error: run.error }); respParts.push({ functionResponse: { name: "run_analysis", response: { error: run.error } } }); }
      } catch (e) {
        analyses.push({ method: fc.args?.method, error: e.message });
        respParts.push({ functionResponse: { name: "run_analysis", response: { error: e.message } } });
      }
    }
    contents.push({ role: "function", parts: respParts });
  }

  // ── Phase B: grounded synthesis (google_search only; analyses summarised in) ──
  const digest = analyses.length
    ? "LIVE ANALYSES EXECUTED THIS SESSION (real numbers from the sandboxed R engine — use exactly, do not alter):\n" +
      analyses.map(a => a.error
        ? `- ${a.method}(${JSON.stringify(a.params || {})}) -> FAILED: ${a.error}`
        : `- ${a.method}(${JSON.stringify(a.params)}) -> ${JSON.stringify(a.result).slice(0, 1400)}`).join("\n")
    : "No live analyses were run for this query (it was conceptual or did not require the engine).";
  const synthContents = [{ role: "user", parts: [{ text:
    ctxPrefix + `Research question: ${query}\n\n${digest}\n\n` +
    "Write the definitive answer a co-author would give: rigorous, economically interpreted, explicit about " +
    "assumptions and limitations. Ground empirical claims in the live analyses above where relevant. Run at least one " +
    "literature search to ground your answer in real sources — do this even for conceptual questions, so you name the " +
    "actual foundational works rather than answering citation-free. You may name a canonical, well-established " +
    "foundational paper from your own knowledge, but verify anything specific, recent, or obscure via search before " +
    "naming it. Never invent an author, year, journal, DOI, or result. Where you cite, name the work inline so the " +
    "reader can find it." }] }];
  let r2;
  try { r2 = await geminiCall({ systemInstruction: { parts: [{ text: RESEARCH_SYS }] }, contents: synthContents, tools: [{ google_search: {} }], generationConfig: { temperature: 0.3 } }, { model: RESEARCH_MODEL, timeoutMs: 55000 }); }
  catch (e) { return { error: `synthesis failed: ${e.message}`, analyses, model: RESEARCH_MODEL }; }
  const cand = r2?.candidates?.[0];
  const answer = (cand?.content?.parts || []).map(p => p.text).filter(Boolean).join("") || "(no answer generated)";
  const gm = cand?.groundingMetadata || {};
  const citations = (gm.groundingChunks || []).map(c => ({ title: c.web?.title || null, uri: c.web?.uri || null })).filter(c => c.uri);
  const searches = gm.webSearchQueries || [];
  return { answer, citations, searches, analyses, model: RESEARCH_MODEL, steps: analyses.length };
}

// ── literature graph (Vision Phase 29.4/29.5) ─────────────────────────────────
// Read-only retrieval over the companion-ingested BigQuery table
//   hopeful-flash-485308-v3.literature.papers
// (schema: paper_id, title, authors[], date, source, category, methods_mentioned[],
//  datasets_mentioned[], results[]{claim,metric,value,context}, ingested_at, verified).
// Every returned item comes from a REAL DB row — nothing is invented here. The actual
// HTTP is behind a swappable seam (`_bqQuery`) so the logic is testable offline.
const BQ_PROJECT = process.env.LITERATURE_PROJECT || "hopeful-flash-485308-v3";
const BQ_DATASET = process.env.LITERATURE_DATASET || "literature";
const BQ_TABLE   = "papers";
const LIT_LIMIT  = 10;

// Map a compute-engine method id (or free name) to the vocabulary papers actually
// use, so methods_mentioned overlaps even when the paper says "DFA"/"Hurst" not
// our internal "dfa_hurst" id. Best-effort; the SQL also matches the raw token.
const METHOD_ALIASES = {
  unit_root: ["ADF", "Augmented Dickey-Fuller", "KPSS", "unit root", "stationarity"],
  panel_unit_root: ["IPS", "LLC", "panel unit root", "Im-Pesaran-Shin", "Levin-Lin-Chu"],
  live_unit_root: ["ADF", "unit root", "stationarity"],
  var_irf: ["VAR", "impulse response", "IRF", "vector autoregression"],
  vecm: ["VECM", "cointegration", "Johansen", "error correction"],
  granger: ["Granger causality", "Granger"],
  dfa_hurst: ["DFA", "detrended fluctuation analysis", "Hurst", "long memory", "GPH"],
  garch: ["GARCH", "volatility", "conditional heteroskedasticity"],
  rolling_dcc: ["DCC-GARCH", "DCC", "dynamic conditional correlation"],
  wavelet: ["MODWT", "wavelet", "wavelet variance", "multiresolution"],
  wavelet_coherence: ["wavelet coherence", "coherence", "phase"],
  wqte: ["transfer entropy", "WQTE", "wavelet quantile transfer entropy", "quantile transfer entropy"],
  quantile_var: ["quantile VAR", "QVAR", "quantile connectedness"],
  connectedness: ["connectedness", "Diebold-Yilmaz", "spillover", "GFEVD", "Barunik-Krehlik"],
  spillover_rolling: ["spillover", "connectedness", "rolling spillover", "Diebold-Yilmaz"],
  network: ["network", "igraph", "community detection", "centrality"],
  soch_profile: ["contagion", "spillover", "systemic risk"],
};
function derivedMethodNames(method) {
  if (!method) return [];
  const key = String(method).toLowerCase().trim();
  const out = new Set([String(method).trim()]);
  if (METHOD_ALIASES[key]) for (const a of METHOD_ALIASES[key]) out.add(a);
  return [...out].filter(Boolean);
}

// The swappable seam. realBqQuery runs the parameterised jobs.query REST call with
// the metadata OAuth bearer; selftest replaces it with a stub. Contract:
//   in : (sql:string, queryParameters:array)
//   out: Promise<{ok:true, rows:[<plain row obj>]} | {ok:false, status, error}>
// realBqQuery is responsible for decoding BigQuery's typed {f:[{v}]} row shape into
// plain objects, so the seam boundary is plain rows (keeps mocks trivial + honest).
function bqDecodeRows(json) {
  const fields = (json?.schema?.fields) || [];
  const rows = (json?.rows) || [];
  const decodeField = (field, cell) => {
    if (cell == null) return field.mode === "REPEATED" ? [] : null;
    if (field.mode === "REPEATED") {
      // REPEATED cell: { v: [ { v: <scalar|struct> }, ... ] }
      const arr = Array.isArray(cell.v) ? cell.v : [];
      return arr.map((e) => decodeScalarOrRecord(field, e?.v));
    }
    return decodeScalarOrRecord(field, cell.v);
  };
  const decodeScalarOrRecord = (field, v) => {
    if (field.type === "RECORD" || field.type === "STRUCT") {
      const sub = field.fields || [];
      const obj = {};
      const fcells = (v && Array.isArray(v.f)) ? v.f : [];
      sub.forEach((sf, i) => { obj[sf.name] = decodeField(sf, fcells[i]); });
      return obj;
    }
    return v; // scalar (string/number come back as strings from BQ; callers coerce)
  };
  return rows.map((row) => {
    const obj = {};
    const cells = (row && Array.isArray(row.f)) ? row.f : [];
    fields.forEach((f, i) => { obj[f.name] = decodeField(f, cells[i]); });
    return obj;
  });
}
function realBqQuery(sql, queryParameters) {
  return new Promise((resolve) => {
    metadataToken().then((tok) => {
      if (!tok) return resolve({ ok: false, status: 0, error: "no OAuth token (metadata server unreachable)" });
      const payload = Buffer.from(JSON.stringify({
        query: sql, useLegacySql: false, parameterMode: "NAMED", queryParameters, timeoutMs: 3000,
      }));
      const u = new URL(`https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(BQ_PROJECT)}/queries`);
      const req = httpsRequest(u, { method: "POST", headers: {
        "Authorization": `Bearer ${tok}`, "Content-Type": "application/json", "Content-Length": payload.length,
      }, timeout: 4000 }, (r) => {
        let b = ""; r.on("data", (d) => (b += d));
        r.on("end", () => {
          if (r.statusCode !== 200) return resolve({ ok: false, status: r.statusCode, error: `bigquery ${r.statusCode}: ${b.slice(0, 200)}` });
          let json; try { json = JSON.parse(b); } catch { return resolve({ ok: false, status: 200, error: "bigquery bad JSON" }); }
          if (json.jobComplete === false) return resolve({ ok: false, status: 200, error: "bigquery job not complete within timeoutMs" });
          try { return resolve({ ok: true, rows: bqDecodeRows(json) }); }
          catch (e) { return resolve({ ok: false, status: 200, error: `bigquery row-decode failed: ${e.message}` }); }
        });
      });
      req.on("error", (e) => resolve({ ok: false, status: 0, error: `bigquery network: ${e.message}` }));
      req.on("timeout", () => { req.destroy(); resolve({ ok: false, status: 0, error: "bigquery timeout" }); });
      req.write(payload); req.end();
    }).catch((e) => resolve({ ok: false, status: 0, error: `metadata: ${e.message}` }));
  });
}
let _bqQuery = realBqQuery;                       // SWAPPABLE seam (selftest overrides)
export function __setBqQuery(fn) { _bqQuery = fn || realBqQuery; }   // test hook only

// Coerce a results.value into a number + sign for deterministic claim comparison.
// Handles "0.915", "-0.04", "AUC = 0.58", "increases by 12%". Returns {num, sign}
// where sign ∈ {-1,0,1,null}; null = no parseable magnitude (treated as related-only).
function valueSign(value) {
  if (value == null) return { num: null, sign: null };
  if (typeof value === "number") return { num: value, sign: Math.sign(value) || 0 };
  const s = String(value);
  const m = s.match(/-?\d+(?:\.\d+)?/);
  if (!m) {
    if (/\b(increase|positive|rise|up|amplif|stronger)\b/i.test(s)) return { num: null, sign: 1 };
    if (/\b(decrease|negative|fall|down|weaker|attenuat)\b/i.test(s)) return { num: null, sign: -1 };
    return { num: null, sign: null };
  }
  let num = parseFloat(m[0]);
  if (/\b(decrease|negative|fall|down|weaker|attenuat)\b/i.test(s) && num > 0) num = -num;
  return { num, sign: Math.sign(num) || 0 };
}
const norm = (x) => String(x == null ? "" : x).toLowerCase().trim();

// queryLiterature(ctx) — ctx = {method?, series?:[], quantile?, text?}.
// Builds a parameterised Standard-SQL SELECT and runs it through the seam. NEVER
// throws into the caller; any failure → {status:"unavailable", reason, papers_found:0, papers:[]}.
async function queryLiterature(ctx = {}) {
  try {
    const methodNames = derivedMethodNames(ctx.method);
    const series = Array.isArray(ctx.series) ? ctx.series.filter(Boolean).map(String) : [];
    const text = ctx.text != null && String(ctx.text).trim() ? String(ctx.text).trim().slice(0, 200) : null;

    // Parameterised WHERE: each clause is OR-combined; arrays use UNNEST overlap.
    const where = [];
    const params = [];
    const addArr = (name, vals, type = "STRING") => {
      params.push({ name, parameterType: { type: "ARRAY", arrayType: { type } },
        parameterValue: { arrayValues: vals.map((v) => ({ value: String(v) })) } });
    };
    if (methodNames.length) {
      addArr("methods", methodNames);
      // methods_mentioned (array) overlaps any derived name (case-insensitive)
      where.push("EXISTS (SELECT 1 FROM UNNEST(methods_mentioned) m JOIN UNNEST(@methods) q ON LOWER(m) = LOWER(q))");
    }
    if (series.length) {
      addArr("series", series);
      // datasets_mentioned overlap OR a result.context mentions the series token
      where.push("EXISTS (SELECT 1 FROM UNNEST(datasets_mentioned) d JOIN UNNEST(@series) q ON LOWER(d) = LOWER(q))");
      where.push("EXISTS (SELECT 1 FROM UNNEST(results) r JOIN UNNEST(@series) q ON LOWER(r.context) LIKE CONCAT('%', LOWER(q), '%'))");
    }
    if (text) {
      params.push({ name: "text", parameterType: { type: "STRING" }, parameterValue: { value: text } });
      where.push("LOWER(title) LIKE CONCAT('%', LOWER(@text), '%')");
    }
    if (!where.length) return { status: "ok", papers_found: 0, papers: [] };   // nothing to match on

    const sql =
      "SELECT paper_id, title, authors, date, category, methods_mentioned, datasets_mentioned, results\n" +
      `FROM \`${BQ_PROJECT}.${BQ_DATASET}.${BQ_TABLE}\`\n` +
      `WHERE ${where.join(" OR ")}\n` +
      `LIMIT ${LIT_LIMIT}`;

    const res = await _bqQuery(sql, params);
    if (!res || !res.ok) {
      return { status: "unavailable", reason: (res && res.error) || "unknown bigquery error", papers_found: 0, papers: [] };
    }
    const papers = (res.rows || []).map((row) => ({
      paper_id: row.paper_id ?? null,
      title: row.title ?? null,
      authors: Array.isArray(row.authors) ? row.authors : [],
      date: row.date ?? null,
      category: row.category ?? null,
      methods: Array.isArray(row.methods_mentioned) ? row.methods_mentioned : [],
      datasets: Array.isArray(row.datasets_mentioned) ? row.datasets_mentioned : [],
      claims: (Array.isArray(row.results) ? row.results : []).map((r) => ({
        claim: r?.claim ?? null, metric: r?.metric ?? null, value: r?.value ?? null, context: r?.context ?? null,
      })),
    })).filter((p) => p.paper_id);   // drop any row without a real id (no phantom papers)
    return { status: "ok", papers_found: papers.length, papers };
  } catch (e) {
    return { status: "unavailable", reason: `queryLiterature: ${e.message}`, papers_found: 0, papers: [] };
  }
}

// buildLiteratureContext(ctx, result?) — assembles a citation-safe context from the
// REAL retrieved rows ONLY. Classification is DETERMINISTIC (no LLM): a retrieved
// claim is `supporting` if it shares metric+context with `result` and the same sign;
// `conflicting` if same metric+context but opposite sign; else it is just a related
// paper. Empty context is acceptable. NEVER adds a paper/claim not in the rows.
async function buildLiteratureContext(ctx = {}, result) {
  const lit = await queryLiterature(ctx);
  const empty = {
    papers_found: lit.papers_found || 0, status: lit.status,
    related_papers: [], related_methods: [], supporting_claims: [], conflicting_claims: [],
  };
  if (lit.status !== "ok" || !lit.papers.length) {
    if (lit.reason) empty.reason = lit.reason;
    return empty;
  }
  // Derive the (metric, context, sign) targets from `result`, if any.
  const targets = [];
  if (result && typeof result === "object") {
    const rmetric = result.metric ?? null;
    const rcontext = result.context ?? null;
    const { sign: rsign } = valueSign(result.value);
    if (rmetric != null) targets.push({ metric: norm(rmetric), context: norm(rcontext), sign: rsign });
  }

  const related_papers = lit.papers.map((p) => ({ paper_id: p.paper_id, title: p.title, date: p.date }));
  const methodSet = new Set();
  for (const p of lit.papers) for (const m of p.methods) if (m) methodSet.add(m);

  const supporting_claims = [], conflicting_claims = [];
  for (const p of lit.papers) {
    for (const c of p.claims) {
      if (!targets.length) continue;
      const cm = norm(c.metric), cc = norm(c.context);
      const { sign: csign } = valueSign(c.value);
      for (const t of targets) {
        if (!t.metric || cm !== t.metric || cc !== t.context) continue;   // must share metric+context
        if (t.sign == null || csign == null || t.sign === 0 || csign === 0) continue;  // need a definite direction both sides
        const entry = { paper_id: p.paper_id, claim: c.claim, metric: c.metric, value: c.value, context: c.context };
        if (csign === t.sign) supporting_claims.push(entry);
        else conflicting_claims.push(entry);
        break;   // one target match is enough per claim
      }
    }
  }
  return {
    papers_found: lit.papers_found, status: lit.status,
    related_papers, related_methods: [...methodSet], supporting_claims, conflicting_claims,
  };
}

// 29.4 — render the retrieved context as a prompt block. Returns "" when there is
// nothing real to inject (unavailable OR empty) so /api/research degrades silently.
function literatureContextBlock(litCtx) {
  if (!litCtx || litCtx.status !== "ok" || !litCtx.related_papers.length) return "";
  return "\n\nLITERATURE GRAPH CONTEXT (retrieved from literature.papers; cite these, do not invent):\n" +
    JSON.stringify({
      related_papers: litCtx.related_papers,
      related_methods: litCtx.related_methods,
      supporting_claims: litCtx.supporting_claims,
      conflicting_claims: litCtx.conflicting_claims,
    }) + "\n";
}

// ── job log ─────────────────────────────────────────────────────────────────────
const LOG_DIR = join(ENGINE_DIR, ".jobs");
let jobSeq = 0;
function logJob(rec) {
  try { mkdirSync(LOG_DIR, { recursive: true }); writeFileSync(join(LOG_DIR, `job_${rec.id}.json`), JSON.stringify(rec, null, 2)); } catch {}
}

// ── public job permalink read-front (GET /api/jobs/:id) ───────────────────────
// Serves a Tier-A async job record that the always-on tower mirrored to
// gs://<JOBS_BUCKET>/<id>.json. Auth = OAuth via the Cloud Run metadata server
// (plain HTTP, NOT https — matches NEURICX bq.mjs). Read-only: no submit/exec here.
const JOBS_BUCKET = process.env.JOBS_BUCKET || "econstellar-jobs";
let _mtok = null, _mtokExp = 0;
function metadataToken() {
  if (process.env.GOOGLE_OAUTH_TOKEN) return Promise.resolve(process.env.GOOGLE_OAUTH_TOKEN);
  if (_mtok && Date.now() < _mtokExp) return Promise.resolve(_mtok);
  return new Promise((resolve) => {
    const req = httpRequest(
      { host: "metadata.google.internal", path: "/computeMetadata/v1/instance/service-accounts/default/token",
        headers: { "Metadata-Flavor": "Google" }, timeout: 4000 },
      (r) => { let b = ""; r.on("data", d => b += d); r.on("end", () => {
        try { const j = JSON.parse(b); if (!j.access_token) return resolve(null);
          _mtok = j.access_token; _mtokExp = Date.now() + Math.max(0, (j.expires_in - 120)) * 1000; resolve(_mtok);
        } catch { resolve(null); } }); });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}
// returns { status, body } where status mirrors the GCS object fetch (200 / 404 / other)
function fetchJobRecord(id) {
  return new Promise((resolve) => {
    metadataToken().then((tok) => {
      if (!tok) return resolve({ status: 0, body: null });
      const u = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(JOBS_BUCKET)}/o/${encodeURIComponent(id + ".json")}?alt=media`);
      const req = httpsRequest(u, { method: "GET", headers: { "Authorization": `Bearer ${tok}` }, timeout: 15000 }, (r) => {
        let b = ""; r.on("data", d => b += d); r.on("end", () => resolve({ status: r.statusCode, body: b }));
      });
      req.on("error", () => resolve({ status: 0, body: null }));
      req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: null }); });
      req.end();
    });
  });
}
// Public read-front for operator-published notebooks. MIRRORS fetchJobRecord exactly
// (same metadataToken auth, same GCS object GET) but under the notebooks/ prefix.
// Read-only: notebooks are written only by the operator-bound job-server, never here.
function fetchNotebookRecord(id) {
  return new Promise((resolve) => {
    metadataToken().then((tok) => {
      if (!tok) return resolve({ status: 0, body: null });
      const u = new URL(`https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(JOBS_BUCKET)}/o/${encodeURIComponent("notebooks/" + id + ".json")}?alt=media`);
      const req = httpsRequest(u, { method: "GET", headers: { "Authorization": `Bearer ${tok}` }, timeout: 15000 }, (r) => {
        let b = ""; r.on("data", d => b += d); r.on("end", () => resolve({ status: r.statusCode, body: b }));
      });
      req.on("error", () => resolve({ status: 0, body: null }));
      req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: null }); });
      req.end();
    });
  });
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

const server = createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const send = (c, t, b) => { res.writeHead(c, { "Content-Type": t, "Access-Control-Allow-Origin": "*" }); res.end(b); };

  // CORS preflight: browsers send OPTIONS before a cross-origin JSON POST.
  // Without this the SPA (GitHub Pages) gets "Failed to fetch" on /api/compute/run + /api/chat.
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    });
    return res.end();
  }

  if (u.pathname === "/health")
    return send(200, "application/json", JSON.stringify({ ok: true, sandbox: HAVE_BWRAP ? "bwrap" : "timeout", methods: Object.keys(METHODS).length, timeout_s: JOB_TIMEOUT_S, revision: process.env.K_REVISION || "local" }));

  if (u.pathname === "/metrics")
    return send(200, "application/json", JSON.stringify(metricsSnapshot()));

  if (u.pathname === "/api/compute/catalog") {
    // capability → [method ids], derived from each method's `capability` tag (drives the workbench filter)
    const capabilities = {};
    for (const [id, m] of Object.entries(METHODS)) {
      if (!m.capability) continue;
      (capabilities[m.capability] ||= []).push(id);
    }
    return send(200, "application/json", JSON.stringify({ methods: METHODS, datasets: DATASETS, capabilities }));
  }

  // ── privacy-respecting usage beacon (T3.2): aggregate counts only, no PII ──
  if (u.pathname === "/api/event" && req.method === "POST") {
    if (!rateLimit(clientIp(req), "/api/event", 60).ok) return send(429, "application/json", JSON.stringify({ error: "rate_limit" }));
    let body = "", tooBig = false;
    req.on("data", d => { if (body.length + d.length > 2048) tooBig = true; else body += d; });
    req.on("end", () => {
      if (tooBig) return send(413, "text/plain", "");
      let name = ""; try { name = String((JSON.parse(body || "{}").name) || "").slice(0, 40); } catch {}
      if (ALLOWED_EVENTS.has(name)) countEvent(name);   // count only allowlisted names; nothing else is stored
      return send(204, "text/plain", "");
    });
    return;
  }

  // ── guards for metered routes: per-minute → per-day → global concurrency ──
  const ip = clientIp(req);
  if (RATE[u.pathname]) {
    // (1) per-IP sliding-window, per-minute
    const rl = rateLimit(ip, u.pathname, RATE[u.pathname]);
    if (!rl.ok) {
      metrics.rate_limited_total++;
      logLine({ path: u.pathname, ip, event: "rate_limit", retry_after_seconds: rl.retry_after_seconds });
      return send(429, "application/json", JSON.stringify({ error: "rate_limit", message: "Too many requests — slow down.", retry_after_seconds: rl.retry_after_seconds }));
    }
    // (2) per-IP per-UTC-day quota on the paid LLM endpoints
    const daily = DAILY[u.pathname];
    if (daily) {
      const dl = dailyLimit(ip, u.pathname, daily);
      if (!dl.ok) {
        metrics.daily_limited_total++;
        logLine({ path: u.pathname, ip, event: "daily_quota" });
        return send(429, "application/json", JSON.stringify({ error: "daily_quota", message: "Daily limit for this endpoint reached; resets at 00:00 UTC.", retry_after_seconds: 3600 }));
      }
    }
    // (3) global concurrency ceiling — shed load rather than fan out unbounded credit spend
    if (!acquire()) {
      metrics.concurrency_shed_total++;
      logLine({ path: u.pathname, ip, event: "concurrency_shed", ...concurrencyState() });
      return send(503, "application/json", JSON.stringify({ error: "busy", message: "High demand right now — please retry in a moment.", retry_after_seconds: 5 }));
    }
    let released = false;
    const rel = () => { if (!released) { released = true; release(); } };
    res.on("close", rel); res.on("finish", rel);   // release the slot on any completion
  }

  if (u.pathname === "/api/compute/run" && req.method === "POST") {
    let body = "", tooBig = false;
    req.on("data", d => { if (body.length + d.length > MAX_BODY_BYTES) { tooBig = true; return; } body += d; });
    req.on("end", async () => {
      if (tooBig) return send(413, "application/json", JSON.stringify({ error: "payload_too_large", message: "Request body too large." }));
      let payload;
      try { payload = JSON.parse(body || "{}"); } catch { return send(400, "application/json", JSON.stringify({ ok: false, error: "bad JSON body" })); }
      let v;
      try { v = validate(payload.method, payload.params || {}); }
      catch (e) { return send(400, "application/json", JSON.stringify({ ok: false, error: e.message })); }
      // long-running methods (e.g. ksg_te) are discoverable in the catalog but run only as
      // background jobs — never spawn them on the sync endpoint.
      if (v.method.long_running) return send(400, "application/json", JSON.stringify({ error: "This method runs as a background job. Submit via /api/jobs/submit.", async: true }));
      const t0 = Date.now();
      metrics.requests_total++; countMethod(payload.method);
      // ── response cache (5-min TTL; never caches errors) ──
      const ck = cacheKey(payload.method, v.clean);
      const cached = cacheGet(ck);
      let r, fromCache = false;
      if (cached) { r = cached; fromCache = true; metrics.cache_hits++; }
      else {
        metrics.cache_misses++;
        try { r = await runSandboxed(v.method, await buildArgsJson(v.method, v.clean)); }
        catch (e) { r = { ok: false, error: `data fetch failed: ${e.message}` }; }
        if (r.ok) cacheSet(ck, r);
        else { const stale = cacheGetStale(ck); if (stale && stale.ok) r = { ...stale, stale: true, note: "served last-good cached result (live run failed)" }; }
      }
      if (!r.ok) metrics.errors_total++;
      const ms = Date.now() - t0;
      const rec = { id: ++jobSeq, ts: new Date().toISOString(), method: payload.method, params: v.clean, ms, ok: r.ok, error: r.error || null };
      logJob(rec);
      logLine({ path: "/api/compute/run", method: payload.method, series: v.clean.series, symbol: v.clean.symbol, ip, ms, cached: fromCache, error: r.error || null });
      return send(r.ok ? 200 : 500, "application/json", JSON.stringify({ ...r, ms, cached: fromCache, job_id: rec.id, provenance: provenance(payload.method, v.method, v.clean) }));
    });
    return;
  }

  // chatbot: NL -> Gemini function-call -> run analysis -> Gemini summary
  if (u.pathname === "/api/chat" && req.method === "POST") {
    let body = "", tooBig = false;
    req.on("data", d => { if (body.length + d.length > MAX_BODY_BYTES) { tooBig = true; return; } body += d; });
    req.on("end", async () => {
      if (tooBig) return send(413, "application/json", JSON.stringify({ error: "payload_too_large", message: "Request body too large." }));
      let payload;
      try { payload = JSON.parse(body || "{}"); } catch { return send(400, "application/json", JSON.stringify({ error: "bad JSON body" })); }
      if (String(payload.message || "").length > MAX_MSG_CHARS) return send(413, "application/json", JSON.stringify({ error: "message_too_long", message: `Message exceeds ${MAX_MSG_CHARS} characters.` }));
      const tc = Date.now();
      metrics.requests_total++; countMethod("chat");
      if (!llmBudget().ok) { metrics.errors_total++; logLine({ path: "/api/chat", ip, event: "llm_daily_cap" }); return send(503, "application/json", JSON.stringify({ error: "daily_capacity", message: "Daily AI-analyst capacity reached; resets 00:00 UTC.", retry_after_seconds: 3600 })); }
      try {
        const out = await chatTurn(payload.message || "");
        if (out && out.ran && out.ran.error) metrics.errors_total++;
        logLine({ path: "/api/chat", ip, ms: Date.now() - tc, ran: out && out.ran ? out.ran.method : null });
        return send(200, "application/json", JSON.stringify(out));
      }
      catch (e) { metrics.errors_total++; logLine({ path: "/api/chat", ip, ms: Date.now() - tc, error: e.message }); return send(500, "application/json", JSON.stringify({ error: e.message })); }
    });
    return;
  }

  // deep-research assistant: Gemini 2.5 Pro + run_analysis + grounded citations
  if (u.pathname === "/api/research" && req.method === "POST") {
    let body = "", tooBig = false;
    req.on("data", d => { if (body.length + d.length > MAX_BODY_BYTES) { tooBig = true; return; } body += d; });
    req.on("end", async () => {
      if (tooBig) return send(413, "application/json", JSON.stringify({ error: "payload_too_large", message: "Request body too large." }));
      let payload;
      try { payload = JSON.parse(body || "{}"); } catch { return send(400, "application/json", JSON.stringify({ error: "bad JSON body" })); }
      if (!GOOGLE_KEY) return send(503, "application/json", JSON.stringify({ error: "research assistant unavailable (no GOOGLE_API_KEY on this revision)" }));
      if (!payload.query || !String(payload.query).trim()) return send(400, "application/json", JSON.stringify({ error: "missing 'query'" }));
      if (String(payload.query).length > MAX_MSG_CHARS) return send(413, "application/json", JSON.stringify({ error: "query_too_long", message: `Query exceeds ${MAX_MSG_CHARS} characters.` }));
      const tr = Date.now();
      metrics.requests_total++; countMethod("research");
      if (!llmBudget().ok) { metrics.errors_total++; logLine({ path: "/api/research", ip, event: "llm_daily_cap" }); return send(503, "application/json", JSON.stringify({ error: "daily_capacity", message: "Daily research capacity reached; resets 00:00 UTC.", retry_after_seconds: 3600 })); }
      try {
        const out = await researchTurn(String(payload.query), payload.context);
        if (out.error) metrics.errors_total++;
        logLine({ path: "/api/research", ip, ms: Date.now() - tr, steps: out.steps ?? null, citations: out.citations ? out.citations.length : 0, error: out.error || null });
        return send(out.error ? 500 : 200, "application/json", JSON.stringify({ ...out, ms: Date.now() - tr }));
      }
      catch (e) { metrics.errors_total++; logLine({ path: "/api/research", ip, ms: Date.now() - tr, error: e.message }); return send(500, "application/json", JSON.stringify({ error: e.message })); }
    });
    return;
  }

  // 29.5 — auto-situate: deterministic literature context for a method/result/text.
  // Read-only, no LLM, no credit spend (so it sits outside the metered-route block);
  // graceful-degrade is inherited from buildLiteratureContext (never throws).
  if (u.pathname === "/api/situate" && req.method === "POST") {
    if (!rateLimit(ip, "/api/situate", 30).ok) return send(429, "application/json", JSON.stringify({ error: "rate_limit", message: "Too many requests — slow down." }));
    let body = "", tooBig = false;
    req.on("data", d => { if (body.length + d.length > MAX_BODY_BYTES) { tooBig = true; return; } body += d; });
    req.on("end", async () => {
      if (tooBig) return send(413, "application/json", JSON.stringify({ error: "payload_too_large", message: "Request body too large." }));
      let payload;
      try { payload = JSON.parse(body || "{}"); } catch { return send(400, "application/json", JSON.stringify({ error: "bad JSON body" })); }
      try {
        const literature_context = await buildLiteratureContext(
          { method: payload.method, series: payload.series, quantile: payload.quantile, text: payload.text },
          payload.result,
        );
        return send(200, "application/json", JSON.stringify({ literature_context }));
      } catch (e) {
        // belt-and-braces: still degrade, never 500 the caller
        return send(200, "application/json", JSON.stringify({ literature_context: { papers_found: 0, status: "unavailable", reason: e.message, related_papers: [], related_methods: [], supporting_claims: [], conflicting_claims: [] } }));
      }
    });
    return;
  }

  // ── Phase 30: Systemic Risk Observatory (public, read-only, graceful-degrade) ──
  // All read BigQuery systemic_risk.daily via _bqQuery; degrade to {status:"unavailable"}
  // on any error/empty (never 500). Populated by the sri_daily method + the sri-daily job.
  const SRI_TBL = "`" + BQ_PROJECT + ".systemic_risk.daily`";
  if (u.pathname === "/api/sri/current" && req.method === "GET") {
    const r = await _bqQuery("SELECT date, sri, sri_total, `window`, k, lag, n_markets, n_pairs, top_edges, computed_at, engine_revision FROM " + SRI_TBL + " ORDER BY date DESC LIMIT 1", []);
    if (!r.ok || !r.rows || !r.rows.length) return send(200, "application/json", JSON.stringify({ status: "unavailable", reason: (r.error || "no SRI points yet") }));
    const row = r.rows[0];
    return send(200, "application/json", JSON.stringify({ status: "ok", date: row.date, sri: row.sri, sri_total: row.sri_total, window: row.window, k: row.k, lag: row.lag, n_markets: row.n_markets, n_pairs: row.n_pairs, top_edges: row.top_edges || [], computed_at: row.computed_at, engine_revision: row.engine_revision }));
  }
  if (u.pathname === "/api/sri/history" && req.method === "GET") {
    const start = (u.searchParams.get("start") || "").slice(0, 10);
    const end = (u.searchParams.get("end") || "").slice(0, 10);
    const params = []; let where = "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(start)) { where += " AND date >= @start"; params.push({ name: "start", parameterType: { type: "DATE" }, parameterValue: { value: start } }); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(end)) { where += " AND date <= @end"; params.push({ name: "end", parameterType: { type: "DATE" }, parameterValue: { value: end } }); }
    const r = await _bqQuery("SELECT date, sri FROM " + SRI_TBL + " WHERE TRUE" + where + " ORDER BY date ASC LIMIT 1000", params);
    if (!r.ok) return send(200, "application/json", JSON.stringify({ status: "unavailable", reason: r.error, series: [] }));
    return send(200, "application/json", JSON.stringify({ status: "ok", series: (r.rows || []).map(x => ({ date: x.date, sri: x.sri })) }));
  }
  if (u.pathname === "/api/sri/network" && req.method === "GET") {
    const date = (u.searchParams.get("date") || "").slice(0, 10);
    let sql, params = [];
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) { sql = "SELECT date, sri, top_edges FROM " + SRI_TBL + " WHERE date = @date LIMIT 1"; params.push({ name: "date", parameterType: { type: "DATE" }, parameterValue: { value: date } }); }
    else { sql = "SELECT date, sri, top_edges FROM " + SRI_TBL + " ORDER BY date DESC LIMIT 1"; }
    const r = await _bqQuery(sql, params);
    if (!r.ok || !r.rows || !r.rows.length) return send(200, "application/json", JSON.stringify({ status: "unavailable", reason: (r.error || "no SRI point for that date") }));
    const row = r.rows[0];
    return send(200, "application/json", JSON.stringify({ status: "ok", date: row.date, sri: row.sri, edges: row.top_edges || [] }));
  }

  // ── Phase 34: epistemic claim layer (public, read-only, graceful-degrade) ──
  // The space's self-description. Claims are seeded ONLY from verified ground truth
  // (scripts/claims-seed.mjs — every row provenanced) and refreshed by the nightly
  // loop (scripts/claims-refresh.mjs). Contested/superseded are visible states:
  // the history of revision is part of the knowledge. Reads BigQuery
  // epistemic.claims via _bqQuery; degrades to {status:"unavailable"} — never 500.
  const CLAIMS_TBL = "`" + BQ_PROJECT + ".epistemic.claims`";
  const CLAIMS_COLS = "claim_id, type, statement, established_at, last_verified, confidence, conditions, counter_conditions, provenance_ids, paper_refs, status";
  if (u.pathname === "/api/claims" && req.method === "GET") {
    const params = []; let where = "";
    const st = (u.searchParams.get("status") || "").toLowerCase();
    if (["established", "contested", "superseded"].includes(st)) { where += " AND status = @st"; params.push({ name: "st", parameterType: { type: "STRING" }, parameterValue: { value: st } }); }
    const ty = (u.searchParams.get("type") || "").toLowerCase();
    if (/^[a-z_]{1,32}$/.test(ty) && ty) { where += " AND type = @ty"; params.push({ name: "ty", parameterType: { type: "STRING" }, parameterValue: { value: ty } }); }
    const r = await _bqQuery("SELECT " + CLAIMS_COLS + " FROM " + CLAIMS_TBL + " WHERE TRUE" + where +
      " ORDER BY IF(status = 'contested', 0, IF(status = 'established', 1, 2)), type, claim_id LIMIT 200", params);
    if (!r.ok) return send(200, "application/json", JSON.stringify({ status: "unavailable", reason: r.error, claims: [] }));
    return send(200, "application/json", JSON.stringify({ status: "ok", n: (r.rows || []).length, claims: r.rows || [] }));
  }
  {
    const m = u.pathname.match(/^\/api\/claims\/([A-Za-z0-9_\-]{1,64})$/);
    if (m && req.method === "GET") {
      const r = await _bqQuery("SELECT " + CLAIMS_COLS + " FROM " + CLAIMS_TBL + " WHERE claim_id = @id LIMIT 1",
        [{ name: "id", parameterType: { type: "STRING" }, parameterValue: { value: m[1] } }]);
      if (!r.ok) return send(200, "application/json", JSON.stringify({ status: "unavailable", reason: r.error }));
      if (!r.rows || !r.rows.length) return send(404, "application/json", JSON.stringify({ status: "not_found", claim_id: m[1] }));
      return send(200, "application/json", JSON.stringify({ status: "ok", claim: r.rows[0] }));
    }
  }

  // ── Phase 30.B: nightly live tick (scheduler-triggered, idempotent) ──
  // POST /api/sri/cron-tick : (1) append new Yahoo trading-day rows to panels.g20_returns
  // (UTC-date log-returns via ticker_map, Russia=NULL), then (2) compute + persist sri_daily
  // for every panel date that still lacks an SRI point. Date-gated on BOTH tables, so re-runs
  // are no-ops and a normal night nets +1 point. The R sandbox stays net-isolated: it only
  // ever sees an injected panel_inline window — never the network. Self-healing: the SRI step
  // is gated on panel-vs-sri (not on this tick's append), so a streaming-visibility lag or a
  // transient failure is caught up by the next tick. Always 200 (status: ok|partial|error).
  if (u.pathname === "/api/sri/cron-tick" && req.method === "POST") {
    const PANEL_TBL = "`" + BQ_PROJECT + ".panels.g20_returns`";
    const dry = u.searchParams.get("dry") === "1";   // health-check: do every read + the compute, write NOTHING
    const out = { status: "ok", dry, appended: 0, sri_points: [], errors: [] };
    // loud guard: a missing/empty ticker map must NOT masquerade as a market holiday
    // (both would otherwise yield appended:0). Distinguish config error from no-new-day.
    if (!tickerMap().USA || !tickerMap().USA.symbol)
      return send(200, "application/json", JSON.stringify({ status: "error", stage: "ticker-map", reason: "neuricx/sri/ticker_map.json missing or has no USA symbol in this image" }));
    const tm = tickerMap();
    const flagged = SRI_COLS.filter(c => tm[c] && tm[c].flag === "ok_vintage");
    // Compute (NO insert) the sri_daily point for one panel date via a BQ window + the
    // net-isolated R sandbox (panel_inline only — never the network). {ok,point}|{ok:false,error}.
    const computeSriForDate = async (D) => {
      const wq = await _bqQuery("SELECT * FROM " + PANEL_TBL + " WHERE date <= @d ORDER BY date DESC LIMIT 250",
        [{ name: "d", parameterType: { type: "DATE" }, parameterValue: { value: D } }]);
      if (!wq.ok || !wq.rows || !wq.rows.length) return { ok: false, error: "window " + (wq.error || "empty") };
      const win = wq.rows.slice().reverse();   // ascending by date
      const panel_inline = { dates: win.map(r => r.date), series: Object.fromEntries(SRI_COLS.map(c => [c, win.map(r => (r[c] == null ? null : Number(r[c])))])) };
      const run = await runSandboxed(METHODS.sri_daily, JSON.stringify({ asof: D, window: 250, k: 4, lag: 1, panel_inline }));
      if (!run.ok) return { ok: false, error: "sri " + (run.error || "failed") };
      const o = run.result;
      return { ok: true, point: { date: o.date, sri: o.sri, sri_total: o.sri_total, window: o.window, k: o.k, lag: o.lag,
        n_markets: o.n_markets, n_pairs: o.n_pairs, top_edges: o.top_edges || [], computed_at: new Date().toISOString(),
        engine_revision: "cron-tick", source: "yahoo", date_convention: "utc",
        excluded_markets: o.excluded_markets || [], flagged_markets: flagged } };
    };
    // (1) new panel rows strictly after MAX(panel date)
    const lr = await _bqQuery("SELECT CAST(MAX(date) AS STRING) AS d FROM " + PANEL_TBL, []);
    if (!lr.ok || !lr.rows || !lr.rows.length || !lr.rows[0].d)
      return send(200, "application/json", JSON.stringify({ status: "error", stage: "max-date", reason: (lr.error || "panel empty") }));
    const lastPanel = lr.rows[0].d;
    let newRows;
    try { newRows = await buildNewPanelRows(lastPanel); }
    catch (e) { return send(200, "application/json", JSON.stringify({ status: "error", stage: "yahoo-fetch", reason: String((e && e.message) || e) })); }
    if (newRows.length > 10) newRows = newRows.slice(0, 10);   // safety: a tick never deep-backfills
    if (dry) {
      // exercise the FULL read+compute path (Yahoo → build → BQ window → sandbox) with no writes
      out.would_append = newRows.map(r => r.date);
      const probe = await computeSriForDate(lastPanel);
      if (probe.ok) out.sri_points.push({ date: probe.point.date, sri: probe.point.sri, n_pairs: probe.point.n_pairs, n_markets: probe.point.n_markets, excluded_markets: probe.point.excluded_markets });
      else out.errors.push({ date: lastPanel, e: probe.error });
      if (out.errors.length) out.status = "partial";
      return send(200, "application/json", JSON.stringify(out));
    }
    if (newRows.length) {
      const ins = await bqInsertAll("panels", "g20_returns", newRows);
      if (!ins.ok) return send(200, "application/json", JSON.stringify({ status: "error", stage: "panel-insert", reason: ins.error }));
      out.appended = newRows.length;
    }
    // (2) compute + persist SRI for any panel date lacking an SRI point (idempotent, self-healing)
    const sd = await _bqQuery("SELECT CAST(MAX(date) AS STRING) AS d FROM " + SRI_TBL, []);
    const lastSri = (sd.ok && sd.rows && sd.rows.length) ? sd.rows[0].d : null;
    const dq = await _bqQuery(
      "SELECT CAST(date AS STRING) AS d FROM " + PANEL_TBL + (lastSri ? " WHERE date > @s" : "") + " ORDER BY date ASC LIMIT 10",
      lastSri ? [{ name: "s", parameterType: { type: "DATE" }, parameterValue: { value: lastSri } }] : []);
    if (!dq.ok) { out.status = "partial"; out.errors.push({ stage: "sri-dates", reason: dq.error }); return send(200, "application/json", JSON.stringify(out)); }
    for (const drow of (dq.rows || [])) {
      const c = await computeSriForDate(drow.d);
      if (!c.ok) { out.errors.push({ date: drow.d, e: c.error }); continue; }
      const si = await bqInsertAll("systemic_risk", "daily", [c.point]);
      if (!si.ok) { out.errors.push({ date: drow.d, e: "sri-insert " + si.error }); continue; }
      out.sri_points.push({ date: c.point.date, sri: c.point.sri, n_pairs: c.point.n_pairs });
    }
    if (out.errors.length) out.status = "partial";
    return send(200, "application/json", JSON.stringify(out));
  }

  // ── public job permalink: GET /api/jobs/:id → mirrored GCS record (read-only) ──
  const jm = u.pathname.match(/^\/api\/jobs\/([A-Za-z0-9_-]{1,128})$/);
  if (jm && req.method === "GET") {
    const { status, body } = await fetchJobRecord(jm[1]);
    if (status === 200 && body) return send(200, "application/json", body);
    if (status === 404) return send(404, "application/json", JSON.stringify({ error: "unknown or expired job" }));
    return send(status === 0 ? 502 : status, "application/json", JSON.stringify({ error: "job lookup failed" }));
  }

  // ── public notebook permalink: GET /api/notebooks/:id → mirrored GCS record (read-only) ──
  const nbm = u.pathname.match(/^\/api\/notebooks\/(nb_[a-z0-9_]+)$/);
  if (nbm && req.method === "GET") {
    const { status, body } = await fetchNotebookRecord(nbm[1]);
    if (status === 200 && body) return send(200, "application/json", body);
    if (status === 404) return send(404, "application/json", JSON.stringify({ error: "unknown notebook" }));
    return send(status === 0 ? 502 : status, "application/json", JSON.stringify({ error: "notebook lookup failed" }));
  }

  // static dashboard
  let p = u.pathname === "/" ? "/index.html" : u.pathname;
  const fp = join(WEB_DIR, p.replace(/\.\.+/g, ""));
  if (existsSync(fp) && fp.startsWith(WEB_DIR)) return send(200, MIME[extname(fp)] || "application/octet-stream", readFileSync(fp));
  // dual-space mandate (OS-P5): every public error is structured JSON, never bare text
  send(404, "application/json", JSON.stringify({ error: "not found", path: u.pathname }));
});

// periodic cleanup of expired cache + rate-limit buckets (unref'd: won't hold process open)
setInterval(sweep, 60 * 1000).unref();

// slowloris guard: a slow request body cannot hold a connection (and a concurrency
// slot) indefinitely — cap total request + header time.
server.requestTimeout = 30000;
server.headersTimeout = 15000;

// ── selftest (Phase 29.4/29.5 literature logic) — local, no network, no server ──
// Overrides the `_bqQuery` seam with mock rows and asserts the deterministic
// situating logic. Run: `node compute-server.mjs --selftest`. Exits non-zero on fail.
async function selftest() {
  let pass = 0, fail = 0;
  const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error("  ✗ " + msg); } };

  // Mock rows in the SEAM's plain-row shape (what realBqQuery yields post-decode).
  const MOCK_ROWS = [
    { paper_id: "arXiv:2507.08065", title: "MCPFM systemic risk", authors: ["Bhandari, A."], date: "2025-07-10",
      category: "systemic-risk", methods_mentioned: ["transfer entropy", "DFA"], datasets_mentioned: ["G20"],
      results: [{ claim: "SRI discriminates crises", metric: "AUC", value: "0.915", context: "US/COVID" }] },
    { paper_id: "arXiv:2604.26546", title: "Contagion channels", authors: ["Bhandari, A."], date: "2026-04-01",
      category: "contagion", methods_mentioned: ["GARCH"], datasets_mentioned: ["G20"],
      results: [{ claim: "weak discrimination", metric: "AUC", value: "-0.40", context: "US/COVID" }] },
    { paper_id: "wp:namh-2026", title: "Network Adaptive Market Hypothesis", authors: ["Bhandari, A."], date: "2026-01-15",
      category: "market-structure", methods_mentioned: ["MODWT", "wavelet"], datasets_mentioned: ["S&P500"],
      results: [{ claim: "scale dependence", metric: "variance-share", value: "0.47", context: "d1" }] },
  ];
  const idsIn = new Set(MOCK_ROWS.map(r => r.paper_id));

  // (a) MOCK rows → correct related_papers/methods + a SUPPORTING + a CONFLICTING claim.
  __setBqQuery(async () => ({ ok: true, rows: MOCK_ROWS }));
  const result = { metric: "AUC", value: "0.90", context: "US/COVID" };   // positive AUC in US/COVID
  const ctxA = await buildLiteratureContext({ text: "systemic risk AUC" }, result);
  ok(ctxA.status === "ok", "(a) status ok");
  ok(ctxA.papers_found === 3 && ctxA.related_papers.length === 3, "(a) 3 related papers");
  ok(ctxA.related_methods.includes("transfer entropy") && ctxA.related_methods.includes("MODWT"), "(a) related_methods aggregated");
  ok(ctxA.supporting_claims.length === 1 && ctxA.supporting_claims[0].paper_id === "arXiv:2507.08065",
     "(a) SUPPORTING = AUC 0.915 US/COVID (same metric+context+sign)");
  ok(ctxA.conflicting_claims.length === 1 && ctxA.conflicting_claims[0].paper_id === "arXiv:2604.26546",
     "(a) CONFLICTING = AUC -0.40 US/COVID (opposite sign)");
  // the d1 variance-share claim shares neither metric nor context with the result → related-only
  ok(!ctxA.supporting_claims.concat(ctxA.conflicting_claims).some(c => c.paper_id === "wp:namh-2026"),
     "(a) non-matching metric/context stays related-only");

  // (b) MOCK error / non-200 → unavailable, empty arrays, NO throw.
  __setBqQuery(async () => ({ ok: false, status: 404, error: "Not found: Dataset literature" }));
  let threw = false, ctxB;
  try { ctxB = await buildLiteratureContext({ text: "anything" }, result); } catch { threw = true; }
  ok(!threw, "(b) no throw on backend error");
  ok(ctxB.status === "unavailable", "(b) status unavailable");
  ok(ctxB.related_papers.length === 0 && ctxB.related_methods.length === 0 &&
     ctxB.supporting_claims.length === 0 && ctxB.conflicting_claims.length === 0, "(b) all arrays empty");
  // also a thrown seam (not just non-200) must still degrade
  __setBqQuery(async () => { throw new Error("network down"); });
  let threw2 = false, ctxB2;
  try { ctxB2 = await queryLiterature({ text: "x" }); } catch { threw2 = true; }
  ok(!threw2 && ctxB2.status === "unavailable" && ctxB2.papers.length === 0, "(b) thrown seam degrades to unavailable");

  // (c) NO-HALLUCINATION: every paper_id in the context exists in the mock input rows.
  __setBqQuery(async () => ({ ok: true, rows: MOCK_ROWS }));
  const ctxC = await buildLiteratureContext({ text: "systemic risk AUC" }, result);
  const outIds = [
    ...ctxC.related_papers.map(p => p.paper_id),
    ...ctxC.supporting_claims.map(c => c.paper_id),
    ...ctxC.conflicting_claims.map(c => c.paper_id),
  ];
  ok(outIds.length > 0 && outIds.every(id => idsIn.has(id)), "(c) every output paper_id ∈ mock rows (no hallucination)");

  // (d) /api/research injection helper: NO block when unavailable; block when ok+populated.
  __setBqQuery(async () => ({ ok: false, status: 403, error: "denied" }));
  const blockUnavail = literatureContextBlock(await buildLiteratureContext({ text: "q" }, result));
  ok(blockUnavail === "", "(d) injection block empty when unavailable");
  __setBqQuery(async () => ({ ok: true, rows: MOCK_ROWS }));
  const blockOk = literatureContextBlock(await buildLiteratureContext({ text: "q" }, result));
  ok(blockOk.includes("LITERATURE GRAPH CONTEXT") && blockOk.includes("arXiv:2507.08065"), "(d) injection block present + real id when ok");
  // empty-rows ok → still no block (empty context is acceptable, nothing to cite)
  __setBqQuery(async () => ({ ok: true, rows: [] }));
  ok(literatureContextBlock(await buildLiteratureContext({ text: "q" }, result)) === "", "(d) no block when ok-but-empty");

  __setBqQuery(null);   // restore real seam
  console.log(`\nselftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

if (process.argv.includes("--selftest")) {
  selftest().then((good) => process.exit(good ? 0 : 1)).catch((e) => { console.error(e); process.exit(1); });
} else {
  server.listen(PORT, HOST, () => {
    console.log(`✓ Compute Engine on http://${HOST}:${PORT}`);
    console.log(`  sandbox: ${HAVE_BWRAP ? "bwrap (net-isolated, ro-fs)" : "timeout fallback"}`);
    console.log(`  methods: ${Object.keys(METHODS).join(", ")}`);
    console.log(`  guards: cache(5m TTL) · rate-limit(run 20/min, chat 10/min) · /metrics`);
    console.log(`  dashboard: http://${HOST}:${PORT}/   ·   catalog: /api/compute/catalog`);
  });
}
