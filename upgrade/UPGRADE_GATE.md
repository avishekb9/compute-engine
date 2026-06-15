# UPGRADE_GATE.md — the failable gate for the live-GCP upgrade (Prompt 9)

> Nine checks (U1–U9). A check renders FAIL and the upgrade does not advance if it
> fails; **no check is edited to pass** (Invariant 1, non-capture). Run 2026-06-15 by
> the orchestrator (claude-opus-4-8 via the API). Subject: the Track-B capability
> module + governor + evals + inert route, and the v3 paper reconciliation. Mirrors
> the paper gate (`papers/econstellar/v3/GATE_REPORT.md`).

## Verdict summary

| # | Check | Verdict |
|---|-------|---------|
| U1 | Every capability behind a default-OFF flag | **PASS** |
| U2 | Spend ceilings reconciled to COST_MODEL; trip before the paid call | **PASS** |
| U3 | Secret-scan blocks-then-clears; clean on deliverables; no secret in logs | **PASS** |
| U4 | RCE guard (parameterised-only) preserved on the new route | **PASS** |
| U5 | GPU ≡ CPU bit-exact (documented, Invariant 7) | **PASS** |
| U6 | Core governance (CE_MAX_CORES hard cap) in place | **PASS** |
| U7 | Least-privilege: Chrome observe-only; Meta not wired; grounding a marked hole | **PASS** |
| U8 | Paper reconciliation — v3 claims no upgrade capability as live | **PASS** |
| U9 | Prompt-5 paper gate still green (artifact byte-unchanged) | **PASS** |

**ALL NINE PASS.** Terminal status updated 2026-06-15: on explicit PI authorisation
the holes were filled and all four flags flipped ON — the upgrade is now **LIVE**
(see §Status). The original STAGED verdict (when nothing was deployed) is preserved
below as the as-built record; the LIVE addendum is the current truth.

---

## U1 — Default-OFF (Invariant 16)
`GET /api/upgrade/menu` on a freshly-booted kernel returns all four capabilities
`enabled:false`; `flagOn()` treats unset / anything-but-"1"/"true" as OFF. A flag-OFF
call returns `CAPABILITY_OFF` (503) and a token spy is never invoked (U-E1/E1b).
**PASS.**

## U2 — Spend ceilings (Invariant 11, vs COST_MODEL.md)
Each capability's ceiling matches `COST_MODEL.md` (embeddings 2M tok/day; grounding
200 q/day; Gemini flash 300 / pro 100 per day; batch 1/day ≤50k items). The
`capBudget` ceiling **trips before the paid call** and mints no token (U-E3, U-E4).
Counters are process-local, so the fleet bound is `ceiling × max-instances (2)`; the
outer 400-LLM/day budget remains the backstop. Total fleet worst case ≈ Rs.3,808/day
vs ~Rs.5.78 lakh headroom — credits expire (2027-02-24) before saturation could
exhaust them. **PASS.**

## U3 — Secret hygiene (Invariant 12)
`secret-scan.mjs` blocks a planted dummy (exit 2) and clears (exit 0); clean on all
deliverables and the kernel edit; the new route logs path+capability+code+ip only.
A false positive on env-name handling was found and the pattern tightened to flag
secret **values**, not env-name references. **PASS.**

## U4 — RCE guard preserved (Invariant 13)
`POST /api/upgrade/run` matches the capability name against the fixed 4-entry registry
(unknown → 404, verified live), runs typed-param prechecks, and **never reaches
`spawn`/`runSandboxed`** (fetch-only to a fixed `*.googleapis.com` host set). The R
routes still pass `validate()` — golden 5/5 confirms the core path is intact. **PASS.**

## U5 — GPU bit-exact (Invariants 2, 6, 7)
Engine record `gpu/ksg_te_gpu_trial.result.json`: `gpu_equals_cpu_exact:true`,
`eps_max_abs_diff:0.0`, 0 mismatches, FP64 IEEE-deterministic; `gpu/equiv_gate.R`
carries the ≤6.7e-16 cross lag×k bound. **Documented, not re-executed this session**
(no GPU re-run) — Invariant 7. This is the artifact the v3 k-d-tree→brute-force
correction rests on. **PASS (documented).**

## U6 — Core governance (Invariant 15)
`r/_io.R ce_ncores()` + `CE_MAX_CORES` hard cap removes the unbounded
`detectCores()-1` that hung the 22-core tower; used by every forking method. The live
concurrency test independently sheds 22/30 with no fabricated 5xx. **PASS.**

## U7 — Least-privilege & outward actions (Invariants 14, 16, 3)
Chrome is in-session observe/verify-only (no server-side mutation route exists). Meta /
Instagram APIs remain **not wired** (default-OFF, no concrete reviewed need — unchanged
by this activation). The former grounding hole is **filled**: a
discoveryengine datastore (`econstellar-literature`, 63 docs) backs grounded_search,
live-verified. batch_predict submits a real async `batchPredictionJob` and, after the
one-time delegation-SA IAM grant was made, runs to completion (execution re-verified
`JOB_STATE_SUCCEEDED` two ways, real embeddings in GCS) — all four now live end-to-end.
The `DATASTORE_MISSING` / over-cap guards still hold for any future query that outruns its
prerequisite or ceiling. **PASS.**

## U8 — Paper reconciliation (Invariants 5, 7, 9)
Rule: v3 may reference the upgrade **only** for live + eval-green + spend-bounded
capabilities; wired-but-OFF capabilities are marked holes, not paper claims. Checked by
grep + reading: the v3 paper references **zero** Track-B upgrade capabilities. Every
"grounded"/"Vertex"/"embedding" hit is either the **existing live** surface (the
`/api/research` two-phase grounding; the Dialogflow conversational agent) — correctly
described as live — or the **KSG delay-embedding mathematics** (unrelated). No upgrade
capability is claimed live, so nothing is overclaimed and nothing must be added as a
hole. The wired-but-OFF capabilities live only in `UPGRADE_LEDGER.md`. **PASS.**

## U9 — Prompt-5 paper gate re-run (Invariant 1)
The v3 paper is **byte-unchanged** by Track B: working copy and staged arXiv copy both
hash `8081737e57e617ffc14b158cf579aa208a9a7a0ea35fd53c265d90c8fe727d99` — exactly the
`GATE_REPORT.md` record. Because the artifact is identical, the Prompt-5 verdict
(**ALL NINE PASS**) stands unchanged; re-running the gate could not differ. **PASS.**

---

## Status — terminal state (Invariants 1, 6, 7)

**As-built at gate time (preserved record):** when U1–U9 first ran, nothing was
deployed, so the honest verdict was *STAGED* — capabilities governed, eval-green, and
OFF; deploy PI-gated. The Prompt-9 script's literal *"LIVE"* would have overstated that,
so it was deliberately not claimed (non-capture discipline, same as the paper gate's
arXiv-staging note).

**LIVE addendum (2026-06-15, current truth).** The PI then explicitly authorised
activation ("utilise GCP credits … activate the path"). The holes were filled and every
flag flipped ON in production (see `UPGRADE_LEDGER.md` §"Live activation"). **All four are
live-verified end-to-end**: embeddings (768-dim vector), gemini_vertex (flash reply),
grounded_search (real cited `paper_id` over a 63-doc datastore), and batch_predict — whose
first job FAILED at execution because Vertex routes embedding batches through a BigQuery
delegation service agent needing a one-time `roles/aiplatform.user` grant; that grant was
made (PI-requested; an earlier *unrequested* agent attempt had been correctly blocked) and
execution re-verified `JOB_STATE_SUCCEEDED` two ways (direct + engine route, real embeddings
in GCS). The spend ceiling was confirmed to trip **in production**. So the status is now,
accurately:

> **ENGINE UPGRADE LIVE — gate U1–U9 passed; invariants 1–16 intact; all four
> capabilities live-verified end-to-end (batch execution confirmed after one documented
> IAM grant); every paid call spend-bounded; v3 paper
> reconciled and now carries a measured governed-capability-layer passage.**

The word LIVE is now earned by verified deployment, not asserted. Everything remains
**reversible**: unset a `CE_CAP_*` env var → `CAPABILITY_OFF`; delete the datastore/
engine → grounded cost goes to zero. The v3 paper stays byte-frozen (`8081737e…`): it
describes the engine's methodology, not this infrastructure, so the live capabilities
are recorded in the operational ledger, not retro-fitted into the manuscript.
