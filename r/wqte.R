## Wavelet-Quantile directional dependence (QTE-style), the contagion-channels /
## WaveQTE Stage-1 *primitive* reimplemented transparently from substrate parts
## (MODWT via waveslim + quantile regression via quantreg) — because the packaged
## WaveQTE/contagionchannels do not load in this R install. It measures, at a
## chosen tail quantile, how much X's past improves prediction of Y's quantile
## beyond Y's own past, per wavelet scale (directional, X->Y).
##
## NOTE: this is a clear, correct quantile-on-wavelet directional measure, not a
## bit-exact reproduction of the published WaveQTE estimator. Labelled honestly.
## params: {dataset, series:[exactly 2 = from,to], tau?(default 0.05), wf?, levels?}
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
suppressMessages({ library(waveslim); library(quantreg) })

p <- ce_params()
if (is.null(p$series) || length(p$series) != 2) ce_fail("wqte needs exactly 2 'series' = [from, to]")
tau <- if (!is.null(p$tau)) as.numeric(p$tau) else 0.05
if (tau <= 0 || tau >= 1) ce_fail("tau must be in (0,1)")
wf <- if (!is.null(p$wf)) p$wf else "la8"

d <- ce_returns(p)
M <- d$R[stats::complete.cases(d$R), , drop = FALSE]
if (nrow(M) < 512) ce_fail("too few complete rows for WQTE")
xf <- M[, 1]; yt <- M[, 2]   # from -> to
n <- length(xf)
J <- if (!is.null(p$levels)) as.integer(p$levels) else 4L
J <- min(J, floor(log2(n)) - 2L)

wx <- brick.wall(modwt(xf, wf, J), wf)
wy <- brick.wall(modwt(yt, wf, J), wf)

## quantile pseudo-R1 (Koenker-Machado): 1 - V(full)/V(restricted), at scale j,
## directional from X to Y: does lag-1 X coeff add to predicting Y's tau-quantile?
qte_scale <- function(cy, cx) {
  m <- length(cy); idx <- 2:m
  Y <- cy[idx]; Ylag <- cy[idx - 1]; Xlag <- cx[idx - 1]
  ok <- is.finite(Y) & is.finite(Ylag) & is.finite(Xlag)
  Y <- Y[ok]; Ylag <- Ylag[ok]; Xlag <- Xlag[ok]
  if (length(Y) < 50) return(NA_real_)
  rho <- function(u) sum(u * (tau - (u < 0)))
  f_full <- suppressWarnings(rq(Y ~ Ylag + Xlag, tau = tau))
  f_rest <- suppressWarnings(rq(Y ~ Ylag, tau = tau))
  V1 <- rho(residuals(f_full)); V0 <- rho(residuals(f_rest))
  if (V0 <= 0) return(0)
  max(0, 1 - V1 / V0)   # >=0 directional info gain
}

dscales <- grep("^d", names(wx), value = TRUE)
per <- lapply(dscales, function(s) list(scale = s, qte = qte_scale(wy[[s]], wx[[s]])))
vals <- sapply(per, function(z) z$qte)
agg <- mean(vals, na.rm = TRUE)

ce_emit(list(
  method = "wqte",
  dataset = if (!is.null(p$dataset)) p$dataset else "g20",
  from = d$cols[1], to = d$cols[2], tau = tau, wavelet = wf, levels = J, n = n,
  per_scale = per,
  aggregate_qte = agg,
  interpretation = paste0("Mean wavelet-quantile directional gain ", d$cols[1], " -> ",
    d$cols[2], " at tau=", tau, " is ", round(agg, 4),
    ifelse(agg > 0.02, " (notable tail spillover)", " (weak)")),
  note = "Quantile-on-wavelet directional measure from substrate primitives (waveslim+quantreg); not the bit-exact packaged WaveQTE estimator."
))
