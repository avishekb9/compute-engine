#!/usr/bin/env bash
# Deploy the SHSSM Compute Engine to Cloud Run.
# Stages the engine + the one bundled dataset into a temp build context (Docker
# can't COPY from outside its context, and the G20 data lives outside
# compute-engine/), then `gcloud run deploy --source`.
#
#   bash cloudrun/deploy.sh
#
# Prereqs (enabled already this project): run, cloudbuild, artifactregistry.
set -euo pipefail

PROJECT="${GCP_PROJECT:-hopeful-flash-485308-v3}"
REGION="${GCP_REGION:-asia-south1}"
SERVICE="${SERVICE:-shssm-compute}"
ACCOUNT="${GCP_ACCOUNT:-avishekb@iitbbs.ac.in}"

HERE="$(cd "$(dirname "$0")" && pwd)"          # compute-engine/cloudrun
ENGINE="$(cd "$HERE/.." && pwd)"               # compute-engine
REPO="$(cd "$ENGINE/.." && pwd)"               # ivy-fineco
DATA="$REPO/papers/contagion-channels/data/G20.xlsx"
SOCHPKG="$REPO/papers/SOCH/code/sochcontagion_0.1.0.tar.gz"   # published method for soch_profile
CCPKG="$REPO/papers/contagion-channels/code/contagionchannels_0.1.3.tar.gz"   # published method for channel_attribution
NAMHPKG="$REPO/papers/namh/code/namh_0.1.0.tar.gz"   # published methods for namh_hurst / namh_te (+ bundled g20_24 extdata)
NEWS="$REPO/papers/news-networks/data/news_attention_logchange.csv"   # news_attention dataset (Frontiers III news-attention TE)

[ -f "$DATA" ] || { echo "ERROR: G20 data not found at $DATA"; exit 1; }
[ -f "$SOCHPKG" ] || { echo "ERROR: sochcontagion tarball not found at $SOCHPKG"; exit 1; }
[ -f "$CCPKG" ] || { echo "ERROR: contagionchannels tarball not found at $CCPKG"; exit 1; }
[ -f "$NAMHPKG" ] || { echo "ERROR: namh tarball not found at $NAMHPKG (build: R CMD build papers/namh/code/namh-pkg)"; exit 1; }
[ -f "$NEWS" ] || { echo "ERROR: news-attention panel not found at $NEWS"; exit 1; }

# GOOGLE_API_KEY enables the /api/chat Gemini analyst. Read from env or
# versiondevs/.env.local (one level above ivy-fineco); never printed/committed.
KEY="${GOOGLE_API_KEY:-}"
if [ -z "$KEY" ] && [ -f "$REPO/../.env.local" ]; then
  KEY=$(grep '^GOOGLE_API_KEY=' "$REPO/../.env.local" | cut -d= -f2- | tr -d '"' | tr -d "'")
fi
[ -z "$KEY" ] && echo "WARN: GOOGLE_API_KEY not found — /api/chat will be disabled on this revision."

BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT
cp -r "$ENGINE/server" "$ENGINE/r" "$ENGINE/web" "$ENGINE/py" "$ENGINE/neuricx" "$BUILD/"
cp "$HERE/Dockerfile" "$BUILD/Dockerfile"
cp "$SOCHPKG" "$BUILD/sochcontagion_0.1.0.tar.gz"
cp "$CCPKG" "$BUILD/contagionchannels_0.1.3.tar.gz"
cp "$NAMHPKG" "$BUILD/namh_0.1.0.tar.gz"
mkdir -p "$BUILD/data-root/papers/contagion-channels/data"
cp "$DATA" "$BUILD/data-root/papers/contagion-channels/data/G20.xlsx"
mkdir -p "$BUILD/data-root/papers/news-networks/data"
cp "$NEWS" "$BUILD/data-root/papers/news-networks/data/news_attention_logchange.csv"

echo "Build context: $BUILD"
gcloud run deploy "$SERVICE" \
  --source "$BUILD" \
  --project "$PROJECT" \
  --region "$REGION" \
  --account "$ACCOUNT" \
  --allow-unauthenticated \
  --memory 2Gi --cpu 2 --timeout 300 \
  --min-instances 0 --max-instances 2 --concurrency 16 \
  --set-env-vars "HOST=0.0.0.0,COMPUTE_TIMEOUT_S=90,MAX_CONCURRENT=8,MAX_LLM_PER_DAY=400${KEY:+,GOOGLE_API_KEY=$KEY}" \
  --quiet

echo "URL:"
gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --account "$ACCOUNT" --format='value(status.url)'
