## NAMH transfer-entropy MAGNITUDE (deterministic) — the PUBLISHED method.
##
## Calls `namh::te_matrix` (Bhandari & Sahu 2026, v0.1.0, GPL-3) DIRECTLY: the
## Kraskov-Stoegbauer-Grassberger k-NN estimator of transfer entropy (Kraskov
## et al. 2004) for every directed market pair in a rolling window. te_matrix is
## DETERMINISTIC (k-NN only; no RNG) and therefore reproduce-eligible.
##
## SCOPE BOUNDARY (honest): this returns RAW KSG TE only. The EFFECTIVE TE and
## the edge p-values require IAAFT surrogate bias-correction (namh::
## correct_te_matrix, B=200), whose generator is UNSEEDED (surrogates.R:24) and
## hence NOT bit-reproducible — those belong to the async namh_pipeline and are
## reported AMBER. Here te_eff_* / p_* are deliberately NOT computed.
##
## REPRODUCE TARGET: papers/namh/output/diagnostics/03_te_summary.csv columns
## te_mean / te_sd (raw TE distribution per window). Windows match the canonical
## Hurst panel: window=252, step=252 (non-overlapping), 20 windows on g20_24.
## NOTE the namh KSG is the package's Euclidean RANN variant; it is a DIFFERENT
## estimator from the engine's `ksg_te` (Frenzel-Pompe max-norm) — do not cross-
## compare their numbers.
##
## params: {dataset?(g20_24), series?[subset], window?(252), step?(252),
##          k_nn?(4), lx?(1), ly?(1), window_index?(all), matrix?(false)}
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
suppressMessages(library(namh))

p <- ce_params()
ds <- if (!is.null(p$dataset)) p$dataset else "g20_24"
p$dataset <- ds
ip <- function(v, d) { if (is.null(v)) return(d); x <- as.integer(v); if (is.na(x)) ce_fail("non-integer param"); x }
## NB exact [[ ]] access: R's $ does partial matching, so p$window would wrongly
## resolve to p$window_index (window is a prefix). Use [[ ]] for the collision.
window <- ip(p[["window"]], 252L)
step   <- ip(p[["step"]],   252L)
k_nn   <- ip(p[["k_nn"]],     4L)
lx     <- ip(p[["lx"]],       1L)
ly     <- ip(p[["ly"]],       1L)
want_matrix <- isTRUE(p[["matrix"]])
wi <- if (!is.null(p[["window_index"]])) ip(p[["window_index"]], NA) else NA_integer_
if (window < 32 || step < 1 || k_nn < 1) ce_fail("param out of range")

d <- ce_returns(p)                          # all 24 series unless subset; full rows
R <- d$R; dates <- d$dates; n <- nrow(R); nm <- d$cols
if (n < window) ce_fail(sprintf("series too short (%d rows < window %d)", n, window))
starts <- seq.int(1, n - window + 1, by = step)
nwin <- length(starts)
if (!is.na(wi)) {
  if (wi < 1 || wi > nwin) ce_fail(sprintf("window_index %d out of range 1..%d", wi, nwin))
  idx <- wi
} else idx <- seq_len(nwin)

off_stats <- function(TE) {
  v <- TE[row(TE) != col(TE)]               # 552 directed off-diagonal entries (n*(n-1))
  list(mean = mean(v), sd = stats::sd(v), n_pairs = length(v))
}

per_window <- lapply(idx, function(i) {
  s <- starts[i]
  Rw <- R[s:(s + window - 1), , drop = FALSE]
  TE <- namh::te_matrix(Rw, lx = lx, ly = ly, k_nn = k_nn, n_cores = 1L)
  st <- off_stats(TE)
  list(window = i,
       date_start = as.character(dates[s]),
       date_end   = as.character(dates[s + window - 1]),
       te_mean = st$mean, te_sd = st$sd, n_pairs = st$n_pairs)
})

out <- list(
  method  = "namh_te",
  dataset = ds,
  config  = list(window = window, step = step, k_nn = k_nn, lx = lx, ly = ly),
  n_series = length(nm), n_windows = nwin,
  per_window = per_window,
  note = "RAW KSG transfer entropy only (deterministic, reproduce-eligible). Effective TE and edge p-values need IAAFT surrogates (unseeded -> not bit-reproducible); see namh_pipeline (amber).",
  source = "Published method: namh::te_matrix (v0.1.0, Bhandari & Sahu 2026, GPL-3) - KSG k-NN transfer entropy (Kraskov et al. 2004), package Euclidean RANN variant."
)

## optional: full directed TE matrix for a single window (TE[tgt,src]=flow src->tgt)
if (want_matrix && !is.na(wi)) {
  s  <- starts[wi]
  TE <- namh::te_matrix(R[s:(s + window - 1), , drop = FALSE], lx = lx, ly = ly, k_nn = k_nn, n_cores = 1L)
  rownames(TE) <- colnames(TE) <- nm
  out$matrix_window <- wi
  out$te_matrix <- lapply(seq_len(nrow(TE)), function(r) setNames(as.list(as.numeric(TE[r, ])), nm))
  ## top directed flows src->tgt (TE[tgt,src])
  fl <- which(row(TE) != col(TE), arr.ind = TRUE)
  vals <- TE[fl]; o <- order(vals, decreasing = TRUE)[seq_len(min(15, length(vals)))]
  out$top_flows <- lapply(o, function(j) list(
    from = nm[fl[j, 2]], to = nm[fl[j, 1]], te = vals[j]))
}

ce_emit(out)
