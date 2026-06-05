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
};

const DATASETS = {
  g20: { label: "G20 equity daily log-returns (18 markets, 2006–2026)", n: 5036,
         series: ["Argentina","Australia","Brazil","Canada","China","France","Germany","India","Indonesia","Italy","Japan","Mexico","Russia","SouthAfrica","SouthKorea","Turkey","UK","USA"] },
};

// ── param validation (no arbitrary keys pass through) ──────────────────────────
function validate(methodId, params) {
  const m = METHODS[methodId];
  if (!m) throw new Error(`unknown method '${methodId}'`);
  const ds = params.dataset || "g20";
  if (!DATASETS[ds]) throw new Error(`unknown dataset '${ds}'`);
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
  return {
    method,
    method_version: (spec && spec.version) || null,
    engine_version: ENGINE_VERSION,
    engine_revision: process.env.K_REVISION || "local",
    params: clean,
    data_vintage: spec && spec.fetch
      ? "live fetch: " + (clean.symbol || "?") + " (" + (clean.source || "yahoo") + ")"
      : (DATASETS[ds] ? DATASETS[ds].label : ds),
    timestamp: new Date().toISOString(),
    permalink: permalink(method, clean),
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
async function buildArgsJson(method, clean) {
  if (!method.fetch) return JSON.stringify(clean);
  const { series, resolved, source } = await fetchSeries(clean.symbol, clean.source);
  return JSON.stringify({ ...clean, levels: series, symbol: resolved, source });
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
  const ctxPrefix = userContext && String(userContext).trim() ? `Context from the researcher: ${userContext}\n\n` : "";
  const analyses = [];

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
    return send(200, "application/json", JSON.stringify({ ok: true, sandbox: HAVE_BWRAP ? "bwrap" : "timeout", methods: Object.keys(METHODS).length, timeout_s: JOB_TIMEOUT_S }));

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

  // ── public job permalink: GET /api/jobs/:id → mirrored GCS record (read-only) ──
  const jm = u.pathname.match(/^\/api\/jobs\/([A-Za-z0-9_-]{1,128})$/);
  if (jm && req.method === "GET") {
    const { status, body } = await fetchJobRecord(jm[1]);
    if (status === 200 && body) return send(200, "application/json", body);
    if (status === 404) return send(404, "application/json", JSON.stringify({ error: "unknown or expired job" }));
    return send(status === 0 ? 502 : status, "application/json", JSON.stringify({ error: "job lookup failed" }));
  }

  // static dashboard
  let p = u.pathname === "/" ? "/index.html" : u.pathname;
  const fp = join(WEB_DIR, p.replace(/\.\.+/g, ""));
  if (existsSync(fp) && fp.startsWith(WEB_DIR)) return send(200, MIME[extname(fp)] || "application/octet-stream", readFileSync(fp));
  send(404, "text/plain", "not found");
});

// periodic cleanup of expired cache + rate-limit buckets (unref'd: won't hold process open)
setInterval(sweep, 60 * 1000).unref();

// slowloris guard: a slow request body cannot hold a connection (and a concurrency
// slot) indefinitely — cap total request + header time.
server.requestTimeout = 30000;
server.headersTimeout = 15000;

server.listen(PORT, HOST, () => {
  console.log(`✓ Compute Engine on http://${HOST}:${PORT}`);
  console.log(`  sandbox: ${HAVE_BWRAP ? "bwrap (net-isolated, ro-fs)" : "timeout fallback"}`);
  console.log(`  methods: ${Object.keys(METHODS).join(", ")}`);
  console.log(`  guards: cache(5m TTL) · rate-limit(run 20/min, chat 10/min) · /metrics`);
  console.log(`  dashboard: http://${HOST}:${PORT}/   ·   catalog: /api/compute/catalog`);
});
