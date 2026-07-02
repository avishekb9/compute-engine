## Shared IO for compute-engine R analyses.
## Each analysis: Rscript <analysis>.R '<params-json>'  -> prints ONE JSON object
## to stdout. Reads only whitelisted datasets. Values in G20.xlsx are already
## daily LOG RETURNS (verified 2026-05-31). No network, no writes outside cwd.

suppressMessages({ library(jsonlite); library(readxl) })
## stdout must be PURE JSON — never let R warnings (e.g. KPSS "p-value beyond
## table") leak onto stdout and corrupt the response. Warnings are non-fatal here.
options(warn = -1)

REPO <- Sys.getenv("COMPUTE_REPO", "/home/ecolex/versiondevs/ivy-fineco")

DATASETS <- list(
  g20    = file.path(REPO, "papers/contagion-channels/data/G20.xlsx"),
  ## NAMH 24-series panel: 19 equity indices + 5 commodity futures (Gold, Silver,
  ## NaturalGas, CrudeOil, Copper), daily LOG RETURNS stored as an xts, 2001-01-03 ->
  ## 2025-10-24 (5085 rows). Source: the `namh` package bundled extdata (Yahoo/quantmod).
  ## A DIFFERENT vintage from `g20` (xlsx, 18 equities, no commodities) — keep both;
  ## disambiguate by provenance. Sparse columns (Russia/SouthAfrica/SaudiArabia have many
  ## NAs) are handled by each method's finite-obs guards, never fabricated.
  ## Sentinel = the repo copy (exists locally). In the Cloud Run image (COMPUTE_REPO=
  ## /app/data-root, no papers/ tree) ce_returns falls back to the INSTALLED namh
  ## package's bundled copy via system.file — both byte-identical (verified 2026-06-09).
  g20_24 = file.path(REPO, "papers/namh/code/namh-pkg/inst/extdata/G20_24_returns_yahoo.rds"),
  ## News-attention panel (Frontiers III): daily log-changes of news-attention
  ## volume intensity, 15 channel-tagged topics, 2018-01-02 -> 2026-06-01 (3054
  ## rows). Already stationarised (median ADF p ~ 0), so the KSG estimator runs on
  ## it directly, exactly as g20 is stored as log returns. Provenance + transform in
  ## papers/news-networks/data/README.md (build_network.py::stationarise). CSV so the
  ## byte-identical intermediate the published TE_matrix was estimated on is the
  ## dataset; ce_returns reads it via the .csv branch below.
  news_attention = file.path(REPO, "papers/news-networks/data/news_attention_logchange.csv"),
  ## Crisis-regime contagion panel (MST-contagion paper, Parida, Bhandari &
  ## Sahu 2026): 26 global equity/FX/commodity markets, daily LOG RETURNS,
  ## 2007-01-02 -> 2025-11-27 (5524 rows), ISO-dated CSV for the generic
  ## loader below. Sentinel = the repo copy; falls back to the installed
  ## mstcontagion package's bundled extdata via system.file, same pattern as
  ## g20_24 falling back to namh's bundled copy.
  crisis_regime_panel = file.path(REPO, "papers/contagion-channels/MST-contagion/data/Returns_prices.csv")
)

ce_fail <- function(msg) {
  cat(toJSON(list(error = as.character(msg)), auto_unbox = TRUE)); quit(status = 1)
}
ce_emit <- function(obj) {
  cat(toJSON(obj, auto_unbox = TRUE, digits = 8, na = "null")); quit(status = 0)
}
## Async progress (Tier A): emits a newline-terminated progress line ONLY when the
## async worker sets CE_PROGRESS=1. Silent (no-op) under the synchronous kernel, so the
## pure-single-JSON stdout contract of /api/compute/run is unchanged. Does not quit.
ce_progress <- function(fraction = NA, stage = "", elapsed_s = NA) {
  if (!nzchar(Sys.getenv("CE_PROGRESS"))) return(invisible(NULL))
  cat(toJSON(list(`__progress__` = TRUE, fraction = fraction, stage = stage,
                  elapsed_s = elapsed_s), auto_unbox = TRUE, na = "null"), "\n", sep = "")
  flush(stdout())
}
ce_params <- function() {
  a <- commandArgs(trailingOnly = TRUE)
  if (length(a) < 1) ce_fail("no params JSON argument")
  tryCatch(fromJSON(a[[1]]), error = function(e) ce_fail(paste("bad params JSON:", e$message)))
}

## Worker budget for parallel::mclapply. Centralises core governance so no single
## method can fork detectCores()-1 workers under concurrency -- two concurrent
## ksg_robustness jobs each forking 21 workers is what drove the Precision 5490 to
## 22 cores at 100% and hung it. Precedence: a base of detectCores()-reserve, an
## explicit n_cores param overrides it, and the job server's CE_MAX_CORES is a HARD
## ceiling clamped last (the server sets it per concurrent slot so N jobs cannot
## oversubscribe the machine). Always returns >= 1. Result counts are independent
## of the split for the order-free pair/grid loops that call this, so capping the
## worker count never changes a number -- it only governs CPU.
ce_ncores <- function(p = NULL, reserve = 2L) {
  b <- max(1L, parallel::detectCores() - as.integer(reserve))
  if (!is.null(p) && !is.null(p$n_cores)) {
    req <- suppressWarnings(as.integer(p$n_cores))
    if (!is.na(req) && req >= 1L) b <- req
  }
  cap <- suppressWarnings(as.integer(Sys.getenv("CE_MAX_CORES", "")))
  if (!is.na(cap) && cap >= 1L) b <- min(b, cap)
  max(1L, b)
}

## Returns list(dates=Date vector, R=numeric matrix [T x k], cols=names).
## Phase-30 live path: if p$panel_inline = {dates:[iso...], series:{col:[vals,null...]}}
## is present, use the injected panel (kept net-isolated: the trusted Node orchestrator /
## host backfill fetches BigQuery `panels.g20_returns` and injects it) instead of the xlsx.
ce_returns <- function(p) {
  if (!is.null(p$panel_inline)) {
    pin   <- p$panel_inline
    dates <- as.Date(unlist(pin$dates))
    nm    <- names(pin$series)
    col_num <- function(v) { if (is.list(v)) v <- vapply(v, function(x) if (is.null(x)) NA_real_ else as.numeric(x), numeric(1)); as.numeric(v) }
    mat   <- vapply(nm, function(c) col_num(pin$series[[c]]), numeric(length(dates)))
    if (is.null(dim(mat))) mat <- matrix(mat, ncol = length(nm))
    colnames(mat) <- nm; storage.mode(mat) <- "double"
    ok <- !is.na(dates); dates <- dates[ok]; mat <- mat[ok, , drop = FALSE]
    o  <- order(dates); dates <- dates[o]; mat <- mat[o, , drop = FALSE]   # ascending by date
    if (!is.null(p$start)) { kk <- dates >= as.Date(p$start); dates <- dates[kk]; mat <- mat[kk, , drop = FALSE] }
    if (!is.null(p$end))   { kk <- dates <= as.Date(p$end);   dates <- dates[kk]; mat <- mat[kk, , drop = FALSE] }
    if (!is.null(p$series)) {
      miss <- setdiff(p$series, colnames(mat)); if (length(miss)) ce_fail(paste("series not found:", paste(miss, collapse = ", ")))
      mat <- mat[, p$series, drop = FALSE]
    }
    return(list(dates = dates, R = mat, cols = colnames(mat)))
  }
  ds <- if (!is.null(p$dataset)) p$dataset else "g20"
  if (is.null(DATASETS[[ds]])) ce_fail(paste0("unknown dataset '", ds, "'"))
  path <- DATASETS[[ds]]
  if (grepl("\\.rds$", path, ignore.case = TRUE)) {
    ## xts returns matrix (e.g. g20_24): already daily LOG RETURNS, dates in the index.
    if (!requireNamespace("xts", quietly = TRUE)) ce_fail("xts not installed (required for .rds datasets)")
    ## image fallback: if the repo copy is absent, read the namh-bundled copy.
    ## suppressMessages keeps the package's S3-registration notice off stdout.
    if (!file.exists(path) &&
        suppressMessages(suppressWarnings(requireNamespace("namh", quietly = TRUE)))) {
      sf <- system.file("extdata", basename(path), package = "namh")
      if (nzchar(sf)) path <- sf
    }
    obj   <- readRDS(path)
    dates <- as.Date(zoo::index(obj))
    mat   <- as.matrix(zoo::coredata(obj))
  } else if (grepl("\\.csv$", path, ignore.case = TRUE)) {
    ## plain CSV: first column dates, remaining columns numeric. ISO (yyyy-mm-dd)
    ## for news_attention (already stationarised log-changes) and the repo copy
    ## of crisis_regime_panel; falls back to the installed mstcontagion
    ## package's bundled extdata (dd-mm-yyyy, its original provenance format)
    ## if the repo copy is absent, same pattern as g20_24 falling back to namh.
    if (ds == "crisis_regime_panel" && !file.exists(path) &&
        suppressMessages(suppressWarnings(requireNamespace("mstcontagion", quietly = TRUE)))) {
      sf <- system.file("extdata", "Returns_prices.csv", package = "mstcontagion")
      if (nzchar(sf)) path <- sf
    }
    d     <- utils::read.csv(path, check.names = FALSE, stringsAsFactors = FALSE)
    dates <- as.Date(d[[1]])
    if (all(is.na(dates))) dates <- as.Date(d[[1]], format = "%d-%m-%Y")
    mat   <- as.matrix(d[, -1, drop = FALSE])
  } else {
    d     <- suppressMessages(read_excel(path))
    dates <- as.Date(d[[1]], format = "%d/%m/%Y")
    mat   <- as.matrix(d[, -1, drop = FALSE])
  }
  storage.mode(mat) <- "double"
  ok <- !is.na(dates)
  dates <- dates[ok]; mat <- mat[ok, , drop = FALSE]
  if (!is.null(p$start)) { k <- dates >= as.Date(p$start); dates <- dates[k]; mat <- mat[k, , drop = FALSE] }
  if (!is.null(p$end))   { k <- dates <= as.Date(p$end);   dates <- dates[k]; mat <- mat[k, , drop = FALSE] }
  if (!is.null(p$series)) {
    miss <- setdiff(p$series, colnames(mat))
    if (length(miss)) ce_fail(paste("series not found:", paste(miss, collapse = ", ")))
    mat <- mat[, p$series, drop = FALSE]
  }
  list(dates = dates, R = mat, cols = colnames(mat))
}
