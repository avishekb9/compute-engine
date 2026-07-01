# COST_MODEL.md — spend bounds vs credit envelope (Prompt 6, Step B)

> Governed by `UPGRADE_INVARIANTS.md`, Invariant 11: every paid capability ships with a
> pre-registered ceiling that bounds worst-case spend independent of caller count, checked
> BEFORE the paid call. A capability whose worst-case daily spend is not bounded below the
> credit headroom is **NOT-LAUNCHABLE** until bounded. Unit prices are list prices as of the
> assistant's knowledge cutoff (Jan 2026) and are **documented, not re-quoted live this
> session** (Invariant 7); the ceilings below are deliberately conservative and the gate
> (Check U2) re-reconciles before any flag flips ON.

## Credit envelope (standing facts, from the project record)
| Pool | Approx. remaining | Expiry |
|---|---|---|
| EDU / Google Cloud research credits | ~Rs. 4.27 lakh | 2027-02-24 |
| GenAI App Builder (Vertex AI Search) | ~Rs. 94.8k | 2027-04-19 |
| Dialogflow CX trial | ~Rs. 56.7k | (trial) |
| **Total headroom** | **~Rs. 5.78 lakh** | earliest hard expiry 2027-02-24 |

Daily budget discipline: the engine already enforces a **global 400 paid LLM turns/day**
(x max-instances 2 => <=800/day fleet). The upgrade ceilings below sit INSIDE that, not
beside it: the existing global LLM budget is the outer bound; each new paid surface adds an
inner per-surface ceiling that trips first.

## Per-capability ceilings and worst-case daily spend

Conversion used for reconciliation: USD 1 ~= Rs. 84 (documented approximation).

| Capability | Unit cost (list, documented) | Pre-registered ceiling | Worst-case daily spend (saturated) | Launchable? |
|---|---|---|---|---|
| **Gemini 2.5 Flash** (chat) | ~$0.15 / 1M in, ~$0.60 / 1M out | already-governed: shares the 400-turn/day global budget; per-call cap 8k out tokens; **add inner cap 300 Flash calls/day** | 300 calls x ~12k tok x ~$0.0004/1k ~= **$1.4/day (~Rs. 120/day)** | **YES** — far below headroom |
| **Gemini 2.5 Pro** (research synthesis) | ~$1.25 / 1M in (<200k), ~$10 / 1M out | inner cap **100 Pro calls/day**, per-call <=8k out | 100 x ~(60k in + 8k out) ~= 100 x ~$0.16 ~= **$16/day (~Rs. 1.3k/day)** | **YES** — ~Rs. 40k/mo worst case, inside EDU pool |
| **Vertex AI Search / grounding** (`discoveryengine`) | ~$2–4 / 1k queries (grounding ~$2.5 / 1k) | inner cap **200 grounded queries/day**; datastore must exist first | 200 x ~$0.0035 ~= **$0.7/day (~Rs. 60/day)**, billed to the GenAI pool | **YES (when datastore built)** — else NOT-LAUNCHABLE (no datastore = hole) |
| **Text embeddings** (`text-embedding-004` class) | ~$0.025 / 1M tokens | inner cap **2M embedded tokens/day**, batch size <=1k docs | 2M x $0.025/1M ~= **$0.05/day (~Rs. 4/day)** | **YES** — negligible |
| **Batch prediction** | per-token, async, ~Flash rate | inner cap **1 batch/day, <=50k items, <=$5 worst case** | **<=$5/day (~Rs. 420/day)** | **YES** — bounded by batch-size cap |
| **Claude on Vertex** (`multimodel`, second-opinion review; default `claude-opus-4-8`) | ~$15 / 1M in, ~$75 / 1M out (Opus-class, list) | inner cap **50 calls/day**, contents <=100k chars (~25k tok), out <=1024 tok | 50 x (~25k in + 1k out) ~= 50 x ~$0.45 ~= **$22.5/day (~Rs. 2150/day)** | **ENABLED, but quota=0** — NOT-LAUNCHABLE until an online-prediction quota-increase is granted |
| **Claude-in-Chrome verify** | $0 GCP (Anthropic-side, observe-only) | n/a (no GCP spend); rate-bound by in-session tool use | **$0 GCP** | **YES** — no GCP cost |
| **Meta / Instagram APIs** | $0 (Graph API free tier) | DEFAULT-OFF (Invariant 16); no engine wiring | **$0** (not wired) | **N/A — not wired** |

## Reconciliation (Invariant 11 — total worst-case must sit below headroom)
Worst-case daily spend if EVERY paid upgrade surface saturates simultaneously:

```
Gemini Flash   ~Rs.  120
Gemini Pro     ~Rs. 1300
Vertex Search  ~Rs.   60   (GenAI pool)
Embeddings     ~Rs.    4
Batch          ~Rs.  420
Claude/Vertex  ~Rs. 2150   (Opus-class default claude-opus-4-8)
------------------------------
TOTAL          ~Rs. 4054 / day  worst-case, all surfaces saturated
```
Monthly worst case ~Rs. 122k. Against ~Rs. 5.78 lakh headroom that is **~4.7 months of
continuous worst-case saturation** before exhaustion, and the earliest credit expiry
(2027-02-24) arrives first — i.e. the credits expire before saturated spend could exhaust
them. **Every paid surface is individually bounded below headroom and the total is bounded.**

## Governor design (wired BEFORE reachable, Invariant 15)
- Each paid surface reads its ceiling from config (`CE_<CAP>_DAILY_MAX`), increments a
  per-UTC-day counter in the warehouse BEFORE the paid call, and returns a **coded 503
  capacity error (never a fabricated answer)** when the counter would exceed the cap.
- The ceiling check is itself a **failable eval** (Prompt 7): an over-cap call must return
  the coded error, spend nothing, and log without the secret.
- The outer global 400-turn/day budget remains the backstop; the inner caps trip first.

## NOT-LAUNCHABLE today (marked holes, Invariant 3)
- **Vertex AI Search grounding** is launchable on cost but currently has **no datastore**
  (inventory 503) — NOT-LAUNCHABLE until a `literature` datastore is built and its eval is
  green. Recorded as a hole, not assumed.
  - **UPDATE 2026-06-15 (hole filled):** datastore `econstellar-literature` + engine
    `econstellar-literature-search` built (63 docs from `literature.papers`);
    grounded_search is now **LIVE** with a 200 q/day ceiling. No longer a hole.
- **Claude on Vertex (`multimodel`)** is ENABLED (PI Marketplace-purchased Opus 4.8, 2026-06-16)
  and bounded on cost (worst-case ~$22.5/day at the Opus-class default `claude-opus-4-8`; the
  `global` endpoint carries no regional premium) — but the **online-prediction quota is 0** for
  `anthropic-claude-opus` across global and all regional endpoints (live 429). NOT-LAUNCHABLE
  until a **quota-increase request** is granted + a live smoke returns `code:OK`. Recorded as a
  hole (2026-06-16), not assumed. Code-complete and flag-OFF; activation is PI-gated.
- Nothing else is cost-blocked; all are flag-OFF pending Prompt 7 evals.

## UPDATE 2026-06-15 — capabilities activated (PI-authorised)
All four flags flipped ON in production and **all four are live-verified end-to-end and
spend-bounded**. batch_predict's first job had failed pending a one-time
`roles/aiplatform.user` grant to the BigQuery embedding-delegation SA; that grant was made
(PI-requested) and execution re-verified `JOB_STATE_SUCCEEDED` two ways (direct + engine
route, real embeddings in GCS). Test spend was sub-rupee. The ceilings here are now the
live enforced caps (the flash cap was confirmed to trip in production). See
`UPGRADE_LEDGER.md` §"Live activation".
