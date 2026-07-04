# ARCHITECTURE.md — Econstellar Compute Engine

> The structural reference for the engine. The companion manuscript
> `docs/econstellar-compute-engine.tex` tells the story and the verified record;
> this file is the map. Every figure here resolves to a job id, a git SHA, a
> Cloud Run revision, or a published artefact. Read this before changing the
> engine; read `STATE.md` for the live ledger and the learning record (L1–L13).

The engine runs a **fixed catalogue of econometric methods inside a sandbox** and
returns each result as structured data, with enough provenance attached that the
number can be banded against an expectation and reproduced later. The governing
rule: **a method is not in the catalogue until it ships with a failable test of
its own output.** The catalogue and that suite of tests are the deliverable.

As of 2026-07-04 the public registry serves **32 methods** — `GET /health` →
`{methods: 32, revision: shssm-compute-00055-bjz, sandbox: "timeout", timeout_s: 90}`.
The §A2 registry below itemises the original **26**; the five served since are
`news_attention_te` (FRONTIERS III, added at rev `…-00045-ns8`) and the four
FRONTIERS V.2 control operators `lq_regulator`, `bellman_value`, `turnpike`,
`fragility_barrier` (added at rev `…-00046-mbx`; verified by `test/v5-control.test.mjs`
and `test/gate-enforcement.test.mjs`). Completing their §A2 rows is tracked debt.
The most recent committed full suite (2026-06-12) recorded **26/26 passing** at
`shssm-compute-00036-llf` (the prior machine-pinned run was 23/23 at
`shssm-compute-00032-c8q`); the machine-written `STATE.md` MEASURED block still
reflects an earlier pin (27) until the next `scripts/state-refresh.mjs` run. That
refresh is wired into a nightly loop installed in `cron` on 2026-06-15 that, as of
this writing, has not yet fired — so `evals.json` carries 26 rows against 31 live
methods, an eval-coverage gap owed the control and `news_attention_te` rows.

---

## The shape of the system — three planes

```
                 ┌──────────────────────────── READ SIDE (GitHub Pages, static) ───────────────┐
                 │  research dashboard · evals.html · reproduce.html · claims.html · gallery     │
                 │                         render  ▶  evals.json  (one genuine suite run)        │
                 └───────────────▲──────────────────────────────────────────────────────────────┘
                                 │ fetch (no compute on the read side)
   ┌───────────── KERNEL ────────┴───────────┐         ┌──────────── TOWER (workstation) ────────────┐
   │  server/compute-server.mjs               │  poll   │  server/job-server.mjs   :3030               │
   │  Cloud Run `shssm-compute` (asia-south1) │◀───────▶│  MAX_CONCURRENT = 2                           │
   │  + local dev :3200                       │  submit │  heavy async jobs:                           │
   │  · synchronous methods                   │         │   ksg_te · ksg_robustness · namh_pipeline ·  │
   │  · /api/chat (Gemini 2.5 fn-calling)     │         │   soch_robustness                            │
   │  · /api/claims  · /health                │         │  governed cores + GPU offload (see §A3,§A4)  │
   └──────────────────────────────────────────┘         └──────────────────────────────────────────────┘
```

- **Kernel** — `server/compute-server.mjs`. Synchronous methods and the chatbot.
  Deployed to Google Cloud Run (`shssm-compute`, `asia-south1`,
  `https://shssm-compute-b7ui3oxaqq-el.a.run.app`); runs locally on `:3200`.
  Cloud Run scales to zero between requests, which suits bursty, low-volume
  research traffic.
- **Tower** — `server/job-server.mjs` on `:3030`, always-on, on the group's
  workstation (`ecolex-Precision-5490`, 22 logical cores, one NVIDIA RTX 3000
  Ada Laptop GPU). Accepts a job, returns an id immediately, runs it
  asynchronously at a small fixed concurrency. Four methods route here; the rest
  are synchronous.
- **Surfaces** — static GitHub Pages in the sibling `econstellar/` checkout.
  Nothing on the read side computes; it displays `evals.json`, the single
  machine-written artefact of one genuine suite run.

---

## §A1 — Request lifecycle & the sandbox

Every analysis follows one path:

```
method + params  ─▶  schema validation  ─▶  bwrap sandbox  ─▶  Rscript x.R '<json>'  ─▶  JSON on stdout
```

- **No code from the user.** A request names a method from the fixed registry
  and a schema-validated parameter object. The runner scripts (`r/*.R`) are part
  of the repo and never user-supplied → **no arbitrary-code-execution surface.**
- **Sandbox.** Where `bwrap` is present — the workstation and local dev — each
  analysis runs under `bubblewrap`: `--unshare-net` (no network), `--ro-bind / /`
  (read-only FS), `--tmpfs /tmp` (fresh scratch), `--die-with-parent`, wrapped in
  `timeout`. The deployed Cloud Run image ships **without** `bwrap`, so the live
  kernel runs in `timeout`-only mode (`/health` → `sandbox: "timeout"`); there the
  guarantee rests on the parameterised-only registry (no user code reaches a
  shell), the read-only container image, and Cloud Run's own egress posture rather
  than on `bwrap`. Either path, one method call is bounded by `COMPUTE_TIMEOUT_S`
  (90 s in the deployed image, default 60 s) and a `124` exit is surfaced as an
  explicit `timeout after Ns` error, never a silent hang.
- **Data contract.** One JSON object in, one JSON object out. This is what lets
  the same method run identically in the cloud container, on the workstation,
  and in the test harness. The R helpers live in `r/_io.R`; emission is via a
  single `ce_emit()`.
- **Async routing.** The four tower methods are submitted to `:3030`, which
  returns a `job_<date>_<hash>` id; the kernel and dashboard poll for completion.
- **Data.** Daily G20 equity log-returns from
  `$COMPUTE_REPO/papers/contagion-channels/data/G20.xlsx` (18 markets,
  2006–2026). Transfer entropy is computed on **log-returns (I(0)), never price
  levels (I(1))** — the stationarity gate, enforced by `live_unit_root`.

**Kernel HTTP surface.** The deployed kernel exposes a small, rate-limited JSON API
(CORS open for the static read-side pages); the read surfaces only ever *read* it.

| Route | Method | Purpose | Cap |
|---|---|---|---|
| `/api/compute/run` | POST | run one registry method on schema-validated params | 20/min |
| `/api/compute/catalog` | GET | the method + dataset registry the workbench binds to | — |
| `/api/chat` | POST | AI analyst — Gemini 2.5 function-calling over the registry | 10/min · 50/day |
| `/api/research` | POST | deep-research assistant (agentic run + grounded synthesis) | 5/min · 20/day |
| `/api/situate` | POST | place a result against the verified record | 30/min |
| `/api/claims` | GET | epistemic ledger (established / contested / superseded) | — |
| `/api/sri/current` · `/history` · `/network` | GET | systemic-risk live-feed reads | — |
| `/api/sri/cron-tick` | POST | the daily SRI append (Cloud Scheduler only; §A6) | — |
| `/api/event` | POST | read-side telemetry | 60/min |
| `/health` · `/metrics` | GET | liveness (methods · revision · sandbox) · counters | — |

The two LLM routes (`/api/chat`, `/api/research`) share a daily budget; over cap
they return `503 daily_capacity` with a reset hint, never a fabricated answer.

---

## §A2 — Method registry (canonical)

The original 26 methods, grouped into six families (the live registry now serves
**31** — see the §A intro for the five later additions, `news_attention_te` and the
four FRONTIERS V.2 control operators, whose table rows are tracked debt). **Value**
and **band/check** are the
verified figure and the pre-registered acceptance criterion from the committed
runner `econstellar/evals/run-evals.mjs` (the bands are this table; the runner
cites `A2`). Bands are never hand-edited (K5); `evals.json` is always one genuine
run.

### Stationarity, cointegration & panels
| Method | Eval params | Value (2026-06-12) | Band / check | Basis |
|---|---|---|---|---|
| `unit_root` | India | ADF −49.18 | ADF stat ∈ [−55, −45] | ADF+KPSS (`urca`,`tseries`) |
| `live_unit_root` | `^GSPC`, both | (verdict) | levels non-stationary **and** returns stationary | live ADF gate |
| `panel_unit_root` | {India,USA,UK,China,Japan} | IPS −77.26 | IPS < −10 **and** LLC < −10 (LLC −51.79) | IPS / LLC panel |
| `vecm` | India,USA,UK | rank 3 | Johansen rank == 3 (trace 7265.97→1851.19) | `urca` Johansen |
| `granger` | India,USA,UK,China | 6 edges | n_edges == 6 (USA out-degree 3) | Granger causality |

### Volatility, long memory & spectra
| Method | Eval params | Value | Band / check | Basis |
|---|---|---|---|---|
| `garch` | default | α+β 0.991 | persistence ∈ [0.95, 1.0] | GARCH(1,1) (`tseries`) |
| `dfa_hurst` | default | H 0.542 | H ∈ [0.45, 0.65] | DFA |
| `namh_hurst` | default | Gold H 0.490 | H_mean ∈ [0.4889, 0.4909] | `namh` package |
| `wavelet` | default | 47.07 | scale-1 % of total ∈ [35, 60] | MODWT variance (`waveslim`) |
| `wavelet_coherence` | USA,India | 0.249 | mean coherence ∈ [0.2, 0.3], peak scale `d6` | MODWT coherence |

### Information flow (transfer entropy)
| Method | Eval params | Value | Band / check | Basis |
|---|---|---|---|---|
| `ksg_te` | default | USA→Japan 0.154234 | TE ∈ [0.150, 0.158] | KSG / Frenzel–Pompe |
| `ksg_robustness` | default | mean Spearman 0.7282 | headline edge rank == 1 across all 8 grids **and** mean Spearman ∈ [0.6, 0.85] | KSG nuisance grid |
| `namh_te` | default | −0.22322165 | window mean ∈ [−0.2242, −0.2222] | `namh` package |
| `wqte` | default | 0.0391 | aggregate QTE ∈ [0.02, 0.06] | wavelet-quantile (`waveslim`+`quantreg`) |
| `soch_profile` | default | 0.0391 | forward ∈ [0.03, 0.05], peak scale `d4` | `sochcontagion` |

### Connectedness & networks
| Method | Eval params | Value | Band / check | Basis |
|---|---|---|---|---|
| `connectedness` | India,USA,UK | TCI 30.25 | TCI ∈ [25, 35] | Diebold–Yılmaz |
| `spillover_rolling` | India,USA,UK | mean TCI 28.39 | mean rolling TCI ∈ [20, 35] | rolling Diebold–Yılmaz |
| `rolling_dcc` | India,USA | 0.2295 | India–USA mean corr ∈ [0.15, 0.31] | DCC |
| `network` | 6 markets | density 0.5667 | 6 nodes, density ∈ (0, 1] | `igraph` surface |
| `var_irf` | default | max root 0.7053 | companion max root ∈ [0.01, 0.999] | VAR / IRF (`vars`) |
| `quantile_var` | India,USA,UK; τ=0.05 | net +0.7006 | top tail driver == USA, net > 0 | quantile VAR (`quantreg`) |

### Contagion channels & systemic risk
| Method | Eval params | Value | Band / check | Basis |
|---|---|---|---|---|
| `channel_attribution` | default | GFC trade 27.9% | trade share ∈ [27.8, 28.0] **and** dominant channel = trade | channel attribution (arXiv:2604.26546) |
| `sri_daily` | default | 0.00849 | SRI ∈ [0.00848, 0.00850] | daily systemic-risk index |

### Reproduction & formal verification
| Method | Eval params | Value | Band / check | Basis |
|---|---|---|---|---|
| `namh_reproduce` | default | Δ 1.55×10⁻¹⁵ | hurst & TE panels green, max\|Δ\| ≤ 1e-8, ≥400 compared, 0 NA-mismatch; FDR amber, 0 edges | `namh` Δ-verifier |
| `namh_pipeline` | default | −0.22322165 | FDR 0/552, network degenerate, window mean ∈ band, seed 42, RNG `L'Ecuyer-CMRG` | `namh` end-to-end (async) |
| `soch_robustness` | default | pass-rate 0.9911 | baseline τ=0.05/J=4 holds 28/28, rate == 0.9911 exact, seed 42, B=200, advanced-8, grid 112 | `sochcontagion` badge (async) |

---

## §A3 — Core governance (the 22-core hang, fixed 2026-06-13)

**Root cause (L11).** `ksg_te.R`, `ksg_robustness.R` and `sri_daily.R` hard-coded
`ncores <- detectCores()-1` (= 21 `mclapply` FORK workers) and ignored the job's
`n_cores`. Two concurrent `ksg_robustness` jobs forked 2×21 = 42 workers over 22
logical cores, each over an unpinned multi-threaded BLAS → every core at 100% →
the host hung mid-pipeline.

**Fix — one governed budget.** `ce_ncores(p, reserve)` in `r/_io.R`:
1. base `detectCores() - reserve`,
2. overridden by the job's `n_cores`,
3. **clamped last by a hard ceiling `CE_MAX_CORES`.**

`server/job-server.mjs` sets `CE_MAX_CORES = floor((cpus-2)/MAX_CONCURRENT)`
(= 10 on the 5490) and pins `OPENBLAS_/OMP_/MKL_/VECLIB_/NUMEXPR_NUM_THREADS=1`
per R spawn; it surfaces `core_budget` in `/health` and the startup log. Wired
into all six `mclapply` sites (`ksg_te`, `ksg_robustness`×2, `sri_daily`,
`channel_attribution`, `channel_robustness`; `soch_robustness` was already capped
at 4). Worker count never changes a TE number (the loops are order-free), so this
is determinism-safe; BLAS pinning is itself a reproducibility gain. Verified:
ask-21-under-ceiling-2 → `mclapply` forks exactly 2 PIDs.

---

## §A4 — GPU offload of the transfer-entropy search

The KSG/Frenzel–Pompe estimator's cost is an *O(n²)* max-norm nearest-neighbour
search, once per directed pair and once per surrogate. It now runs on the
RTX 3000 Ada GPU via **`numba.cuda`** — zero new install (CUDA 12.4 + numba
0.63.1 already present; no torch/cupy).

- **Dispatch.** `ce_ksg_gpu_pairs()` in `r/_ksg_core.R` is the shared dispatcher:
  probe `gpu/ksg_gpu.py --probe` → write returns-bin + spec JSON → invoke the
  helper (child stdout discarded so the engine's stdout stays pure JSON) → parse.
  **Any failure → `NULL` → caller's governed-CPU `mclapply` fallback.**
  `ksg_te` uses it for its pair loop; `ksg_robustness` inside `te_vector()`. Both
  emit a `compute_path` field. **Default AUTO; `CE_GPU=0` forces CPU.**
- **Bit-exactness bar.** `gpu/equiv_gate.R`: observed TE (the only quantity the
  evals gate — `ksg_te` band, `ksg_robustness` ranks/Spearman) must **equal** the
  engine's `.te()`. Measured **max\|Δ\| = 7×10⁻¹⁶**, six-decimal emit identical,
  across lag {1,2} × k {4,5}. So GPU-by-default can never move a published number.
- **The `.count_1d` subtlety the gate caught.** The engine's 1-D Z-count (lag=1
  only) tests membership via `findInterval(v-eps)`, *not* `|dp-v|<eps`, so it
  **includes** a boundary point the textbook abs-form rejects when `|dp-v|` rounds
  to exactly `eps`. The GPU replicates the *engine's* behaviour host-side (the
  ≥2-D `.count_kd` path already matches the abs-form). Lesson: gate on the
  estimator's own output, including its FP boundary conventions, not the textbook.
- **Surrogates.** IAAFT runs host-side as a **batched FFT** (the method is
  unseeded → p-values are non-reproducible in both paths anyway); a pair's
  observed estimate + all B surrogates run as **one batched (S×m) kernel launch**,
  amortising launch/transfer overhead. FP64 throughout (FP32 is faster again but
  would break the anchor).
- **Measured (L13).** 12 pairs × B=99: **GPU 82 s (~1 core) vs governed CPU 289 s
  (~7 cores) = 3.5× faster and frees the CPU.** Phase-1 (the exact workload that
  hung the box — full 18-market panel, 306 directed pairs, B=99 = 30,600
  searches): **35.6 min at 100% of ONE core, peak 388 MB**; 106/306 significant,
  USA→Japan TE 0.154234 exact, Japan the dominant info-sink. The 22-core
  saturation is gone.

Files: `gpu/ksg_gpu.py` (production helper), `gpu/equiv_gate.R` (gate),
`gpu/REPORT.md` (trial), `gpu/runs/` (gitignored).

---

## §A5 — The evaluation suite

`econstellar/evals/run-evals.mjs` runs the full public suite — synchronous rows
against the kernel, async rows as real tower jobs — and writes `evals.json`
(`{run_at, engine, summary:{pass,fail,async_pending,total}, results[]}`). The
read-side pages render that file.

- **Pre-registered, failable.** Each row carries an expected band fixed *before*
  the run (§A2). A regression turns the public dashboard red rather than passing
  silently.
- **Two kinds of red (L4).** A *band failure* means the engine is wrong → stop
  and investigate. An *extraction failure* means the harness misread the result
  shape → fix the check and re-run the whole suite. Fixing extraction is
  calibration, **not** gaming, only while the expected band is left untouched.
- **K5.** `evals.json` is never hand-edited; it is always the output of one
  genuine run of the committed runner.
- **Probe-race honesty.** If the health probe races a Cloud Run cold start,
  `engine.ok=false/methods=null/revision=null` while the method rows still pass;
  the report renders "not captured at this run's probe", never a bare `?`.

---

## §A6 — Nightly loop & the SRI live feed

`scripts/nightly-loop.sh` (cron `10 7 * * *` UTC; reboot-surviving), six steps,
each loud on failure / silent on success:

1. **Re-arm the job server** if `:3030` is closed (never kills a running job).
2. **Run the full eval suite** → `evals.json` in place.
3. **State refresh + drift** (`scripts/state-refresh.mjs`; exit 2 on regression).
4. **Claims refresh** (`scripts/claims-refresh.mjs`; pass → `last_verified`, red →
   contested pair, never deletes) — log-only.
5. **Academic run report** (`scripts/gen-compute-report.mjs`, `nice -n 19`):
   renders a LaTeX manuscript *from* tonight's `evals.json` (verbatim — failures
   render as loudly as passes; never recomputes), into `compute-reports/`.
   Includes `compute-reports/narrative_<run-date>.tex` if present.
6. **Publish to the gallery** (`scripts/publish-reports.mjs`, `nice -n 19`):
   copies each `compute-reports/*.pdf` + a first-page thumbnail into
   `econstellar/reports/` and rewrites `reports/manifest.json`.

Steps 5–6 do **zero compute**, so the report layer can never re-trigger the hang.

**SRI live feed.** A separate Cloud Scheduler tick (`sri-daily-tick`, `0 6 * * *`
UTC) pulls the latest closes (Yahoo) → appends to the stored panel → recomputes
the index in a net-isolated step → writes `systemic_risk.daily`. Idempotent and
self-healing: a missing day skips honestly and composition heals the gap next
day. Never fire it manually during the US session (13:30–20:00 UTC) — the
schedule *is* the partial-bar guard (L3).

---

## §A7 — Report & gallery pipeline

- `scripts/gen-compute-report.mjs` — renders a ≤7-page LaTeX academic report from
  `evals.json`: abstract + keywords + JEL → engine → Data & methods (six families
  with verifiable citations) → grouped Results table (value + pre-registered
  band) → optional narrative → Reproducibility & integrity → per-row provenance
  appendix → **References last** (the generator owns the bib and strips any
  bibliography out of an included narrative, so refs can never sit before a
  section). Filename keyed to `run_at`, so regeneration overwrites in place.
  22/22 selftests.
- `scripts/publish-reports.mjs` — parses each `.tex` for title/date/abstract,
  pages via `pdfinfo`, thumbnail via `pdftoppm`; writes `reports/manifest.json`.
  6/6 selftests. Non-fatal.
- `econstellar/research-engine.html` — a "Compute-Run Reports" card grid reading
  the manifest; click → full-screen modal with the browser's native PDF viewer
  (fit-width / fit-page / 100%, open-in-tab, download, Esc-close).

The reference manuscript `docs/econstellar-compute-engine.tex` is a standalone
doc, not a nightly run report; it lives in `docs/`, not `compute-reports/`.

---

## §A8 — Formal & epistemic layers

- **Formal (Lean 4 + mathlib, toolchain v4.30.0).** Machine-checks the SOCH
  spectral results: **11 of 12 declarations Lean-accepted**, including the
  unconditional closure of the product-Lorentzian spectral-density proposition
  (‖H(ω)‖² = S(ω)) and the FOC-frequency existence/uniqueness chain. One
  declaration (the analytic half of the peak-location lemma) honestly carries
  `sorry` and is reported as unproved — a `sorry` is never reported as proved.
- **Epistemic (claims ledger, Phase 34).** A provenance-carrying ledger of
  ~20 seeded claims spanning **established / contested / superseded** states, with
  `GET /api/claims` on the kernel and a "What we know" read panel. A contested
  result (e.g. a channel-share figure one method/partition puts higher than
  another) is shown *as* contested, with both sides, never silently resolved.
  When its data store is unprovisioned the API degrades honestly, naming the
  missing dataset rather than fabricating an empty success.

---

## §A9 — Integrity invariants

1. **Every number traces** to a live computation or a documented published
   result. No exceptions.
2. **Citations are looked up, never reconstructed from a codename** (L8). Verify
   id ↔ title ↔ authors against the registered record (arXiv / DESCRIPTION)
   before citing. Same discipline for vendored API symbols (L10): grep the
   dependency's own source first.
3. **Reproduce-integrity bar.** Only a true re-run that *matches* the published
   number earns a green "live reproduction" badge; an inexact re-download or a
   re-scored saved output stays honest amber "pending".
4. **Verify the rendered PDF, not just LaTeX source** (L6): TikZ labels and
   line-wrapped phrases are invisible to line-based grep. Use
   `pdftotext file.pdf - | tr '\n' ' ' | grep`, ligature-tolerant.
5. **Commits** are authored `Avishek Bhandari <avishekb@iitbbs.ac.in>` via a
   per-commit `-c user.name/-c user.email` override (the box config is a
   different identity), with **zero Claude co-author trailers** (Invariant 4).
6. **Honest negatives are results.** SOCH-C `p=0.105` (not significant) and the
   FDR 0/552 degenerate NAMH network are immutable facts of the record.

---

## §A10 — Governed live-GCP capability layer (Track B, activated 2026-06-15)

A governed route family on the kernel (`server/upgrade-capabilities.mjs`, zero-dep)
behind `POST /api/upgrade/run {capability,params}` + `GET /api/upgrade/menu`. It extends
the parameterised-only contract to managed-cloud services **without widening the
execution surface**: the route matches a capability name against a fixed four-entry
registry (unknown → `404`) and is **fetch-only — it never reaches `spawn`**, so §A1's RCE
guard holds unchanged. Each capability is OFF unless its `CE_CAP_*` flag is exactly
`1`/`true` (default-OFF, least-privilege), and every paid call runs the gate **flag →
typed params → datastore-hole → spend ceiling** before the call; a rejection returns a
coded error and spends nothing, never a fabricated answer.

- **The governor.** `capBudget(cap, maxPerDay, units)` in `server/guards.mjs` generalises
  `llmBudget` to N named per-UTC-day counters (billing in calls, or tokens for
  embeddings); it reserves *before* the call, so over-cap returns `CAP_EXCEEDED`.
  Process-local, so the fleet bound is `ceiling × max-instances (2)`; the 400-LLM/day
  budget remains the outer backstop. **Verified to trip in production** (flash cap set to
  1 → 2nd live call `CAP_EXCEEDED` → restored to 300). This generalises the §A3
  core-budget lesson: a saturable resource ships with its governor wired before it is
  reachable.

| Capability | `CE_CAP_*` flag | Vertex surface | Ceiling | Status |
|---|---|---|---|---|
| embeddings | `…_EMBEDDINGS` | `text-embedding-004:predict` | 2,000,000 tok/day | **LIVE** (768-dim) |
| grounded_search | `…_GROUNDED_SEARCH` | discoveryengine `:search` | 200 queries/day | **LIVE** (63-doc datastore) |
| gemini_vertex | `…_GEMINI_VERTEX` | `aiplatform:generateContent` | 300 flash / 100 pro per day | **LIVE** |
| batch_predict | `…_BATCH_PREDICT` | GCS-stage + `batchPredictionJobs` | 1 batch/day, ≤50k items | **live end-to-end** (exec verified 2026-06-15 after the delegation-SA IAM grant) |

- **Grounded retrieval.** Vertex AI Search datastore `econstellar-literature` + engine
  `econstellar-literature-search` over the `literature.papers` warehouse (63 docs,
  imported as `{id, structData}` NDJSON — the direct BigQuery import fails for want of a
  per-row `id`). It returns real `paper_id`s, so a grounded answer cites a real retrieved
  passage. Distinct from `/api/research` *search-grounding* (Google-search-backed): this
  is corpus retrieval over our own literature warehouse.
- **batch_predict (honest hole).** Submit + GCS staging are live; the job then fails at
  execution because Vertex routes embedding batch through a BigQuery delegation service
  agent (`bqcx-…@gcp-sa-bigquery-condel`) that needs a one-time `roles/aiplatform.user`
  grant (PI-gated). Recorded, not assumed away.
- **Secret hygiene.** `scripts/secret-scan.mjs` blocks any secret-shaped *value* (output
  redacted to a fingerprint) before commit/deploy; its pattern matches values, not
  env-NAME references, so the engine's `GOOGLE_API_KEY=`-style handling does not
  false-positive. The route logs `path+capability+code+ip` only — never params, never a
  token; the OAuth bearer is minted at the metadata boundary and used in the
  `Authorization` header only.
- **Eval & dossiers.** `test/upgrade.test.mjs` (9/9): default-OFF, typed-param gate,
  ceiling trips and mints no token, datastore-hole spends nothing, secret-scan
  blocks-then-clears. Governance dossiers in `upgrade/` (inventory · cost model · threat
  model · ledger · reverification · gate).
- **Reversible.** Unset a `CE_CAP_*` env var (or set `0`) → `CAPABILITY_OFF`; delete the
  datastore/engine → grounded cost to zero.

---

## Repository layout

```
compute-engine/
├── ARCHITECTURE.md            # this file (canonical structural reference)
├── README.md                  # quick start
├── STATE.md                   # live ledger (MEASURED · DRIFT · LEDGER · LEARNING L1–L13)
├── docs/
│   └── econstellar-compute-engine.tex   # the reference manuscript (+ .pdf)
├── server/
│   ├── compute-server.mjs     # kernel: registry · validation · bwrap · /api/chat · /api/upgrade
│   ├── upgrade-capabilities.mjs # Track-B governed GCP capability layer (§A10, CE_CAP_* gated)
│   ├── guards.mjs             # rate/concurrency/llmBudget + capBudget spend governor
│   └── job-server.mjs         # tower :3030 (async jobs · core governance · GPU)
├── r/                         # R analyses (one JSON in → one JSON out)
│   ├── _io.R                  # ce_emit, ce_ncores (core budget)
│   ├── _ksg_core.R            # KSG/Frenzel–Pompe estimator + ce_ksg_gpu_pairs (GPU dispatch)
│   ├── ksg_te.R  ksg_robustness.R  sri_daily.R  channel_*.R  …
├── gpu/
│   ├── ksg_gpu.py             # numba.cuda helper (batched eps + count kernels, batched IAAFT)
│   ├── equiv_gate.R           # bit-exactness gate (≤7e-16)
│   └── REPORT.md              # GPU trial record
├── scripts/
│   ├── nightly-loop.sh        # 6-step reboot-surviving self-check (cron 10 7 * * * UTC)
│   ├── secret-scan.mjs        # Invariant-12 secret gate (blocks-then-clears; value-not-name)
│   ├── gen-compute-report.mjs · publish-reports.mjs · state-refresh.mjs · claims-*.mjs
├── test/
│   ├── golden.test.mjs        # empirical-band regression (5/5)
│   └── upgrade.test.mjs       # capability-layer governance eval (9/9)
├── upgrade/                   # Track-B dossiers (inventory · cost · threat · ledger · reverif · gate)
├── compute-reports/           # nightly LaTeX run reports (+ narrative_<date>.tex)
└── epistemic/                 # claims schema + seed
```

(The read-side surfaces, `evals.json`, and `reports/` live in the sibling
`econstellar/` GitHub-Pages checkout.)

---

## Deployment & ops facts

- **Kernel:** Cloud Run `shssm-compute`, `asia-south1`,
  `https://shssm-compute-b7ui3oxaqq-el.a.run.app`. Deploy via `cloudrun/deploy.sh`
  (resolves `GOOGLE_API_KEY` from env, then `$REPO/../.env.local`; watch the WARN
  line — a moved root ships a chat-disabled revision (L2); restore in-place with
  `gcloud run services update --update-env-vars`, no rebuild).
- **Tower:** `server/job-server.mjs` on `:3030`, workstation
  `ecolex-Precision-5490` (22 logical cores; RTX 3000 Ada Laptop GPU, CC 8.9,
  8 GB, driver 580.159.04; CUDA 12.4; numba 0.63.1). `setsid` daemons die on
  reboot; the nightly loop re-arms the job server, the operator restarts the
  studio proxy (L7).
- **Registry:** 26 methods. Last 26/26 suite 2026-06-12 (deploy chain reached
  `shssm-compute-00036-llf`); last machine-pinned full run 23/23 at
  `shssm-compute-00032-c8q`.
- **Capability layer (§A10, activated 2026-06-15):** image rebuilt by `cloudrun/deploy.sh`
  (rev `shssm-compute-00038-g7g`; first attempt hit L2 — moved root dropped
  `GOOGLE_API_KEY` — fixed by exporting it from `versiondevs/.env.local` and
  redeploying); `CE_CAP_*` flags then flipped on the same image via
  `gcloud run services update --update-env-vars` (no rebuild). `GET /api/upgrade/menu`
  → all four `enabled:true`; all four live-verified end-to-end (batch execution verified
  2026-06-15 after the one-off `roles/aiplatform.user` grant to the BigQuery delegation SA;
  jobs `4764147582089822208` direct + `7024954595029811200` engine-route, both `SUCCEEDED`).
- **Live verification (2026-06-15):** `GET /health` → `{ok:true, methods:26,
  revision:"shssm-compute-00044-8qt", sandbox:"timeout", timeout_s:90}` (serving rev after
  the flag flips; method count unchanged — the upgrade route is not a registry method).
  Analysis panel
  `$COMPUTE_REPO/papers/contagion-channels/data/G20.xlsx` spans 2006-01-12 →
  2026-03-18 (18 markets) and is byte-hashed at kernel and tower startup so a
  result carries its data state.
- **Canonical jobs (2026-06-12):** `job_20260612_0f2f0fd5` (`namh_pipeline`,
  B=200, seed 42, 1222 s); `job_20260612_fe0c4f06` / `job_20260612_c0398d0f`
  (`soch_robustness` seeded anchor + independent re-run, identical tuple).
