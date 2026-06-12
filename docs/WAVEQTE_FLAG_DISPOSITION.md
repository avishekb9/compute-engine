# WaveQTE GFC-channel flag — written disposition (V4 M4, 2026-06-12)

**The flag (open since 2026-06-09, chronology #41):** the `papers/waveqte/`
manuscript reports the **Financial** channel dominant in the GFC at **50.0%**,
while the engine's verified ground truth (published `contagionchannels`
package, Table 5 reproduced live to 0.000pp) gives **Trade** dominant at
**27.9%**. Flagged as "proxy-vintage — unresolved".

## Investigation (documents read side-by-side)

| | `waveqte/contagion_manuscript.pdf` | arXiv:2604.26546 (`paper3_v2/arxiv_submission/main.tex`) |
|---|---|---|
| Vintage | working paper, file date **2026-02-19** | **submitted April 2026** (newer), 3 authors (Bhandari, Parida & Sahu) |
| Stage-2 method | **multi-proxy activation scoring** — how active each channel's proxies are during the episode relative to their full-sample distribution (descriptive intensity) | **structural channel attribution** — `C_ij,t = α + Σ θ_c Channel_c,t + γ1 f_t + γ2 C_ij,t−1 + ε`, primary identification **IV/2SLS**, with local-projections and heteroskedasticity-based identification as cross-checks; bootstrap CIs |
| Partition | **7 episodes**, 2005–2023; GFC "2007–09"; 18 network configs (6 scales × 3 quantiles) per episode | **8 non-overlapping sub-periods** from Jan 2006; **GFC\* = 1 Aug 2007–30 Jun 2009**; baseline-calibrated link threshold applied identically across sub-periods |
| GFC result | Financial **50.0%** dominant | **Trade 27.9% [26.1, 29.8]** dominant under primary IV |
| Crucial self-disclosure | activation score loads on VIX / HY-OAS / financial-stress indicators — mechanically Financial-heavy in a financial crisis; "cross-pair variation … arises solely through the Trade channel" (4 of 5 channels are common factors) | the paper ITSELF reports the GFC dominant channel is **method-dependent**: "assigns mass to trade, geopolitical, and behavioural channels under different identification strategies"; only 2 of 8 episodes are dominant-robust across all three identifications |

A third vintage exists: the older `manuscripts/paper3.pdf` draft shows GFC
**Behavioral 29%** dominant — consistent with the arXiv paper's note that
heteroskedasticity-based identification produces the behavioural assignment.

## Root cause — NOT proxy vintage

The two numbers are **different estimands from different methods on different
partitions across paper generations**:

1. **Different estimand**: proxy-activation *intensity* (descriptive) vs
   structural contagion-share under IV identification (causal). They would not
   coincide even on identical data and windows.
2. **Different method**: activation scoring vs IV/2SLS structural regression
   (+ two alternative identifications).
3. **Different partition**: 7 episodes vs 8 sub-periods (GFC window differs).
4. **The label sensitivity is real and DOCUMENTED on both sides**: the arXiv
   paper discloses method-dependence of the GFC dominant channel, and the
   engine's own Phase-31 robustness grid independently measured exactly this —
   GFC **Trade share rock-stable (25.7–28.7pp)** across all 27 configs while
   the dominant-channel **label is knife-edge** (chronology #47, badge row).

## Chosen canonical (with reasons; PI may supersede with documented reason)

**arXiv:2604.26546 — GFC\* Trade 27.9% [26.1, 29.8] dominant under primary
IV/2SLS, read together with its own method-dependence disclosure.** Reasons:

- It is the **newer, submitted, 3-author record** (Apr 2026 > Feb 2026 WP).
- It is what the **published CRAN package implements** — the engine reproduces
  its Table 5 to **0.000pp** through the paper's own code.
- It carries **inferential machinery** (identification strategy, bootstrap CIs)
  and honestly discloses where the label is fragile.
- The engine's independent robustness badge **corroborates** the stable-share /
  fragile-label reading.

The manuscript's Financial-GFC 50.0% is **reclassified, not refuted**: a
different estimand (activation intensity) from the superseded working-paper
generation. It is not an engine target and is not comparable 1:1 with 27.9%.
Nothing is averaged or blended.

## Actions taken

- Claim layer (seed, pre-provision): `waveqte_gfc_channel_split` →
  **superseded**, with a new established claim
  `waveqte_gfc_split_resolved` carrying this disposition + provenance.
- Element map (ivy-fineco ARCHITECTURE.md §C7): WaveQTE row flag → resolved
  with pointer here.
- The reproduce-page WaveQTE estimator hole is UNCHANGED (structurally
  unavailable — that hole is about Stage-1, not this flag).
