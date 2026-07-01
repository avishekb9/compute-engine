#!/usr/bin/env node
// upgrade.test.mjs — failable eval for the Track-B GCP capabilities (zero deps).
// Proves the GOVERNANCE of each capability without making any paid call:
//   default-OFF · typed-param gate · spend ceiling trips and mints no token ·
//   datastore hole spends nothing · no-number contract · secret-scan blocks then
//   clears. Run locally: node test/upgrade.test.mjs
//
// Every paid path is unreachable here: failing prechecks return before execute,
// and the happy path is exercised with { dryRun:true } (stops after governance).
// A tokenFn spy that THROWS if called proves an over-cap request mints no token.

import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCapability, capabilityMenu, CAPS } from "../server/upgrade-capabilities.mjs";
import { capBudgetReset, capBudgetState } from "../server/guards.mjs";

const ENGINE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
}
const throwingToken = () => { throw new Error("token minted on a path that must not spend"); };

// reset every per-capability counter so the run is deterministic in-process
for (const c of ["embeddings", "grounded_search", "gemini_vertex_flash", "gemini_vertex_pro", "batch_predict", "multimodel"])
  capBudgetReset(c);

await (async () => {

  // U-E1 — every capability defaults OFF (Invariant 16)
  const menu = capabilityMenu({});
  check("U-E1 all five capabilities default OFF", menu.length === 5 && menu.every(c => c.enabled === false),
    menu.map(c => `${c.name}:${c.enabled}`).join(" "));

  // a flag-OFF call returns CAPABILITY_OFF and never reaches a paid call
  {
    const r = await runCapability("embeddings", { docs: ["x"] }, { env: {}, tokenFn: throwingToken });
    check("U-E1b OFF embeddings → CAPABILITY_OFF, no token minted", r.code === "CAPABILITY_OFF", r.code);
  }

  // U-E2 — typed-param gate holds with the flag ON (bad input → BAD_PARAMS, no spend)
  {
    const e = { CE_CAP_EMBEDDINGS: "1" };
    const r1 = await runCapability("embeddings", { docs: [] }, { env: e, tokenFn: throwingToken });
    const r2 = await runCapability("embeddings", { docs: [123] }, { env: e, tokenFn: throwingToken });
    const g = { CE_CAP_GEMINI_VERTEX: "1" };
    const r3 = await runCapability("gemini_vertex", { model: "xl", contents: "hi" }, { env: g, tokenFn: throwingToken });
    const r4 = await runCapability("gemini_vertex", { model: "flash", contents: "" }, { env: g, tokenFn: throwingToken });
    capBudgetReset("gemini_vertex_flash");
    check("U-E2 typed-param gate → BAD_PARAMS on bad input",
      [r1, r2, r3, r4].every(r => r.code === "BAD_PARAMS"),
      [r1, r2, r3, r4].map(r => r.code).join(" "));
  }

  // U-E3 — spend ceiling trips AND mints no token (Invariant 11)
  {
    const env = { CE_CAP_GEMINI_VERTEX: "1", CE_GEMINI_VERTEX_FLASH_PER_DAY: "2" };
    capBudgetReset("gemini_vertex_flash");
    const a = await runCapability("gemini_vertex", { model: "flash", contents: "q1" }, { env, dryRun: true });
    const b = await runCapability("gemini_vertex", { model: "flash", contents: "q2" }, { env, dryRun: true });
    // third call is over-cap; pass the throwing spy as the token source
    const c = await runCapability("gemini_vertex", { model: "flash", contents: "q3" }, { env, tokenFn: throwingToken });
    check("U-E3 ceiling trips at the cap → CAP_EXCEEDED, no token minted",
      a.code === "DRY_OK" && b.code === "DRY_OK" && c.code === "CAP_EXCEEDED",
      `${a.code} ${b.code} ${c.code}`);
    capBudgetReset("gemini_vertex_flash");
  }

  // U-E4 — embeddings token ceiling: a single over-cap request is rejected
  {
    capBudgetReset("embeddings");
    const small = { CE_CAP_EMBEDDINGS: "1", CE_EMBEDDINGS_TOKENS_PER_DAY: "10" };
    const within = await runCapability("embeddings", { docs: ["abcd"] }, { env: small, dryRun: true }); // ~1 tok
    capBudgetReset("embeddings");
    const huge = await runCapability("embeddings", { docs: ["x".repeat(44)] }, { env: small, tokenFn: throwingToken }); // ~11 tok > 10
    check("U-E4 embeddings token ceiling → within OK, over-cap CAP_EXCEEDED",
      within.code === "DRY_OK" && huge.code === "CAP_EXCEEDED", `${within.code} ${huge.code}`);
    capBudgetReset("embeddings");
  }

  // U-E5 — grounded_search is a marked hole (no datastore) and spends nothing
  {
    capBudgetReset("grounded_search");
    const env = { CE_CAP_GROUNDED_SEARCH: "1" }; // no CE_GROUNDED_DATASTORE
    const r = await runCapability("grounded_search", { query: "systemic risk" }, { env, tokenFn: throwingToken });
    const used = capBudgetState("grounded_search").used;
    check("U-E5 grounded_search → DATASTORE_MISSING and consumes 0 budget",
      r.code === "DATASTORE_MISSING" && used === 0, `${r.code} used=${used}`);
    capBudgetReset("grounded_search");
  }

  // U-E6 — no-number contract declared on every capability (Invariant 13)
  check("U-E6 every capability declares originates_no_number",
    capabilityMenu({}).every(c => c.originates_no_number === true),
    Object.keys(CAPS).join(","));

  // U-E7 — unknown capability is rejected, not silently run
  {
    const r = await runCapability("transfer_funds", {}, { env: {}, tokenFn: throwingToken });
    check("U-E7 unknown capability → UNKNOWN_CAPABILITY", r.code === "UNKNOWN_CAPABILITY", r.code);
  }

  // U-E8 — secret-scan blocks a planted dummy token, then clears (Invariant 12)
  {
    const scanner = join(ENGINE_DIR, "scripts/secret-scan.mjs");
    const tmp = join(tmpdir(), "ce_secret_probe_" + process.pid + ".txt");
    // a syntactically-Google-shaped but fake key (AIza + 35 chars); never committed
    const dummy = "AIza" + "Sy" + "A".repeat(33);
    writeFileSync(tmp, `const k = "${dummy}";\n`, "utf8");
    const blocked = spawnSync("node", [scanner, tmp], { encoding: "utf8" });
    writeFileSync(tmp, `const k = process.env.GOOGLE_API_KEY; // env-name only\n`, "utf8");
    const cleared = spawnSync("node", [scanner, tmp], { encoding: "utf8" });
    try { unlinkSync(tmp); } catch {}
    const redacted = !/AIzaSyAAAA/.test(blocked.stdout || ""); // the gate must not echo the secret
    check("U-E8 secret-scan blocks dummy (exit≠0) then clears (exit 0), redacted",
      blocked.status === 2 && cleared.status === 0 && redacted,
      `blocked=${blocked.status} cleared=${cleared.status} redacted=${redacted}`);
  }

  // U-E9 — multimodel (Claude-on-Vertex second-opinion) governance: default OFF,
  // typed-param gate, and the spend ceiling trips AND mints no token (same contract
  // as the other paid caps). No paid call is reachable: OFF/BAD return before execute,
  // the happy path uses dryRun, and the over-cap path is given the throwing token spy.
  {
    capBudgetReset("multimodel");
    const offR = await runCapability("multimodel", { contents: "review this" }, { env: {}, tokenFn: throwingToken });
    const env = { CE_CAP_MULTIMODEL: "1", CE_MULTIMODEL_PER_DAY: "2" };
    const badR = await runCapability("multimodel", { contents: "" }, { env, tokenFn: throwingToken });
    const a = await runCapability("multimodel", { contents: "q1" }, { env, dryRun: true });
    const b = await runCapability("multimodel", { contents: "q2" }, { env, dryRun: true });
    const overR = await runCapability("multimodel", { contents: "q3" }, { env, tokenFn: throwingToken });
    capBudgetReset("multimodel");
    check("U-E9 multimodel → OFF, BAD_PARAMS, ceiling trips CAP_EXCEEDED, no token minted",
      offR.code === "CAPABILITY_OFF" && badR.code === "BAD_PARAMS" && a.code === "DRY_OK" && b.code === "DRY_OK" && overR.code === "CAP_EXCEEDED",
      `${offR.code} ${badR.code} ${a.code} ${b.code} ${overR.code}`);
  }

})();

console.log(`\n${pass}/${pass + fail} upgrade governance checks passed`);
process.exit(fail ? 1 : 0);
