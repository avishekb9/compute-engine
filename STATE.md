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
