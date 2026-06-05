## Time-varying Diebold-Yilmaz (2012) total connectedness over a rolling window.
## Same GFEVD spillover computation as the static `connectedness` method
## (vars::VAR -> frequencyConnectedness::spilloverDY12 -> overall TCI), evaluated
## on a sliding window to trace how system-wide spillover rises in crises.
## params: {dataset, series:[2-6], p?(VAR lag, default 2), H?(horizon, default 10),
##          window?(default 250), step?(default 20)}
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
suppressMessages({ library(vars); library(frequencyConnectedness) })

p <- ce_params()
if (is.null(p$series) || length(p$series) < 2 || length(p$series) > 6)
  ce_fail("spillover_rolling needs 2-6 'series'")
d <- ce_returns(p)
keep <- stats::complete.cases(d$R)
Y <- d$R[keep, , drop = FALSE]; dates <- d$dates[keep]
nm <- d$cols; n <- nrow(Y)
lag <- if (!is.null(p$p)) max(1L, as.integer(p$p)) else 2L
H   <- if (!is.null(p$H)) max(5L, as.integer(p$H)) else 10L
win <- if (!is.null(p$window)) max(60L, as.integer(p$window)) else 250L
step<- if (!is.null(p$step)) max(5L, as.integer(p$step)) else 20L
if (n < win + step) ce_fail(sprintf("need >= %d complete rows for window=%d", win + step, win))

starts <- seq(1L, n - win + 1L, by = step)
## cap windows; default keeps a public sync request within budget. Async jobs may raise
## it via max_windows (the async worker also enables per-window progress via CE_PROGRESS).
MAXW <- if (!is.null(p$max_windows)) max(5L, as.integer(p$max_windows)) else 45L
if (length(starts) > MAXW) starts <- round(seq(1L, n - win + 1L, length.out = MAXW))
t0 <- Sys.time()

series_out <- list(); NS <- length(starts)
for (i in seq_len(NS)) {
  s <- starts[i]
  w <- Y[s:(s + win - 1L), , drop = FALSE]
  tci <- tryCatch({
    fit <- vars::VAR(w, p = lag, type = "const")
    sp  <- frequencyConnectedness::spilloverDY12(fit, n.ahead = H, no.corr = FALSE)
    as.numeric(frequencyConnectedness::overall(sp)[[1]])
  }, error = function(e) NA_real_)
  series_out[[length(series_out) + 1L]] <- list(
    date = as.character(dates[s + win - 1L]), tci = if (is.na(tci)) NA_real_ else round(tci, 2))
  if (i %% 5L == 0L || i == NS)
    ce_progress(i / NS, sprintf("window_%d_of_%d", i, NS),
                as.numeric(difftime(Sys.time(), t0, units = "secs")))
}
vals <- vapply(series_out, function(z) z$tci, numeric(1))
ok <- vals[is.finite(vals)]

ce_emit(list(
  method = "spillover_rolling",
  dataset = if (!is.null(p$dataset)) p$dataset else "g20",
  series = nm, n = n, var_lag = lag, horizon = H, window = win, step = step,
  windows = length(series_out),
  tci_series = series_out,
  tci_mean = if (length(ok)) round(mean(ok), 2) else NA_real_,
  tci_min  = if (length(ok)) round(min(ok), 2) else NA_real_,
  tci_max  = if (length(ok)) round(max(ok), 2) else NA_real_,
  tci_last = if (length(ok)) round(tail(ok, 1), 2) else NA_real_,
  interpretation = sprintf(
    "Rolling Diebold-Yilmaz total connectedness across %d markets over a %d-day window: ranges %.1f%%-%.1f%% (mean %.1f%%); peaks mark systemic-stress episodes.",
    length(nm), win, if (length(ok)) min(ok) else NA, if (length(ok)) max(ok) else NA, if (length(ok)) mean(ok) else NA)
))
