#!/usr/bin/env node
// publish-reports.mjs — publish the compute-run report PDFs to the econstellar web
// checkout so the research-engine page's paper gallery can display them.
//
// For every compute-reports/*.pdf it parses the companion .tex (title, date,
// abstract), reads the page count (pdfinfo) and renders a first-page thumbnail
// (pdftoppm/pdftocairo, best-effort), copies the PDF + thumbnail into
// <web>/reports/, and writes <web>/reports/manifest.json (newest-first). The
// gallery is a static fetch of that manifest, so publishing is just files.
//
// Idempotent and non-fatal: a missing web checkout, pdfinfo, or thumbnail tool is
// warned and skipped, never thrown — wired as a nightly step after the report so it
// can never repaint the night. Pure rendering: it never recomputes a result.
//
//   node scripts/publish-reports.mjs [--web-dir=../econstellar] [--reports-dir=compute-reports] [--no-thumb]
//   node scripts/publish-reports.mjs --selftest    # parser checks, no disk/network
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, copyFileSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = join(HERE, "..");

// ── LaTeX → plain text for the abstract snippet ──────────────────────────────
export function texToPlain(s) {
  return String(s)
    .replace(/(^|[^\\])%.*$/gm, "$1")               // strip line comments
    .replace(/\\(noindent|smallskip|medskip|bigskip|maketitle|par)\b/g, " ")
    .replace(/\\(code|textbf|textit|emph|texttt|textsc)\{([^}]*)\}/g, "$2")
    .replace(/\\href\{[^}]*\}\{([^}]*)\}/g, "$1")
    .replace(/\\cite\{[^}]*\}/g, "")
    .replace(/---/g, "—").replace(/--/g, "–")
    .replace(/\\[a-zA-Z]+\b/g, " ")                  // any remaining control words
    .replace(/[{}$\\]/g, " ")
    .replace(/~/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function snippet(s, n = 300) {
  const t = texToPlain(s);
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const sp = cut.lastIndexOf(" ");
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).trim() + "…";
}

// parse one report's metadata from its .tex source (title/date/abstract)
export function parseTex(tex, fallbackTitle) {
  const title = (tex.match(/\\title\{([^}]*)\}/) || [])[1] || fallbackTitle || "Compute-run report";
  const dateRaw = (tex.match(/\\date\{([^}]*)\}/) || [])[1] || "";
  const iso = (dateRaw.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/) || dateRaw.match(/\d{4}-\d{2}-\d{2}/) || [])[0] || "";
  const abs = (tex.match(/\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/) || [])[1] || "";
  return { title: texToPlain(title), date_iso: iso, summary: snippet(abs) };
}

function pdfPages(pdfPath) {
  try {
    const out = execFileSync("pdfinfo", [pdfPath], { stdio: ["ignore", "pipe", "ignore"], timeout: 15000 }).toString();
    return Number((out.match(/Pages:\s*(\d+)/) || [])[1]) || null;
  } catch { return null; }
}

function makeThumb(pdfPath, outPrefix) {
  // outPrefix.png (best-effort, first page, ~560px wide). Try pdftoppm then pdftocairo.
  for (const [bin, args] of [
    ["pdftoppm", ["-png", "-singlefile", "-f", "1", "-l", "1", "-scale-to", "560", pdfPath, outPrefix]],
    ["pdftocairo", ["-png", "-singlefile", "-f", "1", "-l", "1", "-scale-to", "560", pdfPath, outPrefix]],
  ]) {
    try { execFileSync(bin, args, { stdio: "ignore", timeout: 30000 }); if (existsSync(outPrefix + ".png")) return true; }
    catch { /* try next */ }
  }
  return false;
}

function arg(name, def) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : def;
}

function publish() {
  const reportsDir = arg("reports-dir", join(ENGINE_DIR, "compute-reports"));
  const webDir = arg("web-dir", join(ENGINE_DIR, "..", "econstellar"));
  const noThumb = process.argv.includes("--no-thumb");
  if (!existsSync(reportsDir)) { console.error(`publish-reports: no reports dir ${reportsDir} — nothing to do`); return; }
  if (!existsSync(webDir)) { console.error(`publish-reports: web checkout ${webDir} absent — skipping (non-fatal)`); return; }
  const outDir = join(webDir, "reports");
  mkdirSync(outDir, { recursive: true });

  const pdfs = readdirSync(reportsDir).filter(f => f.toLowerCase().endsWith(".pdf"));
  const entries = [];
  for (const pdf of pdfs) {
    const base = pdf.replace(/\.pdf$/i, "");
    const pdfPath = join(reportsDir, pdf);
    const texPath = join(reportsDir, base + ".tex");
    const meta = existsSync(texPath)
      ? parseTex(readFileSync(texPath, "utf8"), base)
      : { title: base, date_iso: (base.match(/\d{4}-\d{2}-\d{2}/) || [])[0] || "", summary: "" };
    copyFileSync(pdfPath, join(outDir, pdf));
    let thumb = null;
    if (!noThumb && makeThumb(join(outDir, pdf), join(outDir, base + ".thumb"))) thumb = `reports/${base}.thumb.png`;
    entries.push({
      file: `reports/${pdf}`,
      title: meta.title,
      date_iso: meta.date_iso,
      date: meta.date_iso ? meta.date_iso.slice(0, 10) : "",
      pages: pdfPages(pdfPath),
      size_kb: Math.round(statSync(pdfPath).size / 1024),
      summary: meta.summary,
      thumb,
    });
  }
  // newest first by ISO date, then filename
  entries.sort((a, b) => (b.date_iso || "").localeCompare(a.date_iso || "") || b.file.localeCompare(a.file));
  const manifest = { generated_at: new Date().toISOString(), count: entries.length, reports: entries };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.error(`publish-reports: ${entries.length} report(s) -> ${join(outDir, "manifest.json")}`);
  for (const e of entries) console.error(`  • ${e.date}  ${e.title}  (${e.pages ?? "?"}pp, ${e.size_kb}KB${e.thumb ? ", thumb" : ", no-thumb"})`);
}

// ── selftest (no disk/network) ──
function selftest() {
  let pass = 0, fail = 0;
  const ok = (c, m) => (c ? pass++ : (fail++, console.error("FAIL:", m)));
  const tex = `\\title{Econstellar Compute Engine: Verification Run Report, 2026-06-12}
\\date{Run executed 2026-06-12T17:41:53.875Z (UTC)}
\\begin{abstract}
\\noindent We report a complete verification run of the \\code{econstellar} engine ---
26 method rows, 26 passed \\cite{x}. Honest negatives are results.
\\end{abstract}`;
  const m = parseTex(tex, "fallback");
  ok(m.title === "Econstellar Compute Engine: Verification Run Report, 2026-06-12", "title parsed");
  ok(m.date_iso === "2026-06-12T17:41:53.875Z", "iso date parsed: " + m.date_iso);
  ok(/We report a complete verification run of the econstellar engine/.test(m.summary), "abstract de-TeX'd: " + m.summary.slice(0, 60));
  ok(!/\\|\{|\}|cite/.test(m.summary), "no TeX residue in summary");
  ok(texToPlain("a---b \\code{c} ~ d").includes("—"), "em-dash normalised");
  ok(parseTex("no title here", "fb").title === "fb", "fallback title");
  console.error(`\n${pass}/${pass + fail} publish-reports selftests passed`);
  process.exit(fail ? 1 : 0);
}

if (process.argv.includes("--selftest")) selftest();
else publish();
