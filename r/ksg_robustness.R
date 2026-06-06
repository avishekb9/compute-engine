## KSG transfer-entropy robustness sweep (Tier G.3 diagnostic).
##
## Re-runs the SAME validated KSG/Frenzel-Pompe transfer-entropy POINT estimator
## (from _ksg_core.R, shared verbatim with ksg_te.R) across a grid of the two
## estimator nuisance parameters — the neighbour count k and the history length
## lag — and reports how stable the directed-TE MAGNITUDES and RANKINGS are.
##
## With n_surrogates implicitly 0 (we never call .iaaft here) each (k,lag) point is
## just the TE point estimates for every directed pair (~1s/pair), so a full grid is
## a fast sweep rather than the heavy surrogate job ksg_te runs.
##
## Stability vs a BASELINE grid point (k=4, lag=1 by default — the ksg_te defaults;
## if those are absent from the grids we fall back to the closest point and report
## which was used):
##   (a) Spearman rank correlation of the full directed-TE vector, baseline vs each
##       other grid point (does the whole ranking move?).
##   (b) Top-10 directed-edge Jaccard overlap, baseline vs each grid point (is the
##       set of strongest links stable?).
##   (c) The rank of the BASELINE's #1 edge at every grid point (is the headline
##       link robustly #1?).
##
## This checks TE magnitude/ranking stability across (k,lag); it does NOT check
## significance-count stability (which would need IAAFT surrogates at EACH grid
## point — a much heavier job, what ksg_te does for a single (k,lag)).
##
## params: {dataset?(g20), series?(default ALL columns), k_grid?([3,4,6,8]),
##          lag_grid?([1,2]), max_pairs?(cap directed pairs, for testing)}
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_ksg_core.R"))

## ---------------------------------------------------------------------------
## Params + validation
## ---------------------------------------------------------------------------
p <- ce_params()

## positive-integer grid validator (rejects non-integers, <=0, NA, empty).
pos_int_grid <- function(x, nm, default) {
  if (is.null(x)) return(default)
  v <- suppressWarnings(as.integer(unlist(x)))
  if (length(v) == 0L || any(is.na(v)) || any(v <= 0L)) ce_fail(sprintf("%s must be positive integers", nm))
  unique(v)
}
k_grid   <- pos_int_grid(p$k_grid,   "k_grid",   c(3L, 4L, 6L, 8L))
lag_grid <- pos_int_grid(p$lag_grid, "lag_grid", c(1L, 2L))

d  <- ce_returns(p)
Y  <- d$R[stats::complete.cases(d$R), , drop = FALSE]
nm <- d$cols; kk <- length(nm); n <- nrow(Y)
if (kk < 2L) ce_fail("ksg_robustness needs >= 2 series")
if (n < 200L) ce_fail(sprintf("too few complete rows (%d) for KSG-TE robustness", n))

t0 <- Sys.time()

## all directed (ordered) pairs i -> j, built ONCE so the TE vector is index-aligned
## across every grid point (a prerequisite for the Spearman/Jaccard comparisons).
pairs <- list()
for (i in seq_len(kk)) for (j in seq_len(kk)) if (i != j) pairs[[length(pairs) + 1L]] <- c(i, j)
if (!is.null(p$max_pairs)) {
  mp <- max(1L, as.integer(p$max_pairs))
  if (length(pairs) > mp) pairs <- pairs[seq_len(mp)]
}
n_pairs <- length(pairs)
ncores  <- max(1L, parallel::detectCores() - 1L)

## ---------------------------------------------------------------------------
## Grid: TE point estimates for ALL directed pairs at each (k,lag)
## ---------------------------------------------------------------------------
grid_specs <- list()
for (lg in lag_grid) for (kv in k_grid) grid_specs[[length(grid_specs) + 1L]] <- c(k = kv, lag = lg)
n_grid <- length(grid_specs)

## one (k,lag): TE point estimate per directed pair (NO surrogates), parallelised
## exactly like ksg_te's pair loop. Returns the index-aligned TE vector.
te_vector <- function(kv, lag) {
  one_pair <- function(pi) {
    i <- pairs[[pi]][1]; j <- pairs[[pi]][2]   # i = source, j = target
    .te(Y[, i], Y[, j], kv, lag)
  }
  res <- parallel::mclapply(seq_len(n_pairs), one_pair, mc.cores = ncores, mc.preschedule = FALSE)
  errs <- vapply(res, function(z) inherits(z, "try-error") || !is.numeric(z) || length(z) != 1L, logical(1))
  if (any(errs)) ce_fail(paste("ksg_robustness failed on", sum(errs), "pair(s) at k=", kv, "lag=", lag,
                               "; first:", as.character(res[[which(errs)[1]]])))
  vapply(res, as.numeric, numeric(1))
}

te_by_grid <- vector("list", n_grid)
for (g in seq_len(n_grid)) {
  kv <- grid_specs[[g]]["k"]; lg <- grid_specs[[g]]["lag"]
  te_by_grid[[g]] <- te_vector(kv, lg)
  ce_progress(g / n_grid, sprintf("grid_%d_of_%d_k%d_lag%d", g, n_grid, kv, lg),
              as.numeric(difftime(Sys.time(), t0, units = "secs")))
}

## ---------------------------------------------------------------------------
## Baseline selection: prefer (k=4, lag=1); else the closest grid point.
## ---------------------------------------------------------------------------
gk   <- vapply(grid_specs, function(s) s["k"],   numeric(1))
glag <- vapply(grid_specs, function(s) s["lag"], numeric(1))
exact <- which(gk == 4L & glag == 1L)
if (length(exact)) {
  base_idx <- exact[1]
  base_note <- "exact ksg_te default (k=4, lag=1)"
} else {
  base_idx <- which.min(abs(gk - 4L) * 1000 + abs(glag - 1L))   # nearest k first, then nearest lag
  base_note <- sprintf("closest grid point to (k=4, lag=1); (4,1) not in grid")
}
base_k <- as.integer(gk[base_idx]); base_lag <- as.integer(glag[base_idx])
base_te <- te_by_grid[[base_idx]]

## helpers ------------------------------------------------------------------
## directed-edge id (index into `pairs`) ordered by descending TE -> top-N set.
top_set <- function(te_v, N) order(-te_v)[seq_len(min(N, length(te_v)))]
jaccard <- function(a, b) { u <- length(union(a, b)); if (u == 0L) 1 else length(intersect(a, b)) / u }
## rank (1 = largest) of a given pair index within a TE vector.
rank_of <- function(pair_idx, te_v) match(pair_idx, order(-te_v))

base_top10 <- top_set(base_te, 10L)
headline_idx <- order(-base_te)[1]                         # baseline's #1 directed edge
headline_from <- nm[pairs[[headline_idx]][1]]; headline_to <- nm[pairs[[headline_idx]][2]]

## per-grid-point block + stability vectors -----------------------------------
edge_obj <- function(pi, te_v) list(from = nm[pairs[[pi]][1]], to = nm[pairs[[pi]][2]],
                                    te = round(te_v[pi], 6))
grid_out <- vector("list", n_grid)
spearman_v <- numeric(n_grid); jaccard10_v <- numeric(n_grid); headline_rank_v <- integer(n_grid)
for (g in seq_len(n_grid)) {
  te_v <- te_by_grid[[g]]
  spearman_v[g]      <- if (g == base_idx) 1 else suppressWarnings(stats::cor(base_te, te_v, method = "spearman"))
  jaccard10_v[g]     <- jaccard(base_top10, top_set(te_v, 10L))
  headline_rank_v[g] <- rank_of(headline_idx, te_v)
  grid_out[[g]] <- list(
    k = as.integer(gk[g]), lag = as.integer(glag[g]),
    spearman_vs_baseline = round(spearman_v[g], 4),
    top10_jaccard_vs_baseline = round(jaccard10_v[g], 4),
    headline_edge_rank = headline_rank_v[g],
    top_edges = lapply(top_set(te_v, 10L), edge_obj, te_v = te_v)
  )
}

## stability summary (exclude the baseline-vs-itself trivial 1.0 from the spread) --
off <- setdiff(seq_len(n_grid), base_idx)
mean_spear <- if (length(off)) round(mean(spearman_v[off]), 4) else 1
min_spear  <- if (length(off)) round(min(spearman_v[off]),  4) else 1
headline_robust_top1 <- all(headline_rank_v == 1L)

verdict <- sprintf(
  "Across %d (k,lag) grid points, directed-TE rankings are %s (mean Spearman vs baseline = %.3f, min = %.3f); the headline edge %s->%s is %s #1 across the grid.",
  n_grid,
  if (min_spear >= 0.9) "highly stable" else if (min_spear >= 0.75) "moderately stable" else "sensitive to (k,lag)",
  mean_spear, min_spear, headline_from, headline_to,
  if (headline_robust_top1) "robustly" else "NOT robustly")

runtime <- as.numeric(difftime(Sys.time(), t0, units = "secs"))

ce_emit(list(
  method = "ksg_robustness",
  dataset = if (!is.null(p$dataset)) p$dataset else "g20",
  k_grid = k_grid, lag_grid = lag_grid,
  n_series = kk, n_obs = n, n_pairs = n_pairs,
  baseline = list(k = base_k, lag = base_lag, note = base_note),
  grid = grid_out,
  stability = list(
    mean_spearman = mean_spear,
    min_spearman = min_spear,
    top10_jaccard = round(jaccard10_v, 4),
    headline_edge = list(from = headline_from, to = headline_to,
                         ranks_across_grid = headline_rank_v),
    verdict_string = verdict
  ),
  runtime_s = round(runtime, 1),
  interpretation = sprintf(
    "KSG transfer-entropy robustness sweep over k in {%s} x lag in {%s} (%d grid points, %d directed pairs, %d markets). Reuses the validated KSG/Frenzel-Pompe point estimator with NO surrogates. %s This diagnostic checks the stability of TE MAGNITUDE and RANKING across the (k,lag) nuisance parameters, NOT significance-count stability (that would require IAAFT surrogates at every grid point — the heavier ksg_te job).",
    paste(k_grid, collapse = ","), paste(lag_grid, collapse = ","),
    n_grid, n_pairs, kk, verdict)
))
