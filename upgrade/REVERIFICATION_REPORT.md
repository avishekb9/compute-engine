# REVERIFICATION_REPORT.md — full-suite + guarantee re-check (Prompt 8)

> After wiring the Track-B capabilities (Prompt 7), re-run the engine's verification
> surface and re-assert each safety guarantee with evidence. A guarantee that cannot
> be re-executed this session is marked **documented (Invariant 7)**, never claimed as
> re-verified. Run 2026-06-15 by the orchestrator (claude-opus-4-8 via the API),
> project `hopeful-flash-485308-v3`. No production change; the live engine is unchanged
> (all upgrade flags OFF).

## A. Suite run this session (failable, exit codes)

| Suite | Command | Result | Exit |
|---|---|---|---|
| Upgrade governance (new) | `node test/upgrade.test.mjs` | **9/9 passed** | 0 |
| Golden empirical regression | `node test/golden.test.mjs` | **5/5 passed** (real bwrap+R+G20) | 0 |
| Concurrency-shed (live kernel) | `BASE=…:8799 node test/concurrency.mjs` | **{200:8, 503:22}**, shed 22, 0 bad 5xx | 0 |
| Secret-scan | `node scripts/secret-scan.mjs` | clean (4 files) | 0 |

The golden suite exercised the **real sandboxed R path** (same code the HTTP route
uses): India ADF −49.18, UK ADF −52.64, GARCH persistence 0.991, wavelet D1 47.07%,
DFA Hurst 0.542 — all inside their verified bands. The upgrade did not perturb the
core engine.

## B. Guarantee re-checks

### B1 — RCE guard holds on every route, including the new one (Invariant 13)
The primary guard is the **parameterised-only registry**: a name + typed params,
no code/path/shell. Re-checked on the new surface: `POST /api/upgrade/run` matches
the capability name against the fixed 4-entry `CAPS` registry (unknown → 404
`UNKNOWN_CAPABILITY`, verified live), runs typed-param prechecks, and **never reaches
`spawn`/`runSandboxed`** (grep of the route body: 0 occurrences — it is fetch-only to
a fixed `*.googleapis.com` host set). The R compute routes still pass through
`validate()` unchanged (golden 5/5 confirms). **PASS.**

### B2 — Secrets never leave the boundary (Invariant 12)
`secret-scan.mjs` **blocks a planted dummy** (`AIza…`, exit 2) and **clears** when it
is an env-name reference (exit 0) — proven by U-E8 and by a direct probe. It is clean
on every deliverable (`server/upgrade-capabilities.mjs`, `server/guards.mjs`,
`scripts/secret-scan.mjs`, `test/upgrade.test.mjs`) and on the kernel edit. The new
route's log line carries **path+capability+code+ip only** (verified in the boot log) —
no params, no token. The OAuth bearer is minted at the metadata boundary and passed in
the `Authorization` header only; it is never interpolated into a logged string.
A false positive on env-name handling (`"GOOGLE_API_KEY=".length)`) was found and the
value pattern tightened to a real token alphabet, so the gate flags **values, not
env-name references**. **PASS.**

### B3 — GPU ≡ CPU bit-exact (Invariants 2, 6, 7)
Documented in the engine record `gpu/ksg_te_gpu_trial.result.json`:
`gpu_equals_cpu_exact: true`, `eps_max_abs_diff: 0.0`, mismatches `{n_z:0,n_xz:0,n_yz:0}`,
`precision: float64 (IEEE-deterministic)`, device RTX 3000 Ada (CC 8.9); the cross
lag{1,2}×k{4,5} gate `gpu/equiv_gate.R` carries the ≤6.7e-16 bound. This is the
**documented record, not re-executed this session** (no GPU re-run here) — Invariant 7.
The corrected k-d-tree→brute-force premise in the v3 paper rests on exactly this
artifact. **PASS (documented).**

### B4 — Core governance: the 22-core hang cannot recur (Invariant 15)
`r/_io.R:57 ce_ncores(p, reserve)` bases parallelism on `detectCores()-reserve`, lets
an explicit `n_cores` param override, and enforces the job-server's **`CE_MAX_CORES`
as a HARD cap** (`r/_io.R:63`). Used by every forking method (`sri_daily`,
`channel_attribution`, `channel_robustness`); `soch_robustness` self-bounds to
`min(…, detectCores()%/%4, 4)`. The unbounded `detectCores()-1` that hung the 22-core
tower is gone. Code-verified this session. **PASS.**

### B5 — Spend ceilings trip before the paid call (Invariant 11)
`test/upgrade.test.mjs` U-E3 (gemini_vertex flash cap=2 → 3rd call `CAP_EXCEEDED`, token
spy NOT called) and U-E4 (embeddings token cap=10 → 11-token request rejected) prove the
`capBudget` ceiling trips and **mints no token / makes no paid call** when over-cap.
The live concurrency test independently shows the saturation governor shedding 22/30
(`concurrency_shed_total:22`) with no fabricated 5xx. **PASS.**

### B6 — Claude-in-Chrome stays confined (Invariant 14)
No server-side authenticated-mutation route is wired (grep: the engine exposes no
post/send/login surface; the upgrade route is read/compute only). Chrome remains an
**in-session, observe/verify-only** tool: render a public Econstellar surface and
confirm it matches `evals.json`/the live API; any mutation-capable step halts for
explicit human confirmation. Used in that mode for the Prompt-9 public-page check.
**PASS (observe-only, documented).**

### B7 — Loop integrity (claims demote-never-delete; nightly loop)
`scripts/nightly-loop.sh` is built (refresh → re-eval → claims refresh → report). The
claims ledger is **demote-never-delete** (a falsified claim is demoted with provenance,
not removed). **Hole CLOSED 2026-06-15:** the loop is now installed in cron at
**07:10 UTC** daily (after the 06:00 SRI tick; `CRON_TZ=UTC` already set in the
crontab); verified it starts cleanly from `$HOME` (absolute-path `$0` resolves
`ENGINE_DIR`) and runs the eval suite (unit_root −49.18, dfa_hurst 0.542 pass). **PASS.**

## C. Net verdict
Every guarantee re-checked holds; one is **documented (Invariant 7)** rather than
re-executed (GPU bit-exact). The loop's cron install — previously an open hole — is now
closed (B7). The upgrade adds one governed, fetch-only surface and a reusable spend
governor; it **relaxes no existing guarantee** — the core engine still passes its
empirical regression (5/5) and its saturation guard still sheds load (22/30).

## D. Live activation re-check (2026-06-15, PI-authorised)
After the gate, the PI authorised activation. Post-activation re-checks:
- **Deploy regression:** new image rev `00038-g7g` → `/health` 26 methods (unchanged);
  SRI endpoints live (0.007105, USA→Japan 0.143816); `/api/research` analyst key
  restored (a first deploy lost it from a wrong `.env.local` path — caught and fixed).
- **All four capabilities live-verified end-to-end** (serving rev `00044-8qt`): embeddings
  768-dim vector; gemini_vertex flash reply; grounded_search real cited `paper_id`
  (`2606.04113v1`) over a 63-doc datastore. **batch_predict**: its first job FAILED at
  execution because Vertex routes embedding batches through a BigQuery delegation SA
  (`bqcx-448437003097-igmm@gcp-sa-bigquery-condel`) needing `roles/aiplatform.user`; that
  grant was made (PI-requested) and execution **re-verified two ways** — a direct
  `text-embedding-004` job and an engine-route job both reached `JOB_STATE_SUCCEEDED` with
  real embeddings in GCS (jobs `4764147582089822208`, `7024954595029811200`).
- **Spend ceiling trips IN PRODUCTION:** flash cap set to 1 → 2nd live call
  `CAP_EXCEEDED` → cap restored to 300. Invariant 11 enforced live, not only in eval.
- **RCE / secrets unchanged:** the live route is still fetch-only to `*.googleapis.com`;
  the deploy set was secret-scanned clean before shipping; the boundary key was loaded
  into the deploy env in-process and never printed.
All guarantees survive activation. Status: **LIVE** (see `UPGRADE_GATE.md` §Status).
