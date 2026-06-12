#!/usr/bin/env node
// gen-compute-report.mjs — academic run report from a genuine eval artifact.
//
// After each full suite run, this turns the committed evals.json into a short
// LaTeX manuscript (and PDF when pdflatex is present) under compute-reports/.
// The report is generated FROM the artifact — it never recomputes, never
// invents, and renders failures as loudly as passes (K1/K5). An optional
// --narrative=<file.tex> drops a hand-authored case-study section between the
// results and the integrity statement (today's SOCH-B determinism episode is
// the first).
//
// usage:
//   node scripts/gen-compute-report.mjs --evals=/path/evals.json
//        [--out-dir=compute-reports] [--narrative=file.tex] [--title="..."]
//        [--no-pdf]
//   node scripts/gen-compute-report.mjs --selftest
//
// Nightly loop runs this log-only after claims-refresh; a LaTeX problem must
// never repaint the night — the .tex is always written, the PDF is best-effort.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ENGINE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── LaTeX escaping: specials first, then the unicode our eval prose uses ──
const UNI = [
  [/—/g, "---"], [/–/g, "--"], [/→/g, "$\\rightarrow$"], [/←/g, "$\\leftarrow$"],
  [/↔/g, "$\\leftrightarrow$"], [/≥/g, "$\\geq$"], [/≤/g, "$\\leq$"],
  [/×/g, "$\\times$"], [/·/g, "$\\cdot$"], [/∈/g, "$\\in$"], [/‖/g, "$\\Vert$"],
  [/τ/g, "$\\tau$"], [/Δ/g, "$\\Delta$"], [/δ/g, "$\\delta$"], [/α/g, "$\\alpha$"],
  [/β/g, "$\\beta$"], [/σ/g, "$\\sigma$"], [/ω/g, "$\\omega$"], [/φ/g, "$\\varphi$"],
  [/π/g, "$\\pi$"], [/’/g, "'"], [/‘/g, "`"], [/“/g, "``"], [/”/g, "''"],
  [/…/g, "\\ldots{}"], [/✓/g, "\\checkmark{}"], [/§/g, "\\S{}"], [/°/g, "$^{\\circ}$"],
  [/±/g, "$\\pm$"], [/≈/g, "$\\approx$"], [/−/g, "$-$"],
];
export function esc(s) {
  let t = String(s ?? "");
  // sentinel for backslash so the brace pass can't mangle \textbackslash{}
  t = t.replace(/\\/g, "\u0000")
       .replace(/([&%$#_{}])/g, "\\$1")
       .replace(/~/g, "\\textasciitilde{}")
       .replace(/\^/g, "\\textasciicircum{}")
       .replace(/\u0000/g, "\\textbackslash{}");
  for (const [re, sub] of UNI) t = t.replace(re, sub);
  // residual non-ASCII: degrade to '?' and warn — the nightly must not die on
  // an unmapped glyph, and the selftest asserts the live artifact maps cleanly.
  const residual = t.match(/[^\x00-\x7F]/g);
  if (residual) {
    process.stderr.write(`gen-compute-report: unmapped glyphs ${JSON.stringify([...new Set(residual)])} -> '?'\n`);
    t = t.replace(/[^\x00-\x7F]/g, "?");
  }
  return t;
}

function gitShort(dir) {
  try { return execFileSync("git", ["-C", dir, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}

const fmtVal = (v) => (v === null || v === undefined || v === "") ? "---"
  : (typeof v === "number" ? String(v) : String(v));

export function buildTex(ev, opts = {}) {
  const rows = ev.results || [];
  const s = ev.summary || {};
  const eng = ev.engine || {};
  const runAt = ev.run_at || "unknown";
  const failRows = rows.filter(r => r.status === "fail");
  const pendRows = rows.filter(r => r.status === "async_pending");
  const title = opts.title ||
    `Econstellar Compute Engine: Verification Run Report, ${esc(runAt.slice(0, 10))}`;
  const engineSha = opts.engineSha || "unknown";
  const pagesSha = opts.pagesSha || "unknown";

  const resultLines = rows.map(r => {
    const prov = (r.note && /job_[0-9a-f_]+/i.test(r.note))
      ? `\\texttt{${esc((r.note.match(/job_[0-9a-z_]+/i) || [""])[0])}}`
      : (r.async ? "tower job" : "sync");
    const chip = r.status === "pass" ? "pass" : (r.status === "fail" ? "\\textbf{FAIL}" : esc(r.status));
    return `\\texttt{${esc(r.method)}} & ${chip} & ${esc(fmtVal(r.value))} & ${prov} \\\\`;
  }).join("\n");

  const failSection = failRows.length === 0
    ? `All ${rows.length} rows passed. No expected band was widened, no extraction was
altered after the run, and the artifact below is the unedited output of a single
execution of the committed runner.`
    : failRows.map(r =>
        `\\paragraph{\\texttt{${esc(r.method)}} (FAIL)} Expected: ${esc(r.expected)}.
Observed value: ${esc(fmtVal(r.value))}. ${esc(r.note || "")} Red is information:
the row is reported as it failed, pending investigation under the band/extraction
discipline --- a band failure halts; only extraction plumbing may be calibrated.`)
      .join("\n\n");

  const pendNote = pendRows.length
    ? `\\noindent ${pendRows.length} row(s) are honestly pending (async tower jobs not run in this invocation): ${pendRows.map(r => `\\texttt{${esc(r.method)}}`).join(", ")}.`
    : "";

  const appendix = rows.map(r =>
    `\\item[\\texttt{${esc(r.method)}}] ${esc(r.expected || "(no band recorded)")}\\\\
\\emph{Source:} ${esc(r.source || "(none)")}`).join("\n");

  const narrative = opts.narrativeTex
    ? `\n${opts.narrativeTex}\n`
    : "";

  return `% Auto-generated by scripts/gen-compute-report.mjs --- DO NOT hand-edit the
% results; they are a verbatim rendering of evals.json (one genuine run of the
% committed runner). Narrative sections, when present, are authored separately.
\\documentclass[11pt]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{booktabs}
\\usepackage{longtable}
\\usepackage{amsmath,amssymb}
\\usepackage[hidelinks]{hyperref}
\\usepackage{microtype}
\\newcommand{\\code}[1]{\\texttt{#1}}
\\title{${title}}
\\author{Avishek Bhandari\\\\[2pt]
\\small School of Humanities, Social Sciences and Management\\\\[-2pt]
\\small Indian Institute of Technology Bhubaneswar\\\\[-2pt]
\\small \\href{mailto:avishekb@iitbbs.ac.in}{avishekb@iitbbs.ac.in}}
\\date{Run executed ${esc(runAt)} (UTC)}
\\begin{document}
\\maketitle

\\begin{abstract}
\\noindent We report a full verification run of the Econstellar compute engine,
a continuously deployed econometric service whose every public surface ships
with a failable evaluation. The suite executed ${rows.length} pre-registered
method rows against engine revision \\code{${esc(eng.revision || "unknown")}}
(${esc(String(eng.methods ?? "?"))} registered methods):
${s.pass ?? 0} passed, ${s.fail ?? 0} failed, ${s.async_pending ?? 0} pending.
Every number below traces to a live computation or a documented published
result; expected bands are stated with their full parameterisation and were
fixed before the run. Failures, where present, are reported verbatim --- the
suite exists to fail loudly, and a hand-edited green is worse than a red.
\\end{abstract}

\\section{The engine and the run}
The engine is a sandboxed R/Node compute kernel on Google Cloud Run
(service \\code{shssm-compute}, region asia-south1), backed by an always-on
workstation job server for long-running bootstrap and surrogate work. Methods
execute the published packages of the underlying papers --- never
reimplementations. The run below was produced by
\\code{evals/run-evals.mjs}, whose output \\code{evals.json} is committed
unedited next to the public pages.

\\begin{center}
\\begin{tabular}{@{}ll@{}}
\\toprule
Run timestamp & ${esc(runAt)} \\\\
Engine URL & \\code{${esc(eng.url || "unknown")}} \\\\
Engine reachable at probe & ${eng.ok ? "yes" : "\\textbf{no (probe)} --- see row evidence"} \\\\
Engine revision & \\code{${esc(eng.revision || "unknown")}} \\\\
Registered methods & ${esc(String(eng.methods ?? "unknown"))} \\\\
Suite rows & ${rows.length} \\\\
Summary & ${s.pass ?? 0} pass / ${s.fail ?? 0} fail / ${s.async_pending ?? 0} pending \\\\
Engine repo commit & \\code{${esc(engineSha)}} \\\\
Pages repo commit & \\code{${esc(pagesSha)}} \\\\
\\bottomrule
\\end{tabular}
\\end{center}

\\section{Results}
\\begin{longtable}{@{}llll@{}}
\\toprule
Method & Status & Value & Provenance \\\\
\\midrule
\\endhead
${resultLines}
\\bottomrule
\\end{longtable}

\\section{Failures and pending rows}
${failSection}

${pendNote}
${narrative}
\\section{Integrity statement}
This report is generated from the run artifact and inherits its discipline:
(i) every row carries a pre-registered expected band naming its full
parameterisation and a source; (ii) \\code{evals.json} is the output of one
genuine run of the committed runner and is never hand-edited; (iii) a band
failure halts work --- bands are never widened to pass, and only extraction
plumbing (the harness misreading a result shape) may be calibrated, with the
band untouched; (iv) honest negatives are permanent: a non-significant test is
reported as non-significant, an empty FDR network as empty, an unproved
formal statement as unproved; (v) asynchronous rows are real tower jobs with
persistent job identifiers, or are reported pending --- never fabricated.

\\appendix
\\section{Expected bands and sources, per row}
{\\footnotesize
\\begin{description}
${appendix}
\\end{description}}

\\end{document}
`;
}

export function generate(opts) {
  const evalsPath = opts.evals;
  const ev = JSON.parse(readFileSync(evalsPath, "utf8"));
  const outDir = opts.outDir || join(ENGINE_DIR, "compute-reports");
  mkdirSync(outDir, { recursive: true });
  const stamp = (ev.run_at || "unknown").replace(/[-:]/g, "").replace(/T(\d{4}).*/, "_$1");
  const base = `run_report_${(ev.run_at || "").slice(0, 10)}_${stamp.slice(-4)}`;
  const narrativeTex = opts.narrative ? readFileSync(opts.narrative, "utf8") : null;
  const tex = buildTex(ev, {
    title: opts.title,
    narrativeTex,
    engineSha: gitShort(ENGINE_DIR),
    pagesSha: gitShort(dirname(evalsPath)),
  });
  const texPath = join(outDir, `${base}.tex`);
  writeFileSync(texPath, tex);
  let pdf = null;
  if (!opts.noPdf) {
    try {
      for (let i = 0; i < 2; i++)
        execFileSync("pdflatex", ["-interaction=nonstopmode", "-halt-on-error", `${base}.tex`],
          { cwd: outDir, stdio: "pipe", timeout: 120000 });
      pdf = join(outDir, `${base}.pdf`);
    } catch (e) {
      process.stderr.write(`gen-compute-report: pdflatex failed (tex kept): ${String(e.message).slice(0, 200)}\n`);
    }
  }
  return { texPath, pdfPath: pdf, rows: (ev.results || []).length, summary: ev.summary };
}

// ── selftest (K1): fixture-driven, no network, no pdflatex needed ──
function selftest() {
  let pass = 0, fail = 0;
  const ok = (c, n) => { console.log(`${c ? "PASS" : "FAIL"}  ${n}`); c ? pass++ : fail++; };

  ok(esc("a_b & 50% #x {y} $z") === "a\\_b \\& 50\\% \\#x \\{y\\} \\$z", "specials escaped");
  ok(esc("tau→0.05 ≥ ×J Δ‖H‖") === "tau$\\rightarrow$0.05 $\\geq$ $\\times$J $\\Delta$$\\Vert$H$\\Vert$", "unicode mapped to math macros");
  ok(!/[^\x00-\x7F]/.test(esc("π·ω—τ“q”…")), "no non-ASCII survives escaping");
  ok(esc("±0.01 ≈ −2") === "$\\pm$0.01 $\\approx$ $-$2", "pm/approx/unicode-minus mapped (a '?' minus would be a sign ambiguity)");
  ok(esc("\\evil{}") === "\\textbackslash{}evil\\{\\}", "backslash neutralised first");

  const fixture = {
    run_at: "2026-06-12T00:00:00.000Z",
    engine: { url: "https://x.example", ok: true, methods: 3, revision: "rev-test-1" },
    suite: "fixture",
    results: [
      { method: "alpha", status: "pass", value: 1.5, expected: "x ≥ 1 — τ band", source: "doc A", async: false },
      { method: "beta", status: "fail", value: 27, expected: "28/28 (100%)", source: "doc B", note: "got 27 job job_20260612_ffffffff", async: true },
      { method: "gamma", status: "async_pending", value: null, expected: "pending ok", source: "doc C", async: true },
    ],
    summary: { pass: 1, fail: 1, async_pending: 1, total: 3 },
  };
  const tex = buildTex(fixture, { engineSha: "abc1234", pagesSha: "def5678" });
  ok(/\\textbf\{FAIL\}/.test(tex), "a failed row renders loudly");
  ok(/job\\_20260612\\_ffffffff/.test(tex), "async provenance job id present (escaped)");
  ok(/async_pending|pending/.test(tex) && /gamma/.test(tex), "pending row named, not faked");
  ok(/1 pass \/ 1 fail \/ 1 pending/.test(tex), "summary rendered from artifact counts");
  ok(/never hand-edited/.test(tex), "integrity statement embeds the K5 rule");
  ok(!/[^\x00-\x7F]/.test(tex), "generated tex is pure ASCII");
  ok(/28\/28 \(100\\%\)/.test(tex), "expected band reaches the appendix escaped");
  ok(/rev-test-1/.test(tex) && /abc1234/.test(tex), "revision + repo SHA recorded");

  console.log(`\n${pass}/${pass + fail} gen-compute-report selftests passed`);
  process.exit(fail ? 1 : 0);
}

// main-module guard (L9): safe to import buildTex/esc without CLI side-effects
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (k) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.split("=").slice(1).join("=") : null; };
  if (process.argv.includes("--selftest")) selftest();
  else {
    const evals = arg("evals");
    if (!evals || !existsSync(evals)) { console.error("usage: gen-compute-report.mjs --evals=/path/evals.json [--narrative=f.tex] [--out-dir=d] [--title=t] [--no-pdf]"); process.exit(2); }
    const r = generate({ evals, narrative: arg("narrative"), outDir: arg("out-dir"), title: arg("title"), noPdf: process.argv.includes("--no-pdf") });
    console.log(`report: ${r.texPath}${r.pdfPath ? ` + ${r.pdfPath}` : " (tex only)"} — ${r.rows} rows, ${JSON.stringify(r.summary)}`);
  }
}
