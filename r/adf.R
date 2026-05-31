## Unit-root tests (ADF via urca + KPSS via tseries) on a chosen return series.
## EViews "Unit Root Test" equivalent. params: {dataset, series:[one], lags?, type?}
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
suppressMessages({ library(urca); library(tseries) })

p <- ce_params()
if (is.null(p$series) || length(p$series) != 1) ce_fail("adf needs exactly one 'series'")
d <- ce_returns(p)
x <- as.numeric(d$R[, 1]); x <- x[is.finite(x)]
if (length(x) < 30) ce_fail("series too short after cleaning")

lags <- if (!is.null(p$lags)) as.integer(p$lags) else NULL
adf <- if (is.null(lags)) {
  ur.df(x, type = "drift", selectlags = "AIC")
} else {
  ur.df(x, type = "drift", lags = lags)
}
st <- adf@teststat[1]
cv <- adf@cval[1, ]
kpss <- suppressWarnings(tseries::kpss.test(x, null = "Level"))

ce_emit(list(
  method = "unit_root",
  dataset = if (!is.null(p$dataset)) p$dataset else "g20",
  series = d$cols[1],
  n = length(x),
  adf = list(statistic = unname(st),
             crit = list(`1pct` = unname(cv["1pct"]), `5pct` = unname(cv["5pct"]), `10pct` = unname(cv["10pct"])),
             reject_unit_root_5pct = unname(st) < unname(cv["5pct"]),
             lags = if (is.null(lags)) "AIC-selected" else lags),
  kpss = list(statistic = unname(kpss$statistic), p_value = kpss$p.value,
              stationary_5pct = kpss$p.value > 0.05),
  interpretation = ifelse(unname(st) < unname(cv["5pct"]),
                          "ADF rejects unit root at 5% -> stationary",
                          "ADF fails to reject unit root at 5%")
))
