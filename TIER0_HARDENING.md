# Tier 0 — Harden Before Exposing (compute engine)

**Branch:** `tier0-hardening` (off `cd69e76`, the live-deployment source) · **Date:** 2026-06-03
**Status:** local hardening DONE + load-verified · **NOT deployed / NOT pushed** (awaiting PI go-ahead)

Tier 0 gates the public launch: public traffic must not exhaust the GCP credit or
expose an abuse vector. All work below was implemented and tested against a **local**
instance (`:3200`/`:3201`); nothing was deployed.

---

## What was added

| Layer | Change | File | Deliverable |
|-------|--------|------|-------------|
| Global concurrency ceiling | `acquire/release`, `MAX_CONCURRENT=8`/instance; sheds with `503` | `guards.mjs` + server guard block | D0.2 |
| Per-IP daily quota (paid) | `dailyLimit`, chat 50/day · research 20/day (UTC) | `guards.mjs` + guard block | D0.6 |
| **Global per-instance daily LLM cap** | `llmBudget`, `MAX_LLM_PER_DAY=400`; the credit backstop | `guards.mjs` + chat/research gates | D0.5 |
| Request-body size cap | 64 KB, all 3 POST routes → `413` | server | D0.2 |
| Message/query length cap | 4000 chars, **before any Gemini call** → `413` | server | D0.7 |
| Stale-cache fallback | serve last-good (flagged) when a live run fails | `guards.mjs` + run handler | D0.8 |
| Slowloris guard | `requestTimeout=30s`, `headersTimeout=15s` | server | D0.2 |
| Honest sandbox label | fallback no longer falsely claims `net-isolated` | server | finding #1 |
| Deploy caps (prepared) | `--max-instances 2 --concurrency 16` + guard env vars | `cloudrun/deploy.sh` | D0.3 |

Existing (pre-Tier-0) and retained: per-IP/min limiter (run 20 / chat 10 / research 5),
5-min response cache, per-job `timeout 60s` on R, strict param validation, `/metrics`,
structured logs, CORS preflight.

---

## D0.1 / D0.2 — load-test evidence (local, zero Gemini cost)

`node test/loadtest.mjs` + `node test/concurrency.mjs` (chat tests use over-length
messages so they 413 *before* Gemini — no credit spent):

| Probe | Result | Verdict |
|-------|--------|---------|
| 60× run, one IP | `{200:20, 429:40}` | per-IP/min holds; clean 429s |
| 30× distinct cache-missing, unique IPs | `{200:8, 503:22}` | **global ceiling holds exactly at 8** |
| 15× chat over-length, one IP | `{413:10, 429:5}` | rate-limit + length cap; **0 Gemini** |
| body > 64 KB | `413 payload_too_large` | ✓ |
| `"DROP_TABLE; rm -rf /"` | `400 unknown method` | injection rejected |
| unknown series | `400` | ✓ |
| research over-length | `413` before Gemini | ✓ |
| LLM budget = 0 (gate test) | chat/research → `503 daily_capacity`, run → `200` | **paid calls blocked before Gemini; run unaffected** |
| metrics after | `errors_total: 0` across all bursts | **no 500s anywhere** |

---

## D0.5 — worst-case daily spend

The binding control is the **global per-instance daily LLM cap**:

```
fleet-wide paid "turns"/day  =  MAX_LLM_PER_DAY (400)  ×  max-instances (2)  =  800/day
```

A "turn" = one chat or research request that reaches the paid stage. Worst case is
all-research (Gemini 2.5 Pro, ~4 model calls + 1 grounded search per turn):

| Scenario | Paid model calls/day | Est. spend/day* |
|----------|----------------------|-----------------|
| 800 turns, all chat (Flash) | ~1,600 Flash | ~$6 |
| 800 turns, all research (Pro+search) | ~3,200 Pro + 800 grounding | **~$80** |

\*Pricing approximate; the **hard, verifiable bound is 800 paid turns/day** regardless of
attacker IP count. Against ~₹4.25L (~$5,100) EDU credit that is months of runway even
under continuous worst-case abuse — and real traffic is orders of magnitude lower.
**Without** this cap, 32 saturated concurrent slots could approach ~$2–3k/day (credit
drained in ~2 days). The cap is what makes the launch safe.

Tunable via env (`MAX_LLM_PER_DAY`, `MAX_CONCURRENT`, `--max-instances`).

---

## D0.4 — billing budget alert  →  BLOCKED-ON-PI

The available OAuth token is Vertex/aiplatform-scoped; `cloudbilling` returned
**403 PERMISSION_DENIED**, so the budget cannot be created programmatically. Exact
Console steps for the PI (Billing Account Administrator):

1. https://console.cloud.google.com/billing → select the billing account funding
   `hopeful-flash-485308-v3`.
2. **Budgets & alerts → Create budget**.
3. Scope: project `hopeful-flash-485308-v3` (or the EDU credit).
4. Amount: set to the EDU credit value (~₹4,25,117) or a monthly figure.
5. **Alert thresholds: 80% and 95%** (email to `avishekb@iitbbs.ac.in`).
6. *(optional, strongest)* add the Pub/Sub topic hook to auto-disable billing on
   breach — only if you want a hard stop rather than just alerts.

Until set, the **application-level caps above are the active backstop** — the credit is
protected; the billing alert is an additional financial tripwire.

---

## D0.8 — graceful degradation

- **Engine:** every endpoint returns coded JSON (`429/503/413/400`), never a raw stack
  trace (`errors_total: 0` under all bursts). Run failures fall back to last-good cache.
- **NEURICX:** live `/health` shows `disk_cache:true` and `/intel` serves cached data;
  the simulated-GDELT-429 fallback test lives in the **NEURICX repo** — flagged as a
  follow-up (separate codebase), not done here.

---

## D0.9 — adversarial verifier sign-off

Attacked and survived: per-IP burst (429), multi-IP concurrent fan-out (503 at 8),
oversized body (413), over-length LLM input (413 pre-Gemini), method injection (400),
LLM budget exhaustion (503 pre-Gemini). **No path produced a 500 or an uncoded error.**
1000-request equivalent could not exceed the concurrency ceiling or trigger a paid
Gemini call beyond the daily cap. **PASS**, with two documented caveats below.

---

## Caveats / needs PI go-ahead (outward-facing)

1. **Deploy** the hardened revision to Cloud Run (`bash cloudrun/deploy.sh`) — not done.
2. **Push** the branch + reconcile GitHub: the live engine is **3 commits ahead of
   `origin/main`** (the 6 methods + `/api/research` + vecm fix were never pushed). The
   repo is not reproducible from GitHub until these + Tier 0 are pushed.
3. **Billing budget** (D0.4) — BLOCKED-ON-PI, steps above.
4. **Cloud Run sandbox** is `timeout` mode, **not** gVisor or net-isolated (only the
   `bwrap` local path is). Primary RCE guard is the parameterised-only registry, which
   holds. Real network isolation on Cloud Run would need a deploy-time change.
