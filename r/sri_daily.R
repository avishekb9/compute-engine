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
## Keep ALL rows; NaNs are handled PER PAIR below, so a single market going NaN
## (e.g. Russia/IMOEX unavailable for dates after 2026-03-18) drops only its own
## directed pairs, NOT whole rows — preserving every other market's observations.
Yall <- d$R; dts <- d$dates; nm <- d$cols
N <- nrow(Yall); M <- length(nm)
if (M < 2L) ce_fail("sri_daily needs >= 2 series")
if (N < 60L) ce_fail(sprintf("too few rows (%d)", N))

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

## markets actively trading at the window end (the asof row). A market NaN there
## (e.g. Russia/IMOEX for any date after 2026-03-18) is excluded from the index for
## that date — so new dates are a consistent 17-market/272-pair index, not a stale mix.
active <- which(is.finite(W[nw, , drop = TRUE]))
if (length(active) < 2L) ce_fail(sprintf("only %d active market(s) at %s", length(active), asof_date))
## all directed (ordered) pairs i -> j among ACTIVE markets
pairs <- list()
for (i in active) for (j in active) if (i != j) pairs[[length(pairs) + 1L]] <- c(i, j)
if (!is.null(p$max_pairs)) {
  mp <- max(1L, as.integer(p$max_pairs)); if (length(pairs) > mp) pairs <- pairs[seq_len(mp)]
}
np     <- length(pairs)
ncores <- max(1L, parallel::detectCores() - 1L)

## TE point estimate per directed pair (NO surrogates), parallelised like ksg_robustness.
## Each pair uses ITS OWN complete cases within the window, so a NaN market only voids
## its own pairs (returns NA), never the whole computation.
one_pair <- function(pi) {
  i <- pairs[[pi]][1]; j <- pairs[[pi]][2]
  x <- W[, i]; y <- W[, j]; ok <- is.finite(x) & is.finite(y)
  if (sum(ok) < 60L) return(NA_real_)
  .te(x[ok], y[ok], k, lag)
}
res  <- parallel::mclapply(seq_len(np), one_pair, mc.cores = ncores, mc.preschedule = FALSE)
te_raw <- vapply(res, function(z) if (inherits(z, "try-error") || !is.numeric(z) || length(z) != 1L) NA_real_ else as.numeric(z), numeric(1))
valid  <- is.finite(te_raw)
if (sum(valid) < 2L) ce_fail(sprintf("sri_daily: only %d valid pair(s) in window", sum(valid)))
te          <- te_raw[valid]
pairs_valid <- pairs[valid]

## active markets at the asof row are the index constituents; the rest are excluded (e.g. NaN Russia)
present_mkts   <- nm[active]
excluded_mkts  <- nm[setdiff(seq_len(M), active)]
n_pairs_valid  <- length(te)
n_markets_used <- length(present_mkts)

sri       <- mean(te)
sri_total <- sum(te)
ord       <- order(-te)
top_edges <- lapply(head(ord, 8L), function(ii)
  list(from = nm[pairs_valid[[ii]][1]], to = nm[pairs_valid[[ii]][2]], te = round(te[ii], 6)))
runtime <- as.numeric(difftime(Sys.time(), t0, units = "secs"))

ce_emit(list(
  method  = "sri_daily",
  dataset = if (!is.null(p$dataset)) p$dataset else "g20",
  date    = asof_date,
  window  = nw, k = k, lag = lag,
  n_markets = n_markets_used, n_pairs = n_pairs_valid,
  excluded_markets = as.list(excluded_mkts),
  sri = round(sri, 6), sri_total = round(sri_total, 6),
  top_edges = top_edges,
  runtime_s = round(runtime, 1),
  interpretation = sprintf(
    "Daily systemic-risk index = mean KSG transfer entropy across %d directed pairs over the %d-day window ending %s (%d markets, k=%d, lag=%d): SRI=%.4f. A connectivity / contagion-intensity proxy (higher = more system-wide nonlinear information flow); NOT the MCPFM validation SRI (AUC 0.915). Strongest link: %s->%s (TE=%.4f).%s",
    n_pairs_valid, nw, asof_date, n_markets_used, k, lag, sri, top_edges[[1]]$from, top_edges[[1]]$to, top_edges[[1]]$te,
    if (length(excluded_mkts)) sprintf(" Excluded (insufficient data in window): %s.", paste(excluded_mkts, collapse=", ")) else "")
))
