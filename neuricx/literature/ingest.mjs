#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Econstellar Phase 29 · literature-ingestion (29.3)
//
// Pulls recent econometrics papers from arXiv, extracts structured claims via
// Gemini 2.5 Flash, and streams records into BigQuery
// (hopeful-flash-485308-v3.literature.papers). A `--dry` mode makes ZERO network
// calls and writes newline-delimited JSON to ./literature-dryrun.jsonl instead.
//
// Zero external deps: Node built-ins + global fetch (Node >=18) only.
//
// CLI: node ingest.mjs [--days N] [--cats a,b,c] [--max N] [--dry] [--selftest]
//
// LIVE auth (NOT used in --dry / --selftest):
//   • Gemini   — GOOGLE_API_KEY env (mirrors compute-server.mjs geminiCall)
//   • BigQuery — bearer from the proxy at http://localhost:3001/api/gcloud-token
//                (mirrors job-server.mjs fetchGcloudToken)
// ─────────────────────────────────────────────────────────────────────────────

import http from "node:http";
import { writeFileSync, appendFileSync } from "node:fs";

// ── config ───────────────────────────────────────────────────────────────────
const TOKEN_URL    = process.env.GCLOUD_TOKEN_URL || "http://localhost:3001/api/gcloud-token";
const GOOGLE_KEY   = process.env.GOOGLE_API_KEY || null;
const GEMINI_MODEL = "gemini-2.5-flash";
const BQ_PROJECT   = process.env.BQ_PROJECT || "hopeful-flash-485308-v3";
const BQ_DATASET   = process.env.BQ_DATASET || "literature";
const BQ_TABLE     = process.env.BQ_TABLE   || "papers";
const ARXIV_API    = "https://export.arxiv.org/api/query";
const ARXIV_THROTTLE_MS = 3000;                 // arXiv etiquette: >=3s between requests
const DEFAULT_CATS = ["econ.EM", "q-fin.RM", "stat.AP"];
const DRY_FILE     = "./literature-dryrun.jsonl";

// EXACT extraction prompt (29.3) — abstract is appended after it.
const EXTRACTION_PROMPT = `Extract from this econometrics abstract in JSON only:
{"methods":[],"datasets":[],"claims":[{"claim":"","metric":"","value":null,"context":""}]}
Return {} if nothing extractable. No commentary.

`;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log   = (...a) => console.log("[literature]", ...a);

// ── arXiv Atom parser ──────────────────────────────────────────────────────────
// Regex-based, dependency-free. arXiv Atom is flat and predictable; we extract
// only the fields schema.json needs. Exported via runSelfTest() fixtures.
function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");                      // ampersand last
}
const norm = s => decodeEntities(s).replace(/\s+/g, " ").trim();

function tag(block, name) {                       // first <name>…</name> inner text
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, "i"));
  return m ? m[1] : null;
}
function attr(block, name, a) {                    // <name … a="…"/> attribute value
  const m = block.match(new RegExp(`<${name}\\b[^>]*\\b${a}=("|')(.*?)\\1`, "i"));
  return m ? m[2] : null;
}

// arXiv <id> looks like http://arxiv.org/abs/2604.12345v1 → keep the abs id.
function arxivId(idUrl) {
  if (!idUrl) return null;
  const m = idUrl.match(/arxiv\.org\/abs\/(.+)$/i);
  return m ? m[1].trim() : idUrl.trim();
}

// Parse a full Atom feed string into paper records (pre-extraction shape).
function parseArxivFeed(xml) {
  const out = [];
  const entries = xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  for (const e of entries) {
    const authors = [...e.matchAll(/<author\b[^>]*>[\s\S]*?<name\b[^>]*>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)]
      .map(m => norm(m[1])).filter(Boolean);
    // primary category preferred; fall back to first <category term=…>
    const primary = attr(e, "arxiv:primary_category", "term") || attr(e, "category", "term");
    const published = tag(e, "published");
    const doi = tag(e, "arxiv:doi");
    out.push({
      paper_id:  arxivId(tag(e, "id")),
      title:     norm(tag(e, "title") || ""),
      authors,
      published: published ? norm(published) : null,
      updated:   (tag(e, "updated") ? norm(tag(e, "updated")) : null),
      category:  primary ? primary.trim() : null,
      abstract:  norm(tag(e, "summary") || ""),
      doi:       doi ? norm(doi) : null,
    });
  }
  return out;
}

// ── Gemini response parser ─────────────────────────────────────────────────────
// candidates[0].content.parts[0].text → JSON. Tolerates ```json fences. Throws on
// unparseable; caller logs + skips so the run never crashes.
function parseGeminiExtraction(apiResponse) {
  const parts = apiResponse?.candidates?.[0]?.content?.parts || [];
  const text = parts.map(p => p?.text).filter(Boolean).join("").trim();
  if (!text) throw new Error("empty Gemini text");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced ? fenced[1] : text).trim();
  const obj = JSON.parse(raw);                     // throws on bad JSON
  return {
    methods:  Array.isArray(obj.methods)  ? obj.methods.map(String)  : [],
    datasets: Array.isArray(obj.datasets) ? obj.datasets.map(String) : [],
    claims:   Array.isArray(obj.claims)   ? obj.claims.map(c => ({
      claim:   c?.claim   != null ? String(c.claim)   : null,
      metric:  c?.metric  != null ? String(c.metric)  : null,
      value:   (typeof c?.value === "number" && Number.isFinite(c.value)) ? c.value : null,
      context: c?.context != null ? String(c.context) : null,
    })) : [],
  };
}

// Assemble a BigQuery-ready record from a parsed paper + extraction (or empty).
function buildRecord(paper, extraction) {
  const ext = extraction || { methods: [], datasets: [], claims: [] };
  const date = paper.published ? paper.published.slice(0, 10) : null;   // YYYY-MM-DD
  return {
    paper_id:           paper.paper_id,
    title:              paper.title || null,
    authors:            paper.authors || [],
    date,
    source:             "arxiv",
    category:           paper.category || null,
    methods_mentioned:  ext.methods,
    datasets_mentioned: ext.datasets,
    results:            ext.claims,
    ingested_at:        new Date().toISOString(),
    verified:           false,
  };
}

// ── network (LIVE only) ─────────────────────────────────────────────────────────
function fetchGcloudToken() {                       // mirrors job-server.mjs
  return new Promise((resolve) => {
    const req = http.get(TOKEN_URL, { timeout: 5000 }, (r) => {
      let b = ""; r.on("data", d => b += d);
      r.on("end", () => { try { resolve(JSON.parse(b).token || null); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

async function fetchArxiv(cat, maxResults) {
  const url = `${ARXIV_API}?search_query=cat:${encodeURIComponent(cat)}`
    + `&start=0&max_results=${maxResults}`
    + `&sortBy=submittedDate&sortOrder=descending`;
  const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "econstellar-literature/29 (avishekb@iitbbs.ac.in)" } });
  const body = await res.text();
  if (!res.ok) throw new Error(`arXiv HTTP ${res.status}`);
  if (/^\s*Rate exceeded\.?\s*$/i.test(body)) throw new Error("arXiv rate limited ('Rate exceeded.')");
  return parseArxivFeed(body);
}

async function extractWithGemini(abstract) {
  if (!GOOGLE_KEY) throw new Error("GOOGLE_API_KEY not available");
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GOOGLE_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: EXTRACTION_PROMPT + abstract }] }] }),
  });
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
  return parseGeminiExtraction(await res.json());
}

async function insertBigQuery(token, rows) {
  const url = `https://bigquery.googleapis.com/bigquery/v2/projects/${BQ_PROJECT}`
    + `/datasets/${BQ_DATASET}/tables/${BQ_TABLE}/insertAll`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ rows: rows.map(json => ({ json })) }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`BigQuery HTTP ${res.status}: ${JSON.stringify(out).slice(0, 300)}`);
  if (out.insertErrors?.length) throw new Error(`BigQuery insertErrors: ${JSON.stringify(out.insertErrors).slice(0, 500)}`);
  return rows.length;
}

// ── date filter ─────────────────────────────────────────────────────────────────
function withinDays(paper, days) {
  if (!paper.published) return false;
  const t = Date.parse(paper.published);
  if (Number.isNaN(t)) return false;
  return (Date.now() - t) <= days * 86400 * 1000;
}

// ── CLI parsing ──────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { days: 7, cats: DEFAULT_CATS, max: 50, dry: false, selftest: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--dry") a.dry = true;
    else if (v === "--selftest") a.selftest = true;
    else if (v === "--days") a.days = Number(argv[++i]);
    else if (v === "--max")  a.max  = Number(argv[++i]);
    else if (v === "--cats") a.cats = String(argv[++i]).split(",").map(s => s.trim()).filter(Boolean);
  }
  if (!Number.isFinite(a.days) || a.days <= 0) a.days = 7;
  if (!Number.isFinite(a.max)  || a.max  <= 0) a.max  = 50;
  return a;
}

// ── main pipeline ─────────────────────────────────────────────────────────────────
async function run(opts) {
  log(`cats=${opts.cats.join(",")} days=${opts.days} max=${opts.max} dry=${opts.dry}`);
  let parsed = 0, claimsCount = 0, failures = 0, inserted = 0;
  const dryRecords = [];

  // DRY: zero network — skips arXiv, Gemini, and BigQuery entirely. The self-test
  // supplies a fixture feed via opts._fixtureFeed; without one there is nothing to
  // ingest offline, so we report and exit cleanly (no network fallback).
  if (opts.dry) {
    writeFileSync(DRY_FILE, "");                    // truncate
    if (!opts._fixtureFeed) {
      log("--dry makes no network calls; supply --selftest for the offline fixture. 0 records.");
      return { parsed: 0, claimsCount: 0, failures: 0, inserted: 0, dryRecords: [] };
    }
    for (const paper of parseArxivFeed(opts._fixtureFeed)) {
      if (!opts._ignoreDate && !withinDays(paper, opts.days)) continue;
      parsed++;
      const rec = buildRecord(paper, { methods: [], datasets: [], claims: [] });
      rec.extraction = "skipped (dry)";            // Gemini skipped in dry mode
      dryRecords.push(rec);
      appendFileSync(DRY_FILE, JSON.stringify(rec) + "\n");
    }
    log(`DRY summary: parsed=${parsed} claims=0 failures=0 → ${DRY_FILE} (${dryRecords.length} records)`);
    return { parsed, claimsCount: 0, failures: 0, inserted: 0, dryRecords };
  }

  // LIVE.
  const token = await fetchGcloudToken();
  if (!token) log("WARN: no BigQuery token from proxy; inserts will fail. Is the proxy on :3001?");

  const records = [];
  for (let i = 0; i < opts.cats.length; i++) {
    const cat = opts.cats[i];
    if (i > 0) await sleep(ARXIV_THROTTLE_MS);      // throttle BETWEEN arXiv requests
    let papers;
    try { papers = await fetchArxiv(cat, opts.max); }
    catch (e) { log(`arXiv fetch failed for ${cat}: ${e.message}`); failures++; continue; }
    const recent = papers.filter(p => withinDays(p, opts.days));
    log(`${cat}: ${papers.length} entries, ${recent.length} within ${opts.days}d`);
    for (const paper of recent) {
      parsed++;
      let extraction;
      try { extraction = await extractWithGemini(paper.abstract); }
      catch (e) { log(`gemini/extract skip ${paper.paper_id}: ${e.message}`); failures++; extraction = { methods: [], datasets: [], claims: [] }; }
      claimsCount += extraction.claims.length;
      records.push(buildRecord(paper, extraction));
    }
  }

  if (records.length && token) {
    try { inserted = await insertBigQuery(token, records); }
    catch (e) { log(`BigQuery insert failed: ${e.message}`); failures++; }
  }
  log(`LIVE summary: parsed=${parsed} claims=${claimsCount} inserted=${inserted} failures=${failures}`);
  return { parsed, claimsCount, failures, inserted, dryRecords: [] };
}

// ── self-test (no network) ───────────────────────────────────────────────────────
// Verifies: (2) parser, (3) Gemini-response parse, (4) --dry over fixture.
const FIXTURE_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2699.00001v1</id>
    <updated>2699-01-02T00:00:00Z</updated>
    <published>2699-01-01T00:00:00Z</published>
    <title>TEST FIXTURE A: A Quantile Spillover Estimator for Synthetic Panels</title>
    <summary>TEST ABSTRACT. We propose a synthetic estimator &amp; evaluate it on simulated data. No real results are reported here.</summary>
    <author><name>Test Author One</name></author>
    <author><name>Test Author Two</name></author>
    <arxiv:doi>10.0000/test.0001</arxiv:doi>
    <category term="stat.AP" scheme="http://arxiv.org/schemas/atom"/>
    <arxiv:primary_category term="econ.EM" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2699.00002v2</id>
    <updated>2699-01-04T00:00:00Z</updated>
    <published>2699-01-03T00:00:00Z</published>
    <title>TEST FIXTURE B: Wavelet Risk Measures &lt;in&gt; Simulated Markets</title>
    <summary>TEST ABSTRACT for entry B. A toy methodology described with no empirical claims.</summary>
    <author><name>Solo Test Author</name></author>
    <arxiv:primary_category term="q-fin.RM" scheme="http://arxiv.org/schemas/atom"/>
    <category term="q-fin.RM" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>`;

const MOCK_GEMINI = {
  candidates: [{ content: { parts: [{ text:
    "```json\n" +
    '{"methods":["quantile regression","MODWT"],' +
    '"datasets":["simulated panel"],' +
    '"claims":[{"claim":"out-of-sample RMSE improves","metric":"RMSE","value":0.12,"context":"vs OLS benchmark"},' +
    '{"claim":"no numeric value here","metric":"coverage","value":null,"context":"nominal 95%"}]}' +
    "\n```" }] } }],
};

function assert(cond, msg) { if (!cond) { console.error("  FAIL:", msg); process.exitCode = 1; } else console.log("  ok:", msg); }

async function runSelfTest() {
  console.log("── SELFTEST (no network) ──");

  console.log("[2] arXiv Atom parser");
  const papers = parseArxivFeed(FIXTURE_FEED);
  assert(papers.length === 2, "parsed 2 entries");
  assert(papers[0].paper_id === "2699.00001v1", `entry A id = ${papers[0].paper_id}`);
  assert(papers[0].title.startsWith("TEST FIXTURE A:"), "entry A title");
  assert(papers[0].authors.length === 2 && papers[0].authors[0] === "Test Author One", `entry A authors = ${JSON.stringify(papers[0].authors)}`);
  assert(papers[0].published === "2699-01-01T00:00:00Z", "entry A published");
  assert(papers[0].category === "econ.EM", `entry A primary category = ${papers[0].category}`);
  assert(papers[0].abstract.includes("synthetic estimator & evaluate"), "entry A abstract decoded (&amp; -> &)");
  assert(papers[0].doi === "10.0000/test.0001", "entry A doi");
  assert(papers[1].paper_id === "2699.00002v2", `entry B id = ${papers[1].paper_id}`);
  assert(papers[1].title.includes("<in>"), "entry B title decoded (&lt;in&gt; -> <in>)");
  assert(papers[1].authors.length === 1 && papers[1].authors[0] === "Solo Test Author", "entry B single author");
  assert(papers[1].category === "q-fin.RM", `entry B category = ${papers[1].category}`);

  console.log("[3] Gemini-response parse + record build");
  const ext = parseGeminiExtraction(MOCK_GEMINI);
  assert(ext.methods.length === 2 && ext.methods.includes("MODWT"), `methods = ${JSON.stringify(ext.methods)}`);
  assert(ext.datasets[0] === "simulated panel", "datasets parsed");
  assert(ext.claims.length === 2, "two claims parsed");
  assert(ext.claims[0].value === 0.12, `claim[0].value FLOAT = ${ext.claims[0].value}`);
  assert(ext.claims[1].value === null, "claim[1].value null preserved");
  const rec = buildRecord(papers[0], ext);
  assert(rec.paper_id === "2699.00001v1" && rec.source === "arxiv", "record id+source");
  assert(rec.date === "2699-01-01", `record date = ${rec.date}`);
  assert(rec.verified === false && typeof rec.ingested_at === "string", "record verified=false + ingested_at set");
  assert(Array.isArray(rec.results) && rec.results[0].metric === "RMSE", "record results record-array");

  console.log("[4] --dry over fixture → JSONL matching schema.json");
  const r = await run({ days: 7, cats: DEFAULT_CATS, max: 50, dry: true, _fixtureFeed: FIXTURE_FEED, _ignoreDate: true });
  assert(r.parsed === 2, `dry parsed = ${r.parsed}`);
  assert(r.dryRecords.length === 2, "2 dry records");
  assert(r.dryRecords.every(x => x.extraction === "skipped (dry)"), "dry note present");
  assert(r.dryRecords.every(x => Array.isArray(x.results) && x.results.length === 0), "dry claims empty");
  // validate the written JSONL against schema field set
  const { readFileSync } = await import("node:fs");
  const lines = readFileSync(DRY_FILE, "utf8").trim().split("\n");
  assert(lines.length === 2, `JSONL has 2 lines (${lines.length})`);
  const schema = JSON.parse(readFileSync(new URL("./schema.json", import.meta.url), "utf8"));
  const required = schema.map(f => f.name);
  for (const ln of lines) {
    const o = JSON.parse(ln);                       // valid JSON per line
    for (const f of required) assert(f in o, `JSONL record has field "${f}"`);
    assert(Array.isArray(o.authors) && Array.isArray(o.results), "repeated fields are arrays");
  }
  console.log(process.exitCode ? "── SELFTEST: FAILURES ──" : "── SELFTEST: ALL PASS ──");
}

// ── entrypoint ────────────────────────────────────────────────────────────────────
const opts = parseArgs(process.argv.slice(2));
if (opts.selftest) {
  runSelfTest();
} else {
  run(opts).catch(e => { console.error("[literature] fatal:", e.message); process.exitCode = 1; });
}

export { parseArxivFeed, parseGeminiExtraction, buildRecord, withinDays };
