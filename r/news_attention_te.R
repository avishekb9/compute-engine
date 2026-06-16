## news_attention_te.R — directed KSG transfer entropy on the news-attention panel.
##
## Frontiers III ("The Directed Network of News Attention"). For an ordered topic
## pair (Y -> X) of news-attention log-changes:
##
##   TE(Y->X) = I( X_{t+1} ; Y_t^(lag) | X_t^(lag) )                 [Schreiber 2000]
##
## estimated as the KSG/Frenzel-Pompe conditional MI in the max (Chebyshev) norm —
## the SAME validated estimator as ksg_te (shared verbatim from _ksg_core.R), bound
## to the `news_attention` dataset (daily log-changes of 15 channel-tagged topics).
##
## DETERMINISTIC: raw transfer entropy, no surrogates -> reproduce-eligible. The
## engine reproduces the working paper's GPU-computed TE_matrix to the published
## precision (e.g. TE(inflation -> election) = 0.065781). The IAAFT-gated
## significance network (the published significant-edge adjacency, density, FDR) is
## the async `ksg_te` method run with dataset=news_attention — significance needs
## surrogates (unseeded -> not bit-reproducible) and is NOT computed here.
##
## params: {dataset?(news_attention), series?(default ALL 15 topics; pass exactly two
##          [src,dst] for one ordered pair), k?(4), lag?(1)}
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_ksg_core.R"))

p   <- ce_params()
k   <- if (!is.null(p$k))   max(1L, as.integer(p$k))   else 4L
lag <- if (!is.null(p$lag)) max(1L, as.integer(p$lag)) else 1L
if (is.null(p$dataset)) p$dataset <- "news_attention"   # bind to the news panel

d  <- ce_returns(p)
Y  <- d$R[stats::complete.cases(d$R), , drop = FALSE]
nm <- d$cols; kk <- length(nm); n <- nrow(Y)
if (kk < 2L) ce_fail("news_attention_te needs >= 2 topics")
if (n < 200L) ce_fail(sprintf("too few complete rows (%d) for KSG-TE", n))

t0 <- Sys.time()

## all directed (ordered) pairs i -> j among the selected topics
pairs <- list()
for (i in seq_len(kk)) for (j in seq_len(kk)) if (i != j) pairs[[length(pairs) + 1L]] <- c(i, j)
total <- length(pairs)

## GPU offload first (B=0: raw TE, no surrogates); bit-exact CPU fallback on no-CUDA.
res <- ce_ksg_gpu_pairs(Y, pairs, nm, k, lag, 0L)
compute_path <- if (is.null(res)) "cpu" else "gpu"
gpu_device   <- if (is.null(res)) NA_character_ else attr(res, "device")
if (is.null(res)) {
  ncores <- ce_ncores(p)
  res <- parallel::mclapply(seq_len(total), function(pi) {
    i <- pairs[[pi]][1]; j <- pairs[[pi]][2]
    list(from = nm[i], to = nm[j], te = .te(Y[, i], Y[, j], k, lag))
  }, mc.cores = ncores, mc.preschedule = FALSE)
}
errs <- vapply(res, function(z) inherits(z, "try-error") || is.null(z$te) || !is.finite(z$te), logical(1))
if (any(errs)) ce_fail(paste("news_attention_te failed on", sum(errs), "pair(s)"))

## directed TE matrix + raw (ungated) out/in strength
TE <- matrix(0, kk, kk); dimnames(TE) <- list(nm, nm)
for (z in res) TE[z$from, z$to] <- z$te
out_str <- rowSums(pmax(TE, 0)); in_str <- colSums(pmax(TE, 0))
ord_out <- order(-out_str); ord_in <- order(-in_str)
te_matrix <- lapply(seq_len(kk), function(i) as.numeric(round(TE[i, ], 6)))
top_b <- lapply(head(ord_out, 5L), function(ii) list(topic = nm[ii], out_strength = round(out_str[ii], 6)))
top_r <- lapply(head(ord_in, 5L), function(ii) list(topic = nm[ii], in_strength = round(in_str[ii], 6)))
runtime <- as.numeric(difftime(Sys.time(), t0, units = "secs"))

## strongest single directed edge (named) — convenient reproduce anchor
mx <- which(TE == max(TE), arr.ind = TRUE)[1, ]
strongest <- list(from = nm[mx[1]], to = nm[mx[2]], te = round(TE[mx[1], mx[2]], 6))

ce_emit(list(
  method = "news_attention_te",
  dataset = p$dataset,
  k = k, lag = lag,
  n_series = kk, n_obs = n, n_pairs = total,
  topics = nm,
  te_matrix = te_matrix,
  strongest_edge = strongest,
  raw_out_strength_top = top_b,
  raw_in_strength_top = top_r,
  compute_path = compute_path,
  gpu_device = gpu_device,
  runtime_s = round(runtime, 1),
  deterministic = TRUE,
  note = paste("Raw KSG transfer entropy (max-norm Frenzel-Pompe CMI, no surrogates)",
               "-> deterministic, reproduce-eligible. Raw out/in strengths are NOT the",
               "published significance-gated centralities; the significant-edge network,",
               "density and FDR come from the async ksg_te method on dataset=news_attention."),
  interpretation = sprintf(
    "Directed news-attention transfer-entropy network over %d topics (raw magnitudes, Kraskov k=%d, lag=%d, max-norm CMI per Frenzel-Pompe). Strongest directed edge %s->%s (TE=%.6f). Raw top broadcaster %s, raw top receiver %s. Significance gating via the async ksg_te path.",
    kk, k, lag, strongest$from, strongest$to, strongest$te, nm[ord_out[1]], nm[ord_in[1]])
))
