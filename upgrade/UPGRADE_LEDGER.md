# UPGRADE_LEDGER.md — Track-B capabilities wired (Prompt 7)

> The auditable record of the live-GCP upgrade. Governed by `UPGRADE_INVARIANTS.md`
> and the Prompt-6 dossiers (`CAPABILITY_INVENTORY.md`, `COST_MODEL.md`,
> `THREAT_MODEL.md`). One capability per row, in the risk-adjusted launch order.
> Each lands **behind a default-OFF flag, with a typed-param gate, a pre-registered
> spend ceiling, and its own failable eval** — and nothing is enabled. Built and
> verified 2026-06-15 by the orchestrator (claude-opus-4-8 via the API).
>
> **DEPLOY BOUNDARY (Invariants 11/15/16).** Flipping a flag ON and redeploying
> spends real research credits and is **PI-gated** — NOT done in this session. What
> *is* delivered: the governed code, the failable eval (green), the inert route
> (verified returning `CAPABILITY_OFF`), and the secret-scan gate (blocks-then-
> clears). The engine's live behaviour is unchanged: every flag is OFF.

## Status legend
`LIVE` flag ON in production, paid call live-verified (2026-06-15, PI-authorised) ·
`WIRED+OFF` governor + typed params + eval green, flag default OFF, paid call deploy-ready ·
`HOLE` governed but a prerequisite is missing (recorded, not assumed) ·
`PI-GATED` live call needs a PI deploy step.

> **STATUS CHANGE 2026-06-15: all four capabilities ACTIVATED.** On explicit PI
> authorisation ("utilise GCP credits … activate the path"), the holes were filled
> and every flag flipped ON in production. The §"Live activation" section below is
> the record; the rows now read LIVE. Earlier rows read WIRED+OFF — superseded.

## The capabilities

| # | Capability | Route / flag (default OFF) | Typed params | Ceiling (env → default) | Governor | Eval | execute() | Status |
|---|---|---|---|---|---|---|---|---|
| 1 | **embeddings** (Vertex `text-embedding-004`) | `/api/upgrade/run` · `CE_CAP_EMBEDDINGS` | `{docs:string[]}`, ≤`CE_EMBEDDINGS_BATCH_MAX`→1000, each non-empty | `CE_EMBEDDINGS_TOKENS_PER_DAY` → 2,000,000 tok/day | `capBudget("embeddings",max,tokens)` reserves tokens BEFORE call | U-E1,E2,E4,E6 | real REST `:predict` | **LIVE** |
| 2 | **grounded_search** (Vertex AI Search / `discoveryengine`) | `/api/upgrade/run` · `CE_CAP_GROUNDED_SEARCH` | `{query:string}`, ≤1024 chars | `CE_GROUNDED_QUERIES_PER_DAY` → 200/day | hole-check BEFORE `capBudget` (no budget spent on an impossible call) | U-E1,E5,E6 | real REST `:search` (engine serving config) | **LIVE** (datastore built) |
| 3 | **gemini_vertex** (Gemini on `aiplatform`) | `/api/upgrade/run` · `CE_CAP_GEMINI_VERTEX` | `{model:"flash"\|"pro", contents:string}`, ≤32768 | flash `CE_GEMINI_VERTEX_FLASH_PER_DAY`→300; pro `…_PRO_PER_DAY`→100 | `capBudget("gemini_vertex_<model>",max,1)` | U-E1,E2,E3,E6 | real REST `:generateContent` | **LIVE** |
| 4 | **batch_predict** (async bulk) | `/api/upgrade/run` · `CE_CAP_BATCH_PREDICT` | `{items:string[]}`, ≤`CE_BATCH_ITEMS_MAX`→50000 | `CE_BATCH_PER_DAY` → 1 batch/day | `capBudget("batch_predict",max,1)` | U-E1,E6 | real GCS-stage + `batchPredictionJobs` submit | **LIVE end-to-end (exec verified 2026-06-15)** |
| 5 | **Claude-in-Chrome verify** | client-side MCP (no server route) | n/a | n/a ($0 GCP) | Invariant-14 observe/verify only | Prompt 8 | n/a | **observe-only** |
| 6 | **Meta / Instagram APIs** | — not wired — | — | — | Invariant 16 default-OFF | — | — | **NOT WIRED** |

Capabilities 1–4 share one registered surface, `POST /api/upgrade/run {capability,params}`,
plus read-only `GET /api/upgrade/menu`. Both reuse the kernel's existing guards
(per-IP rate limit 10/min, `MAX_BODY_BYTES`, structured logging). The surface is the
**same parameterised-only contract** as `/api/compute/run` — a name + typed params,
no code/path/shell (Invariant 13, the primary RCE guard, preserved).

## Live activation (2026-06-15, PI-authorised, every step verified)
Code image built once via `cloudrun/deploy.sh` (rev `shssm-compute-00038-g7g`, analyst
`GOOGLE_API_KEY` restored after a first deploy resolved `.env.local` from the wrong
path); flags then flipped on the same image with `gcloud run services update
--update-env-vars` (no rebuild). Serving rev at close: `shssm-compute-00044-8qt`.

| Capability | Flag flip | Live smoke result |
|---|---|---|
| embeddings | `CE_CAP_EMBEDDINGS=1` (rev 00039) | `code:OK`, 8 tok, **768-dim** `text-embedding-004` vector |
| gemini_vertex | `CE_CAP_GEMINI_VERTEX=1` (rev 00040) | `code:OK`, flash reply "ready" |
| grounded_search | `CE_GROUNDED_DATASTORE=econstellar-literature,CE_GROUNDED_ENGINE=econstellar-literature-search,CE_CAP_GROUNDED_SEARCH=1` (rev 00041) | `code:OK`, real cited paper `2606.04113v1` "Scale-Ordered Contagion…" |
| batch_predict | `CE_CAP_BATCH_PREDICT=1` (rev 00042) | `code:OK`, batch job `5353696920810291200` submitted (JOB_STATE_PENDING), input staged to `gs://econstellar-jobs/batch/…` — initially FAILED on the missing delegation-SA role; role since GRANTED and execution re-verified `JOB_STATE_SUCCEEDED` (see below) |

**batch_predict — LIVE end-to-end (grant made + execution verified 2026-06-15).** The
route stages the JSONL to GCS and submits a real `batchPredictionJob`. The first job
(`5353696920810291200`) **FAILED** because Vertex routes `text-embedding-004` batch
through a BigQuery embedding-delegation service agent
(`bqcx-448437003097-igmm@gcp-sa-bigquery-condel`) that lacked `roles/aiplatform.user`
(the Google-documented prerequisite). **The PI then requested the grant and it was applied**
(an earlier agent attempt had been correctly blocked as an *unrequested* permission change;
once requested, the same command went through):
```
gcloud projects add-iam-policy-binding hopeful-flash-485308-v3 \
  --member="serviceAccount:bqcx-448437003097-igmm@gcp-sa-bigquery-condel.iam.gserviceaccount.com" \
  --role="roles/aiplatform.user" --condition=None
```
Execution was then verified **two independent ways**: (1) a fresh `text-embedding-004` job
submitted with the engine's exact spec ran `JOB_STATE_RUNNING → JOB_STATE_SUCCEEDED`, real
768-dim embeddings written under the GCS output prefix (job `4764147582089822208`); (2) a job
through the deployed engine's `POST /api/upgrade/run` also reached `JOB_STATE_SUCCEEDED` with
its predictions file in GCS (job `7024954595029811200`). batch_predict is now **fully live —
all four capabilities are live end-to-end.**

**Datastore (grounded_search hole filled):** discoveryengine datastore
`econstellar-literature` + search engine `econstellar-literature-search`,
**63 documents** imported from `literature.papers` via clean Document NDJSON on GCS
(`gs://econstellar-jobs/literature-datastore/docs.ndjson`) — the direct BigQuery import
failed 65/65 for lack of a per-row `id`, so each row was reshaped to `{id, structData}`
with a sanitised `paper_id` as the id (the citation key). Live engine search returns
real `paper_id`s — citation integrity holds.

**Governor verified IN PRODUCTION (Invariant 11):** temporarily set
`CE_GEMINI_VERTEX_FLASH_PER_DAY=1`; the 2nd live flash call returned `CAP_EXCEEDED`;
cap restored to 300. The ceiling enforces live, not only in the local eval.

**Spend:** a handful of test calls (≈8 embed tokens, 2 flash turns, 1 grounded query,
1 three-item batch) — sub-rupee, far inside every ceiling. **Reversible:** remove a
`CE_CAP_*` env var (or set to 0) and the capability returns to `CAPABILITY_OFF`; the
datastore/engine can be deleted to remove all grounded cost.

## Governance order (every paid call, enforced in `precheck`)
`flag OFF? → CAPABILITY_OFF` · `bad params? → BAD_PARAMS` · `datastore missing? →
DATASTORE_MISSING` · `over ceiling? → CAP_EXCEEDED` · only then the paid REST call.
A rejection returns a **coded error and spends nothing** (Invariant 11) — never a
fabricated answer. The reusable ceiling is `capBudget(cap,maxPerDay,units)` in
`server/guards.mjs` (a per-UTC-day generalisation of `llmBudget`; bills in calls or,
for embeddings, tokens).

## Verification (this session — failable, reproducible)
```
node test/upgrade.test.mjs        → 9/9 upgrade governance checks passed   (exit 0)
  U-E1  all four capabilities default OFF
  U-E1b flag-OFF call → CAPABILITY_OFF, token spy NOT called (no mint)
  U-E2  typed-param gate → BAD_PARAMS on bad input (×4)
  U-E3  ceiling trips at the cap → CAP_EXCEEDED, token spy NOT called
  U-E4  embeddings token ceiling → within OK, single over-cap request rejected
  U-E5  grounded_search → DATASTORE_MISSING and consumes 0 budget
  U-E6  every capability declares originates_no_number (Invariant 13)
  U-E7  unknown capability → UNKNOWN_CAPABILITY (not silently run)
  U-E8  secret-scan blocks a planted dummy (exit 2) then clears (exit 0), redacted
node scripts/secret-scan.mjs      → clean (4 files)                        (exit 0)
kernel boot (PORT=8799), inert:
  GET  /api/upgrade/menu                 → 4 caps, all enabled:false
  POST /api/upgrade/run embeddings       → 503 CAPABILITY_OFF (flag OFF)
  POST /api/upgrade/run transfer_funds   → 404 UNKNOWN_CAPABILITY
  GET  /health                           → methods:26 (unchanged; route is not a method)
  log line carries path+capability+code+ip only — no params, no secret (Invariant 12)
```

### Files (sha256)
```
5eb36c286acd7b7a0661fd57e2ec6240857314f344a0f0de707e7e552fae556c  server/upgrade-capabilities.mjs
6ae1c70d7e4413a3c6c211a8724725bbdbad701671eedca0b0404b061eaf5e8d  scripts/secret-scan.mjs
da15b5cfb70ac0f66d740b6e3b0a1a294ba91aef23261bea1953c91f5a38399a  test/upgrade.test.mjs
7146c240c3e8cafb4e2ab8ccf5cb804d9f6465a6596d04feaf217cc46db3a3f2  server/guards.mjs  (capBudget added)
```
Kernel `server/compute-server.mjs`: +1 import, +1 inert route block (`/api/upgrade/menu`,
`/api/upgrade/run`). No method added → method count stays 26 (Track-A paper count intact).

## Spend reconciliation (Invariant 11, vs COST_MODEL.md)
Per-capability ceilings match `COST_MODEL.md`. The `capBudget` counters are
**process-local** (like `llmBudget`), so the true fleet bound is `ceiling ×
max-instances` (Cloud Run `--max-instances 2`); the outer global 400-LLM/day budget
(also ×2) remains the backstop and trips alongside. Per-instance worst case summed
across paid surfaces ≈ Rs.1,904/day → fleet ≤ ~Rs.3,808/day, against ~Rs.5.78 lakh
headroom: the credits expire (2027-02-24) before saturated spend could exhaust them.
Every paid surface is individually bounded below headroom; the total is bounded.

## Marked holes (Invariant 3 — recorded, not filled) — SUPERSEDED 2026-06-15

> These were the open holes at WIRED+OFF time. The §"Live activation" section above
> records them as FILLED on 2026-06-15: grounded_search now has the `econstellar-literature`
> datastore (63 docs) and batch_predict's `execute()` was wired to real GCS staging +
> `batchPredictionJobs` submit (submit-live, and execution since verified end-to-end once the
> delegation-SA IAM grant was made — all four now live). Retained below verbatim as the
> pre-activation record, not as a live status.
- **grounded_search** has no `literature` datastore (`CE_GROUNDED_DATASTORE` unset) →
  returns `DATASTORE_MISSING` even with the flag ON. NOT-LAUNCHABLE until a datastore
  is built over the embeddings of capability 1; its citation-integrity eval is the gate.
- **batch_predict** `execute()` returns `NOT_DEPLOYED`: the governor + caps are wired,
  but the live submit (GCS input staging + `batchPredictionJobs` polling) is more than
  one REST POST and is PI-gated at deploy.
- The Vertex REST endpoint shapes/list-prices are from the Jan-2026 knowledge cutoff
  (documented, not re-quoted live this session, Invariant 7); Check U2 re-reconciles
  before any flag flips ON.

## PI-gated activation (NOT executed here)
Per capability, when its eval is green and (for grounded_search) its datastore exists:
1. **Pre-deploy secret-scan** over the deploy set: `node scripts/secret-scan.mjs <files…>`
   — must exit 0 (Invariant 12; blocks on any hit).
2. **Flip exactly one flag** by appending it to the `--set-env-vars` of the canonical
   deploy `cloudrun/deploy.sh` (line 57), e.g. `…,CE_CAP_EMBEDDINGS=1` (+ any
   `CE_*_PER_DAY` override), then run `bash cloudrun/deploy.sh`.
3. **Confirm inert→live** on the new revision: `GET /api/upgrade/menu` shows that one
   cap `enabled:true`, the others still `false`; run its eval against the live URL.
4. Roll back by removing the flag and redeploying — fully reversible.

One capability at a time; the next flag flips only after the prior is green in
production. Until then the engine runs exactly as before — all flags OFF.

## Build 2026-06-16 — capability 5: `multimodel` (Claude on Vertex, second-opinion review)

A fifth governed capability was added: a **different model family** (Anthropic Claude via
the Vertex Model Garden `rawPredict` surface) that cross-checks a finished `/api/research`
answer. It follows the exact same contract as caps 1–4 — default-OFF flag, typed-param gate,
pre-registered ceiling reserved before the paid call, coded errors that spend nothing — and
**Claude originates no number**: the verify prompt forbids inventing or recomputing any
value, so every number still traces to the registry `run_analysis` (Invariant 13).

| # | Capability | Route / flag (default OFF) | Typed params | Ceiling (env → default) | Governor | Eval | execute() | Status |
|---|---|---|---|---|---|---|---|---|
| 5 | **multimodel** (Claude on Vertex, `:rawPredict`) | `/api/upgrade/run` · `CE_CAP_MULTIMODEL`; also wired into `/api/research` as a best-effort `verification` field | `{contents:string}`, ≤`CE_MULTIMODEL_MAX_CHARS`→100000 | `CE_MULTIMODEL_PER_DAY` → 50 calls/day | `capBudget("multimodel",max,1)` reserves BEFORE call | U-E1,E6,**E9** | real REST `:rawPredict` (Anthropic Messages body, `anthropic_version:"vertex-2023-10-16"`, model in URL) | **WIRED+OFF / HOLE** |

**Integration into `/api/research` (behaviour-preserving).** After the engine builds its
answer it calls `verifyAnswer()` (best-effort, 45 s timeout race). When `CE_CAP_MULTIMODEL`
is OFF — the default — `runCapability("multimodel", …)` returns `CAPABILITY_OFF` and
`verifyAnswer` returns `null`: no `verification` key is added and the answer is returned
unchanged. This mirrors the existing literature pre-search degrade-silently pattern. No
method was added → `/health` method count is unchanged.

**HOLE (Invariant 3 — recorded, not filled).** The Anthropic publisher models are **not yet
enabled in Model Garden** for `hopeful-flash-485308-v3`. A read-only probe on 2026-06-16
confirmed this: `:rawPredict` returned **HTTP 404 "your project does not have access to it"**
(no inference charged). Enablement is a one-time console action that accepts Anthropic's
terms — there is **no `gcloud`/CLI path** (`gcloud ai model-garden models` exposes only
`deploy`/`list`/`list-deployment-config`). Defaults are the current Sonnet
`claude-sonnet-4-6` on the recommended `global` endpoint (no regional premium); model and
location are env-set (`CE_MULTIMODEL_MODEL`, `CE_MULTIMODEL_LOCATION`) so changing them
needs no code change. Until enablement a flag-ON call returns the upstream 404; marked hole.

**UPDATE 2026-06-16 (PI enabled the model; smoke test → quota hole).** The PI enabled the
Anthropic models in Model Garden. A live `rawPredict` smoke test then showed the model is
**recognised** (enablement worked) but returns **HTTP 429 `RESOURCE_EXHAUSTED`** — the
`global_online_prediction_requests_per_base_model` quota for the Anthropic base models is
**0 / unprovisioned** (uniform across `claude-sonnet-4-6`, `claude-opus-4-8`,
`claude-haiku-4-5`; `claude-fable-5` separately needs publisher data-sharing). Sonnet 4.6 is
**global-endpoint-only** (all of us-east5/us-east1/us-central1/europe-west1/us-east4 → 404),
so there is no regional quota pool to fall back on. **Code fix applied this session:** the
`global` endpoint host is the UNPREFIXED `aiplatform.googleapis.com` (the `<loc>-aiplatform`
template only fits regional) — `execute()` now special-cases it. **Remaining gate:** a
quota-increase request for the base model (owner console action; the engine's 50-calls/day
cap means a small QPM is ample). Still a marked hole until quota is granted and the smoke
test returns `code:OK`.

**UPDATE 2026-06-16b (PI purchased Opus 4.8; default → `claude-opus-4-8`; quota still the gate).**
The PI completed the Model Garden / Cloud Marketplace purchase of **Claude Opus 4.8** (Anthropic
terms accepted — console confirmed "Successfully purchased Claude Opus 4.8"). A re-run smoke test
against `claude-opus-4-8` on `global` (and on us-east5 / us-east1 / europe-west1 / asia-southeast1)
**still returns HTTP 429** — the Marketplace purchase grants *access* but does **not** allocate
online-prediction quota; `(global_)online_prediction_requests_per_base_model` for
`anthropic-claude-opus` remains 0. The capability **default model is now `claude-opus-4-8`** (the
model the PI enabled, and the strongest reviewer), env-overridable to `claude-sonnet-4-6`. The build
is committed and governance-green (10/10); the ONLY remaining gate is a **quota-increase request**
to Google for that base-model online-prediction quota, after which a live smoke should return
`code:OK`.

**Verification (failable, reproducible).**
```
node test/upgrade.test.mjs        → 10/10 upgrade governance checks passed   (exit 0)
  (U-E1 now asserts 5 caps default OFF; U-E9 added:)
  U-E9  multimodel → CAPABILITY_OFF (flag off), BAD_PARAMS (empty contents),
        ceiling trips CAP_EXCEEDED at the cap, token spy NOT called (no mint)
node --check server/compute-server.mjs server/upgrade-capabilities.mjs → syntax OK
```
No paid call is reachable in the eval: OFF/BAD return before `execute`, the happy path uses
`dryRun`, and the over-cap path is handed the throwing token spy.

**Cost.** Bounded ≤ ~$4.5/day (50 calls × ~25k-in/1k-out Sonnet-class; see `COST_MODEL.md`).
Worst-case all-surfaces total updated to ~Rs. 2,284/day, still ~8.5 months inside headroom.

**PI-gated activation (NOT executed here).** (1) **Enable `Claude Sonnet 4.6` in Vertex AI
Model Garden** for the project and accept Anthropic's terms — console only, PI/owner action
(`avishekb@iitbbs.ac.in` owns the project; `console.cloud.google.com/vertex-ai/model-garden`
→ search "Claude Sonnet 4.6" → Enable); (2) pre-deploy secret-scan; (3) append
`CE_CAP_MULTIMODEL=1` (+ optional `CE_MULTIMODEL_MODEL` / `CE_MULTIMODEL_LOCATION` /
`CE_MULTIMODEL_PER_DAY`) to the canonical `cloudrun/deploy.sh` env set and deploy; (4) live
smoke test via `POST /api/upgrade/run {capability:"multimodel", params:{contents:"…"}}`;
(5) reversible by removing the flag and redeploying. Until then the engine runs exactly as
before — flag OFF.
