// upgrade-capabilities.mjs — Track-B GCP capabilities, each behind a default-OFF
// feature flag with its own typed-param gate and pre-registered spend ceiling
// (zero deps; mirrors the kernel's fetch + metadata-OAuth idiom in compute-server.mjs).
//
// CONTRACT (governed by UPGRADE_INVARIANTS.md / upgrade/*.md):
//   • Every capability is OFF unless its CE_CAP_* flag is exactly "1"/"true"
//     (Invariant 16 — default-OFF, least-privilege).
//   • Governance runs BEFORE any paid call, in this order: flag → typed params →
//     (datastore hole) → capBudget ceiling. A rejection returns a CODED error and
//     spends nothing (Invariant 11) — never a fabricated answer. The paid call is
//     only reached after every gate passes.
//   • No secret is read into a prompt, a log line, or a return value; the OAuth
//     token is minted at the infrastructure boundary and used as a bearer only,
//     referenced by env name, never by value (Invariant 12).
//   • The model originates no number: the Gemini-on-Vertex route is a transport
//     swap only — the model's sole tool remains the registry run_analysis(method,
//     params) gate wired by the kernel's existing two-phase loop (Invariant 13).
//
// TRACK-B DEPLOY BOUNDARY: this module is deploy-ready but inert — flags default
// OFF and nothing here is enabled or called at scale in-session. Flipping a flag
// ON and deploying spends real research credits and is PI-gated (Invariants 11/15/16).

import http from "node:http";
import { capBudget } from "./guards.mjs";

const PROJECT = process.env.GCP_PROJECT_ID || "hopeful-flash-485308-v3";
const LOCATION = process.env.VERTEX_LOCATION || "us-central1";

// a flag is OFF unless explicitly "1" or "true" (unset / any other value = OFF)
function flagOn(env, name) {
  const v = (env[name] || "").toString().trim().toLowerCase();
  return v === "1" || v === "true";
}
// positive integer env with a default (rejects 0, negatives, NaN)
function intEnv(env, name, dflt) {
  const n = parseInt(env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
// deliberately-rough token estimate for the ceiling (chars/4). A spend ceiling
// needs an upper-ish bound, not the exact billed count — the cap stays conservative.
function tokenEstimate(s) { return Math.max(1, Math.ceil(String(s).length / 4)); }

// coded-error envelopes (the route maps .http to an HTTP status; .code is stable)
const off  = (cap)         => ({ ok: false, code: "CAPABILITY_OFF",    http: 503, cap, detail: `${cap} is disabled (flag default OFF)` });
const bad  = (cap, detail) => ({ ok: false, code: "BAD_PARAMS",        http: 400, cap, detail });
const over = (cap, b)      => ({ ok: false, code: "CAP_EXCEEDED",      http: 503, cap, detail: "daily spend ceiling reached", used: b.used, want: b.want, max: b.max });
const hole = (cap, detail) => ({ ok: false, code: "DATASTORE_MISSING", http: 501, cap, detail });

// ── OAuth bearer (boundary-minted, never logged) ────────────────────────────
// Mirrors compute-server.mjs metadataToken(): plain HTTP to the metadata server,
// or the GOOGLE_OAUTH_TOKEN env override for local/non-Cloud-Run hosts.
let _tok = null, _tokExp = 0;
function metadataToken() {
  if (process.env.GOOGLE_OAUTH_TOKEN) return Promise.resolve(process.env.GOOGLE_OAUTH_TOKEN);
  if (_tok && Date.now() < _tokExp) return Promise.resolve(_tok);
  return new Promise((resolve) => {
    const req = http.request(
      { host: "metadata.google.internal", path: "/computeMetadata/v1/instance/service-accounts/default/token",
        headers: { "Metadata-Flavor": "Google" }, timeout: 4000 },
      (r) => { let b = ""; r.on("data", d => b += d); r.on("end", () => {
        try { const j = JSON.parse(b); if (!j.access_token) return resolve(null);
          _tok = j.access_token; _tokExp = Date.now() + Math.max(0, (j.expires_in - 120)) * 1000; resolve(_tok);
        } catch { resolve(null); } }); });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// POST JSON with the bearer; never logs the token or body. The bearer is passed
// in the Authorization header only and is not interpolated into any logged string.
async function postJSON(url, bearer, body, extraHeaders = {}) {
  if (!bearer) return { ok: false, code: "NO_TOKEN", http: 503, detail: "no boundary OAuth token available" };
  let r;
  try {
    r = await fetch(url, { method: "POST",
      // X-Goog-User-Project sets the quota/billing project on the OAuth path (required
      // by discoveryengine, harmless on the metadata-SA path); bearer in header only.
      headers: { "Authorization": `Bearer ${bearer}`, "Content-Type": "application/json", "X-Goog-User-Project": PROJECT, ...extraHeaders },
      body: JSON.stringify(body) });
  } catch (e) { return { ok: false, code: "UPSTREAM_UNREACHABLE", http: 502, detail: e.message }; }
  if (!r.ok) {
    let etext = ""; try { etext = await r.text(); } catch {}   // upstream error body is not secret
    return { ok: false, code: "UPSTREAM_ERROR", http: 502, status: r.status, detail: etext.slice(0, 300) };
  }
  let data = null; try { data = await r.json(); } catch {}
  return { ok: true, status: r.status, data };
}

// ── Capability 1: text embeddings over the literature corpus ────────────────
// Launch-order #1 (lowest blast radius: read-only, ~Rs.4/day). Billed in tokens.
const embeddings = {
  name: "embeddings", flagEnv: "CE_CAP_EMBEDDINGS", originatesNoNumber: true,
  precheck(params, env) {
    if (!flagOn(env, this.flagEnv)) return off(this.name);
    const docs = params && params.docs;
    const batchMax = intEnv(env, "CE_EMBEDDINGS_BATCH_MAX", 1000);
    if (!Array.isArray(docs) || docs.length < 1) return bad(this.name, "docs must be a non-empty array of strings");
    if (docs.length > batchMax) return bad(this.name, `batch size ${docs.length} exceeds ${batchMax}`);
    if (!docs.every(d => typeof d === "string" && d.length > 0)) return bad(this.name, "every doc must be a non-empty string");
    const tokens = docs.reduce((s, d) => s + tokenEstimate(d), 0);
    const dailyMax = intEnv(env, "CE_EMBEDDINGS_TOKENS_PER_DAY", 2000000);
    const b = capBudget("embeddings", dailyMax, tokens);   // reserve BEFORE the call
    if (!b.ok) return over(this.name, b);
    return { ok: true, plan: { kind: "embeddings", model: "text-embedding-004", tokens,
      instances: docs.map(content => ({ content, task_type: "RETRIEVAL_DOCUMENT" })) } };
  },
  async execute(plan, { tokenFn }) {
    const tok = await (tokenFn || metadataToken)();
    const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${plan.model}:predict`;
    const res = await postJSON(url, tok, { instances: plan.instances });
    if (!res.ok) return res;
    return { ok: true, code: "OK", cap: this.name, tokens: plan.tokens, predictions: (res.data && res.data.predictions) || [] };
  },
};

// ── Capability 2: Vertex AI Search / grounded generation ────────────────────
// Launch-order #2. NOT-LAUNCHABLE today: no datastore (COST_MODEL marked hole).
// Double-gated — even flag-ON returns the marked hole until a datastore exists,
// and the hole is checked BEFORE the ceiling so an impossible call spends nothing.
const groundedSearch = {
  name: "grounded_search", flagEnv: "CE_CAP_GROUNDED_SEARCH", originatesNoNumber: true,
  precheck(params, env) {
    if (!flagOn(env, this.flagEnv)) return off(this.name);
    const query = params && params.query;
    if (typeof query !== "string" || !query.trim()) return bad(this.name, "query must be a non-empty string");
    if (query.length > 1024) return bad(this.name, "query exceeds 1024 chars");
    const datastore = (env.CE_GROUNDED_DATASTORE || "").trim();
    if (!datastore) return hole(this.name, "no literature datastore provisioned (Invariant 3 marked hole; NOT-LAUNCHABLE until built)");
    const dailyMax = intEnv(env, "CE_GROUNDED_QUERIES_PER_DAY", 200);
    const b = capBudget("grounded_search", dailyMax, 1);
    if (!b.ok) return over(this.name, b);
    // prefer the engine (search app) serving config; fall back to the datastore one
    const engine = (env.CE_GROUNDED_ENGINE || "").trim();
    return { ok: true, plan: { kind: "grounded_search", datastore, engine, query } };
  },
  async execute(plan, { tokenFn }) {
    const tok = await (tokenFn || metadataToken)();
    const base = `https://discoveryengine.googleapis.com/v1/projects/${PROJECT}/locations/global/collections/default_collection`;
    const parent = plan.engine ? `${base}/engines/${plan.engine}` : `${base}/dataStores/${plan.datastore}`;
    const url = `${parent}/servingConfigs/default_search:search`;
    // discoveryengine needs the quota project on the OAuth path
    const res = await postJSON(url, tok, { query: plan.query, pageSize: 10 }, { "X-Goog-User-Project": PROJECT });
    if (!res.ok) return res;
    // grounding metadata (retrieved passages + source ids) travels with the answer;
    // the citation-integrity eval (Prompt 7, when the datastore exists) asserts every
    // cited source is a real retrieved passage, not invented (Invariant 13).
    return { ok: true, code: "OK", cap: this.name, results: (res.data && res.data.results) || [] };
  },
};

// ── Capability 3: Gemini on the Vertex (aiplatform) endpoint ─────────────────
// Launch-order #3. Behaviour-preserving transport swap from the API-key path; the
// no-number contract and the registry tool gate are unchanged. Flash and Pro carry
// separate daily ceilings (COST_MODEL: 300 / 100).
const geminiVertex = {
  name: "gemini_vertex", flagEnv: "CE_CAP_GEMINI_VERTEX", originatesNoNumber: true,
  precheck(params, env) {
    if (!flagOn(env, this.flagEnv)) return off(this.name);
    const model = params && params.model;
    const contents = params && params.contents;
    if (model !== "flash" && model !== "pro") return bad(this.name, "model must be 'flash' or 'pro'");
    if (typeof contents !== "string" || !contents.trim()) return bad(this.name, "contents must be a non-empty string");
    if (contents.length > 32768) return bad(this.name, "contents exceeds 32768 chars");
    const perDay = model === "pro"
      ? intEnv(env, "CE_GEMINI_VERTEX_PRO_PER_DAY", 100)
      : intEnv(env, "CE_GEMINI_VERTEX_FLASH_PER_DAY", 300);
    const b = capBudget("gemini_vertex_" + model, perDay, 1);
    if (!b.ok) return over(this.name, b);
    const vmodel = model === "pro" ? "gemini-2.5-pro" : "gemini-2.5-flash";
    return { ok: true, plan: { kind: "gemini_vertex", model: vmodel, contents } };
  },
  async execute(plan, { tokenFn }) {
    const tok = await (tokenFn || metadataToken)();
    const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/publishers/google/models/${plan.model}:generateContent`;
    const res = await postJSON(url, tok, { contents: [{ role: "user", parts: [{ text: plan.contents }] }] });
    if (!res.ok) return res;
    return { ok: true, code: "OK", cap: this.name, candidates: (res.data && res.data.candidates) || [] };
  },
};

// ── Capability 4: batch prediction (async bulk embeddings) ──────────────────
// Launch-order #4. Stages a JSONL of instances to GCS, submits a Vertex
// batchPredictionJob over text-embedding-004, returns the async job name. Bounded
// by 1 batch/day and <=50k items (COST_MODEL ≤$5/day). The job runs async on
// Vertex; the caller polls the returned job name. No number is model-originated —
// the output is a deterministic embedding written to GCS.
const batchPredict = {
  name: "batch_predict", flagEnv: "CE_CAP_BATCH_PREDICT", originatesNoNumber: true,
  precheck(params, env) {
    if (!flagOn(env, this.flagEnv)) return off(this.name);
    const items = params && params.items;
    const itemsMax = intEnv(env, "CE_BATCH_ITEMS_MAX", 50000);
    if (!Array.isArray(items) || items.length < 1) return bad(this.name, "items must be a non-empty array");
    if (items.length > itemsMax) return bad(this.name, `batch of ${items.length} exceeds ${itemsMax}`);
    if (!items.every(d => typeof d === "string" && d.length > 0)) return bad(this.name, "every item must be a non-empty string");
    const perDay = intEnv(env, "CE_BATCH_PER_DAY", 1);
    const b = capBudget("batch_predict", perDay, 1);
    if (!b.ok) return over(this.name, b);
    const bucket = (env.CE_BATCH_BUCKET || "econstellar-jobs").trim();
    return { ok: true, plan: { kind: "batch_predict", count: items.length, items, bucket } };
  },
  async execute(plan, { tokenFn }) {
    const tok = await (tokenFn || metadataToken)();
    if (!tok) return { ok: false, code: "NO_TOKEN", http: 503, cap: this.name, detail: "no boundary OAuth token available" };
    // deterministic-ish unique prefix (kernel context; Date/random are available here)
    const stamp = Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e9).toString(36);
    const objPath = `batch/${stamp}/input.jsonl`;
    const inputUri = `gs://${plan.bucket}/${objPath}`;
    const outputPrefix = `gs://${plan.bucket}/batch/${stamp}/out/`;
    const jsonl = plan.items.map(t => JSON.stringify({ content: t })).join("\n") + "\n";
    // stage the input to GCS (simple media upload; bearer in header only, never logged)
    const upUrl = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(plan.bucket)}/o?uploadType=media&name=${encodeURIComponent(objPath)}`;
    let up;
    try { up = await fetch(upUrl, { method: "POST", headers: { "Authorization": `Bearer ${tok}`, "Content-Type": "application/x-ndjson" }, body: jsonl }); }
    catch (e) { return { ok: false, code: "UPSTREAM_UNREACHABLE", http: 502, cap: this.name, detail: e.message }; }
    if (!up.ok) return { ok: false, code: "GCS_UPLOAD_FAILED", http: 502, cap: this.name, status: up.status };
    // submit the async batch prediction job
    const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/batchPredictionJobs`;
    const res = await postJSON(url, tok, {
      displayName: `ce-batch-${stamp}`,
      model: "publishers/google/models/text-embedding-004",
      inputConfig: { instancesFormat: "jsonl", gcsSource: { uris: [inputUri] } },
      outputConfig: { predictionsFormat: "jsonl", gcsDestination: { outputUriPrefix: outputPrefix } },
    });
    if (!res.ok) return res;
    return { ok: true, code: "OK", cap: this.name, count: plan.count,
      job: res.data && res.data.name, state: res.data && res.data.state, input: inputUri, output: outputPrefix };
  },
};

// ── Capability 5: Claude on Vertex (Model Garden) — second-opinion reviewer ───
// Launch-order #5. A DIFFERENT-family model (Anthropic Claude via the Vertex
// rawPredict surface) that cross-checks the engine's Gemini research answer. Same
// no-number contract as every other cap: Claude REVIEWS the answer's reasoning and
// claims — it originates no number (every number still traces to the registry
// run_analysis). Claude on Vertex is served from its own endpoints, so it carries its
// own LOCATION; both model and location are env-set because the Anthropic models must
// first be enabled in Model Garden for this project (a one-time console action that
// accepts Anthropic's terms), so changing model/region needs no code change. The
// default is the strongest model (`claude-opus-4-8`, which the PI enabled on Vertex) on the
// recommended `global` endpoint (no regional pricing premium); set
// CE_MULTIMODEL_MODEL=claude-sonnet-4-6 for a cheaper review. Billed per token; bounded to
// CE_MULTIMODEL_PER_DAY calls/day. (Access is enabled; an online-prediction quota grant is
// the remaining gate before a live call succeeds — see upgrade/UPGRADE_LEDGER.md.)
const multimodel = {
  name: "multimodel", flagEnv: "CE_CAP_MULTIMODEL", originatesNoNumber: true,
  precheck(params, env) {
    if (!flagOn(env, this.flagEnv)) return off(this.name);
    const contents = params && params.contents;
    if (typeof contents !== "string" || !contents.trim()) return bad(this.name, "contents must be a non-empty string");
    const maxChars = intEnv(env, "CE_MULTIMODEL_MAX_CHARS", 100000);
    if (contents.length > maxChars) return bad(this.name, `contents exceeds ${maxChars} chars`);
    const perDay = intEnv(env, "CE_MULTIMODEL_PER_DAY", 50);
    const b = capBudget("multimodel", perDay, 1);   // reserve BEFORE the call
    if (!b.ok) return over(this.name, b);
    const model = (env.CE_MULTIMODEL_MODEL || "claude-opus-4-8").trim();
    const location = (env.CE_MULTIMODEL_LOCATION || "global").trim();
    const maxTokens = intEnv(env, "CE_MULTIMODEL_MAX_TOKENS", 1024);
    return { ok: true, plan: { kind: "multimodel", model, location, contents, maxTokens } };
  },
  async execute(plan, { tokenFn }) {
    const tok = await (tokenFn || metadataToken)();
    // Anthropic-on-Vertex rawPredict: the model id is in the URL, the body is the
    // Anthropic Messages shape carrying the required vertex anthropic_version (and
    // NO model field in the body). The bearer is header-only, never logged.
    // Endpoint host differs by location: the recommended `global` endpoint is the
    // UNPREFIXED host `aiplatform.googleapis.com` (with locations/global in the path),
    // whereas a regional endpoint is `<region>-aiplatform.googleapis.com`.
    const host = plan.location === "global" ? "aiplatform.googleapis.com" : `${plan.location}-aiplatform.googleapis.com`;
    const url = `https://${host}/v1/projects/${PROJECT}/locations/${plan.location}/publishers/anthropic/models/${plan.model}:rawPredict`;
    const res = await postJSON(url, tok, {
      anthropic_version: "vertex-2023-10-16",
      max_tokens: plan.maxTokens,
      messages: [{ role: "user", content: plan.contents }],
    });
    if (!res.ok) return res;
    const text = ((res.data && res.data.content) || []).filter(p => p && p.type === "text").map(p => p.text).join("");
    return { ok: true, code: "OK", cap: this.name, model: plan.model, text, stop_reason: (res.data && res.data.stop_reason) || null };
  },
};

// the registry, keyed by capability name
export const CAPS = {
  embeddings,
  grounded_search: groundedSearch,
  gemini_vertex: geminiVertex,
  batch_predict: batchPredict,
  multimodel,
};

// Single entry point a route would call. Governance first; the paid call is only
// reached when precheck returns ok. With { dryRun:true } it stops after governance
// (used by the eval to prove a gate passed without spending). { tokenFn } injects a
// token source for tests; production uses the boundary metadata token.
export async function runCapability(name, params, opts = {}) {
  const env = opts.env || process.env;
  const cap = CAPS[name];
  if (!cap) return { ok: false, code: "UNKNOWN_CAPABILITY", http: 404, detail: String(name) };
  const pre = cap.precheck(params, env);
  if (!pre.ok) return pre;                                   // rejected — execute NOT reached, nothing spent
  if (opts.dryRun) return { ok: true, code: "DRY_OK", cap: name, plan: pre.plan };
  return cap.execute(pre.plan, { env, tokenFn: opts.tokenFn });
}

// the launch-order menu for the route surface + UPGRADE_LEDGER (flags default OFF)
export function capabilityMenu(env = process.env) {
  return Object.values(CAPS).map(c => ({
    name: c.name, flag: c.flagEnv, enabled: flagOn(env, c.flagEnv),
    originates_no_number: !!c.originatesNoNumber,
  }));
}
