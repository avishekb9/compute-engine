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

# ---- provenance + pre-promotion gates (Tier-0 hardening) ----
# Refuse to ship source that is not in git (that is how the live engine became
# unreproducible). Stamp the git SHA into the image via BUILD_SHA so /health
# reports exactly which commit is serving.
GIT_SHA="$(git -C "$ENGINE" rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [ -n "$(git -C "$ENGINE" status --porcelain 2>/dev/null)" ]; then
  if [ "${ALLOW_DIRTY:-0}" = "1" ]; then
    GIT_SHA="${GIT_SHA}-dirty"; echo "WARN: deploying a DIRTY working tree as $GIT_SHA (ALLOW_DIRTY=1)."
  else
    echo "ERROR: working tree is dirty; the deployed source would not be reproducible from git."
    echo "       Commit or stash first, or re-run with ALLOW_DIRTY=1 to override."
    git -C "$ENGINE" status --short
    exit 1
  fi
fi

# Pre-promotion eval gate: the fast unit tests must pass before we ship.
if [ "${SKIP_TESTS:-0}" = "1" ]; then
  echo "WARN: SKIP_TESTS=1 - skipping the pre-promotion test gate."
else
  echo "Pre-promotion tests ..."
  if node --test "$ENGINE"/test/upgrade.test.mjs "$ENGINE"/test/gate-enforcement.test.mjs \
        "$ENGINE"/test/knowledge-bank.test.mjs "$ENGINE"/test/skill-registry-coherence.test.mjs \
        "$ENGINE"/test/v5-control.test.mjs >/dev/null 2>&1; then
    echo "  tests passed."
  else
    echo "ERROR: pre-promotion tests failed - aborting deploy (override with SKIP_TESTS=1 if you know why)."
    exit 1
  fi
fi

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
cp "$ENGINE/knowledge-bank.json" "$BUILD/knowledge-bank.json"   # read-only academic-games manifest (/api/knowledge)
cp "$SOCHPKG" "$BUILD/sochcontagion_0.1.0.tar.gz"
cp "$CCPKG" "$BUILD/contagionchannels_0.1.3.tar.gz"
cp "$NAMHPKG" "$BUILD/namh_0.1.0.tar.gz"
mkdir -p "$BUILD/data-root/papers/contagion-channels/data"
cp "$DATA" "$BUILD/data-root/papers/contagion-channels/data/G20.xlsx"
mkdir -p "$BUILD/data-root/papers/news-networks/data"
cp "$NEWS" "$BUILD/data-root/papers/news-networks/data/news_attention_logchange.csv"

echo "Build context: $BUILD"
# NOTE: --set-env-vars REPLACES the whole env on each deploy, so any capability
# flag not listed here is dropped. To keep flags across deploys, set CE_CAP_ENV,
# e.g. CE_CAP_ENV="CE_CAP_GROUNDED_SEARCH=1,CE_GROUNDED_DATASTORE=econstellar-literature"
# It defaults to empty, so the current all-off state is preserved unless you pin.
gcloud run deploy "$SERVICE" \
  --source "$BUILD" \
  --project "$PROJECT" \
  --region "$REGION" \
  --account "$ACCOUNT" \
  --allow-unauthenticated \
  --memory 2Gi --cpu 2 --timeout 300 \
  --min-instances 0 --max-instances 2 --concurrency 16 \
  --set-env-vars "HOST=0.0.0.0,COMPUTE_TIMEOUT_S=90,MAX_CONCURRENT=8,MAX_LLM_PER_DAY=400,BUILD_SHA=$GIT_SHA${KEY:+,GOOGLE_API_KEY=$KEY}${CE_CAP_ENV:+,$CE_CAP_ENV}" \
  --quiet

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT" --region "$REGION" --account "$ACCOUNT" --format='value(status.url)')"
echo "URL: $URL"

# ---- post-deploy verification (Tier-0 hardening) ----
# Surface the served build SHA, method count, revision, and each managed
# capability's on/off state, so an env-drop or a stale image is visible at once.
echo "Verifying deployment ..."
sleep 3
curl -fsS "$URL/health" 2>/dev/null | sed 's/^/  health: /' || echo "  health: UNREACHABLE"
curl -fsS "$URL/api/upgrade/menu" 2>/dev/null | sed 's/^/  upgrade-menu: /' || echo "  upgrade-menu: unavailable"
echo "  expected build=$GIT_SHA (compare with health.build; a mismatch means a stale image is serving)"
