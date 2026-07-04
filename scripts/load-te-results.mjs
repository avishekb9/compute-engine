#!/usr/bin/env node
// load-te-results.mjs — idempotent GCS -> BigQuery sync of GPU-sweep TE results.
//
// Scans the sweep result prefixes for *.json blobs, skips run_ids already present
// in systemic_risk.te_networks, and loads the rest with full provenance (params
// JSON + source blob URI). Safe to run on every nightly tick: no blob is loaded
// twice, no row is ever mutated. Requires gcloud + bq on PATH (tower/nightly-loop
// environment) — deliberately shell-tool based so it carries zero npm deps, like
// the other nightly scripts.
//
// Usage: node scripts/load-te-results.mjs [--dry]
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT = "hopeful-flash-485308-v3";
const TABLE = "systemic_risk.te_networks";
// The generic Vertex runner uploads every result to this one prefix as
// <RESULT_NAME>-vertex-<UTCSTAMP>-job<ID>.json, whatever the bundle.
const PREFIXES = ["gs://econstellar-jobs/ksg-gpu/results/"];
const DRY = process.argv.includes("--dry");

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

// 1. blobs already loaded (dedup on the source blob URI: regime blobs fan out
// into several rows with suffixed run_ids, so run_id is not the load unit)
const existing = new Set(
  sh("bq", ["query", `--project_id=${PROJECT}`, "--use_legacy_sql=false", "--format=csv", "--quiet",
    `SELECT DISTINCT source_uri FROM \`${PROJECT}.${TABLE}\` WHERE source_uri IS NOT NULL`])
    .trim().split("\n").slice(1).filter(Boolean)
);

// 2. candidate blobs
const blobs = PREFIXES.flatMap(p => {
  try { return sh("gcloud", ["storage", "ls", p]).trim().split("\n").filter(u => u.endsWith(".json")); }
  catch { return []; }   // prefix may not exist yet
});

// run_id = blob basename minus .json, minus the job suffix noise, kept stable + unique
const runIdOf = (uri) => uri.split("/").pop().replace(/\.json$/, "").slice(0, 64);

const fresh = blobs.filter(b => !existing.has(b));
console.log(`te-results: ${blobs.length} blobs, ${existing.size} already loaded, ${fresh.length} new`);
if (!fresh.length || DRY) { if (DRY && fresh.length) console.log(fresh.join("\n")); process.exit(0); }

// 3. build NDJSON rows
const dir = mkdtempSync(join(tmpdir(), "te-load-"));
const rows = [];
const topOf = (edges) => (edges || [])
  .filter(e => (e.p ?? 1) < 0.05)
  .sort((a, b) => (b.te || 0) - (a.te || 0))
  .slice(0, 10);
const pushRow = (runId, ts, d, block, regime) => rows.push(JSON.stringify({
  run_id: runId,
  created: ts,
  dataset: d.dataset ?? null,
  method: d.method ?? "ksg_te",
  params: ({
    B: d.n_surrogates ?? d.B ?? null, k: d.k ?? null, lag: d.lag ?? null, seed: d.seed ?? null,
    n_obs: block.n_obs ?? d.n_obs ?? null, n_series: d.n_series ?? d.n_markets ?? null,
    gpu: block.gpu_device ?? d.gpu_device ?? null, runtime_s: d.runtime_s ?? null,
    window: d.window ?? null, step: d.step ?? null, regime,
  }),
  n_pairs: block.n_pairs ?? (Array.isArray(block.edges) ? block.edges.length : null),
  n_significant: block.n_significant ?? null,
  top: block.top ?? block.top_edges ?? topOf(block.edges),
  edges: block.edges ?? [],
  source_uri: block.source_uri ?? null,
}));
for (const uri of fresh) {
  let d;
  try { d = JSON.parse(sh("gcloud", ["storage", "cat", uri])); }
  catch (e) { console.error(`skip ${uri}: unreadable (${e.message})`); continue; }
  const created = (uri.match(/(\d{8}T\d{6}Z)/) || [])[1];
  const ts = created
    ? `${created.slice(0, 4)}-${created.slice(4, 6)}-${created.slice(6, 8)} ${created.slice(9, 11)}:${created.slice(11, 13)}:${created.slice(13, 15)}`
    : new Date().toISOString().slice(0, 19).replace("T", " ");
  const base = { source_uri: uri };
  if (Array.isArray(d.regimes)) {
    // regime-conditioned sweeps carry one block per regime: one rail row each,
    // run_id suffixed with the regime name so the dedup key stays unique
    for (const r of d.regimes) {
      const tag = String(r.regime ?? "r");
      pushRow(`${runIdOf(uri).slice(0, 63 - tag.length)}-${tag}`, ts, d, { ...r, ...base }, r.regime ?? null);
    }
  } else if (Array.isArray(d.windows)) {
    // rolling sweeps: one summary row; the per-window series stays in the blob
    // (edges holds the peak-fragility window's edge list when present)
    const peak = d.peak_window ?? {};
    pushRow(runIdOf(uri), ts, d, {
      n_pairs: d.n_pairs ?? null, n_significant: d.n_significant ?? null,
      edges: peak.edges ?? [], top: topOf(peak.edges), ...base,
    }, null);
  } else {
    pushRow(runIdOf(uri), ts, d, { ...d, ...base }, null);
  }
}
if (!rows.length) process.exit(0);
const nd = join(dir, "rows.ndjson");
writeFileSync(nd, rows.join("\n") + "\n");

// 4. append-load
sh("bq", ["load", `--project_id=${PROJECT}`, "--source_format=NEWLINE_DELIMITED_JSON", TABLE, nd]);
console.log(`loaded ${rows.length} new run(s) into ${TABLE}`);
