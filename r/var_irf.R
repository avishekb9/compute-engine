## VAR estimation + impulse responses (vars). EViews/RATS "VAR" equivalent.
## params: {dataset, series:[2-6], p?(lag), irf_h?(horizon)}
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
suppressMessages(library(vars))

p <- ce_params()
if (is.null(p$series) || length(p$series) < 2 || length(p$series) > 6)
  ce_fail("var needs 2-6 'series'")
d <- ce_returns(p)
Y <- d$R[stats::complete.cases(d$R), , drop = FALSE]
if (nrow(Y) < 100) ce_fail("too few complete rows for VAR")

lag <- if (!is.null(p$p)) as.integer(p$p) else VARselect(Y, lag.max = 8, type = "const")$selection[["AIC(n)"]]
fit <- VAR(Y, p = lag, type = "const")
h <- if (!is.null(p$irf_h)) as.integer(p$irf_h) else 10

## IRF of each var to a shock in the first series
ir <- irf(fit, impulse = d$cols[1], response = d$cols, n.ahead = h, boot = FALSE)
irf_mat <- ir$irf[[d$cols[1]]]   # (h+1) x k

## per-equation adj R^2
r2 <- sapply(summary(fit)$varresult, function(e) e$adj.r.squared)

ce_emit(list(
  method = "var_irf",
  dataset = if (!is.null(p$dataset)) p$dataset else "g20",
  series = d$cols, n = nrow(Y), lag_order = lag, irf_horizon = h,
  adj_r2 = as.list(setNames(as.numeric(r2), d$cols)),
  stable = all(roots(fit) < 1),
  max_root = max(roots(fit)),
  irf_shock = d$cols[1],
  irf = lapply(seq_len(ncol(irf_mat)), function(j)
          list(response = d$cols[j], values = as.numeric(irf_mat[, j])))
))
