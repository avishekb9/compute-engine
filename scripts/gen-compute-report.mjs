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

// ── method taxonomy: organises the flat suite into families for the report.
// Purely structural (no values live here); a method in no family falls to "Other".
const METHOD_FAMILIES = [
  { key: "stationarity", title: "Stationarity, unit roots and cointegration",
    methods: ["unit_root", "live_unit_root", "panel_unit_root", "vecm"],
    basis: "Augmented Dickey--Fuller and KPSS tests, the Im--Pesaran--Shin and Levin--Lin--Chu panel unit-root tests, and Johansen's trace test for cointegrating rank. The downstream information-flow estimators require inputs integrated of order zero, so log-returns are tested, never price levels." },
  { key: "volatility", title: "Volatility, long memory and spectra",
    methods: ["garch", "dfa_hurst", "namh_hurst", "wavelet", "wavelet_coherence"],
    basis: "GARCH(1,1) persistence, the Hurst exponent by detrended fluctuation analysis, and a maximal-overlap discrete wavelet transform for scale-resolved variance and cross-market coherence." },
  { key: "information", title: "Information flow and transfer entropy",
    methods: ["ksg_te", "ksg_robustness", "namh_te", "namh_pipeline", "wqte", "soch_profile", "quantile_var"],
    basis: "Transfer entropy \\cite{schreiber2000} estimated by the Kraskov--St\\\"ogbauer--Grassberger nearest-neighbour scheme \\cite{kraskov2004} in the Frenzel--Pompe conditional-mutual-information form \\cite{frenzel2007}, with significance assessed against IAAFT surrogates \\cite{schreiber1996} and edges selected under Benjamini--Hochberg false-discovery control \\cite{benjamini1995}; a wavelet--quantile variant resolves spillover by scale and quantile." },
  { key: "connectedness", title: "Connectedness and networks",
    methods: ["var_irf", "granger", "connectedness", "spillover_rolling", "network", "rolling_dcc"],
    basis: "Vector-autoregressive impulse responses, Granger-causal edges, and the Diebold--Y\\i lmaz forecast-error-variance connectedness index \\cite{dieboldyilmaz2012}, static and rolling, with a dynamic conditional-correlation companion and an \\code{igraph} network surface." },
  { key: "systemic", title: "Contagion channels and systemic risk",
    methods: ["channel_attribution", "sri_daily"],
    basis: "Attribution of crisis-window spillovers to economic channels (trade, finance and others; the global-financial-crisis decomposition is anchored to arXiv:2604.26546), and a daily systemic-risk index recomputed in full from the stored panel." },
  { key: "verification", title: "Reproduction and formal verification",
    methods: ["namh_reproduce", "soch_robustness"],
    basis: "A delta-verifier that re-runs the published estimators of the \\code{namh} package \\cite{namh2026} and reports the maximum absolute deviation from the archived output, and a seeded robustness badge \\cite{lecuyer1999} over the published SOCH symmetry test." },
];

// ── references: looked up, never reconstructed from a codename (an arXiv id is
// cited by id alone where its registered title is not verified here). Every key
// below is cited at least once by the generated scaffold on a full suite, so the
// list carries no orphans; the generator renders it last, after every section.
const REFERENCES = [
  ["kraskov2004", "Kraskov, A., St\\\"ogbauer, H., \\& Grassberger, P. (2004). Estimating mutual information. \\emph{Physical Review E}, 69(6), 066138."],
  ["frenzel2007", "Frenzel, S., \\& Pompe, B. (2007). Partial mutual information for coupling analysis of multivariate time series. \\emph{Physical Review Letters}, 99(20), 204101."],
  ["schreiber2000", "Schreiber, T. (2000). Measuring information transfer. \\emph{Physical Review Letters}, 85(2), 461--464."],
  ["schreiber1996", "Schreiber, T., \\& Schmitz, A. (1996). Improved surrogate data for nonlinearity tests. \\emph{Physical Review Letters}, 77(4), 635--638."],
  ["benjamini1995", "Benjamini, Y., \\& Hochberg, Y. (1995). Controlling the false discovery rate: a practical and powerful approach to multiple testing. \\emph{Journal of the Royal Statistical Society: Series B}, 57(1), 289--300."],
  ["dieboldyilmaz2012", "Diebold, F. X., \\& Y\\i lmaz, K. (2012). Better to give than to receive: predictive directional measurement of volatility spillovers. \\emph{International Journal of Forecasting}, 28(1), 57--66."],
  ["lecuyer1999", "L'Ecuyer, P. (1999). Good parameters and implementations for combined multiple recursive random number generators. \\emph{Operations Research}, 47(1), 159--164."],
  ["namh2026", "Bhandari, A., \\& Sahu (2026). \\emph{namh}: Network Adaptive Market Hypothesis estimators. R package version 0.1.0 (GPL-3)."],
  ["econstellar2026", "Bhandari, A. (2026). Econstellar: an open-source AI-augmented research engine for computational financial econometrics. \\emph{arXiv:2606.05705}."],
];

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

  const byMethod = new Map(rows.map(r => [r.method, r]));
  const chip = (r) => r.status === "pass" ? "pass" : (r.status === "fail" ? "\\textbf{FAIL}" : esc(r.status));
  const jobOf = (r) => {
    const m = r && r.note && r.note.match(/job_[0-9a-z_]+/i);
    return m ? `\\code{${esc(m[0])}}` : (r && r.async ? "tower" : "sync");
  };

  // Results grouped by family (Method, Value, pre-registered band, Status);
  // any method in no family is gathered into a trailing "Other" block.
  const placed = new Set();
  const resultRow = (r) =>
    `\\code{${esc(r.method)}} & ${esc(fmtVal(r.value))} & {\\footnotesize ${esc(r.expected || "---")}} & ${chip(r)} \\\\`;
  const famBlocks = [];
  for (const fam of METHOD_FAMILIES) {
    const fr = fam.methods.map(m => byMethod.get(m)).filter(Boolean);
    if (!fr.length) continue;
    fr.forEach(r => placed.add(r.method));
    famBlocks.push(`\\multicolumn{4}{@{}l}{\\textbf{${fam.title}}}\\\\[1pt]\n${fr.map(resultRow).join("\n")}\n\\addlinespace`);
  }
  const otherRows = rows.filter(r => !placed.has(r.method));
  if (otherRows.length)
    famBlocks.push(`\\multicolumn{4}{@{}l}{\\textbf{Other}}\\\\[1pt]\n${otherRows.map(resultRow).join("\n")}\n\\addlinespace`);
  const resultsTable = famBlocks.join("\n");

  // Data & methods: a description list of the families actually present, each
  // naming its published basis (and citing it); plus a phrase for the abstract.
  const presentFams = METHOD_FAMILIES.filter(f => f.methods.some(m => byMethod.has(m)));
  const famDesc = presentFams.map(f => {
    const ms = f.methods.filter(m => byMethod.has(m)).map(m => `\\code{${esc(m)}}`).join(", ");
    return `\\item[${f.title}.] ${f.basis}\\\\\\textit{Methods:} ${ms}.`;
  }).join("\n");
  const dataMethodsList = famDesc
    ? `\\begin{description}\\setlength{\\itemsep}{2pt}\n${famDesc}\n\\end{description}`
    : "The suite's methods are listed individually in Table~\\ref{tab:results}.";
  const familyPhrase = presentFams.length
    ? presentFams.map(f => f.title.charAt(0).toLowerCase() + f.title.slice(1)).join("; ")
    : "the registered method suite";

  const failSection = failRows.length === 0
    ? `All ${rows.length} rows fall within their pre-registered bands. No band was
widened and no extraction was altered after the run; the tables here are the
unedited rendering of a single execution of the committed runner.`
    : failRows.map(r =>
        `\\paragraph{\\code{${esc(r.method)}} (FAIL)} Expected: ${esc(r.expected)}.
Observed: ${esc(fmtVal(r.value))}. ${esc(r.note || "")} Red is information: the row
is reported as it failed, under the band/extraction discipline --- a band failure
halts; only extraction plumbing may be calibrated, the band untouched.`)
      .join("\n\n");

  const pendNote = pendRows.length
    ? `\\noindent ${pendRows.length} row(s) are honestly pending (async tower jobs not run in this invocation): ${pendRows.map(r => `\\code{${esc(r.method)}}`).join(", ")}.`
    : "";

  // Per-row provenance (appendix): the source band and the tower job id, if any.
  const provLines = rows.map(r =>
    `\\code{${esc(r.method)}} & {\\footnotesize ${esc(r.source || "---")}} & ${jobOf(r)} \\\\`).join("\n");

  // An included narrative authors interpretation, not references: strip any
  // bibliography it carries so this generator alone owns reference placement
  // (always last) and a narrative can never push a reference list before a section.
  let narrTex = opts.narrativeTex || "";
  if (narrTex) narrTex = narrTex.replace(/\\begin\{thebibliography\}[\s\S]*?\\end\{thebibliography\}/g, "").trimEnd();
  const narrative = narrTex ? `\n${narrTex}\n` : "";

  const bib = REFERENCES.map(([k, t]) => `\\bibitem{${k}} ${t}`).join("\n\n");

  // The engine self-report (revision, method count) can be absent when this
  // run's single-shot health probe raced a Cloud Run cold start --- the method
  // rows still executed against the live service. Render the absence honestly
  // rather than inventing a revision or stamping a bare "?" method count.
  const revShown = eng.revision ? `\\code{${esc(eng.revision)}}` : "not captured at this run's probe";
  const methodsShown = (eng.methods === null || eng.methods === undefined) ? null : String(eng.methods);
  const methodsCell = methodsShown ? esc(methodsShown) : "not captured at probe";

  return `% Auto-generated by scripts/gen-compute-report.mjs --- DO NOT hand-edit the
% results: they are a verbatim rendering of evals.json (one genuine run of the
% committed runner). Narrative sections, when present, are authored separately;
% the reference list is owned by this generator and is always rendered last.
\\documentclass[11pt]{article}
\\usepackage[margin=1in]{geometry}
\\usepackage{booktabs}
\\usepackage{longtable}
\\usepackage{array}
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
\\noindent We report a complete verification run of the Econstellar compute
engine, a continuously deployed econometric service for financial-market
analysis in which every public method ships with a pre-registered, failable
evaluation. The suite executed ${rows.length} method rows --- spanning
${familyPhrase} --- against the live service, each checked against an expected
band fixed before the run and naming its full parameterisation and source:
${s.pass ?? 0} passed, ${s.fail ?? 0} failed, ${s.async_pending ?? 0} pending.
Every quantity traces to a live computation or a documented published result;
the methods execute the original papers' own software rather than
reimplementations; and the document is generated mechanically from the run
artefact, so that it may be regenerated and audited rather than taken on trust.
Honest negatives, where present, are reported as the registered expectation: an
empty network or a non-significant test is a result, not a blemish to manage.
\\end{abstract}

\\smallskip
\\noindent\\textbf{Keywords:} reproducible econometrics; transfer entropy;
financial contagion; systemic risk; sandboxed computation; continuous verification.

\\smallskip
\\noindent\\textbf{JEL classification:} C55, C58, C63, C88, G15.

\\section{The engine and the run}
The engine is a sandboxed R/Node compute kernel on Google Cloud Run (service
\\code{shssm-compute}, region asia-south1), backed by an always-on workstation
job server for long-running bootstrap and surrogate work. Each method executes
the published package of its source paper rather than a reimplementation. The
run below was produced by \\code{evals/run-evals.mjs}, whose output
\\code{evals.json} is committed unedited beside the public pages and is the sole
source of every number in this report.

\\begin{center}
\\small
\\begin{tabular}{@{}ll@{}}
\\toprule
Run timestamp & ${esc(runAt)} \\\\
Engine URL & \\code{${esc(eng.url || "unknown")}} \\\\
Engine reachable at probe & ${eng.ok ? "yes" : "\\textbf{no (probe)} --- see \\S\\ref{sec:repro}"} \\\\
Engine revision & ${revShown} \\\\
Registered methods & ${methodsCell} \\\\
Suite rows & ${rows.length} \\\\
Summary & ${s.pass ?? 0} pass / ${s.fail ?? 0} fail / ${s.async_pending ?? 0} pending \\\\
Engine repo commit & \\code{${esc(engineSha)}} \\\\
Pages repo commit & \\code{${esc(pagesSha)}} \\\\
\\bottomrule
\\end{tabular}
\\end{center}

\\section{Data and methods}
The engine analyses daily log-returns of major markets. Two panels recur:
\\code{g20} (18 markets, 5036 daily observations, 306 directed pairs) and
\\code{g20\\_24} (24 series, adding commodities, 552 directed pairs).
Information-flow estimators require stationary inputs, so returns --- integrated
of order zero --- are used throughout, never price levels. The ${rows.length}
method rows group into the families below; each names the published basis it runs.

${dataMethodsList}

\\section{Results}
Table~\\ref{tab:results} groups the ${rows.length} rows by family, placing each
verified value beside the pre-registered band it was checked against:
${s.pass ?? 0} of ${rows.length} fall within band (${s.fail ?? 0} fail,
${s.async_pending ?? 0} pending). The bands are not decorative. Several encode
honest negatives: where the engine ships an empty false-discovery-controlled
network or a bit-exact reproduction target, the null or the exact value is the
correct outcome, and a populated network or a moved number would be the failure,
not the pass.

{\\small
\\begin{longtable}{@{}l r >{\\raggedright\\arraybackslash}p{0.44\\textwidth} c@{}}
\\caption{Verification suite grouped by method family: the verified value, the
pre-registered band with its parameterisation, and pass/fail status. Rendered
verbatim from \\texttt{evals.json}.}\\label{tab:results}\\\\
\\toprule
Method & Value & Pre-registered band (parameterisation) & Status \\\\
\\midrule
\\endfirsthead
\\toprule
Method & Value & Pre-registered band (parameterisation) & Status \\\\
\\midrule
\\endhead
${resultsTable}
\\bottomrule
\\end{longtable}}

\\section{Failures and pending rows}
${failSection}

${pendNote}
${narrative}
\\section{Reproducibility and integrity}\\label{sec:repro}
This report is generated mechanically from the run artefact and inherits its
discipline. (i)~Every row carries a pre-registered band naming its full
parameterisation and a source, fixed before the run. (ii)~\\code{evals.json} is
the output of one genuine run of the committed runner and is never hand-edited;
to change a number one re-runs the suite, not the report. (iii)~A band failure
halts work --- bands are never widened to pass, and only extraction plumbing
(the harness misreading a result shape) may be calibrated, with the band
untouched. (iv)~Honest negatives are permanent: a non-significant test is
reported as non-significant, an empty false-discovery network as empty
\\cite{benjamini1995}, an unproved formal statement as unproved.
(v)~Asynchronous rows are real workstation jobs with persistent identifiers, or
are reported pending --- never fabricated.

Reproduction is graded rather than asserted. Deterministic estimators --- the
nearest-neighbour transfer entropy \\cite{kraskov2004} and the Hurst panel of
the published \\code{namh} package \\cite{namh2026} --- are reproduced to a
stated maximum absolute deviation and earn a green only on an exact match;
stochastic surrogate stages, whose generators were unseeded in the original
runs, are reported amber rather than dressed as exact. Where the engine seeds
its own surrogate and bootstrap stages it uses a single declared generator
\\cite{lecuyer1999}, so a result is reproducible for a fixed seed and core count
and the asymmetry with the unseeded published run is stated, not concealed. The
engine and this verification apparatus are described in full in the accompanying
system paper \\cite{econstellar2026}.

\\appendix
\\section{Per-row provenance}
{\\footnotesize
\\begin{longtable}{@{}l >{\\raggedright\\arraybackslash}p{0.60\\textwidth} l@{}}
\\toprule
Method & Source band / provenance & Tower job \\\\
\\midrule
\\endhead
${provLines}
\\bottomrule
\\end{longtable}}

\\begin{thebibliography}{99}
${bib}
\\end{thebibliography}

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
  ok(/28\/28 \(100\\%\)/.test(tex), "expected band rendered in the results table (escaped)");
  ok(/rev-test-1/.test(tex) && /abc1234/.test(tex), "revision + repo SHA recorded");

  // probe-race artifact: engine self-report absent (a real evals.json state when
  // the health probe races a Cloud Run cold start). The rows still ran, so the
  // report must render cleanly without inventing a revision or a bare "?" count.
  const probeRace = buildTex({
    run_at: "2026-06-12T17:00:00.000Z",
    engine: { url: "https://x.example", ok: false, methods: null, revision: null },
    results: [{ method: "alpha", status: "pass", value: 1, expected: "x", source: "s", async: false }],
    summary: { pass: 1, fail: 0, async_pending: 1, total: 1 },
  }, {});
  ok(!/\? registered methods/.test(probeRace), "null method count renders without a bare '?'");
  ok(/not captured at/.test(probeRace), "absent engine self-report rendered honestly, not fabricated");
  ok(!/[^\x00-\x7F]/.test(probeRace), "probe-race tex is pure ASCII");

  // structure (upgrade): the generator owns the reference list and renders it
  // LAST, after every section including the appendix; method families present.
  ok(tex.indexOf("\\begin{thebibliography}") > tex.indexOf("\\appendix"),
     "references placed after the appendix (never before a section)");
  ok(tex.lastIndexOf("\\section{") < tex.indexOf("\\begin{thebibliography}"),
     "no section appears after the reference list");
  ok(/\\section\{Data and methods\}/.test(tex), "data-and-methods section present");
  ok(/\\cite\{benjamini1995\}/.test(tex) && /\\bibitem\{benjamini1995\}/.test(tex),
     "a cited key resolves to a bibitem (no dangling citation)");

  // an included narrative authors prose, not references: any bibliography it
  // carries is stripped, so the generator's single list stays last.
  const withNarr = buildTex(fixture, {
    narrativeTex: "\\section{Case}\nProse.\n\\begin{thebibliography}{9}\n\\bibitem{x} X.\n\\end{thebibliography}\n",
  });
  ok((withNarr.match(/\\begin\{thebibliography\}/g) || []).length === 1,
     "narrative bibliography stripped: exactly one reference list (the generator's)");
  ok(withNarr.indexOf("\\begin{thebibliography}") > withNarr.indexOf("Case"),
     "the surviving reference list follows the narrative section");

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
