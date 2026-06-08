// dispatch-grid.mjs — Phase 32.1 coordinator-side job dispatch with hash gating.
//
// The coordinator dispatches an analysis to a grid node, but ONLY after the
// ADMISSION GATE passes: the target's row in grid.nodes must be status='active'
// AND its registry_hash must equal the coordinator's canonical execution-surface
// hash (grid-registry.mjs). A node that is missing, expelled, or hash-mismatched is
// REFUSED before any request leaves the coordinator — the gate, not connectivity,
// is what blocks a non-conforming node (even one with a live, capable endpoint).
// Admitted → POST the job to the node's job-server over its advertised
// tailscale_ip:port (the real tailnet path a peer uses), then poll to completion
// and return the result.
//
// THREAT MODEL (honest, NORM invariant): gates on the node's SELF-REPORTED hash —
// drift / version-skew defense across the PI's own nodes, not malicious-node proof
// (that needs coordinator-side re-hashing or signed attestation). Same as
// verify-grid.mjs; this is the dispatch-time application of that same gate.
//
// Trusted-orchestrator code (Node). BQ seam = `bq`; worker transport = node:http.
import http from "node:http";
import { spawnSync } from "node:child_process";
import { computeRegistryHash } from "./grid-registry.mjs";

const PROJECT = arg("project") || "hopeful-flash-485308-v3";
const TABLE = `${PROJECT}.grid.nodes`;

function arg(name) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  const eq = hit.indexOf("=");
  return eq === -1 ? true : hit.slice(eq + 1);
}
function bqJson(sql) {
  const r = spawnSync("bq", ["query", `--project_id=${PROJECT}`, "--use_legacy_sql=false", "--quiet", "--format=json", sql],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`bq query failed (${r.status}): ${((r.stderr || "") + (r.stdout || "")).trim().slice(0, 400)}`);
  const out = (r.stdout || "").trim();
  return out ? JSON.parse(out) : [];
}
const S = (v) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const short = (h) => (h ? `${String(h).slice(0, 12)}…` : "(none)");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal JSON HTTP to a worker's job-server (loopback or tailnet IP).
function httpJson(method, host, port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      { host, port, path, method, timeout: 15000, headers: payload ? { "content-type": "application/json", "content-length": payload.length } : {} },
      (res) => {
        let b = "";
        res.on("data", (d) => (b += d));
        res.on("end", () => {
          let j = null;
          try { j = b ? JSON.parse(b) : null; } catch { /* leave null */ }
          resolve({ status: res.statusCode, json: j, raw: b });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(new Error(`timeout connecting to ${host}:${port}`)); });
    if (payload) req.write(payload);
    req.end();
  });
}

function refuse(msg) {
  console.log(`\n⛔ DISPATCH REFUSED — ${msg}`);
  process.exit(3);
}

const nodeId = arg("node");
const method = arg("method");
const workspace = arg("workspace") || "lab";
const pollTimeoutS = Number(arg("poll-timeout") || 300);
let params = {};
try { params = arg("params") ? JSON.parse(arg("params")) : {}; } catch { refuse("--params must be valid JSON"); }
if (!method) refuse("--method is required");

const { hash: canonical, n_files } = computeRegistryHash();
console.log(`Coordinator canonical hash: ${canonical}  (${n_files} execution-surface files)`);

// Resolve the target node: explicit --node, else the first admissible active node.
let node;
if (nodeId) {
  node = bqJson(`SELECT node_id, tailscale_ip, registry_hash, status, capabilities FROM \`${TABLE}\` WHERE node_id=${S(nodeId)}`)[0];
  if (!node) refuse(`node '${nodeId}' not found in grid.nodes`);
} else {
  const cands = bqJson(`SELECT node_id, tailscale_ip, registry_hash, status, capabilities FROM \`${TABLE}\` WHERE status='active' AND registry_hash=${S(canonical)} ORDER BY last_seen DESC`);
  if (!cands.length) refuse("no active node matches the canonical hash");
  node = cands[0];
  console.log(`Auto-selected admissible node: ${node.node_id}`);
}

// ── THE GATE ────────────────────────────────────────────────────────────────
console.log(`\nTarget node: ${node.node_id}  status=${node.status}  advertised=${short(node.registry_hash)}`);
if (node.status !== "active") refuse(`node '${node.node_id}' is not active (status=${node.status})`);
if (node.registry_hash !== canonical)
  refuse(`registry_hash mismatch for '${node.node_id}': advertised ${short(node.registry_hash)} ≠ canonical ${short(canonical)} — node runs a different engine`);
let caps = {};
try { caps = node.capabilities ? JSON.parse(node.capabilities) : {}; } catch { /* ignore */ }
const port = caps.job_server_port;
if (!port) refuse(`node '${node.node_id}' advertises no capabilities.job_server_port`);
const host = node.tailscale_ip || "127.0.0.1";
console.log(`✅ GATE PASSED — node admitted (hash matches canonical, status active).`);
console.log(`   Dispatching ${method}(${JSON.stringify(params)}) → http://${host}:${port}/api/jobs/submit  [ws=${workspace}]`);

// ── DISPATCH + POLL ───────────────────────────────────────────────────────────
const sub = await httpJson("POST", host, port, "/api/jobs/submit", { workspace, method, params }).catch((e) => refuse(`worker unreachable: ${e.message}`));
if (!sub || sub.status !== 202) refuse(`worker rejected submit (HTTP ${sub && sub.status}): ${JSON.stringify(sub && sub.json)}`);
const { job_id, poll_url, permalink } = sub.json;
console.log(`   Accepted: ${job_id}  (poll ${poll_url})`);

const deadline = Date.now() + pollTimeoutS * 1000;
let job;
while (Date.now() < deadline) {
  await sleep(1500);
  const r = await httpJson("GET", host, port, poll_url, null).catch(() => null);
  job = r && r.json;
  if (!job) continue;
  const st = job.status;
  process.stdout.write(`\r   status=${st} stage=${job.progress?.stage ?? "-"} elapsed=${job.progress?.elapsed_s ?? "?"}s   `);
  if (st !== "queued" && st !== "running") break;
}
console.log("");
if (!job || job.status === "queued" || job.status === "running") refuse(`timed out after ${pollTimeoutS}s (last status=${job?.status})`);

if (job.status === "succeeded" || job.status === "done") {
  console.log(`\n✅ DISPATCH SUCCEEDED on ${node.node_id} (${host}:${port})`);
  console.log(`   permalink: ${permalink}`);
  console.log(`   result: ${JSON.stringify(job.result)}`);
} else {
  console.log(`\n⚠️  job ${job_id} terminal status='${job.status}' error=${job.error}`);
  process.exit(4);
}
