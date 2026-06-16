suppressMessages(library(igraph))
base <- "/home/ecolex/versiondevs/ivy-fineco/papers/commodity/commodity_paper_new/output"
files <- c("Pre-Crisis","Subprime_Crisis","Sovereign_Debt_Crisis","Stock_Crash_2015-16",
           "Pre-COVID-19","COVID-19","Russia-Ukraine_War","Post-Crisis_Recovery")
runit <- function(seeded) {
  for (p in files) {
    M <- as.matrix(read.csv(file.path(base, sprintf("fc_matrix_%s.csv", p)), check.names=FALSE, row.names=1))
    A <- abs(M); diag(A) <- 0
    thr <- median(A[upper.tri(A)])
    A[A <= thr] <- 0
    if (seeded) {
      g <- graph_from_adjacency_matrix(A, mode="undirected", weighted=TRUE, diag=FALSE)
      set.seed(42)
    } else {
      g <- graph_from_adjacency_matrix(A, mode="undirected", weighted=TRUE)
    }
    cm <- cluster_fast_greedy(g)
    cat(sprintf("\n===== %s (seeded=%s) =====\n", p, seeded))
    cat("N nodes:", vcount(g), " N communities:", length(cm), " modularity:", round(modularity(cm),4), "\n")
    mem <- membership(cm)
    for (k in sort(unique(mem))) {
      cat(sprintf("  Community %d: %s\n", k, paste(sort(names(mem)[mem==k]), collapse=", ")))
    }
  }
}
cat("########## VARIANT 1: set.seed(42) + diag=FALSE ##########\n")
runit(TRUE)
cat("\n########## VARIANT 2: no set.seed, no diag=FALSE ##########\n")
runit(FALSE)
