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
  g20 = file.path(REPO, "papers/contagion-channels/data/G20.xlsx")
)

ce_fail <- function(msg) {
  cat(toJSON(list(error = as.character(msg)), auto_unbox = TRUE)); quit(status = 1)
}
ce_emit <- function(obj) {
  cat(toJSON(obj, auto_unbox = TRUE, digits = 8, na = "null")); quit(status = 0)
}
ce_params <- function() {
  a <- commandArgs(trailingOnly = TRUE)
  if (length(a) < 1) ce_fail("no params JSON argument")
  tryCatch(fromJSON(a[[1]]), error = function(e) ce_fail(paste("bad params JSON:", e$message)))
}

## Returns list(dates=Date vector, R=numeric matrix [T x k], cols=names).
ce_returns <- function(p) {
  ds <- if (!is.null(p$dataset)) p$dataset else "g20"
  if (is.null(DATASETS[[ds]])) ce_fail(paste0("unknown dataset '", ds, "'"))
  d <- suppressMessages(read_excel(DATASETS[[ds]]))
  dates <- as.Date(d[[1]], format = "%d/%m/%Y")
  mat <- as.matrix(d[, -1, drop = FALSE])
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
