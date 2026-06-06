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
## Estimator internals (.row_kth/.maxnorm_knn_dist/.count_*/.ksg_cmi/.embed_lags/
## .te/.iaaft + FNN/parallel) live in _ksg_core.R — shared verbatim with ksg_robustness.R.
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_ksg_core.R"))

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
