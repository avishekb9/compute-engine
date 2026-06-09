## NAMH network centralities — the PUBLISHED method.
##
## Calls `namh::all_centralities` (Bhandari & Sahu 2026, v0.1.0, GPL-3) DIRECTLY
## on a SUPPLIED Hurst-Weighted Transfer-Entropy adjacency HWTE (n x n, the
## convention is HWTE[j, i] = weighted information flow j -> i). Returns the
## seven canonical-form measures the NAMH paper reports: spectral radius rho_A,
## in/out weighted strength, dominant-SCC eigenvector, PageRank, Katz, and
## (distance-weighted) betweenness.
##
## GATE-AGNOSTIC BY DESIGN. This method computes centralities on whatever
## adjacency it is handed; it does NOT choose a gate. In the NAMH pipeline the
## gate is applied UPSTREAM (TE_eff, TE_p -> fdr_adjacency / gate_adjacency ->
## HWTE). Per the canonical paper-v3 cached output (04_fdr_retention.csv: 0 of
## 552 directed edges retained in ALL 20 windows under BH-FDR q<=0.05, and also
## under q<=0.20), the FDR-gated NAMH adjacency is the ZERO matrix -> every
## centrality is degenerate. That empty-network result is the honest, paper-
## faithful state of the NAMH network (reported amber, never dressed up with the
## separate magnitude-gated headline). When handed an all-zero / edgeless graph
## this method returns `degenerate = true` and the well-defined limits
## (rho_A = 0; PageRank = uniform 1/n; strengths = 0), rather than failing.
##
## params: {hwte:[[...],...] (REQUIRED n x n), names?[n], weight_distance?(log),
##          top?(all)}
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
suppressMessages(library(namh))

p <- ce_params()
if (is.null(p$hwte)) ce_fail("namh_centrality needs 'hwte' = n x n adjacency (list of rows)")

## parse list-of-rows -> numeric matrix. jsonlite simplifies a JSON array-of-
## equal-length-arrays into a matrix (rows = outer array), but leaves a ragged
## one as a list -> handle both.
rows <- p$hwte
if (is.matrix(rows)) {
  A <- rows; storage.mode(A) <- "double"
} else if (is.data.frame(rows)) {
  A <- as.matrix(rows); storage.mode(A) <- "double"
} else if (is.list(rows)) {
  A <- tryCatch(do.call(rbind, lapply(rows, function(r) as.numeric(unlist(r)))),
                error = function(e) ce_fail(paste("bad 'hwte':", e$message)))
} else {
  ce_fail("'hwte' must be a list of equal-length numeric rows or a matrix")
}
if (nrow(A) != ncol(A)) ce_fail(sprintf("'hwte' must be square (got %d x %d)", nrow(A), ncol(A)))
n <- nrow(A)
if (n < 2) ce_fail("'hwte' must be at least 2 x 2")
A[!is.finite(A)] <- 0
diag(A) <- 0

nm <- if (!is.null(p$names)) as.character(unlist(p$names)) else paste0("X", seq_len(n))
if (length(nm) != n) ce_fail(sprintf("'names' length %d != adjacency dim %d", length(nm), n))
rownames(A) <- colnames(A) <- nm
wd  <- if (!is.null(p$weight_distance)) p$weight_distance else "log"
top <- if (!is.null(p$top)) as.integer(p$top) else n

## degeneracy: an edgeless graph has no defined hub structure
n_edges <- sum(A != 0)
rho_pre <- max(Mod(eigen(A, only.values = TRUE)$values))
degenerate <- (n_edges == 0) || (rho_pre < 1e-12)

C <- namh::all_centralities(A, weight_distance = wd)

## helper: named vector -> ranked list of {market, value, rank} (desc), top-k
ranked <- function(v) {
  v <- as.numeric(v); names(v) <- nm
  v[!is.finite(v)] <- NA_real_
  o <- order(v, decreasing = TRUE, na.last = TRUE)
  k <- min(top, n)
  lapply(seq_len(k), function(i) list(market = nm[o[i]], value = v[o[i]], rank = i))
}
named_obj <- function(v) { v <- as.numeric(v); setNames(as.list(v), nm) }

ce_emit(list(
  method = "namh_centrality",
  n = n, n_edges = n_edges, weight_distance = wd,
  degenerate = degenerate,
  rho_A = C$rho_A,
  ## per-node values (named) for every measure
  values = list(
    in_strength  = named_obj(C$in_strength),
    out_strength = named_obj(C$out_strength),
    eigenvector  = named_obj(C$eigenvector),
    pagerank     = named_obj(C$pagerank),
    katz         = named_obj(C$katz),
    betweenness  = named_obj(C$betweenness)
  ),
  ## ranked hub tables (desc) for the measures the paper headlines
  ranked = list(
    eigenvector = ranked(C$eigenvector),
    pagerank    = ranked(C$pagerank),
    katz        = ranked(C$katz),
    betweenness = ranked(C$betweenness),
    out_strength = ranked(C$out_strength)
  ),
  note = if (degenerate)
    "EDGELESS graph: spectral radius 0, PageRank uniform (1/n), strengths 0 - no hub structure. This is the NAMH network's honest state under the paper's BH-FDR gate (0/552 edges, all 20 windows; 04_fdr_retention.csv)."
  else
    "Centralities on the supplied HWTE adjacency. Gate (if any) was applied upstream; this method is gate-agnostic.",
  source = "Published method: namh::all_centralities (v0.1.0, Bhandari & Sahu 2026, GPL-3) - canonical-form network centralities (Katz 1953; eigenvector; PageRank; weighted strength; betweenness)."
))
