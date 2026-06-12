## NAMH Δ-VERIFIER — live reproduction vs the paper's cached diagnostics (M1 Step 5).
##
## D1 honesty bar: recompute the DETERMINISTIC NAMH surfaces with the PUBLISHED
## namh package (Bhandari & Sahu 2026, v0.1.0, GPL-3) at the canonical paper-v3
## config and DIFF them cell-by-cell against the paper's own cached diagnostics,
## emitting the MEASURED max|Δ| — never an assumed zero. Three quantities:
##   hurst_panel — namh::estimate_hurst_panel (window=252, step=252, DFA-1) vs
##                 01_hurst_panel.csv: every finite H cell (24 markets × 20
##                 windows), plus finite/NA placement mismatches counted.
##   te_window   — namh::te_matrix (Euclidean RANN KSG) on one window vs the
##                 te_mean/te_sd row of 03_te_summary.csv (deterministic, no RNG).
##   fdr_network — 04_fdr_retention.csv read-through: edges retained under the
##                 paper's OWN Benjamini-Hochberg FDR gate. At the canonical
##                 config this is 0/552 in every window → status is ALWAYS
##                 "amber" ("empty under the paper's own gate — pending"),
##                 never green, never magnitude-dressed (PI Decision D1).
##
## status rule: green iff max|Δ| <= tol (default 1e-8) AND zero finite/NA
## placement mismatches; otherwise red — a red is information, not a failure to
## hide. The overall verdict never includes the network (amber by construction).
##
## Reference CSVs resolve from r/namh_ref/ (staged byte-identical copies shipped
## in the Docker image via COPY r ./r; see namh_ref/README) with a repo fallback
## to papers/namh/output/diagnostics/ for local runs.
##
## params: {dataset?(g20_24), scope?(all|hurst|te), window?(252), step?(252),
##          order?(1), s_min?(10), n_scales?(20), k_nn?(4), lx?(1), ly?(1),
##          window_index?(1), tol?(1e-8)}
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
suppressMessages(library(namh))

p  <- ce_params()
ds <- if (!is.null(p$dataset)) p$dataset else "g20_24"
p$dataset <- ds

ip <- function(v, d) { if (is.null(v)) return(d); x <- as.integer(v); if (is.na(x)) ce_fail("non-integer param"); x }
np <- function(v, d) { if (is.null(v)) return(d); x <- as.numeric(v); if (is.na(x)) ce_fail("non-numeric param"); x }
## exact [[ ]] access: $ does partial matching and `window` is a prefix of
## `window_index` (the namh_te.R lesson) — never use $ for these two.
window   <- ip(p[["window"]],   252L)
step     <- ip(p[["step"]],     252L)
order    <- ip(p[["order"]],      1L)
s_min    <- ip(p[["s_min"]],     10L)
n_scales <- ip(p[["n_scales"]],  20L)
k_nn     <- ip(p[["k_nn"]],       4L)
lx       <- ip(p[["lx"]],         1L)
ly       <- ip(p[["ly"]],         1L)
wi       <- ip(p[["window_index"]], 1L)
tol      <- np(p[["tol"]], 1e-8)
scope    <- if (!is.null(p$scope)) p$scope else "all"
if (!scope %in% c("all", "hurst", "te")) ce_fail("scope must be all|hurst|te")
if (window < 4 * s_min || step < 1 || k_nn < 1 || tol <= 0) ce_fail("param out of range")

script_dir <- dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE)))
ref_file <- function(f) {
  c1 <- file.path(script_dir, "namh_ref", f)
  c2 <- file.path(REPO, "papers/namh/output/diagnostics", f)
  if (file.exists(c1)) c1 else if (file.exists(c2)) c2 else ce_fail(paste("reference diagnostics missing:", f))
}

d <- ce_returns(p)
if (!requireNamespace("xts", quietly = TRUE)) ce_fail("xts not installed")
X <- xts::xts(d$R, order.by = d$dates); colnames(X) <- d$cols

quantities <- list()

## ── 1 · Hurst panel: every finite H cell vs 01_hurst_panel.csv ──────────────
if (scope %in% c("all", "hurst")) {
  ref <- utils::read.csv(ref_file("01_hurst_panel.csv"), stringsAsFactors = FALSE)
  panel <- namh::estimate_hurst_panel(X, window = window, step = step, order = order,
                                      s_min = s_min, n_scales = n_scales,
                                      stationarity_audit = FALSE)
  n_cmp <- 0L; n_skip_na <- 0L; n_mismatch <- 0L
  max_d <- -Inf; arg <- list(market = NA_character_, window = NA_integer_)
  for (r in seq_len(nrow(ref))) {
    m <- ref$market[r]; w <- ref$window[r]
    h <- panel[[m]]
    rec <- if (!is.null(h) && w >= 1 && w <= nrow(h)) h$H[w] else NA_real_
    cac <- ref$H[r]
    if (is.finite(cac) && is.finite(rec)) {
      n_cmp <- n_cmp + 1L
      dd <- abs(cac - rec)
      if (dd > max_d) { max_d <- dd; arg <- list(market = m, window = w) }
    } else if (is.finite(cac) != is.finite(rec)) {
      n_mismatch <- n_mismatch + 1L          # finite/NA placement disagrees — counts against green
    } else n_skip_na <- n_skip_na + 1L       # NA in both: sparse series, honest skip
  }
  if (n_cmp == 0L) ce_fail("hurst reproduce: no finite cells compared")
  st <- if (max_d <= tol && n_mismatch == 0L) "green" else "red"
  quantities$hurst_panel <- list(
    quantity = "hurst_panel", cached_source = "01_hurst_panel.csv",
    config = list(window = window, step = step, order = order, s_min = s_min, n_scales = n_scales),
    n_compared = n_cmp, n_na_both = n_skip_na, n_finite_na_mismatch = n_mismatch,
    max_abs_delta = max_d, argmax = arg, tol = tol, status = st)
}

## ── 2 · TE window: te_mean/te_sd of one window vs 03_te_summary.csv ─────────
if (scope %in% c("all", "te")) {
  ref <- utils::read.csv(ref_file("03_te_summary.csv"), stringsAsFactors = FALSE)
  if (wi < 1 || wi > nrow(ref)) ce_fail(sprintf("window_index %d out of cached range 1..%d", wi, nrow(ref)))
  starts <- seq.int(1, nrow(X) - window + 1, by = step)
  if (wi > length(starts)) ce_fail("window_index beyond recomputable windows")
  s  <- starts[wi]
  TE <- namh::te_matrix(zoo::coredata(X)[s:(s + window - 1), , drop = FALSE],
                        lx = lx, ly = ly, k_nn = k_nn, n_cores = 1L)
  v  <- TE[row(TE) != col(TE)]
  rec_mean <- mean(v); rec_sd <- stats::sd(v)
  d_mean <- abs(rec_mean - ref$te_mean[wi]); d_sd <- abs(rec_sd - ref$te_sd[wi])
  max_d  <- max(d_mean, d_sd)
  quantities$te_window <- list(
    quantity = "te_window", cached_source = "03_te_summary.csv",
    window_index = wi, date_start = ref$start[wi], date_end = ref$end[wi],
    cached = list(te_mean = ref$te_mean[wi], te_sd = ref$te_sd[wi]),
    recomputed = list(te_mean = rec_mean, te_sd = rec_sd),
    n_pairs = length(v),
    max_abs_delta = max_d, tol = tol,
    status = if (max_d <= tol) "green" else "red")
}

## ── 3 · FDR network: the paper's own gate — always amber ────────────────────
ref <- utils::read.csv(ref_file("04_fdr_retention.csv"), stringsAsFactors = FALSE)
quantities$fdr_network <- list(
  quantity = "fdr_network", cached_source = "04_fdr_retention.csv",
  n_windows = nrow(ref),
  edges_retained_total = sum(ref$n_edges),
  n_possible = if (nrow(ref)) ref$n_possible[1] else NA_integer_,
  windows_nonempty = sum(ref$n_edges > 0),
  status = "amber",
  note = paste("Empty under the paper's own BH-FDR gate (0 of 552 directed edges in",
               "every window) — pending; surrogate-gated centralities are degenerate",
               "by construction. Reported amber, never green, never magnitude-dressed",
               "(PI Decision D1). Effective-TE surrogates are RNG-dependent: see",
               "namh_pipeline (seeded, async)."))

verdict <- list(
  hurst   = if (!is.null(quantities$hurst_panel)) quantities$hurst_panel$status else "skipped",
  te      = if (!is.null(quantities$te_window))   quantities$te_window$status   else "skipped",
  network = "amber")

ce_emit(list(
  method  = "namh_reproduce",
  dataset = ds,
  quantities = unname(quantities),
  verdict = verdict,
  tol = tol,
  note = "Measured live reproduction of the deterministic NAMH surfaces through the paper's own package; the network row is amber by construction (paper's own FDR gate retains nothing). A red here is information — investigate, never widen tol.",
  source = "Published package: namh v0.1.0 (Bhandari & Sahu 2026, GPL-3) — estimate_hurst_panel + te_matrix; reference = the paper's cached diagnostics (r/namh_ref, byte-identical staging)."))
