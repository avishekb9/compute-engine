# compute-reports/

Academic run reports for the Econstellar compute engine. After each full
verification-suite run, a short LaTeX manuscript is generated **from the run
artifact** (`econstellar/evals.json`) and compiled to PDF here.

```
run_report_<YYYY-MM-DD>_<HHMM>.{tex,pdf}   generated report (tex is verbatim from evals.json)
narrative_<YYYY-MM-DD>.tex                  optional hand-authored case-study sections for that run
```

## How a report is produced

`scripts/gen-compute-report.mjs --evals=<…/evals.json> [--narrative=<file.tex>]`

* The **results** (method / status / value / provenance table, the summary, the
  per-row expected bands in the appendix) are a **verbatim rendering of
  `evals.json`** — the output of one genuine run of the committed eval runner.
  The generator **never recomputes, never invents, and renders a failure as
  loudly as a pass**. `evals.json` is never hand-edited (K5); to change a number
  you re-run the suite, not the report.
* An optional `--narrative=<file>` drops hand-authored prose (deployment notes,
  a case study) between the results and the integrity statement. By convention
  it is named `narrative_<run-date>.tex`; the nightly loop auto-includes it when
  one exists for the run's date.
* The `.tex` is always written; the PDF is best-effort (two `pdflatex` passes,
  120 s cap each). A LaTeX failure keeps the `.tex` and exits non-fatally.

## CPU-safety contract (why this layer cannot hang the machine)

The engine's heavy compute (KSG transfer entropy, IAAFT surrogates, bootstrap
nulls, the NAMH pipeline) fans out across all logical cores via `mclapply`
FORK. On a workstation that work can saturate every core; it is run through the
**async tower job server at concurrency 2**, and it is the *suite* step, not the
report step.

**This report layer does no compute.** It reads a finished JSON artifact,
renders text, and runs a single `pdflatex`. It is wired into `nightly-loop.sh`
step 5 **after** the suite, **`nice -n 19`**, log-only and non-fatal. It can
always yield the CPU and never contends with a running tower job. Do not move
report generation in front of, or in parallel with, the compute suite, and do
not have it trigger a re-run of the suite to "refresh" the artifact.

## Manual (re)generation

```bash
# from the engine root; pure render, safe to run anytime
nice -n 19 node scripts/gen-compute-report.mjs \
  --evals=../econstellar/evals.json \
  --narrative=compute-reports/narrative_$(date -u +%F).tex   # omit if none

node scripts/gen-compute-report.mjs --selftest               # 16/16, no network, no pdflatex
```
