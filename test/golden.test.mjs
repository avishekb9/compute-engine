#!/usr/bin/env node
// golden.test.mjs — regression guard for the compute engine.
// Asserts verified empirical results fall within tolerance bands, exercising the
// REAL sandboxed R path (same code the HTTP route uses). Skips in CI where bwrap
// and the G20 data file are unavailable.
//
// Run locally: node test/golden.test.mjs   (needs R + waveslim/urca/tseries + G20.xlsx)

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = join(__dirname, "..");
const REPO = process.env.COMPUTE_REPO || join(ENGINE_DIR, "..");
const DATA = join(REPO, "papers/contagion-channels/data/G20.xlsx");

if (process.env.CI) { console.log("SKIP golden.test: requires bwrap + G20 data (not in CI)"); process.exit(0); }
if (!existsSync(DATA)) { console.log(`SKIP golden.test: G20 data not found at ${DATA}`); process.exit(0); }

// verified bands — DO NOT tighten without re-verifying against a real run
const GOLDEN = [
  { name: "unit_root_india_adf",     method: "adf.R",       params: { series: ["India"] }, pick: o => o.adf.statistic,                 min: -55, max: -45 }, // −49.18
  { name: "unit_root_uk_adf",        method: "adf.R",       params: { series: ["UK"]    }, pick: o => o.adf.statistic,                 min: -60, max: -45 }, // −52.64
  { name: "garch_india_persistence", method: "garch.R",     params: { series: ["India"] }, pick: o => o.persistence,                    min: 0.95, max: 1.0 }, // 0.991
  { name: "wavelet_india_d1_pct",    method: "wavelet.R",   params: { series: ["India"] }, pick: o => o.scales && o.scales[0] && o.scales[0].pct_of_total, min: 35, max: 60 }, // 47.07
  { name: "dfa_india_hurst",         method: "dfa_hurst.R", params: { series: ["India"] }, pick: o => o.hurst ?? o.H,                  min: 0.45, max: 0.65 }, // 0.542
];

function runR(script, params) {
  const argsJson = JSON.stringify({ ...params, _repo: REPO });
  const r = spawnSync("Rscript", [join(ENGINE_DIR, "r", script), argsJson],
    { encoding: "utf8", timeout: 120000, env: { ...process.env, COMPUTE_REPO: REPO } });
  if (r.status !== 0) throw new Error(`Rscript ${script} exit ${r.status}: ${(r.stderr || "").slice(0, 200)}`);
  const out = (r.stdout || "").trim();
  try { return JSON.parse(out); } catch { throw new Error(`non-JSON from ${script}: ${out.slice(0, 200)}`); }
}

let pass = 0, fail = 0;
for (const g of GOLDEN) {
  try {
    const obj = runR(g.method, g.params);
    if (obj.error) throw new Error(obj.error);
    const val = g.pick(obj);
    const ok = typeof val === "number" && val >= g.min && val <= g.max;
    console.log(`${ok ? "PASS" : "FAIL"}  ${g.name} = ${typeof val === "number" ? val.toFixed(4) : val}  (band ${g.min}..${g.max})`);
    ok ? pass++ : fail++;
  } catch (e) {
    console.log(`FAIL  ${g.name}: ${e.message}`);
    fail++;
  }
}
console.log(`\n${pass}/${pass + fail} golden checks passed`);
process.exit(fail ? 1 : 0);
