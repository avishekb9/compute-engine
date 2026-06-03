## Cross-wavelet coherence between two return series, by MODWT scale.
## Transparent realisation from substrate primitives (waveslim MODWT + Pearson
## correlation of the brick-walled detail coefficients): per scale j the squared
## coherence is cor(d_x[j], d_y[j])^2 in [0,1]; the signed correlation gives the
## co-movement direction. This is a discrete scale-resolved coherence, NOT the
## Morlet continuous-wavelet time-frequency WTC (labelled honestly).
## params: {dataset, series:[exactly 2], wf?(la8), levels?}
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
suppressMessages(library(waveslim))

p <- ce_params()
if (is.null(p$series) || length(p$series) != 2) ce_fail("wavelet_coherence needs exactly 2 'series'")
wf <- if (!is.null(p$wf)) p$wf else "la8"
d <- ce_returns(p)
M <- d$R[stats::complete.cases(d$R), , drop = FALSE]
if (nrow(M) < 256) ce_fail("too few complete rows for wavelet_coherence (need >= 256)")
x <- M[, 1]; y <- M[, 2]; n <- length(x)
J <- if (!is.null(p$levels)) as.integer(p$levels) else min(6L, floor(log2(n)) - 2L)
J <- max(1L, min(J, floor(log2(n)) - 2L))

wx <- brick.wall(modwt(x, wf, J), wf)
wy <- brick.wall(modwt(y, wf, J), wf)
scl <- grep("^d", names(wx), value = TRUE)[seq_len(J)]
horizon <- vapply(seq_len(J), function(k) sprintf("d%d: %d-%d days", k, 2^k, 2^(k+1)), character(1))

per <- lapply(seq_len(J), function(k) {
  a <- wx[[scl[k]]]; b <- wy[[scl[k]]]
  ok <- is.finite(a) & is.finite(b)
  if (sum(ok) < 50) return(list(scale = scl[k], coherence = NA_real_, correlation = NA_real_))
  r <- suppressWarnings(stats::cor(a[ok], b[ok]))
  list(scale = scl[k], coherence = r^2, correlation = r)
})
coh <- vapply(per, function(z) z$coherence, numeric(1))
agg <- mean(coh, na.rm = TRUE)
kstar <- scl[which.max(replace(coh, is.na(coh), -Inf))]

ce_emit(list(
  method = "wavelet_coherence",
  dataset = if (!is.null(p$dataset)) p$dataset else "g20",
  series = d$cols, wavelet = wf, levels = J, n = n,
  per_scale = per,
  horizons = horizon,
  aggregate_coherence = agg,
  peak_scale = kstar,
  interpretation = sprintf(
    "MODWT squared coherence between %s and %s peaks at %s (%.3f); mean across scales %.3f. Higher at coarser scales means co-movement is stronger over longer horizons.",
    d$cols[1], d$cols[2], kstar, max(coh, na.rm = TRUE), agg),
  note = "Scale-resolved squared coherence from substrate primitives (waveslim MODWT + correlation); not the Morlet CWT time-frequency coherence."
))
