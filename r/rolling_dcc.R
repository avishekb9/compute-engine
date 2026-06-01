## Dynamic Conditional Correlation (Engle 2002) via rmgarch DCC-GARCH(1,1).
## Fits a multivariate DCC model and returns the time-varying pairwise
## correlation path summary (mean / last / range per pair). For 2-4 series.
## params: {dataset, series:[2-4]}
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
suppressMessages({ library(rmgarch); library(rugarch) })

p <- ce_params()
if (is.null(p$series) || length(p$series) < 2 || length(p$series) > 4)
  ce_fail("rolling_dcc needs 2-4 'series'")
d <- ce_returns(p)
Y <- d$R[stats::complete.cases(d$R), , drop = FALSE]
if (nrow(Y) < 200) ce_fail("too few complete rows for DCC-GARCH")
nm <- d$cols; k <- length(nm)

uspec <- rugarch::multispec(replicate(k,
  rugarch::ugarchspec(variance.model = list(model="sGARCH", garchOrder=c(1,1)),
                      mean.model = list(armaOrder=c(0,0), include.mean=TRUE),
                      distribution.model = "norm")))
dccspec <- rmgarch::dccspec(uspec = uspec, dccOrder = c(1,1), distribution = "mvnorm")
fit <- tryCatch(rmgarch::dccfit(dccspec, data = Y),
                error = function(e) ce_fail(paste("DCC fit failed:", conditionMessage(e))))

R <- rmgarch::rcor(fit)            # k x k x T array of conditional correlations
Tn <- dim(R)[3]
pairs <- list()
for (i in seq_len(k)) for (j in seq_len(k)) if (i < j) {
  series_ij <- R[i, j, ]
  pairs[[length(pairs)+1]] <- list(
    pair = paste(nm[i], nm[j], sep = "-"),
    mean_corr = round(mean(series_ij), 4),
    last_corr = round(series_ij[Tn], 4),
    min_corr  = round(min(series_ij), 4),
    max_corr  = round(max(series_ij), 4))
}

ce_emit(list(
  method = "rolling_dcc",
  dataset = if (!is.null(p$dataset)) p$dataset else "g20",
  series = nm, n = nrow(Y), model = "DCC-GARCH(1,1), mvnorm",
  pairs = pairs,
  interpretation = sprintf("Time-varying conditional correlations for %d market pair(s) over %d days (Engle DCC).",
                           length(pairs), Tn)
))
