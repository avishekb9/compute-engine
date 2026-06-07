## sri_daily — Vision Phase 30 daily systemic-risk index from the KSG TE network.
##
## Over the most-recent `window` rows of the g20 panel, computes the KSG/Frenzel-Pompe
## transfer-entropy POINT estimate (the SAME validated estimator in _ksg_core.R, shared
## verbatim with ksg_te.R / ksg_robustness.R; NO surrogates) for every directed pair.
## The SRI is the MEAN directed TE across all N*(N-1) ordered pairs = the system-wide
## nonlinear information-flow intensity: a contagion / systemic-interconnectedness proxy
## (higher = more risk). It is a CONNECTIVITY index, deliberately DISTINCT from the MCPFM
## validation SRI (the AUC=0.915 crisis-discrimination construct) — do not conflate them.
##
## params: {dataset?(g20), series?(default ALL columns), window?(250), k?(4), lag?(1),
##          asof?(ISO date — window ends on/before it; default latest), max_pairs?(testing)}
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_ksg_core.R"))

p      <- ce_params()
window <- if (!is.null(p$window)) max(60L, as.integer(p$window)) else 250L
k      <- if (!is.null(p$k))   max(1L, as.integer(p$k))   else 4L
lag    <- if (!is.null(p$lag)) max(1L, as.integer(p$lag)) else 1L

d    <- ce_returns(p)
keep <- stats::complete.cases(d$R)
Yall <- d$R[keep, , drop = FALSE]; dts <- d$dates[keep]; nm <- d$cols
N <- nrow(Yall); M <- length(nm)
if (M < 2L) ce_fail("sri_daily needs >= 2 series")
if (N < 60L) ce_fail(sprintf("too few complete rows (%d)", N))

## window end: the row on/before `asof`, else the latest row.
end <- N
if (!is.null(p$asof)) {
  ad  <- tryCatch(as.Date(p$asof), error = function(e) NA)
  if (!is.na(ad)) { idx <- which(as.Date(dts) <= ad); if (length(idx)) end <- max(idx) }
}
start <- max(1L, end - window + 1L)
W     <- Yall[start:end, , drop = FALSE]
nw    <- nrow(W)
asof_date <- as.character(dts[end])
if (nw < 60L) ce_fail(sprintf("window too small (%d rows)", nw))

t0 <- Sys.time()

## all directed (ordered) pairs i -> j
pairs <- list()
for (i in seq_len(M)) for (j in seq_len(M)) if (i != j) pairs[[length(pairs) + 1L]] <- c(i, j)
if (!is.null(p$max_pairs)) {
  mp <- max(1L, as.integer(p$max_pairs)); if (length(pairs) > mp) pairs <- pairs[seq_len(mp)]
}
np     <- length(pairs)
ncores <- max(1L, parallel::detectCores() - 1L)

## TE point estimate per directed pair (NO surrogates), parallelised like ksg_robustness.
one_pair <- function(pi) { i <- pairs[[pi]][1]; j <- pairs[[pi]][2]; .te(W[, i], W[, j], k, lag) }
res  <- parallel::mclapply(seq_len(np), one_pair, mc.cores = ncores, mc.preschedule = FALSE)
errs <- vapply(res, function(z) inherits(z, "try-error") || !is.numeric(z) || length(z) != 1L, logical(1))
if (any(errs)) ce_fail(paste("sri_daily failed on", sum(errs), "pair(s); first:",
                             as.character(res[[which(errs)[1]]])))
te <- vapply(res, as.numeric, numeric(1))

sri       <- mean(te)
sri_total <- sum(te)
ord       <- order(-te)
top_edges <- lapply(head(ord, 8L), function(ii)
  list(from = nm[pairs[[ii]][1]], to = nm[pairs[[ii]][2]], te = round(te[ii], 6)))
runtime <- as.numeric(difftime(Sys.time(), t0, units = "secs"))

ce_emit(list(
  method  = "sri_daily",
  dataset = if (!is.null(p$dataset)) p$dataset else "g20",
  date    = asof_date,
  window  = nw, k = k, lag = lag,
  n_markets = M, n_pairs = np,
  sri = round(sri, 6), sri_total = round(sri_total, 6),
  top_edges = top_edges,
  runtime_s = round(runtime, 1),
  interpretation = sprintf(
    "Daily systemic-risk index = mean KSG transfer entropy across %d directed pairs over the %d-day window ending %s (%d markets, k=%d, lag=%d): SRI=%.4f. A connectivity / contagion-intensity proxy (higher = more system-wide nonlinear information flow); NOT the MCPFM validation SRI (AUC 0.915). Strongest link: %s->%s (TE=%.4f).",
    np, nw, asof_date, M, k, lag, sri, top_edges[[1]]$from, top_edges[[1]]$to, top_edges[[1]]$te)
))
