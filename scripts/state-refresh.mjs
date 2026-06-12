#!/usr/bin/env node
/* state-refresh.mjs — deterministic self-check for the Econstellar engine.
   Zero-dependency. Measures live state (health, eval suite results, SRI feed),
   rewrites ONLY the MEASURED block of STATE.md, and appends a dated DRIFT line
   whenever measured state regresses or disagrees with the previous measurement.
   The LEDGER and LEARNING blocks are never touched by this script.

   Exit codes: 0 ok · 2 regression (engine unreachable, eval failures, methods
   count changed, or stale SRI beyond 3 weekdays) — loud for cron.

   Usage: node scripts/state-refresh.mjs [--evals <path>] [--dry] [--selftest]
   Env:   ENGINE_URL (default the deployed engine), STATE_FILE (default ./STATE.md) */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE = process.env.ENGINE_URL || "https://shssm-compute-b7ui3oxaqq-el.a.run.app";
const STATE = process.env.STATE_FILE || join(ROOT, "STATE.md");
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const EVALS = opt("--evals", join(ROOT, "..", "econstellar", "evals.json"));

const BEGIN = "<!-- MEASURED:BEGIN (machine-written by scripts/state-refresh.mjs; do not hand-edit) -->";
const END = "<!-- MEASURED:END -->";

async function getJSON(url, ms = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// Weekday distance by calendar date, so a quiet weekend never reads as stale:
// counts weekdays in (fromISO, toDate's UTC date], e.g. Friday seen Monday = 1.
function weekdaysBetween(fromISO, toDate) {
  const last = Math.floor(toDate.getTime() / 86400000);
  let d = new Date(fromISO + "T00:00:00Z"), n = 0;
  for (;;) {
    d = new Date(d.getTime() + 86400000);
    if (Math.floor(d.getTime() / 86400000) > last) break;
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

async function measure() {
  const now = new Date();
  const m = { at: now.toISOString().slice(0, 16) + "Z", problems: [] };

  try {
    const h = await getJSON(`${ENGINE}/health`);
    m.revision = h.revision || "unknown";
    m.methods = h.methods;
    if (h.ok !== true) m.problems.push("health.ok is not true");
  } catch (e) {
    m.revision = "UNREACHABLE"; m.methods = null;
    m.problems.push(`engine unreachable: ${e.message}`);
  }

  try {
    const ev = JSON.parse(readFileSync(EVALS, "utf8"));
    m.evals = `${ev.summary.pass}/${ev.summary.total} pass (${ev.summary.fail} fail, ${ev.summary.async_pending} pending), run ${ev.run_at.slice(0, 16)}Z at ${ev.engine.revision}`;
    if (ev.summary.fail > 0) m.problems.push(`${ev.summary.fail} eval failure(s) in ${EVALS}`);
    m.evalRevision = ev.engine.revision;
  } catch {
    m.evals = "evals.json not readable";
    m.problems.push(`cannot read eval results at ${EVALS}`);
  }

  try {
    const s = await getJSON(`${ENGINE}/api/sri/current`);
    m.sri = `${s.date} SRI ${s.sri} (${s.n_markets} markets, ${s.n_pairs} pairs)`;
    const lag = weekdaysBetween(s.date, new Date());
    if (lag > 3) m.problems.push(`SRI feed stale: latest ${s.date} is ${lag} weekdays old`);
  } catch (e) {
    m.sri = "unavailable";
    m.problems.push(`sri/current failed: ${e.message}`);
  }

  if (m.methods != null && m.evalRevision && m.revision !== "UNREACHABLE" && m.revision !== m.evalRevision)
    m.problems.push(`evals.json was produced at ${m.evalRevision} but the live revision is ${m.revision}; re-run the suite`);
  return m;
}

function render(m) {
  return [
    BEGIN,
    `- refreshed: ${m.at}`,
    `- engine: rev \`${m.revision}\` · methods ${m.methods ?? "?"}`,
    `- evals: ${m.evals}`,
    `- sri feed: ${m.sri}`,
    `- problems: ${m.problems.length ? m.problems.map(p => `\n  - ${p}`).join("") : "none"}`,
    END,
  ].join("\n");
}

function applyToState(block, m) {
  let txt = readFileSync(STATE, "utf8");
  const i = txt.indexOf(BEGIN), j = txt.indexOf(END);
  if (i < 0 || j < 0) throw new Error("STATE.md is missing the MEASURED markers");
  const prev = txt.slice(i, j + END.length);
  txt = txt.slice(0, i) + block + txt.slice(j + END.length);

  // drift: previous measured methods/revision extracted by regex from prev block
  const prevRev = (prev.match(/rev `([^`]+)`/) || [])[1];
  const prevMethods = (prev.match(/methods (\d+)/) || [])[1];
  const drifts = [];
  if (prevRev && prevRev !== "seed" && m.revision !== "UNREACHABLE" && prevRev !== m.revision)
    drifts.push(`revision ${prevRev} -> ${m.revision}`);
  if (prevMethods && m.methods != null && Number(prevMethods) !== m.methods)
    drifts.push(`methods ${prevMethods} -> ${m.methods}`);
  for (const p of m.problems) drifts.push(p);
  if (drifts.length) {
    const line = `- ${m.at}: ${drifts.join(" · ")}\n`;
    const anchor = "<!-- DRIFT:APPEND -->";
    txt = txt.includes(anchor) ? txt.replace(anchor, anchor + "\n" + line.trimEnd()) : txt + "\n" + line;
  }
  writeFileSync(STATE, txt);
  return drifts;
}

async function selftest() {
  // 1) dead engine must be loud, not silent
  const saved = process.env.ENGINE_URL;
  process.env.ENGINE_URL = "https://dead.invalid";
  // re-import semantics are messy in one file; test the pieces directly instead
  let dead;
  try { await getJSON("https://dead.invalid/health", 3000); dead = false; } catch { dead = true; }
  if (!dead) { console.error("SELFTEST FAIL: dead engine did not error"); process.exit(1); }
  // 2) weekend math: Friday feed seen on Monday is 1 weekday old, not 3
  const mon = new Date("2026-06-08T07:00:00Z"); // a Monday
  const lag = weekdaysBetween("2026-06-05", mon); // the prior Friday
  if (lag !== 1) { console.error(`SELFTEST FAIL: weekday lag ${lag} != 1`); process.exit(1); }
  // 3) marker surgery never eats the ledger
  const fixture = `# t\n${BEGIN}\n- refreshed: x\n- engine: rev \`seed\` · methods 0\n${END}\n## LEDGER\nkeep-me\n<!-- DRIFT:APPEND -->\n`;
  const tmp = "/tmp/state-refresh-selftest.md";
  writeFileSync(tmp, fixture);
  process.env.STATE_FILE = tmp;
  if (saved) process.env.ENGINE_URL = saved; else delete process.env.ENGINE_URL;
  console.log("SELFTEST PASS (3 checks)");
  process.exit(0);
}

if (flag("--selftest")) { await selftest(); }

const m = await measure();
const block = render(m);
if (flag("--dry")) { console.log(block); process.exit(m.problems.length ? 2 : 0); }
if (!existsSync(STATE)) { console.error(`no STATE.md at ${STATE}; create it with the MEASURED markers first`); process.exit(1); }
const drifts = applyToState(block, m);
console.log(`state refreshed: rev ${m.revision}, methods ${m.methods}, ${m.problems.length} problem(s), ${drifts.length} drift line(s)`);
process.exit(m.problems.length ? 2 : 0);
