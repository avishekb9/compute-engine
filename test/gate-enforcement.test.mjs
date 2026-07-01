#!/usr/bin/env node
// gate-enforcement.test.mjs — the Project-V certification gate as a first-class,
// failable engine concern (ECONSTELLAR v5 / FRONTIERS V.2 control layer).
//
// The gate (papers/project-v): the recovered dependence network identifies the
// SPECTRUM and the Perron ranking (STRONG); the cascade fragility index with an
// explicit beta is a hedged PROXY; the individual interaction weights G_ij and
// response intensities delta_i are UNIDENTIFIED. A control operator must therefore
// ACT ON a STRONG/PROXY target and REFUSE an UNIDENTIFIED one — returning an honest
// error, never a fabricated number. This eval drives the live runners over each
// gate class and asserts that contract. Same idiom as golden.test.mjs: PASS/FAIL
// per check, exit 1 on any violation.
//
// A failure here means the engine answered a question it cannot identify (or refused
// one it can) — STOP and investigate; it is never to be "fixed" by loosening the gate.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const R_DIR = join(__dirname, "..", "r");
const FIXTURE = join(R_DIR, "fixtures", "v5_control_plant.json");
if (!existsSync(FIXTURE)) { console.log(`SKIP gate-enforcement: fixture not found at ${FIXTURE}`); process.exit(0); }

function run(script, params) {
  const r = spawnSync("Rscript", [join(R_DIR, script), JSON.stringify(params)], { encoding: "utf8", timeout: 120000 });
  let json = null;
  try { json = JSON.parse((r.stdout || "").trim()); } catch { /* non-JSON */ }
  return { status: r.status, json, stderr: r.stderr || "" };
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
}

// A STRONG/PROXY target is ANSWERED: exit 0, the gate class is stamped, and a real
// numeric control result is present.
function expectAnswered(script, target, wantClass, numField) {
  const r = run(script, target == null ? {} : { target });
  const g = r.json && r.json.control_target_gate;
  const num = r.json && typeof r.json[numField] === "number";
  check(`${script} target=${target ?? "(default)"} → ANSWERED (${wantClass})`,
    r.status === 0 && g === wantClass && num,
    `status=${r.status} gate=${g} ${numField}=${r.json ? r.json[numField] : "?"}`);
}

// An UNIDENTIFIED target is REFUSED: non-zero exit, an error mentioning UNIDENTIFIED,
// and NO numeric control result (a refusal, not a number).
function expectRefused(script, target) {
  const r = run(script, { target });
  const isErr = !!(r.json && typeof r.json.error === "string" && /UNIDENTIFIED/.test(r.json.error));
  const noNumber = !(r.json && (typeof r.json.rho_closed === "number" || typeof r.json.policy_rest_eta === "number"));
  check(`${script} target=${target} → REFUSED (honest error, not a number)`,
    r.status !== 0 && isErr && noNumber,
    `status=${r.status} error=${r.json && r.json.error ? "yes" : "no"}`);
}

console.log("== STRONG / PROXY targets are answered (with the gate class stamped) ==");
expectAnswered("lq_regulator.R", "rB", "STRONG", "rho_closed");       // cascade spectral root
expectAnswered("lq_regulator.R", "perron", "STRONG", "rho_closed");   // Perron ranking
expectAnswered("lq_regulator.R", "F_index", "PROXY", "rho_closed");   // fragility index (explicit beta) — hedged but admissible
expectAnswered("lq_regulator.R", null, "STRONG", "rho_closed");       // default = rB (STRONG)
expectAnswered("bellman_value.R", "eta", "STRONG", "policy_rest_eta");// adjustment speed
expectAnswered("bellman_value.R", null, "STRONG", "policy_rest_eta"); // default = eta (STRONG)

console.log("== UNIDENTIFIED targets are refused (never answered with a number) ==");
expectRefused("lq_regulator.R", "G_ij");      // an individual interaction weight
expectRefused("lq_regulator.R", "delta_i");   // a response intensity
expectRefused("lq_regulator.R", "edge_3_7");  // any named edge → unknown key → conservative refusal
expectRefused("bellman_value.R", "G_ij");
expectRefused("bellman_value.R", "delta_i");

console.log(`\n${pass}/${pass + fail} gate-enforcement checks passed`);
process.exit(fail ? 1 : 0);
