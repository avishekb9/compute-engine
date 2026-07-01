#!/usr/bin/env node
// v5-control.test.mjs -- reproduction gate for the ECONSTELLAR v5 Bellman control-
// operator layer (FRONTIERS V.2 Recursive Control). Runs each of the four control
// runners over the shipped M3-faithful calibrated plant fixture and asserts every
// reported quantity reproduces its V.2 results.json golden value. Same idiom as
// golden.test.mjs / namh-calibration.test.mjs: PASS/FAIL per check, exit 1 on any
// violation. A violation means the engine disagrees with the published sim -- STOP
// and investigate; it is NEVER to be "fixed" by widening a tolerance.
//
// Tolerance tiers (honest, by construction -- NOT chosen to make checks pass):
//   GREEN  1e-9  : linear-algebra + closed-form analytic quantities. The control
//                  layer serialises at 12 dp (r/_control_core.R::ce_emit_hp) so the
//                  live API genuinely carries this fidelity; the underlying algebra
//                  matches the python sim to ~1e-13.
//   GRID   1e-6  : the two deterministic grid-scan threshold crossings (numeric
//                  bifurcation onset, first chaotic gain). Reproducible to ~1e-12
//                  here, but a threshold crossing on a finite-difference Lyapunov sum
//                  is a per-grid-cell quantity, so 1e-6 is the honest bar.
//   SENSITIVE    : the deep-chaotic-band largest Lyapunov MAGNITUDE is not bit-
//                  reproducible across float implementations (sensitive dependence
//                  is the diagnosed property). We assert its SIGN (positive) and a
//                  ballpark band only -- exactly as the manuscript reports it.
//
// Run: node test/v5-control.test.mjs   (needs R + jsonlite + the fixture)

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = join(__dirname, "..");
const R_DIR = join(ENGINE_DIR, "r");
const FIXTURE = join(R_DIR, "fixtures", "v5_control_plant.json");

if (!existsSync(FIXTURE)) { console.log(`SKIP v5-control: fixture not found at ${FIXTURE}`); process.exit(0); }

const TOL_GREEN = 1e-9;   // linear-algebra + analytic anchors
const TOL_GRID  = 1e-6;   // deterministic grid-scan threshold crossings

// Golden anchors -- transcribed from papers/frontiers-v/V2-recursive-control/sim/
// results.json (which is NOT pure JSON: it stores J_open as Infinity). Full float64
// precision so the 1e-9 GREEN bar is meaningful.
const GOLD = {
  lq: {
    drift: 2.475, rB_stress: 1.1931498522336008, rho_open: 1.2065287737561374,
    beta_rho2_open: 1.3829260978064142, trace_P: 28.331049939023377,
    F_norm2: 0.782771114446585, rho_closed: 0.42375765930954945,
    ce_residual: 0.0, d_C1: 538.2899488414437, d_C2: 592.5940272383698,
    J_optimal: 540.2343847142893, J_threshold: 723.5280283031205,
    rho_threshold: 0.8900894077994234, eta_safe: 0.6794646420148936,
  },
  vi: { iters: 406, contraction_ratio: 0.9500000001744155, policy_rest_eta: 0.9675 },
  tp: {
    eta_bar: 0.9675, trace_min: 26.701957007884552, v1: 0.967181,
    ell_pp: 2.4830253398279103, jac_lo: -0.014985367870864894, jac_hi: 0.06627866225841546,
  },
  fb: {
    barrier: 1.25, sigma_bar: 0.4602554031360735, beta_cascade_rB_stress: 0.9545198817868807,
    g_onset_analytic: 2.7454134082347847, g_onset_numeric: 2.7505613288090074,
    g_chaos: 3.5831636769890314,
  },
};

function run(script) {
  const r = spawnSync("Rscript", [join(R_DIR, script), "{}"], { encoding: "utf8", timeout: 120000 });
  if (r.status !== 0) { console.log(`FAIL  ${script} exit ${r.status}: ${(r.stderr || "").slice(0, 300)}`); process.exit(1); }
  try { return JSON.parse((r.stdout || "").trim()); }
  catch { console.log(`FAIL  ${script} non-JSON: ${(r.stdout || "").slice(0, 200)}`); process.exit(1); }
}

let pass = 0, fail = 0;
const checks = [];
// approx: |val-gold| <= tol.  eq: strict ===.  truthy: === true.  band: min<=val<=max.  str: === expected.
const A = (name, val, gold, tol) => checks.push({ name, val, gold, tol });
const EQ = (name, val, gold) => checks.push({ name, val, gold, eq: true });
const T = (name, val) => checks.push({ name, val, truthy: true });
const B = (name, val, min, max) => checks.push({ name, val, min, max });
const S = (name, val, str) => checks.push({ name, val, str });

console.log("== T1  lq_regulator (discounted LQ-Gaussian regulator) ==");
const lq = run("lq_regulator.R");
S("T1.theorem", lq.theorem, "V.2-T1");
EQ("T1.n", lq.n, 26);
A("T1.rB_stress (=eta*lam_max(stressed))", lq.rB_stress, GOLD.lq.rB_stress, TOL_GREEN);
A("T1.rho_open (open-loop spectral radius)", lq.rho_open, GOLD.lq.rho_open, TOL_GREEN);
A("T1.beta_rho2_open", lq.beta_rho2_open, GOLD.lq.beta_rho2_open, TOL_GREEN);
T("T1.open_loop_nonstationary", lq.open_loop_nonstationary);
A("T1.trace_P (DARE solution)", lq.trace_P, GOLD.lq.trace_P, TOL_GREEN);
A("T1.F_norm2 (feedback spectral norm)", lq.F_norm2, GOLD.lq.F_norm2, TOL_GREEN);
A("T1.rho_closed (closed-loop, <1)", lq.rho_closed, GOLD.lq.rho_closed, TOL_GREEN);
T("T1.closed_loop_stationary", lq.closed_loop_stationary);
A("T1.certainty_equivalence_residual (F indep of C, =0)", lq.certainty_equivalence_residual, GOLD.lq.ce_residual, TOL_GREEN);
A("T1.d_C1 (value constant, loading I)", lq.d_C1, GOLD.lq.d_C1, TOL_GREEN);
A("T1.d_C2 (value constant, loading 2)", lq.d_C2, GOLD.lq.d_C2, TOL_GREEN);
A("T1.J_optimal", lq.J_optimal, GOLD.lq.J_optimal, TOL_GREEN);
A("T1.J_threshold", lq.J_threshold, GOLD.lq.J_threshold, TOL_GREEN);
S("T1.J_open (uncontrolled = infinite)", lq.J_open, "Inf");
A("T1.rho_threshold", lq.rho_threshold, GOLD.lq.rho_threshold, TOL_GREEN);
A("T1.eta_safe", lq.eta_safe, GOLD.lq.eta_safe, TOL_GREEN);
T("T1.cost_ranking_holds (optimal<=threshold<open)", lq.cost_ranking_holds);
S("T1.gate.rho_closed", lq.gate?.rho_closed, "STRONG");
T("T1.provenance present", typeof lq.provenance === "string" && lq.provenance.length > 40);

console.log("== T2  bellman_value (nonlinear Bellman contraction) ==");
const bv = run("bellman_value.R");
S("T2.theorem", bv.theorem, "V.2-T2");
EQ("T2.iters (value iteration to 1e-9)", bv.iters, GOLD.vi.iters);
A("T2.contraction_ratio (= beta)", bv.contraction_ratio, GOLD.vi.contraction_ratio, TOL_GRID);
T("T2.contraction_matches_beta", bv.contraction_matches_beta);
EQ("T2.policy_rest_eta (= turnpike)", bv.policy_rest_eta, GOLD.vi.policy_rest_eta);
S("T2.gate.contraction", bv.gate?.contraction, "STRONG");

console.log("== T3  turnpike (Hamiltonian steady state + saddle) ==");
const tp = run("turnpike.R");
S("T3.theorem", tp.theorem, "V.2-T3");
EQ("T3.eta_bar (activity-min turnpike)", tp.eta_bar, GOLD.tp.eta_bar);
A("T3.trace_min", tp.trace_min, GOLD.tp.trace_min, TOL_GREEN);
A("T3.ell_pp (holding-cost curvature)", tp.ell_pp, GOLD.tp.ell_pp, TOL_GREEN);
A("T3.jacobian_eig_lo (<0)", tp.jacobian_eigs?.[0], GOLD.tp.jac_lo, TOL_GREEN);
A("T3.jacobian_eig_hi (>0)", tp.jacobian_eigs?.[1], GOLD.tp.jac_hi, TOL_GREEN);
T("T3.is_saddle", tp.is_saddle);
EQ("T3.stable_manifold_dim", tp.stable_manifold_dim, 1);
T("T3.turnpike_monotone_in_cost_ratio", tp.turnpike_monotone_in_cost_ratio);

console.log("== T4  fragility_barrier (feasibility barrier + bifurcation diagnostic) ==");
const fb = run("fragility_barrier.R");
S("T4.theorem", fb.theorem, "V.2-T4");
A("T4.barrier (beta*r(B)=1)", fb.barrier, GOLD.fb.barrier, TOL_GREEN);
A("T4.sigma_bar (safe cascade root = turnpike)", fb.sigma_bar, GOLD.fb.sigma_bar, TOL_GREEN);
A("T4.beta_cascade_rB_stress (<1, sub-barrier)", fb.beta_cascade_rB_stress, GOLD.fb.beta_cascade_rB_stress, TOL_GREEN);
A("T4.g_onset_analytic (flip-bifurcation gain)", fb.g_onset_analytic, GOLD.fb.g_onset_analytic, TOL_GREEN);
A("T4.g_onset_numeric (grid-located onset)", fb.g_onset_numeric, GOLD.fb.g_onset_numeric, TOL_GRID);
T("T4.onset_analytic_matches_numeric", fb.onset_analytic_matches_numeric);
A("T4.g_chaos (first positive-Lyapunov gain)", fb.g_chaos, GOLD.fb.g_chaos, TOL_GRID);
// SENSITIVE: chaotic-band Lyapunov MAGNITUDE -- sign + ballpark only (documented).
T("T4.chaotic_band_present (lyap>0)", fb.chaotic_band_present);
B("T4.largest_lyapunov_max (SENSITIVE: sign+band, not bit-exact)", fb.largest_lyapunov_max, 0.3, 1.0);
S("T4.gate.fragility_index (PROXY, explicit beta)", fb.gate?.fragility_index, "PROXY");

// ---- cross-method convergence invariant (mission STOP condition) ------------
// "Turnpike = V.1 interior optimum" must hold live across the three operators that
// touch it: T3's Hamiltonian turnpike, T3's match flag, and T2's value-iteration
// policy rest point must all coincide. If this drifts, STOP -- do not adjust.
console.log("== invariant  turnpike == V.1 interior optimum (across T2/T3) ==");
T("INV.turnpike_matches_v1 (flag)", tp.turnpike_matches_v1);
B("INV.|eta_bar - V.1 optimum| within grid res", Math.abs(tp.eta_bar - GOLD.tp.v1), 0, 1.5e-3);
EQ("INV.T2 rest point == T3 turnpike", bv.policy_rest_eta, tp.eta_bar);

for (const c of checks) {
  let ok, band;
  if (c.eq) { ok = c.val === c.gold; band = `==${c.gold}`; }
  else if (c.truthy) { ok = c.val === true; band = "===true"; }
  else if (c.str) { ok = c.val === c.str; band = `=="${c.str}"`; }
  else if ("min" in c) { ok = typeof c.val === "number" && c.val >= c.min && c.val <= c.max; band = `${c.min}..${c.max}`; }
  else { ok = typeof c.val === "number" && Math.abs(c.val - c.gold) <= c.tol; band = `${c.gold} +-${c.tol.toExponential(0)}`; }
  const shown = typeof c.val === "number"
    ? (Number.isInteger(c.val) ? c.val : c.val.toPrecision(10))
    : JSON.stringify(c.val);
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name} = ${shown}  (${band})`);
  ok ? pass++ : fail++;
}

console.log(`\n${pass}/${pass + fail} v5 control reproduction checks passed`);
process.exit(fail ? 1 : 0);
