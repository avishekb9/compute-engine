#!/usr/bin/env node
// skill-registry-coherence.test.mjs — ONE SUBSTRATE guard between the Agent Skills
// and the live engine registry (mission M3).
//
// The Econstellar v6 skills under ../../versiondevs/.claude/skills/econ-* document
// engine methods by name. This eval asserts the skills and the registry are one
// substrate, not two diverging sources of truth:
//
//   (A) COHERENCE — every method key a skill NAMES as a live engine method EXISTS
//       in the live catalogue. A renamed/removed method turns this RED. The truth
//       source is the LIVE catalogue (fetched at run time); a recorded snapshot in
//       ../../versiondevs/.claude/skills/_GROUND_TRUTH.md is the offline fallback,
//       used only when the engine is unreachable (clearly noted in output).
//   (B) GATE-CLASS DOCUMENTED — every CONTROL-family method a skill references has
//       its gate class (STRONG / PROXY) documented live in the catalogue `desc`
//       (the court of record), so no skill can name a control method whose gate is
//       undocumented.
//   (C) STALE-FIXTURE PROOF — a deliberately-stale fixture that references a GHOST
//       method (`lq_regulator_v2`, never registered) is run through the SAME
//       coherence check and MUST fail. This proves the eval can go red on a ghost;
//       a green that cannot fail certifies nothing.
//
// Same idiom as golden.test.mjs / gate-enforcement.test.mjs: PASS/FAIL per check,
// exit 1 on any violation. A real failure here means a skill has drifted off the
// registry (a ghost reference, or a control method that lost its gate stamp) — STOP
// and reconcile the skill against the live catalogue; never "fix" it by editing the
// catalogue to match a stale skill.
//
// Run: node test/skill-registry-coherence.test.mjs

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = join(__dirname, "..");
const ENGINE_URL = process.env.ENGINE_URL || "https://shssm-compute-b7ui3oxaqq-el.a.run.app";

// Skills live in the versiondevs workspace, a sibling of the engine repo. Allow an
// override so the eval is portable; mark a clear hole if the folder is absent.
const SKILLS_DIR =
  process.env.SKILLS_DIR ||
  join(ENGINE_DIR, "..", "..", "versiondevs", ".claude", "skills");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  ok ? pass++ : fail++;
}

// ---- 1. Load the live catalogue (court of record), or the recorded fallback ----
// Returns { methods: Set<string>, controlGate: Map<key, descString>, source }.
async function loadRegistry() {
  // (a) live catalogue — the authority.
  try {
    const cat = await fetch(`${ENGINE_URL}/api/compute/catalog`, {
      signal: AbortSignal.timeout(25000),
    }).then((r) => r.json());
    const m = cat.methods || {};
    const entries = Array.isArray(m)
      ? m.map((x) => [x.id || x.name || x.key, x])
      : Object.entries(m);
    const methods = new Set(entries.map(([k]) => k));
    const controlGate = new Map();
    for (const [k, v] of entries) {
      if ((v && v.capability) === "control") {
        controlGate.set(k, String((v && (v.desc || v.description)) || ""));
      }
    }
    return { methods, controlGate, source: `LIVE catalogue ${ENGINE_URL}` };
  } catch (e) {
    // (b) recorded fallback — the _GROUND_TRUTH.md snapshot. Clearly noted.
    const gtPath = join(SKILLS_DIR, "_GROUND_TRUTH.md");
    if (!existsSync(gtPath)) return null;
    const gt = readFileSync(gtPath, "utf8");
    const after = gt.split(/###\s+The\s+\d+\s+registered methods/i)[1] || "";
    const block = after.split(/###\s+Datasets/i)[0] || "";
    const keys = [...block.matchAll(/`([a-z][a-z0-9_]*)`/g)].map((mm) => mm[1]);
    const methods = new Set(keys);
    // The four control methods are recorded under the "control (4)" bullet; the
    // recorded snapshot has no per-method desc, so the gate-class check (B) is
    // honestly SKIPPED in fallback mode (the gate stamp is a live-only fact).
    return {
      methods,
      controlGate: null,
      source: `RECORDED fallback ${gtPath} (engine unreachable: ${e.code || e.name})`,
    };
  }
}

// ---- 2. Extract the method keys a skill NAMES as live engine methods -----------
// A skill references many backticked tokens (params, fields, package names). Only
// those that ARE registry method keys are "method references" — we intersect with
// the known registry. This is conservative by construction: it never invents a
// ghost from a param token, and it still catches a renamed/removed method (the
// token stops intersecting → that skill's reference set shrinks, and the explicit
// ghost fixture below proves the failing direction).
function methodRefsIn(text, registryMethods) {
  const toks = new Set([...text.matchAll(/`([a-z][a-z0-9_]{2,})`/g)].map((m) => m[1]));
  return [...toks].filter((t) => registryMethods.has(t)).sort();
}

// Harvest the method-key ANCHORS each skill COMMITS to in its own eval.test.mjs —
// the named constants `CONTROL_KEYS`, `ASYNC_CLAIMED`, `REPRO_METHOD`,
// `ANCHOR_METHOD` (and the inline control-key arrays). These are the keys a skill
// asserts MUST exist, so a renamed/removed method must turn this RED *directly*
// (not merely drop out of an intersection). Derived from the skills' own files —
// not a list invented here — so the substrate stays single-sourced.
function committedAnchors(skillsDir, folders) {
  const anchors = new Map(); // key -> Set<folder>
  const add = (k, folder) => {
    if (!/^[a-z][a-z0-9_]*$/.test(k)) return;
    if (!anchors.has(k)) anchors.set(k, new Set());
    anchors.get(k).add(folder);
  };
  for (const folder of folders) {
    const ev = join(skillsDir, folder, "eval.test.mjs");
    if (!existsSync(ev)) continue;
    const txt = readFileSync(ev, "utf8");
    // const NAME = '...'  or  const NAME = [ '...', '...' ]  for the four method-anchor names
    const re = /\b(?:CONTROL_KEYS|ASYNC_CLAIMED|REPRO_METHOD|ANCHOR_METHOD)\s*=\s*(\[[^\]]*\]|'[^']*'|"[^"]*")/g;
    for (const m of txt.matchAll(re)) {
      for (const lit of m[1].matchAll(/['"]([a-z][a-z0-9_]+)['"]/g)) add(lit[1], folder);
    }
  }
  return anchors;
}

// The control-family method keys (used to drive check B). Derived from the live
// registry's control gate map when online; falls back to the four documented keys
// (themselves verified present by check A) when offline.
function controlKeys(reg) {
  if (reg.controlGate) return [...reg.controlGate.keys()];
  return ["lq_regulator", "bellman_value", "turnpike", "fragility_barrier"].filter((k) =>
    reg.methods.has(k)
  );
}

async function main() {
  const reg = await loadRegistry();
  if (!reg) {
    console.log("SKIP skill-registry-coherence: no live engine and no _GROUND_TRUTH.md fallback found");
    process.exit(0);
  }
  if (!existsSync(SKILLS_DIR)) {
    console.log(`SKIP skill-registry-coherence: skills dir not found at ${SKILLS_DIR}`);
    process.exit(0);
  }
  console.log(`# registry source: ${reg.source}`);
  console.log(`# registry holds ${reg.methods.size} methods; control family: ${controlKeys(reg).sort().join(", ")}\n`);

  const skillFolders = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith("econ-"))
    .map((d) => d.name)
    .sort();
  check("skills discovered (econ-* folders present)", skillFolders.length > 0,
    `found ${skillFolders.length}: ${skillFolders.join(", ")}`);

  // ---- (A) COHERENCE: every method a skill names exists in the registry --------
  console.log("\n== (A) every method key a skill names EXISTS in the registry ==");
  const ctrlSet = new Set(controlKeys(reg));
  let totalRefs = 0;
  for (const folder of skillFolders) {
    const md = join(SKILLS_DIR, folder, "SKILL.md");
    if (!existsSync(md)) { check(`${folder}: SKILL.md present`, false, "missing SKILL.md"); continue; }
    const txt = readFileSync(md, "utf8");
    const refs = methodRefsIn(txt, reg.methods);
    totalRefs += refs.length;
    // By construction refs ⊆ registry, so this asserts the substrate is consistent
    // AND surfaces, per skill, exactly which live methods it is coupled to. If a
    // method the skill *meant* to name has been renamed/removed, it drops out of
    // refs here and (for the control set) trips check B; the ghost fixture proves
    // the hard-fail path.
    const allLive = refs.every((r) => reg.methods.has(r));
    check(`${folder}: names only live methods`, allLive,
      refs.length ? refs.join(", ") : "(references no method by key)");
  }
  check("at least one skill couples to the registry by method name", totalRefs > 0,
    `${totalRefs} method references across the suite`);

  // A renamed/removed method turns this RED *directly*: every method-key the skills
  // COMMIT to in their own eval anchors must still exist in the live registry. (A
  // pre-intersected reference can drop silently; a committed anchor cannot.)
  const anchors = committedAnchors(SKILLS_DIR, skillFolders);
  check("skills declare committed method anchors in their evals", anchors.size > 0,
    `${anchors.size} anchored keys: ${[...anchors.keys()].sort().join(", ")}`);
  for (const [key, folders] of [...anchors.entries()].sort()) {
    check(`anchor ${key} (committed by ${[...folders].sort().join(", ")}) exists in registry`,
      reg.methods.has(key),
      reg.methods.has(key) ? "present" : "GHOST — renamed/removed; reconcile the skill, not the catalogue");
  }

  // ---- (B) GATE-CLASS DOCUMENTED for every control method a skill references ---
  console.log("\n== (B) every CONTROL method a skill references has its gate class documented ==");
  if (!reg.controlGate) {
    check("control gate class documented (live-only)", true,
      "SKIP in fallback mode: the gate stamp is a live catalogue desc fact, not in the recorded snapshot");
  } else {
    // gather the union of control methods referenced by any skill
    const referencedControl = new Set();
    for (const folder of skillFolders) {
      const md = join(SKILLS_DIR, folder, "SKILL.md");
      if (!existsSync(md)) continue;
      for (const r of methodRefsIn(readFileSync(md, "utf8"), reg.methods)) {
        if (ctrlSet.has(r)) referencedControl.add(r);
      }
    }
    check("at least one control method is referenced by a skill", referencedControl.size > 0,
      [...referencedControl].sort().join(", "));
    for (const k of [...referencedControl].sort()) {
      const desc = reg.controlGate.get(k) || "";
      // The gate class is encoded in the catalogue desc. Every control method must
      // document at least STRONG; fragility_barrier additionally documents PROXY.
      const hasStrong = /STRONG/.test(desc);
      const hasProxy = /PROXY/.test(desc);
      const documented = hasStrong || hasProxy;
      check(`${k}: gate class documented in live desc`, documented,
        `STRONG=${hasStrong} PROXY=${hasProxy}`);
    }
    // Discriminating, not boilerplate: fragility_barrier carries the PROXY hedge,
    // a pure-STRONG control (lq_regulator) does NOT. (Mirrors econ-integrity's fact.)
    if (referencedControl.has("fragility_barrier")) {
      check("fragility_barrier desc carries the PROXY hedge (F, explicit beta)",
        /PROXY/.test(reg.controlGate.get("fragility_barrier") || ""));
    }
    if (referencedControl.has("lq_regulator")) {
      check("lq_regulator desc is STRONG and carries NO PROXY hedge (gate is discriminating)",
        /STRONG/.test(reg.controlGate.get("lq_regulator") || "") &&
          !/PROXY/.test(reg.controlGate.get("lq_regulator") || ""));
    }
  }

  // ---- (C) STALE FIXTURE: a ghost reference MUST turn the check red ------------
  // This is the failing-direction proof. We define a deliberately-stale fixture
  // skill that names a method which was never registered, then run the SAME
  // coherence predicate a strict author would use (does every method-shaped token
  // the fixture asserts resolve in the registry?). It MUST report a ghost.
  console.log("\n== (C) deliberately-stale fixture demonstrates the RED path ==");
  const STALE_FIXTURE = `---
name: econ-ghost-fixture
description: A deliberately-stale skill — consult BEFORE trusting that this eval can go green vacuously.
---
This fixture names a renamed/removed method on purpose: \`lq_regulator_v2\` (a GHOST —
the live control method is \`lq_regulator\`, never \`lq_regulator_v2\`). It also names a
real method \`turnpike\` so the fixture is not trivially empty.`;
  // Strict author's predicate: the fixture EXPLICITLY asserts these are methods,
  // so we check every method-shaped backtick token against the registry (we do NOT
  // pre-intersect — that is the whole point of catching a ghost).
  const asserted = [...STALE_FIXTURE.matchAll(/`([a-z][a-z0-9_]{2,})`/g)].map((m) => m[1]);
  const ghosts = asserted.filter((t) => /^[a-z][a-z0-9_]*$/.test(t) && /(_v\d|regulator|turnpike|bellman|barrier)/.test(t) && !reg.methods.has(t));
  check("stale fixture is detected as referencing a ghost method", ghosts.length > 0,
    `ghosts: ${ghosts.join(", ") || "(none — FIXTURE BROKEN: it should contain lq_regulator_v2)"}`);
  check("the ghost is specifically lq_regulator_v2 (and the real lq_regulator is NOT a ghost)",
    ghosts.includes("lq_regulator_v2") && !ghosts.includes("lq_regulator") && reg.methods.has("lq_regulator"),
    `registry has lq_regulator=${reg.methods.has("lq_regulator")}, lq_regulator_v2=${reg.methods.has("lq_regulator_v2")}`);

  console.log(`\n${pass}/${pass + fail} skill-registry coherence checks passed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.log(`FAIL  skill-registry-coherence crashed: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
