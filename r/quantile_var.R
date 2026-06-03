## Quantile Vector Autoregression (QVAR): equation-by-equation quantile regression
## of each series on lag 1..p of all series, at a tail quantile tau (quantreg::rq).
## Returns the lag-1 coefficient matrix A1(tau) -- directed tail dependence at the
## chosen quantile -- plus per-market directional tail influence (column/row sums
## of |A1| off-diagonal). At tau=0.5 this is the median (LAD) VAR.
## params: {dataset, series:[2-6], tau?(0.05), p?(lag, default 1)}
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
suppressMessages(library(quantreg))

p <- ce_params()
if (is.null(p$series) || length(p$series) < 2 || length(p$series) > 6)
  ce_fail("quantile_var needs 2-6 'series'")
tau <- if (!is.null(p$tau)) as.numeric(p$tau) else 0.05
if (tau <= 0 || tau >= 1) ce_fail("tau must be in (0,1)")
lag <- if (!is.null(p$p)) max(1L, min(4L, as.integer(p$p))) else 1L
d <- ce_returns(p)
Y <- d$R[stats::complete.cases(d$R), , drop = FALSE]
nm <- d$cols; k <- ncol(Y); n <- nrow(Y)
if (n < 200) ce_fail("too few complete rows for quantile_var (need >= 200)")

resp <- Y[(lag + 1L):n, , drop = FALSE]
Xlags <- do.call(cbind, lapply(seq_len(lag), function(L) Y[(lag + 1L - L):(n - L), , drop = FALSE]))
## lag-1 block is the first k columns of Xlags
A1 <- matrix(NA_real_, k, k, dimnames = list(nm, nm))
for (i in seq_len(k)) {
  fit <- tryCatch(suppressWarnings(quantreg::rq(resp[, i] ~ Xlags, tau = tau)),
                  error = function(e) NULL)
  if (!is.null(fit)) A1[i, ] <- as.numeric(stats::coef(fit))[2:(k + 1L)]   # drop intercept; lag-1 block
}
offdiag <- A1; diag(offdiag) <- 0
to_inf   <- colSums(abs(offdiag), na.rm = TRUE)   # market j -> others (driver)
from_inf <- rowSums(abs(offdiag), na.rm = TRUE)   # others -> market i (receiver)

ce_emit(list(
  method = "quantile_var",
  dataset = if (!is.null(p$dataset)) p$dataset else "g20",
  series = nm, n = n, tau = tau, lag = lag, var_lag = lag,
  coef_matrix_lag1 = lapply(seq_len(k), function(i)
    list(equation = nm[i], on = lapply(seq_len(k), function(j) list(from = nm[j], coef = A1[i, j])))),
  directional = lapply(seq_len(k), function(i)
    list(market = nm[i], drives = round(to_inf[i], 4), driven_by = round(from_inf[i], 4),
         net = round(to_inf[i] - from_inf[i], 4))),
  interpretation = sprintf(
    "Quantile VAR at tau=%.2f (lag %d) across %d markets: A1[i,j] is market j's lag-1 effect on market i's tau-quantile. Largest tail driver: %s; largest receiver: %s.",
    tau, lag, k, nm[which.max(to_inf)], nm[which.max(from_inf)])
))
