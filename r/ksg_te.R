## Directed transfer entropy via the Kraskov-Stoegbauer-Grassberger (KSG)
## nearest-neighbour estimator, extended to conditional mutual information per
## Frenzel & Pompe (2007). For an ordered pair (Y -> X):
##
##   TE(Y->X) = I( X_{t+1} ; Y_t^(lag) | X_t^(lag) )                 [Schreiber 2000]
##
## estimated as the KSG/Frenzel-Pompe CMI in the max (Chebyshev) norm:
##
##   CMI = psi(k) + < psi(n_z+1) - psi(n_xz+1) - psi(n_yz+1) >       [Frenzel-Pompe 2007]
##
## where z is the conditioning set (X's own past) and eps_i is the distance to the
## k-th nearest neighbour of point i in the FULL joint (x,y,z) space. n_z / n_xz /
## n_yz count points whose marginal Chebyshev distance is STRICTLY < eps_i.
##
## Significance: IAAFT surrogates of the SOURCE series (iterative amplitude-adjusted
## Fourier transform, Schreiber & Schmitz 1996) preserve the source's amplitude
## distribution and linear autocorrelation while destroying its (possibly nonlinear)
## dependence on the target's past. p = (1 + #{TE_surr >= TE_obs}) / (B + 1).
##
## References:
##   Kraskov, Stoegbauer & Grassberger (2004), Phys. Rev. E 69, 066138.
##   Frenzel & Pompe (2007), Phys. Rev. Lett. 99, 204101.
##   Schreiber (2000), Phys. Rev. Lett. 85, 461.
##   Schreiber & Schmitz (1996), Phys. Rev. Lett. 77, 635 (IAAFT).
##
## params: {dataset?(g20), series?(default ALL columns), k?(4), lag?(1),
##          n_surrogates?(99), max_pairs?(cap directed pairs, for testing)}
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
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

## ---------------------------------------------------------------------------
## Driver
## ---------------------------------------------------------------------------
p   <- ce_params()
k   <- if (!is.null(p$k))   max(1L, as.integer(p$k))   else 4L
lag <- if (!is.null(p$lag)) max(1L, as.integer(p$lag)) else 1L
B   <- if (!is.null(p$n_surrogates)) max(0L, as.integer(p$n_surrogates)) else 99L

d  <- ce_returns(p)
Y  <- d$R[stats::complete.cases(d$R), , drop = FALSE]
nm <- d$cols; kk <- length(nm); n <- nrow(Y)
if (kk < 2L) ce_fail("ksg_te needs >= 2 series")
if (n < 200L) ce_fail(sprintf("too few complete rows (%d) for KSG-TE", n))

t0 <- Sys.time()

## all directed (ordered) pairs i -> j
pairs <- list()
for (i in seq_len(kk)) for (j in seq_len(kk)) if (i != j) pairs[[length(pairs) + 1L]] <- c(i, j)
if (!is.null(p$max_pairs)) {
  mp <- max(1L, as.integer(p$max_pairs))
  if (length(pairs) > mp) pairs <- pairs[seq_len(mp)]
}
total <- length(pairs)
ncores <- max(1L, parallel::detectCores() - 1L)

## one directed pair: observed TE + IAAFT-surrogate null + permutation p-value.
one_pair <- function(pi) {
  i <- pairs[[pi]][1]; j <- pairs[[pi]][2]      # i = source, j = target
  src <- Y[, i]; dst <- Y[, j]
  te_obs <- .te(src, dst, k, lag)
  ge <- 0L
  if (B > 0L) {
    surr <- vapply(seq_len(B), function(b) .te(.iaaft(src), dst, k, lag), numeric(1))
    ge <- sum(surr >= te_obs)
  }
  pval <- (1 + ge) / (B + 1)
  ## per-pair progress (no-op unless CE_PROGRESS=1); newline-terminated short line,
  ## atomic on Linux for sizes << PIPE_BUF, safe under FORK shared stdout.
  ce_progress(pi / total, sprintf("pair_%d_of_%d", pi, total),
              as.numeric(difftime(Sys.time(), t0, units = "secs")))
  list(from = nm[i], to = nm[j], te = te_obs, p = pval)
}

res <- parallel::mclapply(seq_len(total), one_pair, mc.cores = ncores, mc.preschedule = FALSE)
## surface any forked error rather than silently emitting a broken object
errs <- vapply(res, function(z) inherits(z, "try-error") || is.null(z$te), logical(1))
if (any(errs)) ce_fail(paste("KSG-TE failed on", sum(errs), "pair(s); first:",
                             as.character(res[[which(errs)[1]]])))

edges <- lapply(res, function(z) list(from = z$from, to = z$to,
                                      te = round(z$te, 6), p = round(z$p, 4)))
te_v  <- vapply(res, function(z) z$te, numeric(1))
p_v   <- vapply(res, function(z) z$p,  numeric(1))
sig   <- is.finite(p_v) & p_v < 0.05

## strongest significant edges (by TE), up to 5
ord_sig <- which(sig)[order(-te_v[sig])]
top <- lapply(head(ord_sig, 5L), function(ii)
  list(from = nm[pairs[[ii]][1]], to = nm[pairs[[ii]][2]],
       te = round(te_v[ii], 6), p = round(p_v[ii], 4)))

runtime <- as.numeric(difftime(Sys.time(), t0, units = "secs"))

ce_emit(list(
  method = "ksg_te",
  dataset = if (!is.null(p$dataset)) p$dataset else "g20",
  k = k, lag = lag, n_surrogates = B,
  n_series = kk, n_obs = n, n_pairs = total,
  n_significant = sum(sig),
  edges = edges,
  top = top,
  runtime_s = round(runtime, 1),
  interpretation = sprintf(
    "KSG transfer entropy (Kraskov k=%d, lag=%d, max-norm CMI per Frenzel-Pompe) across %d markets: %d of %d directed links are significant at p<0.05 vs %d IAAFT source surrogates.%s",
    k, lag, kk, sum(sig), total, B,
    if (length(top)) sprintf(" Strongest: %s->%s (TE=%.4f, p=%.3f).",
      top[[1]]$from, top[[1]]$to, top[[1]]$te, top[[1]]$p) else "")
))
