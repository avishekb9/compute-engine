// join-grid.mjs — Phase 32.1 node registration for the federated research grid.
//
// A node JOINS the grid by advertising its VERIFIED execution surface:
//   1. compute its registry hash (grid-registry.mjs) — the integrity proof that
//      this node runs the identical parameterised-only engine, nothing more.
//   2. measure its real identity + capacity — hostname, Tailscale IP, cores, RAM
//      (READ from the OS, never hardcoded; absent values are NULL, not invented —
//      the REAL-COORDINATES invariant).
//   3. upsert one row into grid.nodes via MERGE (never streaming-insert, so a
//      node can heartbeat last_seen without the ~90-min streaming-buffer lock).
//
// The coordinator later compares this advertised registry_hash against the
// canonical reference hash on every job submission; a node whose code was
// modified to accept arbitrary execution has a different hash and is rejected.
// That coordinator-side enforcement is the NEXT unit — this script is the node
// side: it only advertises, honestly.
//
// Trusted-orchestrator code (Node, not the net-isolated R sandbox): it is the
// component permitted to touch BigQuery. BigQuery seam = the `bq` CLI, the
// documented tower-side path (CLAUDE.md §4: gcloud SDK POST is broken on this
// box but bq REST works). A future node lacking `bq` mints a token from the SA
// JSON (sa/hopeful-flash-vertex.json, node:crypto JWT) and calls BigQuery REST —
// that is the only line that would change; everything above it is portable.
import os from "node:os";
import { spawnSync } from "node:child_process";
import { computeRegistryHash, runnableMethods } from "./grid-registry.mjs";

const PROJECT = arg("project") || "hopeful-flash-485308-v3";
const TABLE = `${PROJECT}.grid.nodes`;

function arg(name, dflt = null) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const eq = hit.indexOf("=");
  return eq === -1 ? true : hit.slice(eq + 1);
}

// Run a local command, returning trimmed stdout or null (never throws — a missing
// optional tool like `tailscale` must degrade to NULL, not abort registration).
function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return r.status === 0 ? (r.stdout || "").trim() : null;
}

// Run `bq`, throwing on failure (the BQ write is the point — failure must surface).
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

// SQL literal helpers: single-quote a string (doubling embedded quotes) or NULL;
// numbers pass through, NaN/null → NULL (never a fabricated 0).
const S = (v) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const N = (v) => (v == null || Number.isNaN(Number(v)) ? "NULL" : String(Number(v)));

// Measure this node's real identity + capacity + verified surface.
function describeNode() {
  const { hash, n_files } = computeRegistryHash();
  const methods = runnableMethods();
  const tsIp = (() => {
    const ip = sh("tailscale", ["ip", "-4"]);
    return ip ? ip.split(/\s+/)[0] : null; // first IPv4; null if Tailscale absent
  })();
  let caps;
  try {
    caps = arg("capabilities") ? JSON.parse(arg("capabilities")) : {};
  } catch {
    throw new Error("--capabilities must be valid JSON");
  }
  return {
    node_id: arg("node-id") || os.hostname(),
    hostname: os.hostname(),
    tailscale_ip: tsIp,
    cores: os.cpus().length,
    ram_gb: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
    methods: JSON.stringify(methods),
    n_methods: methods.length,
    registry_hash: hash,
    n_files,
    grid_role: arg("role") || "compute",
    status: "active",
    capabilities: JSON.stringify(caps),
  };
}

function buildMergeSQL(n) {
  const src =
    `SELECT ${S(n.node_id)} AS node_id, ${S(n.hostname)} AS hostname, ${S(n.tailscale_ip)} AS tailscale_ip, ` +
    `${N(n.cores)} AS cores, ${N(n.ram_gb)} AS ram_gb, ${S(n.methods)} AS methods, ${N(n.n_methods)} AS n_methods, ` +
    `${S(n.registry_hash)} AS registry_hash, ${S(n.grid_role)} AS grid_role, ${S(n.status)} AS status, ` +
    `${S(n.capabilities)} AS capabilities, CURRENT_TIMESTAMP() AS ts`;
  return (
    `MERGE \`${TABLE}\` T USING (${src}) S ON T.node_id = S.node_id ` +
    `WHEN MATCHED THEN UPDATE SET hostname=S.hostname, tailscale_ip=S.tailscale_ip, cores=S.cores, ram_gb=S.ram_gb, ` +
    `methods=S.methods, n_methods=S.n_methods, registry_hash=S.registry_hash, grid_role=S.grid_role, status=S.status, ` +
    `capabilities=S.capabilities, last_seen=S.ts, expelled_reason=NULL ` +
    `WHEN NOT MATCHED THEN INSERT (node_id,hostname,tailscale_ip,cores,ram_gb,methods,n_methods,registry_hash,grid_role,status,capabilities,joined_at,last_seen,expelled_reason) ` +
    `VALUES (S.node_id,S.hostname,S.tailscale_ip,S.cores,S.ram_gb,S.methods,S.n_methods,S.registry_hash,S.grid_role,S.status,S.capabilities,S.ts,S.ts,NULL)`
  );
}

function printNode(n, head) {
  console.log(head);
  console.log(`  node_id        ${n.node_id}`);
  console.log(`  hostname       ${n.hostname}`);
  console.log(`  tailscale_ip   ${n.tailscale_ip ?? "(none)"}`);
  console.log(`  cores / ram_gb ${n.cores} / ${n.ram_gb}`);
  console.log(`  methods        ${n.n_methods} (${JSON.parse(n.methods).slice(0, 6).join(", ")}${n.n_methods > 6 ? ", …" : ""})`);
  console.log(`  registry_hash  ${n.registry_hash}  (${n.n_files} files)`);
  console.log(`  role / status  ${n.grid_role} / ${n.status}`);
  console.log(`  capabilities   ${n.capabilities}`);
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// node join-grid.mjs                 register this node (role=compute)
// node join-grid.mjs --role=data     register with a role
// node join-grid.mjs --dry           measure only, no BigQuery write
// node join-grid.mjs --list          read back the whole node registry
if (arg("list")) {
  const rows = bqJson(
    `SELECT node_id, hostname, tailscale_ip, cores, ram_gb, n_methods, ` +
      `SUBSTR(registry_hash,1,16) AS hash16, grid_role, status, ` +
      `FORMAT_TIMESTAMP('%Y-%m-%d %H:%M:%S', last_seen) AS last_seen ` +
      `FROM \`${TABLE}\` ORDER BY last_seen DESC`
  );
  console.log(`grid.nodes — ${rows.length} node(s):`);
  for (const r of rows) {
    console.log(
      `  [${r.status}] ${r.node_id}  ${r.tailscale_ip ?? "-"}  ${r.cores}c/${r.ram_gb}g  ` +
        `${r.n_methods} methods  hash=${r.hash16}…  role=${r.grid_role}  seen=${r.last_seen}`
    );
  }
} else {
  const node = describeNode();
  if (arg("dry")) {
    printNode(node, "DRY RUN — would register (no BigQuery write):");
  } else {
    bqExec(buildMergeSQL(node));
    printNode(node, "Registered into grid.nodes:");
    const back = bqJson(
      `SELECT node_id, registry_hash, status, FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', joined_at) AS joined_at, ` +
        `FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', last_seen) AS last_seen FROM \`${TABLE}\` WHERE node_id = ${S(node.node_id)}`
    );
    console.log("Read-back confirms:", JSON.stringify(back[0] || null));
  }
}
