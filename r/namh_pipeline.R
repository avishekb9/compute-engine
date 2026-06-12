## NAMH FULL PIPELINE (async-only) — the published end-to-end run, SEEDED (M1 Step 4).
##
## Calls namh::run_namh_pipeline (Bhandari & Sahu 2026, v0.1.0, GPL-3) — the
## paper's own end-to-end code: rolling DFA-Hurst → KSG transfer entropy
## (Euclidean RANN variant) → IAAFT effective TE → Benjamini-Hochberg FDR
## adjacency → Hurst-weighted TE (HWTE) → NAMH fixed point E*=(I−A)⁻¹(φ+g1) →
## Leiden communities → centralities.
##
## RNG HONESTY (the V4 requirement): the package's IAAFT generator is UNSEEDED
## (surrogates.R), so the paper's published surrogate run is not bit-reproducible.
## THIS runner pins RNGkind("L'Ecuyer-CMRG") + set.seed(seed) (default 42) before
## the pipeline call, making engine results reproducible for a FIXED {seed,
## n_cores} pair (mclapply child streams derive deterministically from the master
## seed; changing core count changes the stream split — that dependence is stated,
## not hidden).
##
## GATE HONESTY (PI Decision D1): the paper's own FDR gate (alpha=0.05) is the
## ONLY gate exposed. At the canonical config it retains 0/552 directed edges in
## every window — the masked HWTE, fixed point, communities and centralities are
## then degenerate BY CONSTRUCTION and are emitted as measured (the reproduce
## page's honest amber), never magnitude-dressed.
##
## COST: one window ≈ 552 pairs × (1 + n_surrogates) KSG estimates — tower
## minutes at B=200 — far beyond the 90 s sync cap. long_running: job-server only
## (POST /api/jobs/submit); the sync /api/compute/run rejects it.
##
## params: {dataset?(g20_24), window?(252), step?(252), k_nn?(4),
##          n_surrogates?(200), fdr_alpha?(0.05), lambda?(5), seed?(42),
##          n_cores?(2, max 4), window_index?(1..20, default 1)}
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
suppressMessages(library(namh))

p  <- ce_params()
ds <- if (!is.null(p$dataset)) p$dataset else "g20_24"
p$dataset <- ds

ip <- function(v, d) { if (is.null(v)) return(d); x <- as.integer(v); if (is.na(x)) ce_fail("non-integer param"); x }
np <- function(v, d) { if (is.null(v)) return(d); x <- as.numeric(v); if (is.na(x)) ce_fail("non-numeric param"); x }
## exact [[ ]] access — `window` is a prefix of `window_index` (partial-match trap)
window  <- ip(p[["window"]],       252L)
step    <- ip(p[["step"]],         252L)
k_nn    <- ip(p[["k_nn"]],           4L)
B       <- ip(p[["n_surrogates"]], 200L)
alpha   <- np(p[["fdr_alpha"]],   0.05)
lambda  <- np(p[["lambda"]],         5)
seed    <- ip(p[["seed"]],          42L)
ncores  <- ip(p[["n_cores"]],        2L)
wi      <- ip(p[["window_index"]],   1L)
if (window < 64 || step < 1 || k_nn < 1 || B < 1 || alpha <= 0 || alpha >= 1) ce_fail("param out of range")
if (ncores < 1 || ncores > 4) ce_fail("n_cores must be 1..4")

d <- ce_returns(p)
if (!requireNamespace("xts", quietly = TRUE)) ce_fail("xts not installed")
X <- xts::xts(d$R, order.by = d$dates); colnames(X) <- d$cols
starts <- seq.int(1, nrow(X) - window + 1, by = step)
if (wi < 1 || wi > length(starts)) ce_fail(sprintf("window_index %d out of range 1..%d", wi, length(starts)))

## the seed pin — the whole point of this runner
RNGkind("L'Ecuyer-CMRG")
set.seed(seed)

ce_progress(0.05, sprintf("namh pipeline window %d: %d pairs x (1+%d) KSG estimates", wi, ncol(X) * (ncol(X) - 1), B))
t0 <- Sys.time()
res <- namh::run_namh_pipeline(X, window = window, step = step, k_nn = k_nn,
                               n_surrogates = B, fdr_alpha = alpha, lambda = lambda,
                               n_cores = ncores, window_index = wi, save = FALSE)
ce_progress(0.9, "pipeline complete; summarising")
runtime_s <- as.numeric(difftime(Sys.time(), t0, units = "secs"))

## defensive numeric helpers — summarise the per-window object without assuming
## more shape than the pipeline guarantees; anything unparseable emits NULL.
`%||%` <- function(a, b) if (is.null(a)) b else a
off <- function(M) if (is.matrix(M)) M[row(M) != col(M)] else as.numeric(M)
top3 <- function(v) {
  v <- v[is.finite(v)]
  if (!length(v)) return(NULL)
  o <- order(v, decreasing = TRUE)[seq_len(min(3L, length(v)))]
  lapply(o, function(i) list(market = names(v)[i], value = as.numeric(v[i])))
}

per_window <- list()
for (k in seq_along(res$windows)) {
  w <- res$windows[[k]]
  if (is.null(w)) next
  n   <- length(w$H)
  vR  <- off(w$TE_raw); vE <- off(w$TE_eff); vP <- off(w$TE_p)
  fmean <- function(v) if (any(is.finite(v))) mean(v[is.finite(v)]) else NA_real_
  fsd   <- function(v) if (sum(is.finite(v)) > 1) stats::sd(v[is.finite(v)]) else NA_real_
  adj <- w$adj_FDR
  n_edges <- if (is.matrix(adj)) sum(adj[row(adj) != col(adj)] != 0) else NA_integer_
  comm <- tryCatch({
    cm <- w$comm
    if (is.null(cm)) NULL
    else {
      memb <- if (!is.null(cm$membership)) cm$membership
              else if (is.list(cm) && length(cm) && !is.null(cm[[1]]$membership)) cm[[1]]$membership
              else NULL
      if (is.null(memb)) NULL
      else list(k = length(unique(memb)),
                modularity = tryCatch(as.numeric(cm$modularity %||% cm[[1]]$modularity)[1],
                                      error = function(e) NA_real_))
    }
  }, error = function(e) NULL)
  cents <- tryCatch({
    cc <- w$cent
    out <- list()
    for (nmv in intersect(c("eigenvector", "pagerank", "out_strength", "katz"), names(cc))) {
      t3 <- top3(stats::setNames(as.numeric(cc[[nmv]]), names(cc[[nmv]])))
      if (!is.null(t3)) out[[nmv]] <- t3
    }
    if (length(out)) out else NULL
  }, error = function(e) NULL)
  per_window[[length(per_window) + 1L]] <- list(
    window_index = wi,
    date_start = as.character(w$window$start), date_end = as.character(w$window$end),
    te_raw  = list(mean = fmean(vR), sd = fsd(vR), n_pairs = length(vR)),
    te_eff  = list(mean = fmean(vE), sd = fsd(vE),
                   n_finite = sum(is.finite(vE)), n_na = sum(!is.finite(vE)),
                   pos_share = if (any(is.finite(vE))) mean(vE[is.finite(vE)] > 0) else NA_real_),
    ## surrogate p-values: RNG-dependent — the discriminator for seeded reproducibility
    p_values = list(median = if (any(is.finite(vP))) stats::median(vP[is.finite(vP)]) else NA_real_,
                    min = if (any(is.finite(vP))) min(vP[is.finite(vP)]) else NA_real_,
                    below_05 = sum(is.finite(vP) & vP < 0.05)),
    fdr     = list(n_edges = n_edges, n_possible = n * (n - 1),
                   retention_rate = if (is.finite(n_edges)) n_edges / (n * (n - 1)) else NA_real_,
                   alpha = alpha),
    hwte_nonzero = if (is.matrix(w$HWTE)) sum(w$HWTE != 0) else NA_integer_,
    rho_pre  = tryCatch(as.numeric(w$rho_HWTE_pre_rescale),  error = function(e) NA_real_),
    rho_post = tryCatch(as.numeric(w$rho_HWTE_post_rescale), error = function(e) NA_real_),
    H = list(mean = mean(w$H[is.finite(w$H)]), min = min(w$H[is.finite(w$H)]), max = max(w$H[is.finite(w$H)])),
    communities = if (is.null(comm)) NA else comm,
    centralities = if (is.null(cents)) NA else cents,
    degenerate = is.finite(n_edges) && n_edges == 0)
}

ce_emit(list(
  method  = "namh_pipeline",
  dataset = ds,
  config  = list(window = window, step = step, k_nn = k_nn, n_surrogates = B,
                 fdr_alpha = alpha, lambda = lambda, seed = seed,
                 rng = "L'Ecuyer-CMRG", n_cores = ncores, window_index = wi,
                 embedding = tryCatch(as.integer(stats::median(res$embedding)), error = function(e) NA_integer_)),
  n_series = ncol(X),
  runtime_s = runtime_s,
  per_window = per_window,
  note = paste("Published end-to-end NAMH pipeline under the paper's OWN FDR gate.",
               "Reproducible for a fixed {seed, n_cores} (L'Ecuyer-CMRG); the paper's",
               "published surrogate run was unseeded and is NOT bit-reproducible —",
               "that asymmetry is the reproduce page's honest amber. An empty FDR",
               "network (0 edges) at canonical config is the published result, and",
               "downstream network surfaces are then degenerate by construction."),
  source = "Published method: namh::run_namh_pipeline (v0.1.0, Bhandari & Sahu 2026, GPL-3)."))
