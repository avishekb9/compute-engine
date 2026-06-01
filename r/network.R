## Directed network of return-series dependencies via igraph.
## Edges are inferred from pairwise Granger causality (lmtest), then igraph
## computes centralities + a force-directed layout. Returns nodes (with x,y
## coordinates + centrality) and edges as JSON so the workbench draws an
## interactive SVG (no server-side image; ggraph deliberately not used).
## params: {dataset, series:[3-12], lag?(default 2), alpha?(default 0.05)}
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
suppressMessages({ library(lmtest); library(igraph) })

p <- ce_params()
if (is.null(p$series) || length(p$series) < 3 || length(p$series) > 12)
  ce_fail("network needs 3-12 'series'")
d <- ce_returns(p)
Y <- d$R[stats::complete.cases(d$R), , drop = FALSE]
if (nrow(Y) < 100) ce_fail("too few complete rows for network")
nm <- d$cols; k <- length(nm)
lag <- if (!is.null(p$lag)) max(1L, as.integer(p$lag)) else 2L
alpha <- if (!is.null(p$alpha)) as.numeric(p$alpha) else 0.05

## directed edges where i Granger-causes j
el <- list()
for (i in seq_len(k)) for (j in seq_len(k)) {
  if (i == j) next
  pv <- tryCatch(grangertest(Y[, j] ~ Y[, i], order = lag)$`Pr(>F)`[2], error = function(e) NA_real_)
  if (is.finite(pv) && pv < alpha) el[[length(el)+1]] <- c(nm[i], nm[j], -log10(pv))
}
if (!length(el)) {
  ce_emit(list(method="network", dataset="g20", series=nm, n=nrow(Y), lag=lag, alpha=alpha,
               n_edges=0, nodes=lapply(nm,function(s)list(id=s)), edges=list(),
               interpretation="No significant directed links at this threshold."))
}
em <- do.call(rbind, el)
g <- igraph::graph_from_data_frame(
  data.frame(from = em[,1], to = em[,2], weight = as.numeric(em[,3]), stringsAsFactors = FALSE),
  directed = TRUE, vertices = data.frame(name = nm, stringsAsFactors = FALSE))

set.seed(42)
lay <- igraph::layout_with_fr(g)                 # force-directed coords
lay <- scale(lay)                                # centre/normalise for the SVG viewbox
deg_in  <- igraph::degree(g, mode = "in")
deg_out <- igraph::degree(g, mode = "out")
btw <- igraph::betweenness(g, directed = TRUE)
ev  <- tryCatch(igraph::eigen_centrality(g, directed = TRUE)$vector, error=function(e) rep(NA_real_,k))
comm <- tryCatch(igraph::membership(igraph::cluster_walktrap(igraph::as.undirected(g))),
                 error = function(e) rep(1L, igraph::vcount(g)))
vn <- igraph::V(g)$name

nodes <- lapply(seq_along(vn), function(i) list(
  id = vn[i],
  x = round(lay[i,1], 4), y = round(lay[i,2], 4),
  in_degree = as.integer(deg_in[vn[i]]), out_degree = as.integer(deg_out[vn[i]]),
  betweenness = round(as.numeric(btw[vn[i]]), 3),
  eigen = round(as.numeric(ev[vn[i]]), 3),
  community = as.integer(comm[vn[i]])))
edges <- lapply(seq_len(nrow(em)), function(r) list(
  from = em[r,1], to = em[r,2], weight = round(as.numeric(em[r,3]), 3)))

ce_emit(list(
  method = "network",
  dataset = if (!is.null(p$dataset)) p$dataset else "g20",
  series = nm, n = nrow(Y), lag = lag, alpha = alpha,
  n_edges = nrow(em),
  density = round(igraph::edge_density(g), 4),
  reciprocity = round(igraph::reciprocity(g), 4),
  n_communities = length(unique(comm)),
  nodes = nodes, edges = edges,
  interpretation = sprintf("Granger network: %d directed edges, density %.3f, %d communities (Walktrap).",
                           nrow(em), igraph::edge_density(g), length(unique(comm)))
))
