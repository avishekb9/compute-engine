#!/usr/bin/env node
// Compute Engine — sandboxed R/Python econometrics orchestrator (P1 slice).
//
// Open-source econometrics workbench (EViews/RATS/OxMetrics-style) over the
// project's real research stack. v1 is PARAMETERIZED-ONLY: the user picks a
// method from a fixed registry + params; the runner script is OURS (in r/ or
// py/), never user-supplied — so there is no arbitrary-code-execution surface.
//
// Sandbox: every analysis runs under `bwrap` (bubblewrap) with:
//   --unshare-net      no network (verified: blocks outbound)
//   --ro-bind / /      whole FS read-only (incl. the data + scripts)
//   --tmpfs /tmp ...   fresh writable scratch only
//   --die-with-parent  killed if server dies
//   + wall-clock `timeout` + a JSON-only stdout contract.
//
// Standalone on :3200 (NOT folded into the 14k-line VERALABS proxy).
//
// Usage:  node compute-server.mjs      (PORT, HOST env overridable)

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { request as httpsRequest } from "node:https";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = join(__dirname, "..");        // compute-engine/
const R_DIR = join(ENGINE_DIR, "r");
const WEB_DIR = join(ENGINE_DIR, "web");
// Data root holding papers/contagion-channels/data/G20.xlsx. Honor an explicit
// COMPUTE_REPO (set in the Cloud Run image to /app/data-root); else infer the
// monorepo parent for local runs.
const REPO = process.env.COMPUTE_REPO || join(ENGINE_DIR, "..");  // ivy-fineco/ (local) or /app/data-root (container)

const PORT = parseInt(process.env.PORT || "3200", 10);
const HOST = process.env.HOST || "127.0.0.1";
const JOB_TIMEOUT_S = parseInt(process.env.COMPUTE_TIMEOUT_S || "60", 10);
const HAVE_BWRAP = (() => { try { return existsSync("/usr/bin/bwrap") || existsSync("/bin/bwrap"); } catch { return false; } })();
const GEMINI_MODEL = "gemini-2.5-flash";
function loadGoogleKey() {
  if (process.env.GOOGLE_API_KEY) return process.env.GOOGLE_API_KEY;
  try {
    const env = join(REPO, "..", ".env.local"); // versiondevs/.env.local
    const line = readFileSync(env, "utf8").split(/\r?\n/).find(l => l.startsWith("GOOGLE_API_KEY="));
    if (line) return line.slice("GOOGLE_API_KEY=".length).replace(/^["']|["']$/g, "").trim();
  } catch {}
  return null;
}
const GOOGLE_KEY = loadGoogleKey();

// ── method registry ───────────────────────────────────────────────────────────
// Each method: runner script + a param schema (for validation + the UI form).
// kind: "r" (Rscript) | "py" (python3). All current methods are R.
const METHODS = {
  unit_root: {
    runner: "r", script: "adf.R",
    label: "Unit Root Test (ADF + KPSS)",
    category: "Time Series · Stationarity",
    desc: "Augmented Dickey-Fuller + KPSS on one return series. EViews 'Unit Root Test'.",
    params: { series: { type: "series", n: 1, required: true }, lags: { type: "int", optional: true } },
  },
  var_irf: {
    runner: "r", script: "var_irf.R",
    label: "VAR + Impulse Responses",
    category: "Time Series · Multivariate",
    desc: "Vector autoregression with AIC lag selection + orthogonal IRFs. EViews/RATS 'VAR'.",
    params: { series: { type: "series", n: [2, 6], required: true }, p: { type: "int", optional: true }, irf_h: { type: "int", optional: true } },
  },
  dfa_hurst: {
    runner: "r", script: "dfa_hurst.R",
    label: "DFA Hurst Exponent (long memory)",
    category: "Long Memory · Fractal",
    desc: "Detrended Fluctuation Analysis → Hurst exponent. Core NAMH primitive.",
    params: { series: { type: "series", n: 1, required: true }, min_box: { type: "int", optional: true }, max_box: { type: "int", optional: true } },
  },
  garch: {
    runner: "r", script: "garch.R",
    label: "GARCH(1,1) Volatility",
    category: "Volatility · Conditional Heteroskedasticity",
    desc: "GARCH(p,q) conditional-variance model + persistence. EViews/OxMetrics 'GARCH'.",
    params: { series: { type: "series", n: 1, required: true }, p: { type: "int", optional: true }, q: { type: "int", optional: true } },
  },
  wavelet: {
    runner: "r", script: "wavelet.R",
    label: "Wavelet Variance (MODWT)",
    category: "Multi-Scale · Wavelets",
    desc: "MODWT variance decomposition across time scales (d1≈2-4d …). Stage-1 substrate for NAMH/MCPFM/contagion.",
    params: { series: { type: "series", n: 1, required: true }, levels: { type: "int", optional: true } },
  },
  wqte: {
    runner: "r", script: "wqte.R",
    label: "Wavelet-Quantile Spillover (WQTE)",
    category: "Contagion · Tail Dependence",
    desc: "Directional wavelet-quantile dependence X→Y at a tail quantile, per scale. contagion-channels / WaveQTE primitive.",
    params: { series: { type: "series", n: 2, required: true }, tau: { type: "num", optional: true }, levels: { type: "int", optional: true } },
  },
  live_unit_root: {
    runner: "r", script: "live_adf.R", fetch: true,
    label: "Live Stationarity — Levels vs Returns (ADF + KPSS)",
    category: "Time Series · Live Data",
    desc: "Fetches a LIVE price series from a public source (Yahoo Finance / FRED) and runs ADF+KPSS on price LEVELS and LOG-RETURNS separately. Price levels are I(1)/non-stationary; returns are stationary.",
    params: {
      symbol:    { type: "symbol", required: true },
      source:    { type: "enum", values: ["yahoo", "fred"], optional: true },
      transform: { type: "enum", values: ["levels", "returns", "both"], optional: true },
    },
  },
};

const DATASETS = {
  g20: { label: "G20 equity daily log-returns (18 markets, 2006–2026)", n: 5036,
         series: ["Argentina","Australia","Brazil","Canada","China","France","Germany","India","Indonesia","Italy","Japan","Mexico","Russia","SouthAfrica","SouthKorea","Turkey","UK","USA"] },
};

// ── param validation (no arbitrary keys pass through) ──────────────────────────
function validate(methodId, params) {
  const m = METHODS[methodId];
  if (!m) throw new Error(`unknown method '${methodId}'`);
  const ds = params.dataset || "g20";
  if (!DATASETS[ds]) throw new Error(`unknown dataset '${ds}'`);
  const clean = { dataset: ds };
  for (const [k, spec] of Object.entries(m.params)) {
    const v = params[k];
    if (v == null) { if (spec.required) throw new Error(`missing required param '${k}'`); continue; }
    if (spec.type === "series") {
      const arr = Array.isArray(v) ? v : [v];
      const bad = arr.filter(s => !DATASETS[ds].series.includes(s));
      if (bad.length) throw new Error(`unknown series: ${bad.join(", ")}`);
      const n = spec.n;
      if (Array.isArray(n)) { if (arr.length < n[0] || arr.length > n[1]) throw new Error(`'${k}' needs ${n[0]}-${n[1]} series`); }
      else if (arr.length !== n) throw new Error(`'${k}' needs exactly ${n} series`);
      clean[k] = arr;
    } else if (spec.type === "int") {
      const i = parseInt(v, 10);
      if (!Number.isFinite(i)) throw new Error(`'${k}' must be an integer`);
      clean[k] = i;
    } else if (spec.type === "num") {
      const x = Number(v);
      if (!Number.isFinite(x)) throw new Error(`'${k}' must be a number`);
      clean[k] = x;
    } else if (spec.type === "symbol") {
      const s = String(v).trim();
      if (!/^[A-Za-z0-9 .^=_&-]{1,32}$/.test(s)) throw new Error(`'${k}' is not a valid ticker/name`);
      clean[k] = s;
    } else if (spec.type === "enum") {
      const s = String(v).trim().toLowerCase();
      if (!spec.values.includes(s)) throw new Error(`'${k}' must be one of: ${spec.values.join(", ")}`);
      clean[k] = s;
    }
  }
  // optional date window passthrough (validated as ISO-ish strings only)
  for (const k of ["start", "end"]) if (typeof params[k] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(params[k])) clean[k] = params[k];
  return { method: m, clean };
}

// ── live market-data fetch (TRUSTED orchestrator only) ─────────────────────────
// The R sandbox stays network-isolated (--unshare-net). Only this trusted Node
// layer reaches the net, and only to an allowlisted public host with a validated
// symbol — no arbitrary URL, no arbitrary code. The fetched price series is
// injected into the sandbox as a numeric array.
const FRED_ALIAS = { // friendly name -> FRED series id (keyless, server-friendly)
  "sp500": "SP500", "s&p500": "SP500", "s&p 500": "SP500", "spx": "SP500", "^spx": "SP500", "^gspc": "SP500",
  "nasdaq": "NASDAQCOM", "nasdaqcom": "NASDAQCOM", "ixic": "NASDAQCOM", "^ixic": "NASDAQCOM",
  "dow": "DJIA", "djia": "DJIA", "dow jones": "DJIA", "^dji": "DJIA", "vix": "VIXCLS", "^vix": "VIXCLS",
};
function httpGet(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: "GET", headers: { "User-Agent": "Mozilla/5.0 (SHSSM-compute-engine)" } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects > 0) {
        r.resume(); return httpGet(new URL(r.headers.location, url).toString(), redirects - 1).then(resolve, reject);
      }
      let b = ""; r.on("data", d => (b += d)); r.on("end", () => resolve({ status: r.statusCode, body: b }));
    });
    req.on("error", reject);
    req.setTimeout(20000, () => req.destroy(new Error("data-source fetch timeout")));
    req.end();
  });
}
// returns { series:[prices...], resolved, source }
async function fetchSeries(symbolRaw, sourceRaw) {
  const raw = String(symbolRaw || "").trim();
  if (!raw) throw new Error("missing symbol");
  // default: Yahoo for tickers; auto-switch to FRED for known index aliases
  let source = (sourceRaw || (FRED_ALIAS[raw.toLowerCase()] ? "fred" : "yahoo")).toLowerCase();

  if (source === "fred") {
    const id = FRED_ALIAS[raw.toLowerCase()] || raw.toUpperCase();
    if (!/^[A-Za-z0-9.^=_-]{1,24}$/.test(id)) throw new Error(`invalid FRED series id: ${id}`);
    const { status, body } = await httpGet(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(id)}`);
    if (status !== 200) throw new Error(`FRED HTTP ${status} for ${id}`);
    if (/^\s*</.test(body)) throw new Error(`FRED returned non-CSV for ${id} (unknown series id?)`);
    const vals = [];
    for (const ln of body.trim().split("\n").slice(1)) {
      const v = parseFloat((ln.split(",")[1] || "").trim());   // FRED uses "." for NA -> NaN
      if (Number.isFinite(v)) vals.push(v);
    }
    if (vals.length < 50) throw new Error(`FRED gave ${vals.length} usable points for ${id} (need >=50)`);
    return { series: vals, resolved: id, source: "fred" };
  }
  if (source === "yahoo") {
    if (!/^[A-Za-z0-9.^=_-]{1,24}$/.test(raw)) throw new Error(`invalid Yahoo symbol: ${raw}`);
    const { status, body } = await httpGet(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(raw)}?range=5y&interval=1d`);
    if (status !== 200) throw new Error(`Yahoo HTTP ${status} for ${raw}`);
    let j; try { j = JSON.parse(body); } catch { throw new Error(`Yahoo non-JSON for ${raw} (anti-bot gate?)`); }
    const r = j?.chart?.result?.[0];
    if (!r) throw new Error(`Yahoo: no data for ${raw}${j?.chart?.error?.description ? " — " + j.chart.error.description : ""}`);
    const c = r?.indicators?.adjclose?.[0]?.adjclose || r?.indicators?.quote?.[0]?.close || [];
    const vals = c.filter(v => Number.isFinite(v));
    if (vals.length < 50) throw new Error(`Yahoo gave ${vals.length} usable points for ${raw}`);
    return { series: vals, resolved: r.meta?.symbol || raw, source: "yahoo" };
  }
  throw new Error(`unknown data source: ${source} (use "yahoo" or "fred")`);
}
// build the JSON arg for a run, fetching + injecting live data when method.fetch
async function buildArgsJson(method, clean) {
  if (!method.fetch) return JSON.stringify(clean);
  const { series, resolved, source } = await fetchSeries(clean.symbol, clean.source);
  return JSON.stringify({ ...clean, levels: series, symbol: resolved, source });
}

// ── sandboxed runner ───────────────────────────────────────────────────────────
function runSandboxed(method, paramsJson) {
  return new Promise((resolve) => {
    const scriptPath = join(method.runner === "r" ? R_DIR : join(ENGINE_DIR, "py"), method.script);
    const interp = method.runner === "r" ? "Rscript" : "python3";
    const innerCmd = [interp, scriptPath, paramsJson];

    let argv, bin;
    if (HAVE_BWRAP) {
      bin = "bwrap";
      argv = [
        "--ro-bind", "/", "/",          // whole FS read-only
        "--dev", "/dev", "--proc", "/proc",
        "--tmpfs", "/tmp",              // fresh writable scratch
        "--tmpfs", join(process.env.HOME || "/home/ecolex", ".cache"),
        "--unshare-net",               // NO network
        "--die-with-parent",
        "--chdir", "/tmp",
        "timeout", String(JOB_TIMEOUT_S), ...innerCmd,
      ];
    } else {
      // fallback: timeout + unshare-net only (still no network)
      bin = "timeout";
      argv = [String(JOB_TIMEOUT_S), ...innerCmd];
    }

    const env = { COMPUTE_REPO: REPO, HOME: process.env.HOME, PATH: process.env.PATH, LANG: "C.UTF-8" };
    const child = spawn(bin, argv, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", d => (out += d));
    child.stderr.on("data", d => (err += d));
    child.on("error", e => resolve({ ok: false, error: `spawn failed: ${e.message}` }));
    child.on("close", code => {
      if (code === 124) return resolve({ ok: false, error: `timeout after ${JOB_TIMEOUT_S}s` });
      const trimmed = out.trim();
      if (!trimmed) return resolve({ ok: false, error: `no output (exit ${code}): ${err.slice(0, 300)}` });
      try {
        const result = JSON.parse(trimmed);
        if (result.error) return resolve({ ok: false, error: result.error });
        resolve({ ok: true, result, sandbox: HAVE_BWRAP ? "bwrap+timeout(net-isolated)" : "timeout(net-isolated)" });
      } catch (e) {
        resolve({ ok: false, error: `non-JSON output: ${trimmed.slice(0, 300)}` });
      }
    });
  });
}

// ── chatbot (Gemini function-calling → sandboxed analysis → NL summary) ────────
// User types natural language; Gemini maps it to run_analysis(method,series,…)
// against the SAME validated registry the UI uses; we execute in the sandbox;
// Gemini then explains the numbers. No arbitrary code — only registered methods.
function geminiCall(payload) {
  return new Promise((resolve, reject) => {
    if (!GOOGLE_KEY) return reject(new Error("GOOGLE_API_KEY not available"));
    const data = Buffer.from(JSON.stringify(payload));
    const u = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GOOGLE_KEY}`);
    const r = httpsRequest(u, { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": data.length } }, res => {
      let b = ""; res.on("data", c => (b += c));
      res.on("end", () => { try { resolve(JSON.parse(b)); } catch { reject(new Error("gemini bad JSON")); } });
    });
    r.on("error", reject); r.setTimeout(30000, () => r.destroy(new Error("gemini timeout")));
    r.write(data); r.end();
  });
}
function chatTools() {
  return [{ functionDeclarations: [{
    name: "run_analysis",
    description: "Run a sandboxed econometric analysis. Stored-panel methods use G20 daily equity LOG-RETURNS (2006-2026, by market name). live_unit_root fetches a LIVE price series from a public source and tests price LEVELS vs LOG-RETURNS. " +
      Object.entries(METHODS).map(([k, m]) => `${k}=${m.label}`).join("; "),
    parameters: { type: "object", properties: {
      method: { type: "string", enum: Object.keys(METHODS) },
      series: { type: "array", items: { type: "string", enum: DATASETS.g20.series }, description: "stored-panel market(s): 1 for most; 2 for wqte (from,to); 2-6 for var_irf. NOT used by live_unit_root." },
      symbol: { type: "string", description: "live_unit_root only: ticker or index, e.g. ^FTSE, ^GSPC, AAPL, RELIANCE.NS, SP500, NASDAQCOM, DJIA" },
      source: { type: "string", enum: ["yahoo", "fred"], description: "live_unit_root data source; default yahoo (FRED auto-used for SP500/NASDAQCOM/DJIA)" },
      transform: { type: "string", enum: ["levels", "returns", "both"], description: "live_unit_root: which to test; default both" },
      tau: { type: "number" }, lags: { type: "integer" }, p: { type: "integer" }, q: { type: "integer" }, irf_h: { type: "integer" }, levels: { type: "integer" },
    }, required: ["method"] },
  }] }];
}
const CHAT_SYS = "You are the SHSSM Econometrics Analyst, a careful financial econometrician at the School of " +
  "Humanities, Social Sciences & Management, IIT Bhubaneswar. You are NOT a generic chatbot; if asked who you " +
  "are, identify yourself as the SHSSM Econometrics Analyst (do not say you are a model trained by Google). You " +
  "answer econometrics/finance questions and run real sandboxed R via the run_analysis tool.\n\n" +
  "CRITICAL STATIONARITY ECONOMICS — never get this wrong:\n" +
  "- Equity PRICE LEVELS are non-stationary: they have a unit root (I(1), random-walk-with-drift). Never call a " +
  "price level stationary.\n" +
  "- LOG-RETURNS = diff(log(price)) are typically stationary (I(0)). Model and report on RETURNS, not price levels.\n" +
  "- The stored G20 panel (methods unit_root, var_irf, dfa_hurst, garch, wavelet, wqte; selected by market NAME " +
  "like India/USA/UK) is ALREADY log-returns, so any 'stationary' verdict there is about RETURNS — always say so " +
  "explicitly (e.g. 'UK equity RETURNS are stationary', never 'the UK equity market is stationary').\n" +
  "- For LIVE data use method=live_unit_root with a symbol (e.g. ^FTSE, ^GSPC, AAPL, RELIANCE.NS, or SP500 via FRED). " +
  "It returns separate results for price LEVELS and LOG-RETURNS; report the contrast — levels non-stationary " +
  "(fails to reject the unit root), returns stationary — and explain that this is exactly why we difference prices " +
  "to returns.\n\n" +
  "Stored-panel markets: " + DATASETS.g20.series.join(", ") + ". After the tool returns numbers, explain them " +
  "concisely for a finance researcher (what each statistic means + the verdict, naming whether it was levels or " +
  "returns). If a request is conceptual, answer directly without a tool call.";
async function chatTurn(message) {
  if (!message.trim()) return { reply: "Ask me to run an analysis, e.g. 'ADF test on India returns' or 'wavelet variance for USA'.", ran: null };
  const contents = [{ role: "user", parts: [{ text: message }] }];
  const r1 = await geminiCall({ systemInstruction: { parts: [{ text: CHAT_SYS }] }, contents, tools: chatTools(), generationConfig: { temperature: 0.2 } });
  const parts = r1?.candidates?.[0]?.content?.parts || [];
  const fc = (parts.find(p => p.functionCall) || {}).functionCall;
  if (!fc) return { reply: parts.map(p => p.text).filter(Boolean).join("") || "I couldn't parse that.", ran: null };
  let v;
  try { v = validate(fc.args.method, fc.args); }
  catch (e) { return { reply: `I tried ${fc.args.method} but the parameters were invalid: ${e.message}`, ran: { method: fc.args.method, error: e.message } }; }
  let run;
  try { run = await runSandboxed(v.method, await buildArgsJson(v.method, v.clean)); }
  catch (e) { run = { ok: false, error: `data fetch failed: ${e.message}` }; }
  if (!run.ok) return { reply: `The ${fc.args.method} analysis failed: ${run.error}`, ran: { method: fc.args.method, error: run.error } };
  const contents2 = [
    ...contents,
    { role: "model", parts: [{ functionCall: fc }] },
    { role: "function", parts: [{ functionResponse: { name: "run_analysis", response: { result: run.result } } }] },
  ];
  const r2 = await geminiCall({ systemInstruction: { parts: [{ text: CHAT_SYS }] }, contents: contents2, generationConfig: { temperature: 0.3 } });
  const reply = (r2?.candidates?.[0]?.content?.parts || []).map(p => p.text).filter(Boolean).join("") || "(analysis complete)";
  return { reply, ran: { method: fc.args.method, params: v.clean, result: run.result, ms: run.ms } };
}

// ── job log ─────────────────────────────────────────────────────────────────────
const LOG_DIR = join(ENGINE_DIR, ".jobs");
let jobSeq = 0;
function logJob(rec) {
  try { mkdirSync(LOG_DIR, { recursive: true }); writeFileSync(join(LOG_DIR, `job_${rec.id}.json`), JSON.stringify(rec, null, 2)); } catch {}
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };

const server = createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const send = (c, t, b) => { res.writeHead(c, { "Content-Type": t, "Access-Control-Allow-Origin": "*" }); res.end(b); };

  if (u.pathname === "/health")
    return send(200, "application/json", JSON.stringify({ ok: true, sandbox: HAVE_BWRAP ? "bwrap" : "timeout", methods: Object.keys(METHODS).length, timeout_s: JOB_TIMEOUT_S }));

  if (u.pathname === "/api/compute/catalog")
    return send(200, "application/json", JSON.stringify({ methods: METHODS, datasets: DATASETS }));

  if (u.pathname === "/api/compute/run" && req.method === "POST") {
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", async () => {
      let payload;
      try { payload = JSON.parse(body || "{}"); } catch { return send(400, "application/json", JSON.stringify({ ok: false, error: "bad JSON body" })); }
      let v;
      try { v = validate(payload.method, payload.params || {}); }
      catch (e) { return send(400, "application/json", JSON.stringify({ ok: false, error: e.message })); }
      const t0 = Date.now();
      let r;
      try { r = await runSandboxed(v.method, await buildArgsJson(v.method, v.clean)); }
      catch (e) { r = { ok: false, error: `data fetch failed: ${e.message}` }; }
      const rec = { id: ++jobSeq, ts: new Date().toISOString(), method: payload.method, params: v.clean, ms: Date.now() - t0, ok: r.ok, error: r.error || null };
      logJob(rec);
      return send(r.ok ? 200 : 500, "application/json", JSON.stringify({ ...r, ms: rec.ms, job_id: rec.id }));
    });
    return;
  }

  // chatbot: NL -> Gemini function-call -> run analysis -> Gemini summary
  if (u.pathname === "/api/chat" && req.method === "POST") {
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", async () => {
      let payload;
      try { payload = JSON.parse(body || "{}"); } catch { return send(400, "application/json", JSON.stringify({ error: "bad JSON body" })); }
      try { return send(200, "application/json", JSON.stringify(await chatTurn(payload.message || ""))); }
      catch (e) { return send(500, "application/json", JSON.stringify({ error: e.message })); }
    });
    return;
  }

  // static dashboard
  let p = u.pathname === "/" ? "/index.html" : u.pathname;
  const fp = join(WEB_DIR, p.replace(/\.\.+/g, ""));
  if (existsSync(fp) && fp.startsWith(WEB_DIR)) return send(200, MIME[extname(fp)] || "application/octet-stream", readFileSync(fp));
  send(404, "text/plain", "not found");
});

server.listen(PORT, HOST, () => {
  console.log(`✓ Compute Engine on http://${HOST}:${PORT}`);
  console.log(`  sandbox: ${HAVE_BWRAP ? "bwrap (net-isolated, ro-fs)" : "timeout fallback"}`);
  console.log(`  methods: ${Object.keys(METHODS).join(", ")}`);
  console.log(`  dashboard: http://${HOST}:${PORT}/   ·   catalog: /api/compute/catalog`);
});
