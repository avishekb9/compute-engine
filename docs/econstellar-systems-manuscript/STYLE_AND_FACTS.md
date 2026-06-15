# STYLE_AND_FACTS.md — the manuscript contract (read fully before writing)

This is the shared contract for every section writer of *The Econstellar Compute
Engine* manuscript. Your section must obey this file exactly. Your section-specific
material (the deep analysis of your subsystem) is in your task prompt.

## 0. What we are building
A focused (35–45 pp) LaTeX systems-and-theory manuscript on the entire Econstellar
compute engine, pitched at the depth and discipline of a top-tier systems technical
report (Anthropic / Google / DeepSeek) fused with an applied financial-econometrics
narrative. Thesis: **Econstellar is a research "space programme" — one sandboxed
compute engine exposing one 8-primitive methodological substrate under a
pre-registered, failable evaluation gate; the six published frameworks
(NAMH, SOCH, contagion-channels, WaveQTE, commodity, MCPFM) are its elements.**

## 1. Voice and style (non-negotiable)
- Measured, precise, British spelling, first-person plural ("we"). Pitch like a
  serious systems paper, not marketing.
- **No superlatives** (no "revolutionary / breakthrough / unprecedented /
  state-of-the-art / world-class"). The registered voice: *"we would rather have
  twenty-six checked methods than fifty asserted ones."*
- **NO em dashes (—).** Use "--" (en dash in LaTeX) or restructure with commas /
  colons / parentheses. This is a hard rule.
- Lead each part with the problem and the value in plain language; keep heavy jargon
  in the body.
- Active, concrete, example-driven. Prefer a real number + its provenance over an
  adjective.

## 2. No fabrication (hard rule)
- **Every quantitative claim must come from the Verified-Results table (§5) or your
  task prompt's file-anchored analysis.** If you need a number that is not there,
  write `\textbf{[VERIFY: what you need]}` inline and move on — do NOT invent it.
- Cite code by file path where it strengthens a claim (e.g. `\file{server/compute-server.mjs}`),
  but do NOT invent line numbers in the prose; describe the mechanism.
- Citations: use ONLY the `\cite{}` keys in §4. If you need a reference not listed,
  write `\cite{NEEDS:author-year-topic}` and I will resolve it at integration. Never
  reconstruct a paper title from a codename.
- Honest negatives are results and must be stated as such (see §5: SOCH-C p=0.105 not
  significant; NAMH FDR 0/552; MCPFM v2 AUC 0.470; Lean sorry 1/12).

## 3. LaTeX contract (compile-safety — use ONLY these)
- Class is `article` 11pt, already set in `main.tex`. **Write a section file only**
  (start at `\section{...}`); do NOT add `\documentclass`, `\begin{document}`,
  `\usepackage`, or a preamble. Do NOT redefine macros.
- Available macros: `\code{...}` (inline code), `\route{...}` (an HTTP route),
  `\method{...}` (a method name), `\file{...}` (a path), `\engine{}` ("Econstellar"),
  `\Norm{...}` (a norm).
- Available environments: `principle`, `invariant`, `cexample` (definition style);
  `proposition` (plain); `lstlisting` (style preset — use `language=` from
  {R, Python, bash, JavaScript} or none); `tikzpicture` (libraries: arrows.meta,
  positioning, shapes.geometric, fit, backgrounds, calc); `tabular`/`longtable` with
  `booktabs` (`\toprule \midrule \bottomrule`). `amsmath`/`amssymb` for maths.
- Colours available: `ceblue`, `ceorange`, `cegreen`, `cegrey`, `celight`.
- Do NOT use: `algorithm`/`algpseudocode` (NOT installed — use `lstlisting` for
  pseudocode), `tcolorbox`, `mdframed`, `subcaption`, `minted`. Keep tables within
  `\textwidth` (use `\small`/`\footnotesize` and `tabular*` or `longtable` if wide).
- Figures: prefer self-contained TikZ. Give every float a `\label{}` and reference it.
- Keep each section's depth high but tight; target page budgets in §6.

## 4. Citation key map (cite only these; more appended later)
Information flow / TE: `kraskov2004`, `frenzel2007`, `schreiber2000`,
`schreiber1996` (IAAFT), `marschinski2002` (effective TE).
Testing / community: `benjamini1995` (BH-FDR), `traag2019` (Leiden).
Connectedness: `diebold2012`, `diebold2014`, `barunik2018`.
Economics: `lo2004` (AMH), `grossman1980`.
Numerics: `lecuyer1999` (RNG), `lam2015numba` (Numba).
Programme papers: `bhandari2026econstellar` (arXiv:2606.05705),
`bhandari2026soch` (2606.04113), `bhandari2026contagion` (2604.26546),
`bhandari2025mcpfm` (2507.08065). Packages: `namhpkg`, `sochpkg`, `ccpkg`.
(The LiteratureAgent is adding verified Tier-2 references; if you want one, flag with
`\cite{NEEDS:...}`.)

## 5. Verified-Results table (the ONLY numbers you may state)
Engine: **26 methods**, live rev `shssm-compute-00036-llf` (re-verified 2026-06-15:
`/health` -> methods 26, sandbox `timeout`, timeout_s 90; prior machine-pinned 23/23
at `00032-c8q`); eval suite **26/26 pass**.
Cost bound: **400 LLM turns/instance/day x max-instances 2 = <=800 paid turns/day**.
Core governance: `CE_MAX_CORES = floor((cpus-2)/MAX_CONCURRENT)` = **10** on the
workstation (22 logical cores); BLAS pinned to 1.
GPU: RTX 3000 Ada Laptop GPU (CC 8.9, 8 GB / 8188 MiB, driver 580.159.04), CUDA 12.4,
numba 0.63.1. Bit-exact gate **<=7e-16** (6.7e-16 in the NAMH re-estimation).
Speedup **3.5x** (12 pairs, B=99: GPU 82 s ~1 core vs governed CPU 289 s ~7 cores);
isolated trial **73.76x** (n=3000); **32--74x** across n in {2000,3000,5000}.
Full-panel re-run (306 pairs, B=99): **35.6 min, one core, peak 388 MB, 106/306 sig**.
Data: `G20.xlsx` **18 markets, 2006-01-12 -> 2026-03-18**, 306 directed pairs;
`g20_24` 24 series; sha256-stamped.

| Method | Verified value | Notes / source |
|---|---|---|
| unit_root | India ADF -49.18; UK -52.64 | live re-probe -49.1796 |
| garch | persistence alpha+beta = 0.991 | GARCH(1,1) |
| dfa_hurst | India H = 0.542 | DFA |
| namh_hurst | Gold H = 0.490 (0.4899) | band [0.4889,0.4909]; via namh pkg |
| panel_unit_root | IPS -77.26, LLC -51.79 | tuple {India,USA,UK,China,Japan}; tuple-sensitive (Brazil 5th -> -80.16) |
| vecm | rank 3 (trace 7265.97->1851.19) | India/USA/UK |
| granger | 6 edges (USA out-deg 3) | India/USA/UK/China |
| wavelet | India d1 = 47.07% | MODWT variance |
| wavelet_coherence | USA/India mean 0.249, peak d6 (0.523) | scale-resolved sq. coherence |
| connectedness | TCI 30.25% (S 15.05 / M 11.56 / L 3.64) | DY12 + BK18 |
| spillover_rolling | mean TCI 28.39 (45 win, 10.5--46.3) | rolling DY |
| rolling_dcc | India--USA mean rho 0.23 (0.2295; 0.15--0.31) | DCC-GARCH |
| network | 6 nodes, 18 edges, density 0.60 (0.5667), 6 comms | igraph |
| quantile_var | USA top driver net +0.70 (+0.7006) | tau=0.05 |
| var_irf | max root 0.7053 (lag 7, stable) | VAR/IRF |
| wqte | USA->India tau.05 = 0.039 (0.0391) | MODWT+quantreg reimpl. |
| soch_profile | USA->India 4-scale agg 0.0391, peak d4 | published sochcontagion; paper 5-scale 0.0426 |
| ksg_te | USA->Japan TE **0.154234**; 306 pairs, 108 sig | KSG/Frenzel-Pompe; GPU==CPU 6.7e-16 |
| ksg_robustness | mean Spearman 0.7282 (min 0.581); USA->Japan #1 all 8 (k,lag) | k in {3,4,6,8} x lag {1,2} |
| namh_te | window-1 te_mean -0.223222 | bit-exact to cached (Delta 4.92e-9) |
| namh_reproduce | max\|Delta\| **1.55e-15** | Hurst 4.882e-9, TE 4.92e-9; FDR amber 0/552 |
| namh_pipeline | window mean **-0.22322165**, band [-0.2242,-0.2222]; FDR **0/552** degenerate | seed 42, L'Ecuyer-CMRG, B=200; job_20260612_0f2f0fd5 (1222 s) |
| channel_attribution | GFC trade **27.9%** [26.1,29.8], reproduced **0.000 pp**, 8 episodes | published contagionchannels |
| sri_daily | first 2026-03-18 SRI **0.00849** (306 pairs); 2026-06-05 SRI **0.00709** (272 pairs) | eval band [0.00848,0.00850] |
| soch_robustness | pass-rate **0.9911** (111/112); baseline tau=0.05/J=4 holds 28/28 | seed 42, B=200; job_20260612_fe0c4f06 |

Programme / elements (state honestly):
- SOCH: SOCH-A p=0.042; SOCH-B 28/28; **SOCH-C p=0.105 (NOT significant; immutable)**.
  Lean: **sorry-count 1/12**; `prop:spectrum` closed (`\Norm{H(\omega)}^2 = S(\omega)`).
- NAMH FRONTIERS Paper I (17 pp): 28 assets 2001->2026; **US broadcasts** (out-strength
  9/20 annual, 26/79 quarterly), **Japan receives** (in-strength 12/20, PageRank 10/20,
  Katz 8/20); honest exception: quarterly Katz Argentina 22 edges Japan 21; verify 44/44.
- contagion-channels: GFC trade 27.9%, reproduced 0.000 pp (arXiv:2604.26546).
- WaveQTE: 50.0%-vs-27.9% resolved as a method+partition divergence (not a bug); the
  packaged Stage-1 estimator is structurally unavailable in-image (engine `wqte` is an
  honest MODWT+quantreg reimplementation).
- commodity: Subprime most-fragmented, \|FC\| **0.290**, 5 communities (23 commodities,
  1991--2025).
- MCPFM (arXiv:2507.08065): v1 AUC **0.581** (DeLong p=0.030) / 0.915 (US/COVID); a
  pre-registered v2 re-evaluation returns AUC **0.470** (Hansen SPA p=0.031) and is
  reported openly. Reproduce status: honest-pending.

## 6. Section assignments and page budgets
- 01 Introduction (Writer A) ~3.5 pp · 07 Elements (A) ~4.5 pp · 10 Outlook (A) ~2.5 pp
- 02 Architecture (Writer B) ~5 pp · 08 Deployment & ops (B) ~3 pp
- 03 Substrate & methods (Writer C) ~6 pp
- 04 Heterogeneous compute (Writer D) ~4 pp · 05 AI layer (D) ~3 pp
- 06 Verification & epistemics (Writer E) ~5 pp · 09 Worked examples (E) ~3 pp
Appendices (A registry, B API, C learnings, D results) are authored at integration.

## 7. Load-bearing facts every writer must respect
1. **The parameterised-only registry is the primary RCE guard, not the sandbox.**
   Cloud Run runs `sandbox:"timeout"` (no bwrap in the image; gVisor is the kernel
   boundary); bwrap (`--unshare-net`, `--ro-bind / /`) is the local/workstation path.
2. **Three planes:** kernel (`compute-server.mjs`, scale-to-zero Cloud Run), tower
   (`job-server.mjs`, always-on workstation, the 4 heavy async methods), surfaces
   (static GitHub Pages rendering `evals.json`).
3. **One governed core budget** + BLAS pinning fixed the 22-core hang; worker count
   never changes a number (order-free loops).
4. **GPU offload is bit-exact** to the CPU estimator on the only gated quantity
   (observed TE); the p-value is an unseeded draw in both paths and is never claimed
   reproducible.
5. **The self-learning loop:** evals (real compute, pre-registered failable bands,
   never hand-edited) -> state-refresh (machine MEASURED + DRIFT) -> claims-refresh
   (never deletes; reds become contested pairs) -> verbatim report + gallery ->
   gap-proposals (pre-registered, PI-gated, never auto-deploys). Its own wiring is a
   failable eval.
6. **A method is not in the catalogue until it ships with a failable test of its own
   output.** Holes are marked, never filled.

When in doubt: cite the mechanism, state the verified number, keep the voice measured.
