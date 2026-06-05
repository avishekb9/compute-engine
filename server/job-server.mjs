// job-server.mjs — Econstellar async process manager (Tier A) — TOWER worker.
// Zero dependency. Runs the SAME parameterised-only registered R methods as the kernel,
// but asynchronously: POST /api/jobs/submit returns a job_id immediately; the worker runs
// the job on this always-on tower (no Cloud Run 300s cap, no CPU throttling); progress
// streams via SSE; job records + results persist to .jobs/ (durable across restarts) for a
// 30-day permalink. Security: submission is workspace-gated; runnable methods are exactly
// the r/*.R registry (no arbitrary execution). Default bind 127.0.0.1; HOST=0.0.0.0 to
// expose over Tailscale to the lab.
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = path.join(__dirname, "..");                 // compute-engine/
const R_DIR = path.join(ENGINE_DIR, "r");
const JOBS_DIR = path.join(ENGINE_DIR, ".jobs");
const REPO = process.env.COMPUTE_REPO || path.join(ENGINE_DIR, "..");
const PORT = Number(process.env.JOB_PORT || 3030);
const HOST = process.env.HOST || "127.0.0.1";
const MAX_CONCURRENT = Number(process.env.JOB_CONCURRENCY || 2);
const JOB_TTL_MS = 30 * 24 * 3600 * 1000;
const JOBS_BUCKET = process.env.JOBS_BUCKET || "econstellar-jobs";   // GCS mirror for the public read-front
const TOKEN_URL = process.env.GCLOUD_TOKEN_URL || "http://localhost:3001/api/gcloud-token";
const PORTAL = "https://avishekb9.github.io/econstellar/research-engine.html";
const WORKSPACES = new Set((process.env.JOB_WORKSPACES || "avishekb,lab")
  .split(",").map(s => s.trim()).filter(Boolean));
const METHODS = new Set(fs.readdirSync(R_DIR)
  .filter(f => f.endsWith(".R") && !f.startsWith("_")).map(f => f.replace(/\.R$/, "")));

fs.mkdirSync(JOBS_DIR, { recursive: true });

const jobs = new Map();            // id -> job record
const listeners = new Map();       // id -> Set(res) SSE subscribers
const queue = [];                  // queued ids
let running = 0;

const now = () => new Date().toISOString();
const jobFile = id => path.join(JOBS_DIR, id + ".json");
const persist = j => { try { fs.writeFileSync(jobFile(j.job_id), JSON.stringify(j)); } catch {} };
const publicJob = j => { const { _last, ...rest } = j; return rest; };

// Best-effort mirror of a terminal job record to gs://<JOBS_BUCKET>/<id>.json so the
// Cloud Run kernel can serve a public read-only permalink. This tower is NOT on GCP
// (no metadata server), so the OAuth token comes from the running proxy. Fully
// fire-and-forget: any failure (proxy down, GCS unreachable, non-2xx) is logged and
// swallowed — it MUST never fail or delay a job.
function fetchGcloudToken() {
  return new Promise((resolve) => {
    const req = http.get(TOKEN_URL, { timeout: 5000 }, (r) => {
      let b = ""; r.on("data", d => b += d);
      r.on("end", () => { try { resolve(JSON.parse(b).token || null); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}
async function mirrorToGcs(job) {
  try {
    const tok = await fetchGcloudToken();
    if (!tok) { console.log(`[job-server] gcs-mirror skipped (no token) ${job.job_id}`); return; }
    const data = Buffer.from(JSON.stringify(publicJob(job)));
    const url = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(JOBS_BUCKET)}/o`
      + `?uploadType=media&name=${encodeURIComponent(job.job_id + ".json")}`;
    await new Promise((resolve) => {
      const req = https.request(url, { method: "POST", timeout: 15000,
        headers: { "Authorization": `Bearer ${tok}`, "Content-Type": "application/json", "Content-Length": data.length } },
        (r) => { r.resume(); r.on("end", () => {
          if (r.statusCode >= 200 && r.statusCode < 300) console.log(`[job-server] gcs-mirror ok ${job.job_id} -> gs://${JOBS_BUCKET}/${job.job_id}.json`);
          else console.log(`[job-server] gcs-mirror failed (HTTP ${r.statusCode}) ${job.job_id}`);
          resolve();
        }); });
      req.on("error", (e) => { console.log(`[job-server] gcs-mirror error ${job.job_id}: ${e.message}`); resolve(); });
      req.on("timeout", () => { req.destroy(); console.log(`[job-server] gcs-mirror timeout ${job.job_id}`); resolve(); });
      req.end(data);
    });
  } catch (e) { console.log(`[job-server] gcs-mirror exception ${job.job_id}: ${e.message}`); }
}

function loadAll() {
  for (const f of fs.readdirSync(JOBS_DIR).filter(f => f.endsWith(".json"))) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), "utf8"));
      if (j.status === "running" || j.status === "queued") { j.status = "queued"; queue.push(j.job_id); }
      jobs.set(j.job_id, j);
    } catch {}
  }
}
function notify(id, event, data) {
  const set = listeners.get(id); if (!set) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) { try { res.write(payload); } catch {} }
}
function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = jobs.get(queue.shift());
    if (job && job.status === "queued") runJob(job);
  }
}
function runJob(job) {
  running++;
  job.status = "running"; job.started_at = now();
  job.progress = { fraction: 0, stage: "starting", elapsed_s: 0 };
  persist(job); notify(job.job_id, "progress", job.progress);
  const args = [path.join(R_DIR, job.method + ".R"), JSON.stringify(job.params || {})];
  const env = { ...process.env, CE_PROGRESS: "1", COMPUTE_REPO: REPO };
  const child = spawn("Rscript", args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let buf = "", err = "";
  child.stdout.on("data", d => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (o && o.__progress__) {
          job.progress = { fraction: o.fraction, stage: o.stage, elapsed_s: o.elapsed_s };
          persist(job); notify(job.job_id, "progress", job.progress);
        } else { job._last = o; }     // a non-progress JSON line (defensive)
      } catch { /* non-JSON debug line: ignore */ }
    }
  });
  child.stderr.on("data", d => { err += d.toString(); });
  child.on("error", e => finish(job, false, null, `spawn failed: ${e.message}`));
  child.on("close", code => {
    let result = job._last || null;
    const tail = buf.trim();                 // ce_emit prints the final JSON without a newline
    if (tail) { try { result = JSON.parse(tail); } catch {} }
    if (code !== 0 || !result || result.error)
      finish(job, false, null, (result && result.error) || `exit ${code}${err ? ": " + err.slice(0, 300) : ""}`);
    else
      finish(job, true, result, null);
  });
}
function finish(job, ok, result, error) {
  running = Math.max(0, running - 1);
  delete job._last;
  job.status = ok ? "succeeded" : "failed";
  job.finished_at = now();
  job.result = ok ? result : null;
  job.error = ok ? null : error;
  job.provenance = {
    method: job.method, params: job.params, worker: os.hostname(),
    panel_id: (job.params && job.params.dataset) || "g20",
    timestamp: job.finished_at, permalink: job.permalink,
  };
  persist(job);
  mirrorToGcs(job);   // best-effort GCS mirror for the public read-front (fire-and-forget; never blocks)
  notify(job.job_id, ok ? "done" : "error",
    { status: job.status, error: job.error, poll_url: `/api/jobs/${job.job_id}` });
  const set = listeners.get(job.job_id);
  if (set) { for (const res of set) { try { res.end(); } catch {} } listeners.delete(job.job_id); }
  pump();
}

function sendJSON(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(b);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" });
    return res.end();
  }
  if (p === "/health")
    return sendJSON(res, 200, { ok: true, service: "job-server", worker: os.hostname(), methods: METHODS.size, running, queued: queue.length });
  if (p === "/api/jobs" && req.method === "GET")
    return sendJSON(res, 200, { jobs: [...jobs.values()].map(j => ({ job_id: j.job_id, method: j.method, status: j.status, submitted_at: j.submitted_at })) });

  if (p === "/api/jobs/submit" && req.method === "POST") {
    let body = ""; req.on("data", d => { body += d; if (body.length > 65536) req.destroy(); });
    req.on("end", () => {
      let b; try { b = JSON.parse(body || "{}"); } catch { return sendJSON(res, 400, { error: "bad JSON" }); }
      if (!b.workspace || !WORKSPACES.has(String(b.workspace))) return sendJSON(res, 401, { error: "missing or unknown workspace" });
      if (!b.method || !METHODS.has(b.method)) return sendJSON(res, 404, { error: `unknown method '${b.method}'`, available: [...METHODS] });
      const id = `job_${new Date().toISOString().slice(0, 10).replace(/-/g, "")}_${crypto.randomBytes(4).toString("hex")}`;
      const permalink = `${PORTAL}#job=${id}`;
      const job = {
        job_id: id, method: b.method, params: b.params || {}, workspace: String(b.workspace),
        status: "queued", progress: { fraction: 0, stage: "queued", elapsed_s: 0 },
        result: null, error: null, submitted_at: now(), started_at: null, finished_at: null, permalink,
      };
      jobs.set(id, job); persist(job); queue.push(id); pump();
      return sendJSON(res, 202, { job_id: id, status: "queued", poll_url: `/api/jobs/${id}`, stream_url: `/api/jobs/${id}/stream`, permalink });
    });
    return;
  }

  const m = p.match(/^\/api\/jobs\/([^/]+?)(\/stream)?$/);
  if (m && req.method === "GET") {
    const id = m[1]; const job = jobs.get(id);
    if (!job) return sendJSON(res, 404, { error: "unknown or expired job" });
    if (m[2]) {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });
      res.write(`event: progress\ndata: ${JSON.stringify(job.progress || {})}\n\n`);
      if (job.status === "succeeded" || job.status === "failed") {
        res.write(`event: ${job.status === "succeeded" ? "done" : "error"}\ndata: ${JSON.stringify({ status: job.status, error: job.error, poll_url: `/api/jobs/${id}` })}\n\n`);
        return res.end();
      }
      if (!listeners.has(id)) listeners.set(id, new Set());
      listeners.get(id).add(res);
      const hb = setInterval(() => { try { res.write(": hb\n\n"); } catch {} }, 15000);
      req.on("close", () => { clearInterval(hb); listeners.get(id)?.delete(res); });
      return;
    }
    return sendJSON(res, 200, publicJob(job));
  }
  sendJSON(res, 404, { error: "not found" });
});

setInterval(() => {
  const t = Date.now();
  for (const [id, j] of jobs) {
    const fin = Date.parse(j.finished_at || j.submitted_at);
    if (t - fin > JOB_TTL_MS) { jobs.delete(id); try { fs.unlinkSync(jobFile(id)); } catch {} }
  }
}, 3600 * 1000).unref();

loadAll(); pump();
server.listen(PORT, HOST, () =>
  console.log(`[job-server] http://${HOST}:${PORT} methods=${METHODS.size} concurrency=${MAX_CONCURRENT} jobs=${JOBS_DIR}`));
