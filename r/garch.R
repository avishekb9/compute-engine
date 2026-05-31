## GARCH(1,1) volatility model (tseries::garch). EViews/OxMetrics "GARCH".
## params: {dataset, series:[one], p?(garch order, default 1), q?(arch order, default 1)}
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
suppressMessages(library(tseries))

p <- ce_params()
if (is.null(p$series) || length(p$series) != 1) ce_fail("garch needs exactly one 'series'")
d <- ce_returns(p)
x <- as.numeric(d$R[, 1]); x <- x[is.finite(x)]
if (length(x) < 100) ce_fail("series too short for GARCH")

gp <- if (!is.null(p$p)) as.integer(p$p) else 1L   # GARCH order
gq <- if (!is.null(p$q)) as.integer(p$q) else 1L   # ARCH order
fit <- suppressWarnings(garch(x, order = c(gp, gq), trace = FALSE))
co <- coef(fit)
## persistence = sum of arch + garch coefficients (a1.. + b1..)
arch_garch <- co[grepl("^a[1-9]|^b[1-9]", names(co))]
persistence <- sum(arch_garch)
ll <- as.numeric(logLik(fit))
## conditional vol series summary (last value = current vol estimate)
cv <- fit$fitted.values[, 1]
cv <- cv[is.finite(cv)]

ce_emit(list(
  method = "garch",
  dataset = if (!is.null(p$dataset)) p$dataset else "g20",
  series = d$cols[1], n = length(x),
  order = list(garch = gp, arch = gq),
  coefficients = as.list(setNames(as.numeric(co), names(co))),
  persistence = persistence,
  high_persistence = persistence > 0.9,
  log_likelihood = ll,
  current_cond_vol = if (length(cv)) cv[length(cv)] else NULL,
  mean_cond_vol = if (length(cv)) mean(cv) else NULL,
  interpretation = paste0("Volatility persistence (alpha+beta) = ", round(persistence, 4),
    if (persistence > 0.97) " — very high (shocks decay slowly)"
    else if (persistence > 0.9) " — high (typical for financial returns)"
    else " — moderate")
))
