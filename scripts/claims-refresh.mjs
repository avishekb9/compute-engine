#!/usr/bin/env node
// claims-refresh.mjs — Phase 34 (V4 M3) loop wiring: the nightly tick re-verifies
// epistemic claims against the SAME night's genuine eval-suite artifact.
//
//   pass  -> UPDATE last_verified (established rows only; contested rows are NOT
//            silently re-greened — PI review resolves them)
//   fail  -> the claim is marked CONTESTED and an auto contradiction row is
//            MERGE-inserted as the other side of the pair. NOTHING is deleted:
//            a red is information, and the revision history is knowledge.
//
// Only claims the suite genuinely measures are mapped (MAP below); badge-derived,
// formal and hole claims are refreshed by their own processes, never assumed here.
//
// usage:
//   node scripts/claims-refresh.mjs --selftest
//   node scripts/claims-refresh.mjs --dry   [--evals <path>]   # default: print SQL
//   node scripts/claims-refresh.mjs --apply [--evals <path>]   # bq query DML
//   node scripts/claims-refresh.mjs --simulate-contradiction   # ztest_* pair, end-to-end
//   node scripts/claims-refresh.mjs --clean-simulation         # DELETE ztest_* rows only
//
// DML query jobs only (never streaming inserts) so every row stays immediately
// updatable/deletable — the ztest simulation depends on that (CLAUDE.md §4).
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { CLAIMS } from "./claims-seed.mjs";

const PROJECT = process.env.BQ_PROJECT || "hopeful-flash-485308-v3";
const TBL = "`" + PROJECT + ".epistemic.claims`";
const DEFAULT_EVALS = "/home/ecolex/engine-work/econstellar/evals.json";

// eval-suite method -> the claims that row genuinely re-verifies
const MAP = [
  { eval: "unit_root",           claims: ["te_log_returns_stationarity"] },
  { eval: "panel_unit_root",     claims: ["panel_tuple_named"] },
  { eval: "ksg_te",              claims: ["ksg_usa_japan_te"] },
  { eval: "channel_attribution", claims: ["channel_table5_exact"] },
  { eval: "namh_reproduce",      claims: ["namh_hurst_machine_exact", "namh_te_window_panel", "namh_network_fdr_empty"] },
  { eval: "namh_pipeline",       claims: ["namh_pipeline_seeded_deterministic"] },
  { eval: "soch_robustness",     claims: ["soch_b_shape_symmetry"] },
];

const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
const sStr = (s) => `"${esc(s)}"`;
const sArr = (a) => `[${(a || []).map(sStr).join(", ")}]`;

function mergeInsert({ id, type, statement, ts, provenance, status = "contested" }) {
  return `MERGE ${TBL} T USING (SELECT ${sStr(id)} AS claim_id) S ON T.claim_id = S.claim_id\n` +
    `WHEN NOT MATCHED THEN INSERT (claim_id, type, statement, established_at, last_verified, confidence, conditions, counter_conditions, provenance_ids, paper_refs, status)\n` +
    `VALUES (${sStr(id)}, ${sStr(type)}, ${sStr(statement)}, TIMESTAMP(${sStr(ts)}), TIMESTAMP(${sStr(ts)}), CAST(NULL AS FLOAT64), [], [], ${sArr(provenance)}, [], ${sStr(status)})`;
}

export function plan(evals) {
  const ts = evals.run_at || new Date(0).toISOString();
  const day = String(ts).slice(0, 10).replace(/-/g, "");
  const results = evals.results || [];
  const verified = [], contradicted = [], skipped = [];
  for (const m of MAP) {
    const row = results.find((r) => r.method === m.eval);
    if (!row) { skipped.push({ eval: m.eval, why: "no row in this run" }); continue; }
    if (row.status === "pass") verified.push(...m.claims);
    else if (row.status === "fail") m.claims.forEach((c) => contradicted.push({ claim: c, eval: m.eval, expected: row.expected, ts }));
    else skipped.push({ eval: m.eval, why: `status ${row.status} (e.g. async_pending) — not evidence either way` });
  }
  const sql = [];
  if (verified.length)
    sql.push(`UPDATE ${TBL} SET last_verified = TIMESTAMP(${sStr(ts)}) WHERE claim_id IN (${verified.map(sStr).join(", ")}) AND status = "established"`);
  for (const c of contradicted) {
    sql.push(`UPDATE ${TBL} SET status = "contested" WHERE claim_id = ${sStr(c.claim)} AND status = "established"`);
    sql.push(mergeInsert({
      id: `${c.claim}_contra_${day}`, type: "empirical", ts: c.ts,
      statement: `NIGHTLY CONTRADICTION (auto): eval row '${c.eval}' FAILED against its pre-registered expectation at ${c.ts} (expected: ${String(c.expected || "").slice(0, 160)}). Parent claim '${c.claim}' is contested pending PI review — a red is information; nothing was deleted.`,
      provenance: [`eval:evals.json/${c.eval}`, `run:${c.ts}`, `contests:${c.claim}`],
    }));
  }
  return { ts, verified, contradicted, skipped, sql };
}

function simulationSQL(ts) {
  const day = String(ts).slice(0, 10).replace(/-/g, "");
  return {
    create: [
      mergeInsert({
        id: "ztest_sim_claim", type: "empirical", ts, status: "established",
        statement: "SIMULATION (test fixture): a deliberately planted claim used to exercise the contested path end-to-end; never part of the knowledge. Cleaned by --clean-simulation.",
        provenance: ["test:simulated-contradiction-exercise"],
      }),
    ],
    contradict: [
      `UPDATE ${TBL} SET status = "contested" WHERE claim_id = "ztest_sim_claim" AND status = "established"`,
      mergeInsert({
        id: `ztest_sim_claim_contra_${day}`, type: "empirical", ts,
        statement: "SIMULATED CONTRADICTION (test): the other side of the ztest pair — exercises the contested path end-to-end; cleaned by --clean-simulation.",
        provenance: ["test:simulated-contradiction-exercise", "contests:ztest_sim_claim"],
      }),
    ],
    clean: [`DELETE FROM ${TBL} WHERE claim_id LIKE "ztest_%"`],
  };
}

function runBq(sql) {
  const r = spawnSync("bq", ["query", "--use_legacy_sql=false", "--format=none", sql], { encoding: "utf8", timeout: 120000 });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}
function applyAll(stmts) {
  for (const s of stmts) {
    console.log("-- applying:\n" + s.slice(0, 200) + (s.length > 200 ? " …" : ""));
    const r = runBq(s);
    if (r.code !== 0) { console.error(r.out); process.exit(1); }
  }
  console.log(`applied ${stmts.length} statement(s)`);
}

function selftest() {
  let pass = 0, fail = 0;
  const ok = (c, n) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}`); c ? pass++ : fail++; };
  const ids = new Set(CLAIMS.map((c) => c.claim_id));
  ok(MAP.flatMap((m) => m.claims).every((c) => ids.has(c)), "every mapped claim exists in the seed set");
  ok(new Set(MAP.map((m) => m.eval)).size === MAP.length, "eval rows mapped once");
  const fix = { run_at: "2026-06-12T07:10:00Z", results: [
    { method: "unit_root", status: "pass" },
    { method: "namh_reproduce", status: "fail", expected: "hurst green <=1e-8" },
    { method: "soch_robustness", status: "async_pending" },
  ] };
  const p = plan(fix);
  ok(p.verified.includes("te_log_returns_stationarity"), "pass row -> last_verified plan");
  ok(p.contradicted.length === 3 && p.contradicted.every((c) => ["namh_hurst_machine_exact", "namh_te_window_panel", "namh_network_fdr_empty"].includes(c.claim)), "fail row -> all its claims contested");
  ok(p.skipped.some((s) => /async_pending/.test(s.why)), "async_pending is not evidence either way (skipped honestly)");
  ok(p.sql.some((s) => s.startsWith("UPDATE") && /last_verified/.test(s) && /status = "established"/.test(s)), "verify SQL touches established rows only");
  ok(p.sql.some((s) => /SET status = "contested"/.test(s)), "contradiction SQL marks parent contested");
  ok(p.sql.some((s) => /MERGE/.test(s) && /contests:namh_hurst_machine_exact/.test(s)), "contradiction MERGE links the pair (contests:<id>)");
  ok(!p.sql.some((s) => /DELETE/.test(s)), "the nightly path NEVER deletes");
  const sim = simulationSQL("2026-06-12T07:10:00Z");
  ok(/"established"\)/.test(sim.create[0]) && /SIMULATION/.test(sim.create[0]), "simulation creates an established ztest claim");
  ok(sim.contradict.length === 2 && /contests:ztest_sim_claim/.test(sim.contradict[1]), "simulation contradiction pair builds");
  ok(sim.clean[0].includes('LIKE "ztest_%"') && !/established|contested/.test(sim.clean[0]), "clean deletes ONLY ztest_* rows");
  console.log(`\n${pass}/${pass + fail} claims-refresh selftests passed`);
  process.exit(fail ? 1 : 0);
}

const argv = process.argv.slice(2);
const mode = argv.find((a) => a.startsWith("--") && !a.startsWith("--evals")) || "--dry";
const evalsPath = (argv.find((a) => a.startsWith("--evals=")) || "").slice(8) || DEFAULT_EVALS;

if (mode === "--selftest") selftest();
else if (mode === "--dry" || mode === "--apply") {
  let evals;
  try { evals = JSON.parse(readFileSync(evalsPath, "utf8")); }
  catch (e) { console.error(`cannot read evals artifact at ${evalsPath}: ${e.message}`); process.exit(1); }
  const p = plan(evals);
  console.log(`run_at ${p.ts} · re-verified ${p.verified.length} · contradictions ${p.contradicted.length} · skipped ${p.skipped.length}`);
  p.skipped.forEach((s) => console.log(`  skip ${s.eval}: ${s.why}`));
  if (!p.sql.length) { console.log("nothing to apply"); process.exit(0); }
  if (mode === "--dry") p.sql.forEach((s) => console.log("\n" + s));
  else applyAll(p.sql);
} else if (mode === "--simulate-contradiction") {
  const sim = simulationSQL(new Date().toISOString());
  applyAll([...sim.create, ...sim.contradict]);
  console.log('verify: curl -s "https://shssm-compute-b7ui3oxaqq-el.a.run.app/api/claims?status=contested" | grep ztest');
} else if (mode === "--clean-simulation") {
  applyAll(simulationSQL(new Date().toISOString()).clean);
} else { console.error("usage: claims-refresh.mjs --selftest | --dry | --apply | --simulate-contradiction | --clean-simulation"); process.exit(2); }
