## Shared KSG transfer-entropy estimator internals.
##
## MOVED VERBATIM out of ksg_te.R (no logic change) so both ksg_te.R and
## ksg_robustness.R can reuse the SAME validated estimator. ksg_te.R was validated
## against the closed-form Gaussian MI and a known directed-coupling system; these
## functions must not change in behaviour.
suppressMessages({ library(FNN); library(parallel) })

## ---------------------------------------------------------------------------
## Estimator internals (all in the max / Chebyshev norm; validated against the
## closed-form Gaussian MI and a known directed-coupling system — see report).
## ---------------------------------------------------------------------------

## k-th smallest of each row, without a full sort (m is small: ~k*sqrt(d)*3).
.row_kth <- function(M, k) {
  n <- nrow(M); cur <- M
  for (s in seq_len(k - 1L)) {
    mn <- max.col(-cur, ties.method = "first")
    cur[cbind(seq_len(n), mn)] <- Inf
  }
  cur[cbind(seq_len(n), max.col(-cur, ties.method = "first"))]
}

## Exact distance to the k-th nearest neighbour of each point under the max norm.
## FNN's k-d-tree is L2-only; since L_inf <= L_2 <= sqrt(d)*L_inf, the true L_inf
## k-NN are contained in the L2 ball of radius sqrt(d)*eps_inf. We pull an inflated
## L2 candidate list, recompute exact Chebyshev distances, take the k-th smallest,
## and accept a point's value only once its candidate list provably covers that
## radius (sqrt(d)*ek <= farthest L2 candidate). Only the still-uncovered points
## (typically a few heavy-tailed outliers) are re-queried at a larger k -- widening
## the whole n-by-kq matrix for them would be O(n^2) on real return data.
.maxnorm_knn_dist <- function(M, k) {
  n <- nrow(M); d <- ncol(M)
  ek <- numeric(n); todo <- seq_len(n)
  kq <- min(n - 1L, max(k + 1L, ceiling(k * sqrt(d) * 3) + 5L))
  repeat {
    nn  <- FNN::get.knnx(M, M[todo, , drop = FALSE], k = kq + 1L, algorithm = "kd_tree")
    idx <- nn$nn.index
    cd  <- matrix(0, nrow(idx), kq + 1L)
    for (c in seq_len(d)) { col <- M[, c]; cd <- pmax(cd, abs(matrix(col[idx], nrow(idx), kq + 1L) - col[todo])) }
    cd[idx == todo] <- Inf                            # exclude self
    ekt <- .row_kth(cd, k)
    covered <- (sqrt(d) * ekt <= nn$nn.dist[, kq + 1L] + 1e-9) | (kq >= n - 1L)
    ek[todo[covered]] <- ekt[covered]
    todo <- todo[!covered]
    if (!length(todo) || kq >= n - 1L) return(ek)
    kq <- min(n - 1L, kq * 4L)
  }
}

## Count points with Chebyshev distance STRICTLY < eps_i (excluding self).
## d==1: exact O(n log n) via a sorted array + findInterval.
.count_1d <- function(v, eps) {
  sv <- sort(v)
  hi <- findInterval(v + eps - 1e-12, sv)            # # values < v+eps
  lo <- findInterval(v - eps, sv)                    # # values <= v-eps
  pmax(hi - lo - 1L, 0L)                             # strict band, minus self
}
## d>=2: FNN k-NN with adaptive widening (each eps-ball usually holds ~k points).
.count_kd <- function(M, eps) {
  n <- nrow(M); d <- ncol(M)
  cnt <- integer(n); todo <- seq_len(n); kk <- min(n - 1L, 32L)
  repeat {
    nn  <- FNN::get.knnx(M, M[todo, , drop = FALSE], k = kk + 1L, algorithm = "kd_tree")
    idx <- nn$nn.index
    cd  <- matrix(0, nrow(idx), kk + 1L)
    for (c in seq_len(d)) { col <- M[, c]; cd <- pmax(cd, abs(matrix(col[idx], nrow(idx), kk + 1L) - col[todo])) }
    cd[idx == todo] <- Inf
    cnt[todo] <- rowSums(cd < eps[todo])
    covered <- (sqrt(d) * eps[todo]) <= nn$nn.dist[, kk + 1L] + 1e-9   # eps-ball fully inside list
    todo <- todo[!covered]
    if (!length(todo) || kk >= n - 1L) break
    kk <- min(n - 1L, kk * 4L)
  }
  cnt
}
.count_within <- function(M, eps) {
  M <- as.matrix(M)
  if (ncol(M) == 1L) .count_1d(M[, 1], eps) else .count_kd(M, eps)
}

## KSG/Frenzel-Pompe conditional mutual information I(X;Y|Z), max norm.
.ksg_cmi <- function(X, Y, Z, k) {
  X <- as.matrix(X); Y <- as.matrix(Y); Z <- as.matrix(Z)
  eps <- .maxnorm_knn_dist(cbind(X, Y, Z), k)
  val <- digamma(k) + mean(digamma(.count_within(Z, eps) + 1) -
                           digamma(.count_within(cbind(X, Z), eps) + 1) -
                           digamma(.count_within(cbind(Y, Z), eps) + 1))
  val
}

## Lag embedding: column-bind v_{t-0}, v_{t-1}, ..., v_{t-(lag-1)} for a vector v.
.embed_lags <- function(v, lag) {
  n <- length(v)
  do.call(cbind, lapply(seq_len(lag) - 1L, function(d) v[(lag - d):(n - d)]))
}

## TE(src -> dst) = I( dst_{t+1} ; src_t^(lag) | dst_t^(lag) ).
## Align so that dst_{t+1} pairs with the lag-blocks ending at t.
.te <- function(src, dst, k, lag) {
  n <- length(dst)
  Dpast <- .embed_lags(dst, lag)            # rows index t = lag .. n-1 (last row drops)
  Spast <- .embed_lags(src, lag)
  m <- nrow(Dpast)
  Dpast <- Dpast[-m, , drop = FALSE]        # t = lag .. n-1
  Spast <- Spast[-m, , drop = FALSE]
  Xt1   <- dst[(lag + 1L):n]                # dst_{t+1}, same length as the trimmed blocks
  .ksg_cmi(Xt1, Spast, Dpast, k)
}

## IAAFT surrogate of x (Schreiber & Schmitz 1996): alternately impose x's Fourier
## amplitude spectrum and x's empirical amplitude distribution until the rank order
## stabilises. The final step imposes the amplitude distribution exactly, so the
## surrogate has the same marginal as x (which the KSG estimator is sensitive to).
.iaaft <- function(x, n_iter = 100L) {
  n <- length(x); sx <- sort(x); amp <- Mod(fft(x))
  s <- x[sample.int(n)]; prev <- NULL
  for (it in seq_len(n_iter)) {
    S <- fft(s); ph <- S / pmax(Mod(S), 1e-12)
    s2 <- Re(fft(amp * ph, inverse = TRUE)) / n        # impose spectrum
    r  <- rank(s2, ties.method = "first")
    s  <- sx[r]                                        # impose amplitude distribution
    if (!is.null(prev) && all(r == prev)) break
    prev <- r
  }
  s
}
