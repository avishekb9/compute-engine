#!/usr/bin/env node
// namh-calibration.test.mjs — calibration band-guard for the NAMH x Network-Economics
// programme (net-papers/namh-networks-program). Runs r/namh_calibration.R over the
// CANONICAL saved NAMH run and asserts the per-window empirical counterparts of
// Theorems A/B/C fall within PRE-REGISTERED, theory-derived failable bands. Same
// idiom as golden.test.mjs: PASS/FAIL per check, exit 1 on any band violation.
//
// A band violation means the engine/data disagrees with the proven theorem — STOP
// and investigate; it is never to be "fixed" by widening the band.
//
// Run: node test/namh-calibration.test.mjs   (needs R + jsonlite + results_*.rds)

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = join(__dirname, "..");
const RDS = "/home/ecolex/versiondevs/ivy-fineco/papers/namh/NAMH_researchr_new/output/results_annual.rds";

if (process.env.CI) { console.log("SKIP namh-calibration: requires R + saved NAMH run (not in CI)"); process.exit(0); }
if (!existsSync(RDS)) { console.log(`SKIP namh-calibration: NAMH run not found at ${RDS}`); process.exit(0); }

const r = spawnSync("Rscript", [join(ENGINE_DIR, "r", "namh_calibration.R"), "{}"],
  { encoding: "utf8", timeout: 180000 });
if (r.status !== 0) { console.log(`FAIL  namh_calibration.R exit ${r.status}: ${(r.stderr || "").slice(0, 300)}`); process.exit(1); }
let R;
try { R = JSON.parse((r.stdout || "").trim()); } catch { console.log(`FAIL  non-JSON: ${(r.stdout||"").slice(0,200)}`); process.exit(1); }
const A = R.summary.annual, Q = R.summary.quarterly;

// Each check: theorem it certifies + a failable band. eq => exact integer match.
const CHECKS = [
  // ---- Theorem A: directed well-posedness, Katz-Bonacich/Leontief identity, monotone static ----
  { name: "A.T1_identity_annual (E*=(I-A)^-1 phi = stored E)", val: A.t1_max_resid, max: 1e-8 },
  { name: "A.T1_identity_quarterly",                           val: Q.t1_max_resid, max: 1e-8 },
  { name: "A.monotone_static_annual (#neg (I-A)^-1 entries=0)", val: A.t1_total_neg_inv, eq: 0 },
  { name: "A.monotone_static_quarterly",                        val: Q.t1_total_neg_inv, eq: 0 },
  { name: "A.contraction_annual (||A||_inf<1 all 20)",          val: A.n_inf_ge_1, eq: 0 },
  { name: "A.infnorm_max_annual (anchor 0.7345)",               val: A.inf_norm_max, min: 0.73, max: 0.74 },
  { name: "A.rho_max_annual (anchor 0.0665, slack vs 0.95)",    val: A.rho_max, min: 0.066, max: 0.067 },
  { name: "A.acyclic_annual (structural N=5: w9,12,14,16,19)",  val: A.n_acyclic, eq: 5 },

  // ---- Theorem B: directedness obstruction + the COMPLEMENTS lambda_max diagnostic ----
  { name: "B.wellposed_annual (lambda_max(A_sym)<1 all 20)",    val: A.n_wellposed, eq: 20 },
  { name: "B.wellposed_quarterly (all 79)",                     val: Q.n_wellposed, eq: 79 },
  { name: "B.wp_margin_min_annual (1-lambda_max>0.8)",          val: A.wp_margin_min, min: 0.80, max: 1.0 },
  { name: "B.wp_margin_min_quarterly",                          val: Q.wp_margin_min, min: 0.80, max: 1.0 },
  { name: "B.lambda_max_sym_max_annual (<=0.1547)",             val: A.lam_max_sym_max, min: 0.10, max: 0.16 },
  { name: "B.never_potential_game_annual (asym_index>0 all)",   val: A.n_potential_game, eq: 0 },
  { name: "B.never_potential_game_quarterly",                   val: Q.n_potential_game, eq: 0 },
  { name: "B.asym_index_min_annual (>=0.896, never 0)",         val: A.asym_index_min, min: 0.85, max: 1.0 },
  { name: "B.not_diag_symmetrizable_annual (count=0, Thm B(e))",val: A.n_diag_symmetrizable, eq: 0 },
  { name: "B.not_diag_symmetrizable_quarterly",                 val: Q.n_diag_symmetrizable, eq: 0 },
  // the headline cross-scalar finding: lambda_max(A_sym) is the ROBUST scalar -- the one
  // quarterly window with ||A||_inf>=1 (Thm A fails) still has lambda_max(A_sym)<1 (Thm B holds)
  { name: "B.lambda_max_robust_quarterly (contraction-fail-but-wellposed=1)", val: Q.n_contraction_fail_but_wellposed, eq: 1 },
  { name: "B.contraction_fail_count_quarterly (||A||_inf>=1 in exactly 1)",    val: Q.n_inf_ge_1, eq: 1 },

  // ---- Theorem C: estimability -- the MEASURED inverse-norm corrects the bogus cap of 20 ----
  { name: "C.inv_norm_max_annual (measured ~1.5, NOT 20)",      val: A.inv_norm_max, min: 1.0, max: 5.0 },
  { name: "C.inv_norm_mean_annual (~1.37)",                     val: A.inv_norm_mean, min: 1.2, max: 1.6 },
  { name: "C.inv_norm_max_quarterly (<20)",                     val: Q.inv_norm_max, min: 1.0, max: 6.0 },
];

let pass = 0, fail = 0;
for (const c of CHECKS) {
  let ok;
  if ("eq" in c) ok = c.val === c.eq;
  else ok = typeof c.val === "number" && (c.min === undefined || c.val >= c.min) && (c.max === undefined || c.val <= c.max);
  const band = "eq" in c ? `==${c.eq}` : `${c.min ?? "-inf"}..${c.max ?? "inf"}`;
  const shown = typeof c.val === "number" ? (Number.isInteger(c.val) ? c.val : c.val.toExponential(3)) : c.val;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name} = ${shown}  (band ${band})`);
  ok ? pass++ : fail++;
}

// EGJ phase-plane sanity: GFC high-integration/low-modularity vs COVID low-integration
const eras = Object.fromEntries((R.egj_annual || []).map(e => [e.era, e]));
if (eras.GFC && eras.COVID) {
  const ok = eras.GFC.rho_mean > eras.COVID.rho_mean && eras.GFC.Q_mean < eras.COVID.Q_mean;
  console.log(`${ok ? "PASS" : "FAIL"}  EGJ.GFC_vs_COVID (GFC rho>COVID rho & GFC Q<COVID Q) = GFC(${eras.GFC.rho_mean.toFixed(4)},${eras.GFC.Q_mean.toFixed(3)}) COVID(${eras.COVID.rho_mean.toFixed(4)},${eras.COVID.Q_mean.toFixed(3)})`);
  ok ? pass++ : fail++;
}

console.log(`\n${pass}/${pass + fail} calibration band-checks passed`);
console.log(`results written under: ${R.out_dir}`);
process.exit(fail ? 1 : 0);
