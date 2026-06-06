#!/usr/bin/env bash
# Vision Phase 29 — host run: create literature.papers (location US) + ingest.
# Paste-safe (no fragile interactive quoting). Idempotent. Run: bash run-ingest.sh
set -uo pipefail

PROJECT=hopeful-flash-485308-v3
ENVFILE=/home/ecolex/versiondevs/.env.local
DIR=/home/ecolex/versiondevs/ivy-fineco/compute-engine/neuricx/literature
LOC=US   # must match the kernel's query location (the live 404 resolved in US)

echo "== 1. project =="
gcloud config set project "$PROJECT" >/dev/null 2>&1 && echo "project -> $PROJECT"
# best-effort: align ADC quota project (silences the warning; harmless if it fails)
gcloud auth application-default set-quota-project "$PROJECT" >/dev/null 2>&1 || true

echo "== 2. GOOGLE_API_KEY (from .env.local, quotes stripped) =="
GOOGLE_API_KEY=$(python3 -c "v=[l.split('=',1)[1] for l in open('$ENVFILE') if l.startswith('GOOGLE_API_KEY=')]; print(v[0].strip().strip(chr(34)).strip(chr(39)) if v else '')")
export GOOGLE_API_KEY
if [ -z "$GOOGLE_API_KEY" ]; then echo "ERROR: GOOGLE_API_KEY not found in $ENVFILE"; exit 1; fi
echo "GOOGLE_API_KEY -> ${#GOOGLE_API_KEY} chars"

echo "== 3. proxy on :3001 (ingest.mjs uses it for the BigQuery bearer) =="
if curl -sf --max-time 5 http://localhost:3001/api/gcloud-token >/dev/null 2>&1; then
  echo "proxy :3001 -> OK"
else
  echo "ERROR: proxy not reachable on :3001. In another terminal: cd /home/ecolex/versiondevs && npm run proxy"; exit 1
fi

echo "== 4. BigQuery dataset + table (location $LOC, idempotent) =="
bq --location="$LOC" mk --dataset "$PROJECT:literature" 2>/dev/null && echo "dataset literature created ($LOC)" || echo "dataset literature exists (or mk skipped)"
bq mk --table "$PROJECT:literature.papers" "$DIR/schema.json" 2>/dev/null && echo "table papers created" || echo "table papers exists (or mk skipped)"
echo "-- table check --"; bq show --format=prettyjson "$PROJECT:literature.papers" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print('table location:', d.get('location'), '| fields:', len(d.get('schema',{}).get('fields',[])))" 2>/dev/null || echo "(table not visible yet)"

echo "== 5. ingest (last 7 days, econ.EM + q-fin.RM + stat.AP) =="
cd "$DIR" || exit 1
node ingest.mjs --days 7
echo "== done. ping the assistant to verify /api/situate + /api/research live. =="
