#!/usr/bin/env bash
# nightly-loop.sh — the engine's reboot-surviving self-check loop.
# 07:10 UTC daily (after the 06:00 UTC SRI tick): re-arm the job server if the
# port is closed (never kills anything), run the full public eval suite (async
# rows as real tower jobs), then refresh STATE.md and append drift. Exit code
# follows state-refresh: non-zero means a problem line was written — loud in
# the cron log, never silent.
set -u
ENGINE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PAGES_DIR="${PAGES_DIR:-$ENGINE_DIR/../econstellar}"
LOG_PREFIX="[nightly $(date -u +%FT%TZ)]"

echo "$LOG_PREFIX start"

# 1) job server: start only if the port is closed (idempotent, no kills)
if ! curl -sf --max-time 5 http://127.0.0.1:3030/api/jobs >/dev/null 2>&1; then
  echo "$LOG_PREFIX job-server down, re-arming"
  ( cd "$ENGINE_DIR" && COMPUTE_REPO="${COMPUTE_REPO:-/home/ecolex/versiondevs/ivy-fineco}" \
    setsid node server/job-server.mjs >> /tmp/job-server-nightly.log 2>&1 < /dev/null & )
  sleep 4
fi

# 2) the eval suite: one genuine run of the committed runner, artifact in place
if [ -f "$PAGES_DIR/evals/run-evals.mjs" ]; then
  ( cd "$PAGES_DIR" && node evals/run-evals.mjs --async --out="$PAGES_DIR/evals.json" )
  SUITE=$?
  echo "$LOG_PREFIX suite exit $SUITE"
else
  echo "$LOG_PREFIX no eval runner at $PAGES_DIR, skipping suite"
fi

# 3) state refresh + drift append (exit 2 on regression -> cron log shows it)
node "$ENGINE_DIR/scripts/state-refresh.mjs" --evals "$PAGES_DIR/evals.json"
RC=$?
echo "$LOG_PREFIX state-refresh exit $RC"

# 4) epistemic claim refresh (Phase 34): pass rows bump last_verified; a red
#    creates a contested pair (never deletes). Log-only — a BQ outage must not
#    repaint the night; the suite + state-refresh above are the canary.
node "$ENGINE_DIR/scripts/claims-refresh.mjs" --apply --evals="$PAGES_DIR/evals.json" \
  && echo "$LOG_PREFIX claims-refresh ok" \
  || echo "$LOG_PREFIX claims-refresh skipped/failed (non-fatal; see above)"

# 5) academic run report (compute-reports/): a LaTeX manuscript generated FROM
#    tonight's evals.json (verbatim rendering — failures render as loudly as
#    passes; never recomputes, never invents). Log-only — a LaTeX problem must
#    not repaint the night; the .tex is always written, the PDF is best-effort.
#    Runs nice'd: it is pure render + a single pdflatex, but it must never
#    contend with a long-running tower job for CPU (the report layer is the one
#    step that can always yield). If a hand-authored narrative for the run's
#    date exists (compute-reports/narrative_<YYYY-MM-DD>.tex), include it.
NARR_DATE="$(node -e 'try{process.stdout.write((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).run_at||"").slice(0,10))}catch(e){}' "$PAGES_DIR/evals.json" 2>/dev/null)"
[ -z "$NARR_DATE" ] && NARR_DATE="$(date -u +%F)"
NARR="$ENGINE_DIR/compute-reports/narrative_${NARR_DATE}.tex"
NARR_FLAG=""; [ -f "$NARR" ] && NARR_FLAG="--narrative=$NARR"
nice -n 19 node "$ENGINE_DIR/scripts/gen-compute-report.mjs" --evals="$PAGES_DIR/evals.json" $NARR_FLAG \
  && echo "$LOG_PREFIX compute-report ok${NARR_FLAG:+ (+narrative ${NARR_DATE})}" \
  || echo "$LOG_PREFIX compute-report skipped/failed (non-fatal; see above)"

exit $RC
