#!/usr/bin/env Rscript
# live_adf.R — ADF + KPSS stationarity on a LIVE price series, comparing
# price LEVELS against LOG-RETURNS.
#
# Network model: this script is network-isolated (runs in the sandbox). The
# trusted Node orchestrator fetches the price series from a public source and
# injects it as `levels`. This script only computes — it never reaches the net.
#
# Economics: equity price LEVELS are I(1) (a unit root / random walk with drift)
# and are NOT stationary. LOG-RETURNS = diff(log(price)) are typically I(0)
# (stationary). Testing a price level and calling it "the market" is the classic
# error this method is designed to expose.
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
suppressMessages({ library(urca); library(tseries) })

P  <- ce_params()
lv <- as.numeric(P$levels)
lv <- lv[is.finite(lv)]
if (length(lv) < 50) ce_fail("not enough observations (need >= 50 prices)")

transform <- if (!is.null(P$transform)) P$transform else "both"

run_tests <- function(x, adf_type) {
  x <- x[is.finite(x)]
  # Schwert (1989) upper bound for the augmentation lag, then AIC within it.
  # NB: urca::ur.df defaults to a max of lags=1 with selectlags, which badly
  # under-augments and can yield a spurious near-zero ADF on returns with
  # holiday-induced repeats. Setting an explicit Schwert max fixes this.
  pmax <- max(1L, floor(12 * (length(x) / 100)^0.25))
  adf <- ur.df(x, type = adf_type, lags = pmax, selectlags = "AIC")
  adf_stat  <- as.numeric(adf@teststat[1])
  adf_crit5 <- as.numeric(adf@cval[1, "5pct"])
  null_kind <- if (adf_type == "trend") "Trend" else "Level"
  kp <- suppressWarnings(kpss.test(x, null = null_kind))
  kpss_stat <- as.numeric(kp$statistic)
  kpss_p    <- as.numeric(kp$p.value)
  adf_reject <- adf_stat < adf_crit5            # reject unit root => stationary
  verdict <- if (adf_reject && kpss_p > 0.05) {
    "stationary"
  } else if (!adf_reject && kpss_p <= 0.05) {
    "non-stationary"
  } else {
    "mixed"
  }
  list(
    adf_stat             = unbox(round(adf_stat, 4)),
    adf_crit_5pct        = unbox(round(adf_crit5, 4)),
    adf_spec             = unbox(adf_type),
    adf_reject_unit_root = unbox(adf_reject),
    kpss_stat            = unbox(round(kpss_stat, 4)),
    kpss_null            = unbox(null_kind),
    kpss_pvalue          = unbox(round(kpss_p, 4)),
    verdict              = unbox(verdict)
  )
}

out <- list(
  method      = unbox("live_unit_root"),
  symbol      = unbox(if (!is.null(P$symbol)) P$symbol else "?"),
  source      = unbox(if (!is.null(P$source)) P$source else "?"),
  n_obs       = unbox(length(lv)),
  price_first = unbox(round(lv[1], 4)),
  price_last  = unbox(round(lv[length(lv)], 4))
)

# price levels trend => use the trend specification for a fair test
if (transform %in% c("levels", "both")) {
  out$levels <- run_tests(lv, "trend")
}
# log-returns: drift specification (no deterministic trend expected)
if (transform %in% c("returns", "both")) {
  if (any(lv <= 0)) ce_fail("non-positive prices: cannot take log-returns")
  rets <- diff(log(lv))
  out$returns <- run_tests(rets, "drift")
}

out$note <- unbox(paste(
  "Equity price LEVELS are I(1) (unit root) and non-stationary;",
  "LOG-RETURNS are typically stationary. Model returns, not price levels."
))

ce_emit(out)
