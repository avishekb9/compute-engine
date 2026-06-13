## equiv_gate.R -- the bit-exactness gate for the GPU KSG offload.
##
## Proves that gpu/ksg_gpu.py reproduces the engine's OWN CPU estimator
## (r/_ksg_core.R .te) for the OBSERVED transfer entropy -- the only quantity the
## eval suite gates (ksg_te band, ksg_robustness rankings). Runs the same bin+spec
## contract the R dispatcher uses, on a small bounded case (2 series, B=0), so it
## is safe on an idle box and cannot reproduce the 22-core hang.
##
##   Rscript gpu/equiv_gate.R [dataset] [seriesCSV] [k] [lag]
##   default: g20  USA,Japan  4  1
## exit 0 iff max|TE_gpu - TE_cpu| < 1e-9 (rounds identically at the emit's 6 dp).
args <- commandArgs(trailingOnly = TRUE)
ds   <- if (length(args) >= 1) args[[1]] else "g20"
ser  <- if (length(args) >= 2) strsplit(args[[2]], ",")[[1]] else c("USA", "Japan")
k    <- if (length(args) >= 3) as.integer(args[[3]]) else 4L
lag  <- if (length(args) >= 4) as.integer(args[[4]]) else 1L

rdir <- normalizePath(file.path(dirname(sub("--file=", "",
          grep("--file=", commandArgs(FALSE), value = TRUE))), "..", "r"))
source(file.path(rdir, "_io.R"))
source(file.path(rdir, "_ksg_core.R"))

d  <- ce_returns(list(dataset = ds, series = ser))
Y  <- d$R[stats::complete.cases(d$R), , drop = FALSE]
nm <- d$cols; kk <- length(nm); n <- nrow(Y)
cat(sprintf("data: %s  series=%s  n=%d  k=%d  lag=%d\n",
            ds, paste(nm, collapse = "/"), n, k, lag))

## all directed pairs (same construction as ksg_te.R)
pairs <- list()
for (i in seq_len(kk)) for (j in seq_len(kk)) if (i != j) pairs[[length(pairs) + 1L]] <- c(i, j)

## CPU reference: the engine's own .te()
te_cpu <- vapply(pairs, function(pr) .te(Y[, pr[1]], Y[, pr[2]], k, lag), numeric(1))

## --- the bin+spec contract (identical to ce_ksg_te_gpu in _ksg_core.R) ---
binf <- tempfile(fileext = ".bin"); specf <- tempfile(fileext = ".json"); outf <- tempfile(fileext = ".json")
writeBin(as.double(Y), binf, size = 8)               # column-major float64
spec <- list(n = n, kk = kk, k = k, lag = lag, B = 0L,
             pairs = lapply(pairs, function(pr) c(pr[1] - 1L, pr[2] - 1L)), seed = 0L)
writeLines(jsonlite::toJSON(spec, auto_unbox = TRUE), specf)

helper <- file.path(dirname(rdir), "gpu", "ksg_gpu.py")
st <- system2("python3", c(helper, "--spec", specf, "--bin", binf, "--out", outf),
              stdout = TRUE, stderr = TRUE)
if (!file.exists(outf)) { cat("GPU helper produced no output:\n", paste(st, collapse = "\n"), "\n"); quit(status = 2) }
res <- jsonlite::fromJSON(outf, simplifyVector = FALSE)
if (!isTRUE(res$ok)) { cat("GPU helper error:", res$error, "\n"); quit(status = 2) }

## align GPU results back to the pair order (helper preserves it, but match on (i,j))
te_gpu <- vapply(seq_along(pairs), function(idx) {
  pr <- pairs[[idx]]; want_i <- pr[1] - 1L; want_j <- pr[2] - 1L
  hit <- Filter(function(e) e$i == want_i && e$j == want_j, res$pairs)
  if (!length(hit)) NA_real_ else as.numeric(hit[[1]]$te)
}, numeric(1))

delta <- abs(te_gpu - te_cpu)
for (idx in seq_along(pairs)) {
  pr <- pairs[[idx]]
  cat(sprintf("  %-10s -> %-10s  CPU=% .9f  GPU=% .9f  |d|=%.2e\n",
              nm[pr[1]], nm[pr[2]], te_cpu[idx], te_gpu[idx], delta[idx]))
}
mx <- max(delta, na.rm = TRUE)
cat(sprintf("max|TE_gpu - TE_cpu| = %.3e   (gate: < 1e-9)\n", mx))
cat(sprintf("6dp-rounded edges identical: %s\n",
            identical(round(te_gpu, 6), round(te_cpu, 6))))
quit(status = if (is.finite(mx) && mx < 1e-9) 0L else 1L)
