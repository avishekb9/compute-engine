# Phase 31 — robustness closure (Pathway C, completion stage 1)

Pre-registered grid designs for the remaining published-headline badges.
**This file is written BEFORE the grids run** (2026-06-11); results are appended
after, never edited into the designs. Mechanism, schema (`robustness.badges`,
17 fields) and the first two badges (KSG USA→Japan, SOCH-B) landed in
chronology #39 (2026-06-08). Badge thresholds throughout (the #39 convention):
**robust ≥ 0.90 · conditional ≥ 0.60 · else fragile** on `pass_rate`, with the
decomposition in `notes` where the aggregate is misleading.

All three grids re-run the **papers' own published code** (integrity bar: no
reimplementations are badged as the paper). All are sensitivity analyses of one
maintained claim each under nuisance variation — not discovery sweeps — so no
cross-config multiplicity correction, stated here explicitly (Stats-Prof
mandate: the null and the multiple-testing posture are declared up front).

## C-1 SOCH-A — scale ordering by adaptation speed (`r/soch_a_robustness.R`)

- **Claim**: pairs containing slower (emerging) markets peak at coarser wavelet
  scales — positive slope of peak scale on pair emerging-count
  (published: p = 0.042 at tau = .05, J = 5; arXiv:2606.04113).
- **Published code path**: `sochcontagion::soch_profiles` →
  `soch_test_ordering` (the paper's own test; OLS slope + t + p).
- **Null**: slope = 0 (no scale ordering by slowness).
- **Grid**: tau ∈ {.05, .10} × J ∈ {4, 5, 6} (6 configs; baseline in-grid).
  Markets: `market_groups$advanced ∪ emerging` present in the g20 panel.
- **Pass rule (pre-registered)**: slope > 0 AND p < 0.05 (the paper's own
  standard). Directional share (slope > 0 alone) reported in the emit.
- **Anchor**: tau = .05, J = 5 must reproduce a positive significant slope.

## C-2 NAMH Hurst — phi-ranking stability (`r/namh_hurst_robustness.R`)

- **Claim**: the cross-sectional ordering of NAMH node weights
  phi(H) = 1 − 2|H − .5| over the 24 g20_24 series is config-stable
  (the framework's deterministic GREEN surface; canonical config reproduces
  the cached panel bit-exact, max|Δ| 4.9e-9, chronology #45).
- **Published code path**: `namh::estimate_hurst_panel` (v0.1.0).
- **Grid**: window ∈ {126, 252, 504} × order ∈ {1, 2} × s_min ∈ {8, 10, 12},
  step = window (canonical non-overlapping convention), n_scales = 20 fixed;
  configs violating window ≥ 4·s_min dropped a priori.
- **Pass rule (pre-registered)**: Spearman(per-series mean phi, config vs
  canonical 252/1/10) ≥ 0.70. Canonical anchor (rho = 1) excluded from
  pass_rate.
- **Honest scope**: badges the Hurst/phi surface ONLY. The NAMH surrogate-FDR
  network stays an unbadged honest AMBER hole (0/552 edges under the paper's
  own BH-FDR gate) — recorded as `untested`, never badged around.

## C-3 Channel attribution — GFC Trade dominance (`r/channel_robustness.R`)

- **Claim**: Trade is the dominant GFC transmission channel
  (Table 5: 27.9%; arXiv:2604.26546).
- **Published code path**: `contagionchannels::run_contagion_pipeline`
  (two-stage WQTE detection + IV/2SLS; baseline reproduces Table 5 to
  0.000 pp).
- **Grid**: scale ∈ {4, 5, 6} × tau ∈ {.4, .5, .6} × edge_quantile ∈
  {.70, .75, .80} (27 configs; baseline 5/.5/.75 in-grid). Identification held
  at the paper's own: threshold_period = PreCrisis; all 8 episodes computed
  internally every run.
- **Pass rule (pre-registered)**: Dominant(GFC) == "Trade". The badge is about
  channel ORDERING; the Trade-share dispersion (min/median/max) is reported in
  the emit, not badged.

## Not badged (holes stay marked — invariant 3)

- **NAMH network (eigenvector hub etc.)** → `untested` (FDR-empty under the
  paper's own gate; PI decision D1 2026-06-09).
- **MCPFM SRI AUC 0.915/0.581** → MCPFM-pending hole (no engine reproduction
  exists; reproduce stays honest amber by PI decision 2026-06-06).
- **WaveQTE Stage-1 estimator** → structurally unavailable (engine `wqte` is an
  honest reimplementation; never badged as the paper).

## Execution

Tower async job-server (`server/job-server.mjs`, 127.0.0.1:3030, registry =
`r/*.R`), one job per grid; the badge rows are written to
`robustness.badges` by the trusted orchestrator AFTER the JSON emits are
inspected — never from inside the sandbox. `job_id`, `engine_rev` (tower),
`grid_spec`, `criterion`, and `computed_at` recorded per row.

## Results (appended after execution, 2026-06-11 — see chronology #47)

All three grids ran on the tower job-server (22-core worker, repo `ade7723`);
rows verified in `robustness.badges`.

### Amendment (documented, not silent): SOCH-A re-anchored

The C-1 grid as pre-registered (package `soch_profiles` on the engine g20
panel) **failed its own anchor condition** — tau=.05/J=5 gave p=.158, not the
published .042. Investigation traced it to the *universe*, not the estimator:
the paper's Test 1 runs on its 8-market design (ADV {USA, UK, Germany, Japan} ×
EMG {China, India, Brazil, SouthAfrica} = 56 ordered pairs,
`papers/SOCH/R/soch_empirics.R`), while the registered grid ran 306 pairs over
the full panel with the package's `market_groups`. The badge was therefore
re-anchored **through the paper's own scripts** (`soch_a_grid.R`, sourcing
`soch_empirics.R` verbatim); the package-path run is preserved as an auxiliary
broader-universe result. Both runs' JSON is retained
(`job_20260611_4757346d`, `paperpipe_20260611_soch_a_grid`).

### C-1 SOCH-A → **conditional** (pass_rate 4/6 = 0.667)

- **Anchor EXACT**: slope 0.583333 / t 2.0827 / p 0.042034 / mean k\*
  2.667/3.781/3.833 = published 0.583 / 2.08 / 0.042 / 2.67/3.78/3.83.
- Direction (slope > 0): **6/6**. Significance: J=5 and J=6 pass at both taus
  (4/4); J=4 misses (p .0612/.0653) — k\* truncated at 4 scales coarsens the
  regressor (resolution effect, not refutation).
- Auxiliary 306-pair full-panel grid: slope > 0 in 6/6 there too (p<.05 in
  3/6) — the ordering direction survives far outside the paper design.

### C-2 NAMH phi-ranking → **fragile** (pass_rate 2/17 = 0.118)

- Anchor: canonical config is the bit-exact published panel (#45; rho ≡ 1).
- Decomposition decisive: the canonical neighbourhood (window 252, order 1)
  passes 2/2 (s_min 8 → rho .936; s_min 12 → .941); window and order changes
  collapse the correlation (w126 .16–.57; w504 .32–.69; order-2 ≤ .69).
- Honest reading: under NAMH itself H is **time-varying**, so cross-window rank
  instability is partly the theory's own content; the registered aggregate rule
  still grades fragile and is reported as such. **PI may supersede with a
  decomposition-based conditional row (the #39 KSG precedent) — not
  self-authorised.**

### C-3 Channel GFC Trade-dominance → **fragile** (pass_rate 9/27 = 0.333)

- **Anchor EXACT**: baseline reproduces Table 5 (GFC Trade 27.9, dominant).
- The Trade **share** is highly stable: 25.7 / 27.6 / 28.7 (min/med/max) across
  all 27 configs — the magnitude is robust.
- The strict dominance **label** is knife-edge: GFC's top three channels sit
  within ~1 pp (Trade 27.9 / Monetary 27.2 / Geopolitical 27.0), flipping to
  Geopolitical in 18/27 off-spec configs. Magnitude-robust, ordering-fragile.

### Holes written as visible `untested` rows

`namh_network_fdr` (FDR-empty by the paper's own gate, PI D1) ·
`mcpfm_sri_auc` (no engine reproduction exists) · `waveqte_stage1`
(structurally unavailable). The badge table now carries the holes in public,
not just the docs.

### Process note (K3)

A pre-registered anchor that FAILS is the system working: the package-path
p=.158 was caught *because* the anchor was registered, and the amendment is
documented instead of silently re-run. Second lesson: a published headline's
config (universe, sample filter) is part of the claim's identity — robustness
grids must anchor through the paper's own scripts, not a same-named
re-implementation path.
