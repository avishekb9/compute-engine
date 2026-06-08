// verify-grid.mjs — Phase 32.1 coordinator-side admission control.
//
// The coordinator computes the CANONICAL execution-surface hash (ITS OWN engine,
// via grid-registry.mjs) and checks every node registered in grid.nodes against it:
//   - advertised hash == canonical            -> admit   (status active)
//   - advertised hash != canonical            -> EXPEL   (status expelled + reason)
//   - was expelled but now matches again       -> reinstate (active, reason cleared)
// This is the enforcement leg of the integrity invariant (VISION §4): only nodes
// running the identical parameterised-only engine may stay in the grid. It is the
// check a coordinator would run before dispatching a job to a node. Report-only by
// default; --enforce writes verdicts back via UPDATE (DML — the rows were MERGE-
// written by join-grid.mjs, never streamed, so they update immediately).
//
// THREAT MODEL (honest, NORM invariant — not overclaimed): this compares each
// node's SELF-REPORTED hash against the coordinator's own hash. It catches
// accidental drift / version-skew / casual modification across the PI's own nodes.
// It does NOT stop a malicious node that lies about its hash — defeating that needs
// the coordinator to independently obtain & re-hash the node's files (or signed
// remote attestation), which is future work.
//
// Trusted-orchestrator code (Node, not the net-isolated R sandbox). BQ seam = `bq`.
import { spawnSync } from "node:child_process";
import { computeRegistryHash } from "./grid-registry.mjs";

const PROJECT = arg("project") || "hopeful-flash-485308-v3";
const TABLE = `${PROJECT}.grid.nodes`;
const ENFORCE = !!arg("enforce");

function arg(name) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  const eq = hit.indexOf("=");
  return eq === -1 ? true : hit.slice(eq + 1);
}
function bq(args) {
  const r = spawnSync("bq", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    const msg = ((r.stderr || "") + (r.stdout || "")).trim().slice(0, 600);
    throw new Error(`bq ${args[0]} failed (status ${r.status}): ${msg || "no output"}`);
  }
  return r.stdout || "";
}
function bqExec(sql) {
  bq(["query", `--project_id=${PROJECT}`, "--use_legacy_sql=false", "--quiet", "--format=none", sql]);
}
function bqJson(sql) {
  const out = bq(["query", `--project_id=${PROJECT}`, "--use_legacy_sql=false", "--quiet", "--format=json", sql]).trim();
  return out ? JSON.parse(out) : [];
}
const S = (v) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const short = (h) => (h ? `${String(h).slice(0, 12)}…` : "(none)");

// ── verify ────────────────────────────────────────────────────────────────────
const { hash: canonical, n_files } = computeRegistryHash();
console.log(`Coordinator canonical hash: ${canonical}  (${n_files} execution-surface files)`);
console.log(`Mode: ${ENFORCE ? "ENFORCE (writes verdicts)" : "report-only (no writes — pass --enforce to apply)"}\n`);

const nodes = bqJson(`SELECT node_id, registry_hash, status FROM \`${TABLE}\` ORDER BY node_id`);
if (!nodes.length) {
  console.log("grid.nodes is empty — no nodes to verify.");
} else {
  let admitted = 0,
    expelled = 0,
    changed = 0;
  for (const n of nodes) {
    const match = n.registry_hash === canonical;
    const target = match ? "active" : "expelled";
    const reason = match ? null : `registry_hash mismatch: advertised ${short(n.registry_hash)} != canonical ${short(canonical)}`;
    const willChange = n.status !== target;
    const verdict = match ? (willChange ? "REINSTATE" : "OK") : willChange ? "EXPEL" : "STILL-EXPELLED";
    if (match) admitted++;
    else expelled++;
    console.log(`  [${verdict.padEnd(13)}] ${n.node_id}  advertised=${short(n.registry_hash)}  ${match ? "== canonical" : "≠ CANONICAL"}`);
    if (willChange && ENFORCE) {
      bqExec(`UPDATE \`${TABLE}\` SET status=${S(target)}, expelled_reason=${S(reason)} WHERE node_id=${S(n.node_id)}`);
      changed++;
    }
  }
  console.log(`\nSummary: ${nodes.length} node(s) — ${admitted} match canonical, ${expelled} mismatch.`);
  if (ENFORCE) console.log(`Applied ${changed} status change(s).`);
  else if (expelled || nodes.some((n) => (n.registry_hash === canonical) !== (n.status === "active")))
    console.log(`(${expelled} would be expelled / some statuses stale — re-run with --enforce to apply.)`);
}
