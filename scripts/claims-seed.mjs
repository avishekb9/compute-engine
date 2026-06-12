#!/usr/bin/env node
// claims-seed.mjs — Phase 34 (V4 M3): seed BigQuery `epistemic.claims` from
// VERIFIED ground truth ONLY. Every row carries provenance_ids; nothing here is
// invented — each statement traces to a chronology entry (ivy-fineco
// ARCHITECTURE.md §C4), a badge row (robustness.badges), a tower job id, a file
// anchor, or a Lean build. Honest ambers/holes are seeded AS claims about the
// space's own gaps (invariant 3). The WaveQTE GFC divergence carries its full
// lifecycle: contested 2026-06-09→12, then SUPERSEDED by the documented V4-M4
// disposition (docs/WAVEQTE_FLAG_DISPOSITION.md) — revision history is part of
// the knowledge, so the superseded row ships, never deleted.
//
// usage:
//   node scripts/claims-seed.mjs --selftest   # schema/provenance validation, no network
//   node scripts/claims-seed.mjs --dry        # print bq DDL + the INSERT SQL, run nothing
//   node scripts/claims-seed.mjs --apply      # bq mk dataset+table, then DML INSERT
//
// Writes use a DML INSERT query job (bq query), NEVER tabledata.insertAll:
// streaming-buffer rows cannot be DML-updated/deleted for ~30-90 min (hard-won,
// CLAUDE.md §4) and the nightly refresher + the contested-path exercise need
// immediate UPDATE/DELETE. Timestamps are date-precision by convention (00:00Z).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PROJECT = process.env.BQ_PROJECT || "hopeful-flash-485308-v3";
const DS = "epistemic", TBL = "claims";
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(__dirname, "..", "epistemic", "schema.json");

const D = (s) => s + "T00:00:00Z";   // date-precision convention

export const CLAIMS = [
  {
    claim_id: "soch_a_ordering", type: "empirical", status: "established",
    statement: "SOCH-A (ordering): the directed tail-spillover profile peaks at a coarser wavelet scale when the slower market is involved; published p=0.042, re-anchored EXACTLY through the paper's own 56-pair design (slope 0.583333, t 2.082655, p 0.042034). The package-default universe gives p=0.158 — the anchor must run the paper's own estimation universe.",
    established_at: D("2026-06-03"), last_verified: D("2026-06-11"), confidence: 0.667,
    conditions: ["badge: conditional, pass_rate 0.667 over 6 pre-registered grid configs", "anchor: 56-pair design, slope/t/p = 0.583333/2.082655/0.042034 exact"],
    counter_conditions: ["package-default estimation universe (not the paper's design) yields p=0.158 — universe choice matters"],
    provenance_ids: ["badge:robustness.badges/soch_a", "doc:compute-engine/docs/PHASE31_CLOSURE.md", "chronology:#47", "method:soch_profile"],
    paper_refs: ["arXiv:2606.04113"],
  },
  {
    claim_id: "soch_b_shape_symmetry", type: "empirical", status: "established",
    statement: "SOCH-B (shape symmetry): the spillover profile's SHAPE is direction-symmetric even when its level is not — 28/28 advanced-market pairs hold at the baseline (tau=0.05, J=4), reproduced exactly; robustness badge ROBUST with pass_rate 0.991 (111/112 config-pair tests) over the tau{0.05,0.10} x J{4,5} grid.",
    established_at: D("2026-06-03"), last_verified: D("2026-06-11"), confidence: 0.991,
    conditions: ["grid: tau in {0.05, 0.10} x J in {4, 5}, 28 pairs, B=200 block-bootstrap", "baseline tau=0.05, J=4 reproduces the immutable 28/28 exactly"],
    counter_conditions: [],
    provenance_ids: ["badge:robustness.badges/soch_b", "method:soch_robustness", "chronology:#39", "chronology:#47"],
    paper_refs: ["arXiv:2606.04113"],
  },
  {
    claim_id: "soch_c_not_significant", type: "empirical", status: "established",
    statement: "SOCH-C (level asymmetry): p=0.105 — NOT statistically significant. Reported honestly as a non-finding, always (immutable honesty fact; the claim that IS established is the non-significance itself).",
    established_at: D("2026-06-03"), last_verified: D("2026-06-12"), confidence: null,
    conditions: ["immutable: never reported as significant under any framing"],
    counter_conditions: [],
    provenance_ids: ["chronology:#13", "page:reproduce.html (SOCH-C row)", "doc:compute-engine/STATE.md (immutables)"],
    paper_refs: ["arXiv:2606.04113"],
  },
  {
    claim_id: "ksg_usa_japan_te", type: "empirical", status: "established",
    statement: "Full-sample lag-1 KSG transfer entropy USA->Japan = 0.1542 (18-market g20 panel, 306 directed pairs, 108 significant at p<0.05, 99 IAAFT surrogates); the robustness-grid baseline reproduces it exactly, and USA->Japan is rank-1 across all 8 (k,lag) base-grid points. Aggregate badge 0.528 over the 180-point wide grid (PI-superseded fragile->conditional with documented reason): robust in the published configuration's own neighbourhood.",
    established_at: D("2026-06-05"), last_verified: D("2026-06-12"), confidence: 0.528,
    conditions: ["by embedding: e1 (the published lag-1) pass 0.97", "by window: w504 (full-ish sample) pass 0.92", "baseline anchor: full-sample lag-1 TE 0.1542 exact"],
    counter_conditions: ["short windows (126/252) and high embeddings (3/6/9) the paper never claimed weaken rank stability (e6/e9 pass 0.33)"],
    provenance_ids: ["job:job_20260608_8c295764", "job:job_20260608_1c4f8771", "badge:robustness.badges/ksg_te", "chronology:#28", "chronology:#39", "chronology:#47", "eval:evals.json/ksg_te"],
    paper_refs: [],
  },
  {
    claim_id: "ksg_te_paper_null", type: "methodological", status: "established",
    statement: "The engine's ksg_te carries paper=null deliberately: the KSG/Frenzel-Pompe estimator is NOT the MCPFM paper's binned-TE estimator, so no paper attribution is made (citation/count integrity). Only wqte and soch_profile carry the SOCH arXiv id.",
    established_at: D("2026-06-05"), last_verified: D("2026-06-12"), confidence: null,
    conditions: [],
    counter_conditions: [],
    provenance_ids: ["chronology:#24", "catalog:/api/compute/catalog (ksg_te.paper)"],
    paper_refs: [],
  },
  {
    claim_id: "namh_hurst_machine_exact", type: "empirical", status: "established",
    statement: "The NAMH rolling Hurst panel (24 g20_24 series x 20 non-overlapping windows, DFA-1) reproduces the published panel machine-exactly THROUGH THE PAPER'S OWN PACKAGE at the canonical config window=252, step=252, order=1, s_min=10, n_scales=20: live engine max|Delta| = 4.882e-9 (cross-BLAS); same-machine 5.0e-16 over 440 finite cells. The package DEFAULT step=21 gives ~231 overlapping windows and does NOT reproduce the paper — config is part of the claim.",
    established_at: D("2026-06-09"), last_verified: D("2026-06-12"), confidence: null,
    conditions: ["canonical config: window=252, step=252, order=1, s_min=10, n_scales=20 (non-overlapping yearly blocks)", "measured, never assumed: the honest Delta is whatever namh_reproduce returns"],
    counter_conditions: ["package default step=21 -> ~231 overlapping windows, NOT the paper's 20"],
    provenance_ids: ["method:namh_hurst", "method:namh_reproduce", "file:papers/namh/output/diagnostics/01_hurst_panel.csv", "chronology:#44", "chronology:#46"],
    paper_refs: ["pkg:namh v0.1.0 (Bhandari & Sahu 2026, GPL-3)"],
  },
  {
    claim_id: "namh_te_window_panel", type: "empirical", status: "established",
    statement: "NAMH raw per-window KSG transfer entropy (namh::te_matrix, deterministic — no surrogates) reproduces the cached 03_te_summary.csv te_mean/te_sd across ALL 20 windows to max|Delta| = 4.92e-9; window-1 mean -0.223222 re-anchored at |Delta| = 6.6e-10 (AHRC submission day).",
    established_at: D("2026-06-09"), last_verified: D("2026-06-12"), confidence: null,
    conditions: ["raw TE only: effective-TE / p-values are surrogate-dependent and live in namh_pipeline (seeded)"],
    counter_conditions: [],
    provenance_ids: ["method:namh_te", "file:papers/namh/output/diagnostics/03_te_summary.csv", "chronology:#45", "chronology:#48"],
    paper_refs: ["pkg:namh v0.1.0 (Bhandari & Sahu 2026, GPL-3)"],
  },
  {
    claim_id: "namh_network_fdr_empty", type: "empirical", status: "established",
    statement: "Under the NAMH paper's OWN BH-FDR (q<0.05) gate the surrogate network is EMPTY: 0 of 552 directed edges retained in every one of the 20 windows — so eigenvector/Katz/PageRank centralities are degenerate by construction, and the engine reports the network honestly AMBER (PI decision D1: FDR-only gate; the published magnitude-gated headlines use a separate gate the pipeline does not expose). Confirmed end-to-end by the seeded canonical pipeline run (B=200, seed 42): FDR 0/552, p-value median 0.4925, 27/552 raw p<0.05 pre-correction.",
    established_at: D("2026-06-09"), last_verified: D("2026-06-12"), confidence: null,
    conditions: ["gate: Benjamini-Hochberg FDR q<0.05, the paper's own stated gate", "canonical seeded run: namh_pipeline B=200, RNG L'Ecuyer-CMRG seed 42"],
    counter_conditions: ["the paper's magnitude (70th-pct) gate — a different, unexposed gate — yields the published non-empty network headlines"],
    provenance_ids: ["file:papers/namh/output/diagnostics/04_fdr_retention.csv", "job:job_20260612_0f2f0fd5", "chronology:#43", "chronology:#44", "decision:PI-D1-FDR-only"],
    paper_refs: ["pkg:namh v0.1.0 (Bhandari & Sahu 2026, GPL-3)"],
  },
  {
    claim_id: "namh_phi_badge", type: "robustness", status: "established",
    statement: "NAMH node-weight phi(H)=1-2|H-0.5| robustness: aggregate FRAGILE with pass_rate 0.118 over the 18-config grid, BUT the canonical-neighbourhood decomposition passes 0.936/0.941 — the aggregate is a grid-coverage artefact to be read with its decomposition, not a refutation of the canonical configuration.",
    established_at: D("2026-06-11"), last_verified: D("2026-06-11"), confidence: 0.118,
    conditions: ["canonical neighbourhood: pass 0.936/0.941", "fragile aggregate != refutation; badges are read with their decompositions (invariant)"],
    counter_conditions: ["far-from-canonical grid corners drive the 0.118 aggregate"],
    provenance_ids: ["badge:robustness.badges/namh_phi", "chronology:#47"],
    paper_refs: ["pkg:namh v0.1.0 (Bhandari & Sahu 2026, GPL-3)"],
  },
  {
    claim_id: "channel_table5_exact", type: "empirical", status: "established",
    statement: "Contagion-channel attribution reproduces the published Table 5 channel shares to 0.000pp across ALL 8 crisis sub-periods, live, via the published contagionchannels package (the paper's own code) running in the sandboxed engine.",
    established_at: D("2026-06-05"), last_verified: D("2026-06-12"), confidence: null,
    conditions: ["the engine runs the published package run_contagion_pipeline, not a reimplementation"],
    counter_conditions: [],
    provenance_ids: ["method:channel_attribution", "chronology:#27", "eval:evals.json/channel_attribution", "page:reproduce.html (contagion-channels card)"],
    paper_refs: ["arXiv:2604.26546", "pkg:contagionchannels v0.1.3 (CRAN)"],
  },
  {
    claim_id: "channel_label_knife_edge", type: "robustness", status: "established",
    statement: "Channel-attribution robustness: badge FRAGILE with aggregate pass_rate 0.333 over 27 configs — but the decomposition shows the GFC Trade SHARE is rock-stable (25.7-28.7pp across every config); what flips is the dominant-channel LABEL (Trade vs Financial near-equal, a knife-edge). The share is robust; the label is not.",
    established_at: D("2026-06-11"), last_verified: D("2026-06-11"), confidence: 0.333,
    conditions: ["GFC Trade share stable: 25.7-28.7pp across all 27 configs"],
    counter_conditions: ["dominant-channel LABEL flips between Trade and Financial (near-equal shares)"],
    provenance_ids: ["badge:robustness.badges/channel_attribution", "chronology:#47"],
    paper_refs: ["arXiv:2604.26546"],
  },
  {
    claim_id: "waveqte_estimator_hole", type: "hole", status: "established",
    statement: "The WaveQTE Stage-1 estimator is STRUCTURALLY UNAVAILABLE through the engine: the packaged estimator does not load in the engine R install, and the engine's wqte is a transparent MODWT+quantreg substrate reimplementation — honestly labelled, never presented as the published estimator. A marked hole, not filled.",
    established_at: D("2026-06-09"), last_verified: D("2026-06-10"), confidence: null,
    conditions: [],
    counter_conditions: [],
    provenance_ids: ["chronology:#41", "chronology:#46", "method:wqte (labelled reimplementation)"],
    paper_refs: ["arXiv:2604.26546"],
  },
  {
    claim_id: "waveqte_gfc_channel_split", type: "empirical", status: "superseded",
    statement: "SUPERSEDED (was contested 2026-06-09 to 2026-06-12): the waveqte/ working paper (2026-02-19) reports the FINANCIAL channel dominant in the GFC at 50.0%, while the engine's verified ground truth (published contagionchannels package, Table-5-exact to 0.000pp) gives TRADE dominant at 27.9%. Originally flagged as a proxy-vintage disagreement. RESOLVED by the V4-M4 investigation: not proxy vintage — different estimands from different methods on different partitions (activation-scoring intensity, 7 episodes vs structural IV/2SLS shares, 8 sub-periods). See waveqte_gfc_split_resolved.",
    established_at: D("2026-06-09"), last_verified: D("2026-06-12"), confidence: null,
    conditions: ["engine side: Trade-GFC 27.9% via the published CRAN package, Table 5 reproduced 0.000pp"],
    counter_conditions: ["manuscript side: Financial-GFC 50.0% (papers/waveqte/contagion_manuscript.pdf, 2026-02-19 vintage)"],
    provenance_ids: ["file:papers/waveqte/contagion_manuscript.pdf", "method:channel_attribution", "chronology:#41", "chronology:#46", "doc:compute-engine/docs/WAVEQTE_FLAG_DISPOSITION.md", "superseded_by:waveqte_gfc_split_resolved"],
    paper_refs: ["arXiv:2604.26546"],
  },
  {
    claim_id: "waveqte_gfc_split_resolved", type: "methodological", status: "established",
    statement: "The 50.0%-vs-27.9% GFC channel divergence is RESOLVED as a method + partition divergence, not a contradiction and not proxy vintage: the Feb-2026 working paper measures proxy-ACTIVATION INTENSITY (descriptive; loads on VIX/HY-OAS, mechanically Financial-heavy in a financial crisis) over 7 episodes, while the published arXiv paper estimates STRUCTURAL channel shares under IV/2SLS over 8 sub-periods (GFC* = Aug-2007 to Jun-2009) and ITSELF discloses that the GFC dominant-channel label is identification-dependent. Canonical = arXiv:2604.26546 (newer, submitted, CRAN-implemented, engine-reproduced 0.000pp, bootstrap CIs [26.1, 29.8]); the engine's independent Phase-31 badge corroborates: Trade SHARE rock-stable 25.7-28.7pp, dominant LABEL knife-edge. The 50.0% is reclassified (different estimand), not refuted; nothing averaged or blended.",
    established_at: D("2026-06-12"), last_verified: D("2026-06-12"), confidence: null,
    conditions: ["canonical: arXiv:2604.26546 GFC* Trade 27.9% under primary IV/2SLS, read WITH its method-dependence disclosure", "PI may supersede this disposition with a documented reason"],
    counter_conditions: ["heteroskedasticity-based identification assigns the GFC label to Behavioural (per the paper's own robustness section; also the older paper3.pdf draft vintage)"],
    provenance_ids: ["doc:compute-engine/docs/WAVEQTE_FLAG_DISPOSITION.md", "file:papers/contagion-channels/manuscripts/paper3_v2/arxiv_submission/main.tex", "file:papers/waveqte/contagion_manuscript.pdf", "badge:robustness.badges/channel_attribution", "chronology:#47"],
    paper_refs: ["arXiv:2604.26546"],
  },
  {
    claim_id: "mcpfm_sri_pending", type: "hole", status: "established",
    statement: "MCPFM published SRI: AUC 0.915 (ten major U.S. equities, 2010-2024, COVID-19 crash as natural experiment; 1-day lead) and 0.581 (India, DeLong p=0.030). Live reproduction is HONEST-PENDING: the SRI price inputs were since overwritten on disk and the sandbox forbids the re-download — shown published-only, never re-scored as if live (PI decision 2026-06-06).",
    established_at: D("2026-06-05"), last_verified: D("2026-06-12"), confidence: null,
    conditions: ["published values shown AS published; the pending state is itself the verified fact"],
    counter_conditions: [],
    provenance_ids: ["chronology:#26", "page:reproduce.html (MCPFM card)", "decision:PI-2026-06-06-keep-pending"],
    paper_refs: ["arXiv:2507.08065"],
  },
  {
    claim_id: "sri_index_not_mcpfm_sri", type: "methodological", status: "established",
    statement: "The live nightly SRI connectivity index (mean KSG TE over a 250-day rolling window) is NOT the validated MCPFM Systemic Risk Index: no AUC, lead-time, or early-warning claim transfers from the MCPFM paper to the live index. They share a name, not a validation.",
    established_at: D("2026-06-07"), last_verified: D("2026-06-12"), confidence: null,
    conditions: ["the observatory page carries this distinction in an explicit honesty block"],
    counter_conditions: [],
    provenance_ids: ["chronology:#35", "page:observatory.html (honesty block)", "eval:evals/os-p2 (23/23 incl. honesty-block check)"],
    paper_refs: ["arXiv:2507.08065"],
  },
  {
    claim_id: "te_log_returns_stationarity", type: "methodological", status: "established",
    statement: "All transfer-entropy and spillover operators in the space act on LOG-RETURNS (I(0)), never on price levels (I(1)). Levels-based TE is outside the space; the stationarity facts are measured (e.g. India ADF -49.18, UK -52.64 on returns).",
    established_at: D("2026-06-01"), last_verified: D("2026-06-12"), confidence: null,
    conditions: ["ADF on returns: India -49.18, UK -52.64 (immutable measured anchors)"],
    counter_conditions: [],
    provenance_ids: ["chronology:#3", "doc:compute-engine/STATE.md (immutables)", "eval:evals.json/unit_root"],
    paper_refs: [],
  },
  {
    claim_id: "panel_tuple_named", type: "methodological", status: "established",
    statement: "The documented panel-unit-root tuple IPS -77.26 / LLC -51.79 belongs to the NAMED panel {India, USA, UK, China, Japan} (-77.25938898 / -51.79333005 live, uncached); an unnamed '5-market' tuple is not a reproducible claim — a different fifth market (Brazil) gives -80.16 / -58.19. Documented tuples must name their full parameterisation.",
    established_at: D("2026-06-11"), last_verified: D("2026-06-12"), confidence: null,
    conditions: ["panel: {India, USA, UK, China, Japan} exactly"],
    counter_conditions: ["Brazil as fifth market: -80.16 / -58.19 (different claim)"],
    provenance_ids: ["chronology:#47", "eval:evals.json/panel_unit_root", "lesson:STATE.md/L5"],
    paper_refs: [],
  },
  {
    claim_id: "soch_spectrum_formally_closed", type: "formal", status: "established",
    statement: "SOCH prop:spectrum is FORMALLY CLOSED in Lean 4 (mathlib v4.30.0): the squared modulus of the cascade transfer function equals the product-Lorentzian spectrum, ||H(omega)||^2 = S(omega), machine-checked unconditionally. The lem:peak STATIONARY-POINT half is fully Lean-accepted: FOC <-> 3x^2+(a_s^2+a_r^2)x-a_s^2a_r^2=0 in x=omega^2; symmetric peak omega*=alpha/sqrt(3); and EXACTLY ONE positive FOC frequency exists (Q strictly monotone on [0,inf)), lying in [alpha_min/sqrt(3), alpha_min]. What remains STATED, NOT proved is the analytic half (the maximiser of omega*S exists and satisfies the FOC) — honest sorry-count 1 of 12 declarations. A sorry is never reported as a proof.",
    established_at: D("2026-06-12"), last_verified: D("2026-06-12"), confidence: null,
    conditions: ["CI check: lake build green (8478 jobs) with exactly the 1 declared sorry", "page<->source lockstep: reproduce-page eval greps Spectrum.lean and fails on drift"],
    counter_conditions: ["lem:peak analytic half (maximiser existence + stationarity): stated only — the continuing research line"],
    provenance_ids: ["lean:ivy-fineco/papers/SOCH/lean4/sochlean/Sochlean/Spectrum.lean", "page:reproduce.html#sochformal", "chronology:#49", "eval:evals/reproduce-page.test.mjs (21/21)"],
    paper_refs: ["arXiv:2606.04113"],
  },
  {
    claim_id: "namh_pipeline_seeded_deterministic", type: "methodological", status: "established",
    statement: "The NAMH surrogate pipeline is reproducible END-TO-END for a fixed {seed, n_cores}: the engine pins RNGkind L'Ecuyer-CMRG with set.seed (the published package leaves IAAFT unseeded), verified by discriminating runs — seed 42 twice gives identical p-values (median 0.5), seed 7 differs (0.667). Canonical run: B=200, seed 42, te_raw window-1 mean -0.22322165 inside the pre-registered band [-0.2242, -0.2222], FDR 0/552.",
    established_at: D("2026-06-12"), last_verified: D("2026-06-12"), confidence: null,
    conditions: ["reproducibility is conditional on {seed, n_cores} — parallel streams change with worker count", "p-values are the RNG discriminator (te_raw is surrogate-free)"],
    counter_conditions: ["the unseeded published package path is NOT run-to-run reproducible for p-values"],
    provenance_ids: ["method:namh_pipeline", "job:job_20260612_0f2f0fd5", "file:compute-engine/r/namh_pipeline.R"],
    paper_refs: ["pkg:namh v0.1.0 (Bhandari & Sahu 2026, GPL-3)"],
  },
];

// ---------- SQL generation ----------
const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const sStr = (s) => (s == null ? "NULL" : `"${esc(s)}"`);
const sNum = (x) => (x == null ? "CAST(NULL AS FLOAT64)" : String(x));
const sTs = (s) => (s == null ? "CAST(NULL AS TIMESTAMP)" : `TIMESTAMP("${esc(s)}")`);
const sArr = (a) => `[${(a || []).map(sStr).join(", ")}]`;

export function buildInsertSQL(rows, project = PROJECT) {
  const tbl = `\`${project}.${DS}.${TBL}\``;
  const cols = "(claim_id, type, statement, established_at, last_verified, confidence, conditions, counter_conditions, provenance_ids, paper_refs, status)";
  const vals = rows.map((c) =>
    `(${sStr(c.claim_id)}, ${sStr(c.type)}, ${sStr(c.statement)}, ${sTs(c.established_at)}, ${sTs(c.last_verified)}, ${sNum(c.confidence)}, ${sArr(c.conditions)}, ${sArr(c.counter_conditions)}, ${sArr(c.provenance_ids)}, ${sArr(c.paper_refs)}, ${sStr(c.status)})`
  ).join(",\n");
  return `INSERT INTO ${tbl} ${cols} VALUES\n${vals}`;
}

// ---------- selftest (no network) ----------
function selftest() {
  let pass = 0, fail = 0;
  const ok = (c, n) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}`); c ? pass++ : fail++; };
  const TYPES = ["empirical", "methodological", "formal", "robustness", "hole"];
  const STATUSES = ["established", "contested", "superseded"];
  ok(CLAIMS.length >= 15, `>= 15 seeded claims (have ${CLAIMS.length})`);
  ok(new Set(CLAIMS.map(c => c.claim_id)).size === CLAIMS.length, "claim_id unique");
  ok(CLAIMS.every(c => /^[a-z0-9_]{3,64}$/.test(c.claim_id)), "claim_id snake_case");
  ok(CLAIMS.every(c => TYPES.includes(c.type)), "type in enum");
  ok(CLAIMS.every(c => STATUSES.includes(c.status)), "status in enum");
  ok(CLAIMS.every(c => (c.provenance_ids || []).length >= 1), "EVERY claim provenanced (no provenance = no claim)");
  ok(CLAIMS.every(c => c.statement && c.statement.length > 40 && !/\n/.test(c.statement)), "statements single-line, substantive");
  ok(CLAIMS.every(c => /^\d{4}-\d{2}-\d{2}T00:00:00Z$/.test(c.established_at)), "established_at date-precision convention");
  ok(CLAIMS.filter(c => ["contested", "superseded"].includes(c.status)).every(c => (c.counter_conditions || []).length >= 1), "contested/superseded claims carry both sides");
  ok(CLAIMS.some(c => c.claim_id === "waveqte_gfc_channel_split" && c.status === "superseded" && c.provenance_ids.some(p => p.startsWith("superseded_by:"))), "the WaveQTE divergence carries its full lifecycle (contested -> superseded, linked)");
  ok(CLAIMS.some(c => c.claim_id === "waveqte_gfc_split_resolved" && c.status === "established" && c.provenance_ids.some(p => /WAVEQTE_FLAG_DISPOSITION/.test(p))), "the resolution claim traces to the written disposition");
  ok(CLAIMS.some(c => c.type === "hole"), "holes are seeded as claims about the space's gaps");
  ok(CLAIMS.some(c => c.type === "formal"), "the Lean formal layer is a claim");
  ok(CLAIMS.every(c => c.confidence == null || (c.confidence > 0 && c.confidence <= 1)), "confidence is a pass_rate or NULL, never invented");
  const sql = buildInsertSQL(CLAIMS);
  ok(sql.includes("INSERT INTO") && (sql.match(/\(/g) || []).length > CLAIMS.length, "INSERT SQL builds");
  ok(!/'(?:[^'])*'/.test(sql.replace(/"[^"]*"/g, "")), "no stray single-quote literals outside strings");
  console.log(`\n${pass}/${pass + fail} claims-seed selftests passed`);
  process.exit(fail ? 1 : 0);
}

// ---------- bq runner ----------
function runBq(args, stdin) {
  const r = spawnSync("bq", args, { input: stdin, encoding: "utf8", timeout: 120000 });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

function apply() {
  console.log(`[1/3] bq mk dataset ${PROJECT}:${DS} (US)`);
  const mk1 = runBq(["mk", "--dataset", "--location=US", `${PROJECT}:${DS}`]);
  if (mk1.code !== 0 && !/already exists/i.test(mk1.out)) { console.error(mk1.out); process.exit(1); }
  console.log(/already exists/i.test(mk1.out) ? "      exists (ok)" : "      created");
  console.log(`[2/3] bq mk table ${PROJECT}:${DS}.${TBL}`);
  const mk2 = runBq(["mk", "--table", `${PROJECT}:${DS}.${TBL}`, SCHEMA]);
  if (mk2.code !== 0 && !/already exists/i.test(mk2.out)) { console.error(mk2.out); process.exit(1); }
  console.log(/already exists/i.test(mk2.out) ? "      exists (ok)" : "      created");
  console.log(`[3/3] DML INSERT ${CLAIMS.length} claims (query job, not streaming)`);
  const q = runBq(["query", "--use_legacy_sql=false", "--format=none", buildInsertSQL(CLAIMS)]);
  if (q.code !== 0) { console.error(q.out); process.exit(1); }
  console.log("      inserted. Verify: bq query --use_legacy_sql=false 'SELECT status, COUNT(*) n FROM `" + PROJECT + "." + DS + "." + TBL + "` GROUP BY status'");
}

// CLI dispatch only when run directly — claims-refresh.mjs imports CLAIMS from
// this module and must not trigger the seeder's modes (caught by selftest).
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2] || "--dry";
  if (mode === "--selftest") selftest();
  else if (mode === "--dry") {
    console.log(`-- bq mk --dataset --location=US ${PROJECT}:${DS}`);
    console.log(`-- bq mk --table ${PROJECT}:${DS}.${TBL} ${SCHEMA}`);
    console.log(buildInsertSQL(CLAIMS));
  } else if (mode === "--apply") apply();
  else { console.error("usage: claims-seed.mjs --selftest | --dry | --apply"); process.exit(2); }
}
