## Pairwise Granger-causality network over a set of return series.
## For each ordered pair (i -> j) fits a bivariate VAR and runs the F-test that
## i does not Granger-cause j (lmtest::grangertest). Returns the directed edge
## list (p < alpha) + a p-value matrix — the input to the `network` method.
## params: {dataset, series:[2-8], lag?(default 2), alpha?(default 0.05)}
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
suppressMessages({ library(lmtest); library(vars) })

p <- ce_params()
if (is.null(p$series) || length(p$series) < 2 || length(p$series) > 8)
  ce_fail("granger needs 2-8 'series'")
d <- ce_returns(p)
Y <- d$R[stats::complete.cases(d$R), , drop = FALSE]
if (nrow(Y) < 100) ce_fail("too few complete rows for Granger test")
lag <- if (!is.null(p$lag)) max(1L, as.integer(p$lag)) else 2L
alpha <- if (!is.null(p$alpha)) as.numeric(p$alpha) else 0.05
nm <- d$cols; k <- length(nm)

pmat <- matrix(NA_real_, k, k, dimnames = list(nm, nm))
edges <- list()
for (i in seq_len(k)) for (j in seq_len(k)) {
  if (i == j) next
  pv <- tryCatch(grangertest(Y[, j] ~ Y[, i], order = lag)$`Pr(>F)`[2],
                 error = function(e) NA_real_)        # H0: i does NOT cause j
  pmat[i, j] <- pv
  if (is.finite(pv) && pv < alpha) edges[[length(edges)+1]] <- list(from = nm[i], to = nm[j], p_value = pv)
}
out_deg <- sapply(nm, function(s) sum(sapply(edges, function(e) e$from == s)))
in_deg  <- sapply(nm, function(s) sum(sapply(edges, function(e) e$to   == s)))

ce_emit(list(
  method = "granger",
  dataset = if (!is.null(p$dataset)) p$dataset else "g20",
  series = nm, n = nrow(Y), lag = lag, alpha = alpha,
  n_edges = length(edges),
  edges = edges,
  out_degree = as.list(setNames(as.integer(out_deg), nm)),
  in_degree  = as.list(setNames(as.integer(in_deg),  nm)),
  p_matrix = lapply(seq_len(k), function(i) list(from = nm[i], p = as.numeric(pmat[i, ]))),
  interpretation = sprintf("%d significant directed Granger links (p<%.2f, lag %d) among %d markets.",
                           length(edges), alpha, lag, k)
))
