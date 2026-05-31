## Wavelet variance decomposition (MODWT, waveslim). Core multi-scale primitive
## (NAMH/MCPFM/contagion-channels Stage 1). Shows how a series' variance is
## distributed across time scales (d1≈2-4d, d2≈4-8d, …). params:
## {dataset, series:[one], wf?(default "la8"), levels?(default 5)}
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
suppressMessages(library(waveslim))

p <- ce_params()
if (is.null(p$series) || length(p$series) != 1) ce_fail("wavelet needs exactly one 'series'")
d <- ce_returns(p)
x <- as.numeric(d$R[, 1]); x <- x[is.finite(x)]
n <- length(x)
if (n < 256) ce_fail("series too short for wavelet decomposition")

wf <- if (!is.null(p$wf)) p$wf else "la8"
J <- if (!is.null(p$levels)) as.integer(p$levels) else 5L
J <- min(J, floor(log2(n)) - 2L)
w <- modwt(x, wf = wf, n.levels = J, boundary = "periodic")

## variance per scale (drop boundary-affected coeffs via brick.wall)
wb <- brick.wall(w, wf)
vars <- sapply(wb, function(co) { co <- co[is.finite(co)]; if (length(co)) sum(co^2) / length(co) else 0 })
total <- sum(vars)
scale_days <- function(j) sprintf("~%d-%d days", 2^j, 2^(j + 1))
detail <- names(vars)
labels <- sapply(detail, function(nm) {
  if (grepl("^d", nm)) scale_days(as.integer(sub("d", "", nm))) else "smooth (low-freq trend)"
})

ce_emit(list(
  method = "wavelet",
  dataset = if (!is.null(p$dataset)) p$dataset else "g20",
  series = d$cols[1], n = n, wavelet = wf, levels = J,
  scales = lapply(seq_along(vars), function(i) list(
    scale = detail[i], horizon = unname(labels[i]),
    variance = unname(vars[i]),
    pct_of_total = if (total > 0) round(100 * vars[i] / total, 2) else 0
  )),
  interpretation = {
    di <- which(grepl("^d", detail)); if (length(di)) {
      top <- detail[di][which.max(vars[di])]
      paste0("Most return variance sits at scale ", top, " (", labels[[top]], ").")
    } else "smooth component dominates"
  }
))
