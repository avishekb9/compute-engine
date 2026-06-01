## Diebold-Yilmaz (2012/2014) connectedness + Barunik-Krehlik (2018) frequency
## decomposition, via the `frequencyConnectedness` package on a VAR/GFEVD.
## Returns the total connectedness index (TCI), directional TO/FROM/NET per
## market, and the frequency band split (short/medium/long). This is the
## connectedness primitive underlying the contagion frameworks.
## params: {dataset, series:[2-8], p?(VAR lag, default 4), H?(GFEVD horizon, default 10)}
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
suppressMessages({ library(vars); library(frequencyConnectedness) })

p <- ce_params()
if (is.null(p$series) || length(p$series) < 2 || length(p$series) > 8)
  ce_fail("connectedness needs 2-8 'series'")
d <- ce_returns(p)
Y <- d$R[stats::complete.cases(d$R), , drop = FALSE]
if (nrow(Y) < 100) ce_fail("too few complete rows for connectedness")
nm <- d$cols
lag <- if (!is.null(p$p)) max(1L, as.integer(p$p)) else 4L
H   <- if (!is.null(p$H)) max(5L, as.integer(p$H)) else 10L

fit <- vars::VAR(Y, p = lag, type = "const")
## time-domain Diebold-Yilmaz spillover table from the generalised FEVD
sp <- frequencyConnectedness::spilloverDY12(fit, n.ahead = H, no.corr = FALSE)
tci <- as.numeric(frequencyConnectedness::overall(sp)[[1]])
to_   <- as.numeric(frequencyConnectedness::to(sp)[[1]])
from_ <- as.numeric(frequencyConnectedness::from(sp)[[1]])
net_  <- as.numeric(frequencyConnectedness::net(sp)[[1]])

## Barunik-Krehlik frequency bands: short (<=5d), medium (5-20d), long (>20d).
## Frequency for a period of P days is omega = 2*pi/P, so the cut points are
## 2*pi/5 and 2*pi/20; the top bound must be strictly > pi (package requirement),
## and the frequency grid needs a fine n.ahead (>=100) or getPartition rejects it.
bounds <- c(pi + 1e-5, 2*pi/5, 2*pi/20, 0)
bk_h   <- max(100L, H)
freq_total <- tryCatch({
  bk <- frequencyConnectedness::spilloverBK12(fit, n.ahead = bk_h, no.corr = FALSE,
                                              partition = bounds)
  as.numeric(unlist(frequencyConnectedness::overall(bk)))   # one TCI per band
}, error = function(e) rep(NA_real_, 3))

ce_emit(list(
  method = "connectedness",
  dataset = if (!is.null(p$dataset)) p$dataset else "g20",
  series = nm, n = nrow(Y), var_lag = lag, horizon = H,
  total_connectedness = round(tci, 3),
  directional = lapply(seq_along(nm), function(i)
    list(market = nm[i], to = round(to_[i],3), from = round(from_[i],3), net = round(net_[i],3))),
  frequency_bands = list(
    short_1_5d   = round(as.numeric(freq_total[1]), 3),
    medium_5_20d = round(as.numeric(freq_total[2]), 3),
    long_gt20d   = round(as.numeric(freq_total[3]), 3)),
  interpretation = sprintf("Diebold-Yilmaz total connectedness = %.1f%% of forecast-error variance is cross-market; Barunik-Krehlik splits it across frequency bands.", tci)
))
