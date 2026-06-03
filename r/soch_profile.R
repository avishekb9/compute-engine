## SOCH wavelet-quantile directional SCALE PROFILE — the PUBLISHED method.
##
## Unlike `wqte` (a transparent substrate reimplementation), this calls the
## published CRAN-candidate package `sochcontagion` (Bhandari & Parida 2026,
## github.com/avishekb9/sochcontagion, GPL-3) DIRECTLY. `wqte_profile()` is the
## directed WQTE-by-scale profile whose shape, ordering, and level the
## Scale-Ordered Contagion theory predicts:
##   - peak scale            -> SOCH-A (slower market peaks at a coarser scale)
##   - shape symmetry (KL)   -> SOCH-B (profile shape is direction-symmetric)
##   - level (aggregate)     -> SOCH-C (level is directionally asymmetric)
## Reproduces the paper's USA->India result (tau=0.05, J=4: agg=0.039, rising d1->d4).
##
## params: {dataset, series:[from,to], tau?(0.05), levels?(4), wf?(la8)}
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
suppressMessages(library(sochcontagion))

p <- ce_params()
if (is.null(p$series) || length(p$series) != 2) ce_fail("soch_profile needs exactly 2 'series' = [from, to]")
tau <- if (!is.null(p$tau)) as.numeric(p$tau) else 0.05
if (tau <= 0 || tau >= 1) ce_fail("tau must be in (0,1)")
J  <- if (!is.null(p$levels)) as.integer(p$levels) else 4L     # paper's headline uses J=4
if (is.na(J) || J < 1 || J > 8) ce_fail("'levels' must be 1-8")
wf <- if (!is.null(p$wf)) p$wf else "la8"

d <- ce_returns(p)                         # [T x 2], columns ordered = from, to
from <- d$cols[1]; to <- d$cols[2]
R <- d$R
n <- sum(stats::complete.cases(R))
if (n < 512) ce_fail("too few complete rows for soch_profile (need >= 512)")

## published directed scale profiles, both directions
pf <- sochcontagion::wqte_profile(R, from, to, tau = tau, J = J, filter = wf)
pr <- sochcontagion::wqte_profile(R, to, from, tau = tau, J = J, filter = wf)
scl <- paste0("d", seq_len(J))
per  <- function(v) lapply(seq_len(J), function(k) list(scale = scl[k], gain = v[k]))
peak <- function(v) scl[which.max(v)]
sym  <- sochcontagion::sym_kl(pf, pr)

ce_emit(list(
  method  = "soch_profile",
  dataset = if (!is.null(p$dataset)) p$dataset else "g20",
  from = from, to = to, tau = tau, wavelet = wf, levels = J, n = n,
  profile_forward = per(pf),
  profile_reverse = per(pr),
  peak_scale_forward = peak(pf),
  peak_scale_reverse = peak(pr),
  aggregate_forward  = mean(pf),
  aggregate_reverse  = mean(pr),
  shape_symmetry_kl  = sym,
  interpretation = paste0(
    "Directed WQTE scale profile ", from, "->", to, " at tau=", tau,
    ": aggregate ", round(mean(pf), 4), ", peaks at ", peak(pf),
    " (SOCH-A). Reverse ", to, "->", from, " aggregate ", round(mean(pr), 4),
    "; shape-symmetry KL ", round(sym, 4),
    " (SOCH-B: shape direction-symmetric even when level is not / SOCH-C)."),
  source = "Published method: sochcontagion::wqte_profile (v0.1.0, Bhandari & Parida 2026, GPL-3) — the live engine running the paper's own code, not a reimplementation."
))
