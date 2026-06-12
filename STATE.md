# STATE.md — Econstellar engine state ledger

One file, three blocks. MEASURED is machine-written by `scripts/state-refresh.mjs`
(nightly via `scripts/nightly-loop.sh`, or on demand); LEDGER is appended by working
sessions; LEARNING is the staged lesson record whose distilled rows become Skills.
The repository and the catalogue are the truth; this file follows verified state and
is loud about drift. Sessions should read this file before acting on the engine.

## MEASURED

<!-- MEASURED:BEGIN (machine-written by scripts/state-refresh.mjs; do not hand-edit) -->
- refreshed: 2026-06-12T02:33Z
- engine: rev `shssm-compute-00032-c8q` · methods 23
- evals: 23/23 pass (0 fail, 0 pending), run 2026-06-12T02:33Z at shssm-compute-00032-c8q
- sri feed: 2026-06-09 SRI 0.007146 (17 markets, 272 pairs)
- problems: none
<!-- MEASURED:END -->

## DRIFT (machine-appended, newest first)

<!-- DRIFT:APPEND -->
- 2026-06-12T02:09Z: methods 0 -> 23

## LEDGER (session-appended; humans and agents)

- 2026-06-12: OS-P0..P5 shipped with green page evals (16/16 · 14/14 · 23/23 · 19/19
  · 10/10); engine hardened (24/24 failure probes) at rev `shssm-compute-00032-c8q`;
  Phase-31 badge board: 1 robust · 2 conditional · 2 fragile · 3 untested holes.
- Open PI gates (report readiness, never self-authorise): AHRC submission (supreme,
  before 12 July) · CRAN sochcontagion · Zenodo · billing alarm · 32.2 Bloomberg ·
  second grid node power-on · Phase 33 Lean · Phase 34 claim DB.
- Open PI decisions: register the 4 robustness drivers in the public catalogue
  (23 -> 27)? · supersede the NAMH phi-ranking fragile badge with a
  decomposition-based conditional (KSG #39 precedent)? · 4 untracked PNGs in the
  pages repo (banner/logo/post2/post3) — commit or keep local?
- Known operational fact: setsid daemons (job-server :3030, studio proxy :3001) die
  on reboot; the nightly loop re-arms the job-server, the proxy is started manually
  by the operator.
- 2026-06-12: Econstellar system paper v2 COMPLETE at ivy-fineco/papers/econstellar/
  arxiv_submission_v2/ (v1 frozen, mtimes Jun 4): 29 pp, 2 TikZ figs (incl. the real
  58-point series), 5 tables, 108-entry bib; built by 6 domain briefs -> writer ->
  review panel (2 agent reviews + 3 in-loop audits after a session-limit cutoff);
  30 panel fixes applied; tarball compiles standalone; PRE-SUBMISSION GATE: push
  pages commit 6290f90 first (paper's URLs table 404s until then). Submission =
  PI action (arXiv replacement of 2606.05705).
- PI ACTION pending (one command): install the nightly loop in cron. The loop is
  built and self-tested; the harness declined to edit the crontab autonomously.
  Run:  ( crontab -l; echo '10 7 * * * /home/ecolex/engine-work/compute-engine/scripts/nightly-loop.sh >> /tmp/econstellar-nightly.log 2>&1' ) | crontab -
- 2026-06-12: AHRC proposal SUBMITTED by the PI (supreme gate CLOSED, a month ahead
  of the 12 July deadline). Submitted artifact = ivy-fineco/proposals/ahrc/template/
  main.pdf (23 pp), frozen beside it as main_SUBMITTED_2026-06-12.pdf + source
  tarball, sha256 88806b67d5523c94…; engine facts pinned at submission: 23 methods /
  rev shssm-compute-00032-c8q / SHAs 37d4337 (engine) + 7bea875 (pages) / 60-point
  SRI / namh_te live-anchored vs 03_te_summary.csv (|Δ|=6.6e-10). Live surfaces
  re-verified at submission time. Pages push 6290f90 now gates ONLY the paper-v2
  arXiv replacement; keep Cloud Run + Pages up through the review period.
- 2026-06-12: V4 M2 / Phase 33 — Lean 4 formal closure layer SHIPPED at
  ivy-fineco/papers/SOCH/lean4/sochlean (Lean v4.30.0 + mathlib v4.30.0 pinned;
  CI check = `lake build`, green at 8478 jobs). 8/9 declarations machine-checked:
  prop:spectrum FORMALLY CLOSED (‖H(ω)‖² = S(ω), unconditional Lean theorem);
  lem:peak scaffolding proved (FOC ⟺ 3x²+(α_s²+α_r²)x−α_s²α_r²=0 in x=ω²;
  symmetric peak ω*=α/√3; IVT bracket [α_min/√3, α_min]); single-peakedness +
  uniqueness remains STATED — honest sorry-count 1/9 (a sorry is never reported
  as proved). Element map: reproduce.html #sochformal strip (page eval 21/21,
  incl. a page↔Lean-source sorry-count lockstep check) + ivy-fineco
  ARCHITECTURE.md §C7 row + chronology #49. Pages changes stay UNCOMMITTED with
  the M1 reproduce wiring — one coherent pages commit lands after the engine
  deploy + full 26-row suite run (alignment rule). Same day: canonical
  namh_pipeline tower job job_20260612_0f2f0fd5 SUCCEEDED (B=200, seed 42,
  1222 s) — te_raw.mean −0.22322165 inside the pre-registered band
  [−0.2242, −0.2222], FDR 0/552 (honest amber end-to-end), p-value RNG
  discriminator live; all 5 pre-registered eval-row criteria pass.
- 2026-06-12: V4 M3 / Phase 34 — epistemic claim layer BUILT (commit 6fab33d (author-fixed)):
  epistemic/schema.json + scripts/claims-seed.mjs (19 provenanced claims, 15/15
  selftests; WaveQTE 50.0%-vs-27.9% seeded CONTESTED with both sides; DML INSERT
  only, never streaming) + GET /api/claims + /api/claims/:id on the kernel
  (CORS *, graceful-degrade smoke-verified) + claims.html "What we know" panel
  (26/26 page evals; contested/superseded visible; degrade fabricates nothing)
  + scripts/claims-refresh.mjs (12/12; pass→last_verified, red→contested pair
  via MERGE contests:<id>, NEVER deletes) wired into nightly-loop step 4.
  PI-GATED (classifier-denied in-session, run in order):
    (1) cd ~/engine-work/compute-engine && node scripts/claims-seed.mjs --apply
    (2) bash cloudrun/deploy.sh        # ships /api/claims + the 26-method registry
    (3) node scripts/claims-refresh.mjs --simulate-contradiction
        → curl -s "https://shssm-compute-b7ui3oxaqq-el.a.run.app/api/claims?status=contested" | grep ztest
        → node scripts/claims-refresh.mjs --clean-simulation
  Chrome court blocked in-session (browser navigation denied by permission
  mode) — claims.html + reproduce.html #sochformal need the PI's desktop+mobile
  eyeball; the harness evals (26/26 + 21/21) are the machine record.
- 2026-06-12: V4 M4 / self-improving loop — (1) WaveQTE 50.0%-vs-27.9% flag
  RESOLVED with a written disposition (docs/WAVEQTE_FLAG_DISPOSITION.md): a
  method+partition divergence (Feb-WP activation-scoring intensity / 7 episodes
  vs published structural IV/2SLS / 8 sub-periods, GFC* Aug-07→Jun-09), NOT
  proxy vintage; canonical = arXiv:2604.26546 (Trade 27.9% [26.1,29.8], read
  with its own method-dependence disclosure; the Phase-31 badge independently
  corroborates share-stable/label-knife-edge); claim seed updated to the full
  lifecycle (contested→superseded + established resolution claim; seed 16/16).
  (2) Gap-proposal pipeline scripts/gap-proposals.mjs (7/7 selftests) RAN once
  end-to-end for real: /metrics read OK (events:{} — true in-memory state),
  gcloud logging read OK (0 unanswerable asks / 7d), rule >=5/7d → NO proposals
  — recorded in candidates/RUNLOG.md as a first-class outcome. Never
  auto-deploys; candidates are PI-review documents. (3) Eval growth law: local
  registry 26 methods / local suite 26 rows; deployed 23/23 (last full run
  02:33Z); page harnesses 21/21 + 26/26. Law holds at both layers; the 26/26
  full run lands post-deploy (alignment rule). (4) K3 process changes adopted:
  main-module guard on dual-use scripts (L9) + grep-vendored-source-before-
  writing (L10) — skill distillation PI-gated.
- PI ACTION pending (two commands, skill distillation of L9/L10): append the
  "Tooling discipline (L9)" block to
  versiondevs/.claude/skills/econstellar-eval-discipline/SKILL.md and the
  "Vendored-API names (L10)" block to .../econstellar-verifier/SKILL.md —
  exact texts in this session's final report.
- 2026-06-12 (continuation): sorry-count FELL 1/9 → 1/12 — Lean uniqueness
  chain proved first-build (Q_strictMonoOn · foc_omega_unique ·
  existsUnique_foc_omega): the stationary-point half of lem:peak is now fully
  machine-checked; the single sorry is the analytic half only (maximiser
  existence + stationarity, route documented in the file). Lockstep
  re-verified: #sochformal text, reproduce-page eval 22/22 (new uniqueness
  check), README, seed claim (16/16, refresh 12/12). NEW
  evals/loop-integrity.test.mjs 20/20 — the autonomy loop's own wiring is now
  a failable eval (steps exist · artifact paths agree · claims MAP ⊆ suite
  rows · no nightly DELETE · gap rule + PI gate intact · install-state
  honesty). First run was 11/20 red — all 9 extraction failures (m: vs
  method:, quoted path, DELETE in a comment), calibrated per L4, bands
  untouched. SRI auto-appended 2026-06-11 = 0.006875 overnight.

## LEARNING (fail → investigate → verify → distill → consult)

Stages: a burned lesson enters at fail; investigate names the cause; verify proves
the fix; distill promotes it to a Skill (consultable procedure); consult means
future sessions read the Skill before acting. Distilled rows name their Skill.

| id | date | stage | lesson | distilled to |
|----|------|-------|--------|--------------|
| L1 | 2026-06-11 | distilled | A pre-registered robustness grid must anchor through the paper's own scripts and estimation universe before any badge is written; the package-default universe gave p 0.158 where the published 56-pair design gives 0.042 (reproduced exactly). Stop on anchor failure, diagnose, document the amendment openly, keep the auxiliary run. | econstellar-verifier |
| L2 | 2026-06-11 | distilled | `cloudrun/deploy.sh` resolves GOOGLE_API_KEY from env first, then `$REPO/../.env.local`; moving the engine root (symlinks) silently changes that resolution and ships a chat-disabled revision. Always check the WARN line; restore with `gcloud run services update --update-env-vars` (no rebuild). | econstellar-engine-ops |
| L3 | 2026-06-10 | distilled | Yahoo serves `close: null` for 10+ hours after a session; the finite-close guard makes the 06:00Z tick skip honestly and composition heals the gap next day. Never fire cron-tick manually during the US session (13:30-20:00Z): buildNewPanelRows has no partial-bar guard; the schedule IS the guard. | econstellar-engine-ops |
| L4 | 2026-06-11 | distilled | Eval failures split into band failures (engine wrong: stop, investigate) and extraction failures (harness wrong about the result shape: fix the check, re-run the whole suite). Fixing extraction is calibration, not gaming, ONLY when the expected band is untouched. evals.json must always be the output of one genuine run of the committed runner. | econstellar-eval-discipline |
| L5 | 2026-06-11 | distilled | "5-market IPS -77.26" was unreproducible until the market set was pinned: the documented tuple belongs to {India, USA, UK, China, Japan}; a different fifth market gives -80.16. Documented tuples must name their full parameterisation or they are not reproducible claims. | econstellar-eval-discipline |
| L6 | 2026-06-08 | distilled | LaTeX source grep is insufficient for count/fact consistency: TikZ figure labels and line-wrapped phrases are invisible to line-based search but visible in the rendered PDF. Verify with `pdftotext file.pdf - \| tr '\n' ' ' \| grep`, ligature-tolerant, across all figures/*.tex. | econstellar-verifier |
| L7 | 2026-06-12 | distilled | A laptop reboot killed both setsid daemons mid-pipeline; the eval suite survived because it had already written its artifact. Long-lived local services need a reboot-surviving re-arm (cron port-guard), and pipelines should write artifacts as they go, not at the end. | econstellar-engine-ops |
| L8 | 2026-06-04 | distilled | Bibliography titles are looked up, never reconstructed from codenames: "MCPFM" resolves to a Model Context Protocol title (arXiv:2507.08065), not the codename expansion. Verify id <-> title <-> authors against the registered record before citing. | econstellar-verifier |
| L9 | 2026-06-12 | verify | A dual-use ESM script (CLI + importable) must guard its CLI dispatch with the main-module check (import.meta.url vs pathToFileURL(argv[1])): claims-refresh imported CLAIMS from claims-seed and the seeder's top-level dispatch ran the WRONG selftest + process.exit'd, masquerading as a pass. Fixed + selftested. Distillation to econstellar-eval-discipline PENDING (skill append classifier-denied; PI one-liner in LEDGER). | pending |
| L10 | 2026-06-12 | verify | Before writing code against a large vendored dependency, grep the dependency's OWN source for exact symbol names first (mathlib in .lake/packages): the Lean PSD proof compiled FIRST-TRY with zero name-risk iterations because Complex.sq_norm / normSq_add_mul_I / normSq_div were verified from source pre-write. Code-API corollary of L8. Distillation to econstellar-verifier PENDING (same gate). | pending |
