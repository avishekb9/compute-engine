## Vector Error Correction Model — Johansen cointegration test (urca::ca.jo).
## Returns the trace-test rank decision + eigenvalues. Note: G20 series are
## LOG RETURNS (already ~I(0)); cointegration is normally run on price LEVELS, so
## the result is reported honestly as "on the supplied series" and the typical
## outcome (no cointegration among stationary returns) is itself informative.
## params: {dataset, series:[2-6], K?(lag, default 2), ecdet?("none"|"const"|"trend")}
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
suppressMessages(library(urca))

p <- ce_params()
if (is.null(p$series) || length(p$series) < 2 || length(p$series) > 6)
  ce_fail("vecm needs 2-6 'series'")
d <- ce_returns(p)
Y <- d$R[stats::complete.cases(d$R), , drop = FALSE]
if (nrow(Y) < 100) ce_fail("too few complete rows for VECM")

K <- if (!is.null(p$K)) max(2L, as.integer(p$K)) else 2L
ecdet <- if (!is.null(p$ecdet) && p$ecdet %in% c("none","const","trend")) p$ecdet else "const"

jo <- urca::ca.jo(Y, type = "trace", ecdet = ecdet, K = K, spec = "longrun")
teststat <- as.numeric(jo@teststat)                 # length k, descending r = k-1 .. 0
cv5 <- as.numeric(jo@cval[, "5pct"])                 # matching critical values
k <- ncol(Y)
## rank r = number of hypotheses r<=i rejected (teststat > cv) reading from r=0 up.
## ca.jo orders rows r<=k-1 first; reverse to read r=0,1,...
ts_asc <- rev(teststat); cv_asc <- rev(cv5)
rank <- 0L
for (i in seq_along(ts_asc)) { if (ts_asc[i] > cv_asc[i]) rank <- i else break }

ce_emit(list(
  method = "vecm",
  dataset = if (!is.null(p$dataset)) p$dataset else "g20",
  series = d$cols, n = nrow(Y), K = K, ecdet = ecdet,
  test = "Johansen trace",
  rank = rank,
  n_series = k,
  eigenvalues = as.numeric(jo@lambda),
  trace_stat = rev(ts_asc),            # r=0,1,...,k-1
  crit_5pct  = rev(cv_asc),
  interpretation = if (rank == 0)
      "No cointegrating relationship at 5% (expected for stationary return series)."
    else sprintf("%d cointegrating relationship(s) at 5%% trace test.", rank)
))
