// grid-registry.mjs — Phase 32.1 federated-grid registry integrity (keystone).
//
// The federation's security invariant (VISION §4 / INVARIANT 1): every node runs
// the IDENTICAL parameterised-only engine. The coordinator verifies a node's
// registry hash on every job submission and expels any node whose hash differs —
// i.e. a node whose code was modified to accept arbitrary execution. This module
// computes that hash DETERMINISTICALLY from the execution surface:
//   - r/*.R         the compute scripts (the methods themselves, incl. _helpers)
//   - server/*.mjs  the execution-path orchestrators that spawn them (grid meta-tools excluded — see GRID_META)
// Any modification to either changes the hash, so a tampered node cannot pass.
// Zero dependencies (node:crypto/fs/path only) so every node computes it the same.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Grid MEMBERSHIP-management tools (this file + the join/verify CLIs). They do NOT
// spawn R or execute analyses — they only compute/check hashes and register nodes —
// so they are NOT part of the execution surface and are EXCLUDED from the hash.
// This keeps the canonical hash STABLE as grid tooling evolves: adding verify-grid.mjs
// must not retroactively "expel" already-registered nodes. The execution-surface
// files that CAN run code (compute-server.mjs, job-server.mjs, guards.mjs, all r/*.R)
// stay hashed, so a backdoored kernel / worker / method is still caught.
const GRID_META = new Set(["grid-registry.mjs", "join-grid.mjs", "verify-grid.mjs", "dispatch-grid.mjs"]);

// Canonical hash over the sorted {relpath: sha256(bytes)} manifest of the
// execution surface. Sorting + a fixed separator make it byte-stable across
// machines and filesystems (readdir order is not guaranteed).
export function computeRegistryHash(engineDir = path.join(__dirname, "..")) {
  const files = [];
  const add = (dir, filter) => {
    const d = path.join(engineDir, dir);
    if (!fs.existsSync(d)) return;
    for (const f of fs.readdirSync(d)) {
      if (!filter(f)) continue;
      const rel = `${dir}/${f}`;
      const bytes = fs.readFileSync(path.join(d, f));
      files.push({ path: rel, sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
    }
  };
  add("r", (f) => f.endsWith(".R"));        // compute scripts (incl. _ksg_core.R etc. — trusted code)
  add("server", (f) => f.endsWith(".mjs") && !GRID_META.has(f)); // execution-path orchestrators only (kernel + worker + guards); grid meta-tools excluded
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest = files.map((f) => `${f.path}:${f.sha256}`).join("\n");
  const hash = crypto.createHash("sha256").update(manifest).digest("hex");
  return { hash, n_files: files.length, files };
}

// The runnable method set (r/*.R, excluding _helpers) — what a node advertises it
// can run. Mirrors the job-server's METHODS derivation so they never drift.
export function runnableMethods(engineDir = path.join(__dirname, "..")) {
  const rdir = path.join(engineDir, "r");
  if (!fs.existsSync(rdir)) return [];
  return fs.readdirSync(rdir)
    .filter((f) => f.endsWith(".R") && !f.startsWith("_"))
    .map((f) => f.replace(/\.R$/, ""))
    .sort();
}

// CLI: print the hash (+ optional per-file manifest). Used by join-grid.mjs and
// the coordinator to compare a node's surface against the expected canonical hash.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { hash, n_files, files } = computeRegistryHash();
  if (process.argv.includes("--manifest")) for (const f of files) console.log(`${f.sha256}  ${f.path}`);
  const out = { registry_hash: hash, n_files, n_methods: runnableMethods().length };
  console.log(JSON.stringify(out, null, process.argv.includes("--pretty") ? 2 : 0));
}
