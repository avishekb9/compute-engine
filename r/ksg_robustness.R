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

## ===========================================================================
## BADGE MODE (Phase 31 / Pathway C): significance-robustness of ONE target edge.
## Opt-in — triggered by p$target = [from, to]. Adds the two axes the (k,lag)
## sweep below deliberately omits: sample WINDOW and significance ALPHA (the
## latter needs IAAFT surrogates at every grid point). Reports a pass_rate + a
## robust|conditional|fragile|untested badge for the target directed edge,
## reusing .te/.iaaft from _ksg_core.R verbatim (same validated estimator as
## ksg_te). Net-isolated: emits JSON only — the BigQuery badge row is written by
## the trusted orchestrator, never from inside the sandbox.
## params: {target:[from,to], window_grid?([126,252,504]), embed_grid?([3,6,9]),
##          k_grid?([3,4,6,8]), alpha_grid?([.01,.05,.10]), n_surrogates?(199)}
if (!is.null(p$target)) {
  tg <- as.character(unlist(p$target))
  if (length(tg) != 2L) ce_fail("badge mode: 'target' must be [from, to]")
  fi <- match(tg[1], nm); ti <- match(tg[2], nm)
  if (is.na(fi) || is.na(ti))
    ce_fail(sprintf("badge mode: target market(s) not in dataset (cols: %s)", paste(nm, collapse = ",")))

  num_grid <- function(x, default) {
    if (is.null(x)) return(default)
    v <- suppressWarnings(as.numeric(unlist(x)))
    if (length(v) == 0L || any(is.na(v))) ce_fail("badge mode: bad numeric grid")
    unique(v)
  }
  win_grid   <- as.integer(num_grid(p$window_grid, c(126, 252, 504)))
  emb_grid   <- as.integer(num_grid(p$embed_grid,  c(3, 6, 9)))
  kk_grid    <- as.integer(num_grid(p$k_grid,      c(3, 4, 6, 8)))
  alpha_grid <- num_grid(p$alpha_grid,             c(0.01, 0.05, 0.10))
  B <- if (!is.null(p$n_surrogates)) max(19L, as.integer(p$n_surrogates)) else 199L

  ## all directed pairs (for the rank-of-target metric)
  bpairs <- list(); for (i in seq_len(kk)) for (j in seq_len(kk)) if (i != j) bpairs[[length(bpairs) + 1L]] <- c(i, j)
  np <- length(bpairs)
  tgt_idx <- which(vapply(bpairs, function(z) z[1] == fi && z[2] == ti, logical(1)))
  ncores <- ce_ncores(p)

  ## baseline anchor — full-sample target TE at the published ksg_te defaults
  ## (k=4, lag/embed=1): reproduces the headline magnitude (point estimate only,
  ## no surrogates, so it is cheap). Lets the grid badge be read against the
  ## headline rather than mistaken for a verdict on the headline itself.
  base_full_te <- .te(Y[, fi], Y[, ti], 4L, 1L)

  cfgs <- list()
  for (w in win_grid) for (e in emb_grid) for (kv in kk_grid)
    cfgs[[length(cfgs) + 1L]] <- c(window = w, embed = e, k = kv)
  ncfg <- length(cfgs)

  ## one (window,embed,k): observed target TE + IAAFT-surrogate p, plus the target's
  ## rank among ALL directed pairs (no surrogates) at that config.
  one_cfg <- function(ci) {
    w <- cfgs[[ci]]["window"]; e <- cfgs[[ci]]["embed"]; kv <- cfgs[[ci]]["k"]
    Yw <- utils::tail(Y, w)                              # most-recent w complete obs
    nu <- nrow(Yw) - e - 1L                              # usable embedded rows
    if (nu < (kv + e + 5L))
      return(list(window = w, embed = e, k = kv, te = NA_real_, p = NA_real_,
                  rank = NA_integer_, n_used = max(0L, nu), estimable = FALSE))
    te_obs <- .te(Yw[, fi], Yw[, ti], kv, e)
    surr   <- vapply(seq_len(B), function(b) .te(.iaaft(Yw[, fi]), Yw[, ti], kv, e), numeric(1))
    pval   <- (1 + sum(surr >= te_obs)) / (B + 1)
    te_all <- vapply(seq_len(np), function(pp) .te(Yw[, bpairs[[pp]][1]], Yw[, bpairs[[pp]][2]], kv, e), numeric(1))
    rk     <- match(tgt_idx, order(-te_all))
    list(window = w, embed = e, k = kv, te = te_obs, p = pval, rank = rk, n_used = nu, estimable = TRUE)
  }
  cres <- parallel::mclapply(seq_len(ncfg), one_cfg, mc.cores = ncores, mc.preschedule = FALSE)
  errs <- vapply(cres, function(z) inherits(z, "try-error") || is.null(z$window), logical(1))
  if (any(errs)) ce_fail(paste("badge mode failed on", sum(errs), "config(s); first:",
                               as.character(cres[[which(errs)[1]]])))

  estimable   <- vapply(cres, function(z) isTRUE(z$estimable), logical(1))
  n_estimable <- sum(estimable); n_skipped <- ncfg - n_estimable

  ## pass_rate over (estimable config x alpha): pass = surrogate p < alpha
  pass_count <- 0L; total_pts <- 0L
  for (z in cres[estimable]) for (a in alpha_grid) {
    total_pts <- total_pts + 1L
    if (is.finite(z$p) && z$p < a) pass_count <- pass_count + 1L
  }
  pass_rate  <- if (total_pts > 0L) pass_count / total_pts else NA_real_
  rank1_rate <- if (n_estimable > 0L) mean(vapply(cres[estimable], function(z) isTRUE(z$rank == 1L), logical(1))) else NA_real_
  badge <- if (is.na(pass_rate)) "untested" else if (pass_rate >= 0.90) "robust" else if (pass_rate >= 0.60) "conditional" else "fragile"

  te_vals  <- vapply(cres[estimable], function(z) z$te, numeric(1))
  grid_out <- lapply(cres, function(z) list(
    window = z$window, embed = z$embed, k = z$k,
    te = if (is.finite(z$te)) round(z$te, 6) else NA, p = if (is.finite(z$p)) round(z$p, 4) else NA,
    rank = z$rank, n_used = z$n_used, estimable = z$estimable))

  runtime <- as.numeric(difftime(Sys.time(), t0, units = "secs"))
  ce_emit(list(
    method = "ksg_robustness", mode = "badge",
    target = list(from = tg[1], to = tg[2]),
    dataset = if (!is.null(p$dataset)) p$dataset else "g20",
    grids = list(window = win_grid, embed = emb_grid, k = kk_grid, alpha = alpha_grid),
    n_surrogates = B, n_configs = ncfg, n_estimable = n_estimable, n_skipped = n_skipped,
    n_grid_points = total_pts,
    baseline = list(scope = "full_sample", k = 4L, embed = 1L, n = nrow(Y),
                    te = round(base_full_te, 6),
                    note = "published ksg_te-default config (k=4, lag=1); point estimate, anchors the headline magnitude (~0.154)"),
    pass_rate = if (is.na(pass_rate)) NA else round(pass_rate, 4),
    rank1_rate = if (is.na(rank1_rate)) NA else round(rank1_rate, 4),
    badge = badge,
    te_summary = if (n_estimable > 0L) list(min = round(min(te_vals), 6),
      median = round(stats::median(te_vals), 6), max = round(max(te_vals), 6)) else NULL,
    criterion = "pass = IAAFT-surrogate p < alpha at each (window,embed,k,alpha); badge robust>=0.90, conditional>=0.60, else fragile; rank1_rate = fraction of (window,embed,k) where target is the #1 directed edge among all pairs",
    grid = grid_out,
    runtime_s = round(runtime, 1),
    interpretation = sprintf(
      "KSG-TE significance-robustness badge for %s->%s over window{%s} x embed{%s} x k{%s} x alpha{%s} (%d estimable of %d configs; %d skipped for too-few-obs; B=%d IAAFT surrogates): pass_rate=%.3f -> badge '%s'; target is the #1 directed edge in %.0f%% of estimable configs.",
      tg[1], tg[2], paste(win_grid, collapse = ","), paste(emb_grid, collapse = ","),
      paste(kk_grid, collapse = ","), paste(alpha_grid, collapse = ","),
      n_estimable, ncfg, n_skipped, B, if (is.na(pass_rate)) 0 else pass_rate, badge,
      if (is.na(rank1_rate)) 0 else 100 * rank1_rate)
  ))
}

## all directed (ordered) pairs i -> j, built ONCE so the TE vector is index-aligned
## across every grid point (a prerequisite for the Spearman/Jaccard comparisons).
pairs <- list()
for (i in seq_len(kk)) for (j in seq_len(kk)) if (i != j) pairs[[length(pairs) + 1L]] <- c(i, j)
if (!is.null(p$max_pairs)) {
  mp <- max(1L, as.integer(p$max_pairs))
  if (length(pairs) > mp) pairs <- pairs[seq_len(mp)]
}
n_pairs <- length(pairs)
ncores  <- ce_ncores(p)

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
