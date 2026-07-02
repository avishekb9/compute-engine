## Directed, scale-resolved, regime-conditioned transfer-entropy network — the
## published `mstcontagion` package (Parida, Bhandari & Sahu 2026,
## github.com/avishekb9/mstcontagion, GPL-3). Runs the paper's own method, not
## a reimplementation: maximal-overlap wavelet detail coefficients feed the
## SAME validated KSG/Frenzel-Pompe conditional-MI transfer-entropy estimator
## as ksg_te (shared verbatim from _ksg_core.R), pooled within a crisis or
## tranquil regime's contiguous episodes (the paper's own endogenous
## Markov-switching regime dates, bundled with the package), tested against
## IAAFT source surrogates under node-level Benjamini-Hochberg FDR control.
##
## Heavy (wavelet decomposition x k-d-tree CMI x surrogates, across up to
## 26x25 directed pairs) — runs ONLY as a background job via
## /api/jobs/submit; discoverable here but rejected by the sync
## /api/compute/run endpoint.
##
## params: {series?(2-26, default all 26), regime?(crisis|tranquil, default
##          crisis), scale?(D1|D2|D3|D4, default D1), k?(4), lag?(1),
##          n_surrogates?(99), nmax?(day budget per regime, default 500)}
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
suppressMessages(library(mstcontagion))

p <- ce_params()
regime <- if (!is.null(p$regime)) p$regime else "crisis"
if (!regime %in% c("crisis", "tranquil")) ce_fail("regime must be 'crisis' or 'tranquil'")
scale <- if (!is.null(p$scale)) p$scale else "D1"
if (!scale %in% c("D1", "D2", "D3", "D4")) ce_fail("scale must be one of D1, D2, D3, D4")
k    <- if (!is.null(p$k))   max(1L, as.integer(p$k))   else 4L
lag  <- if (!is.null(p$lag)) max(1L, as.integer(p$lag)) else 1L
B    <- if (!is.null(p$n_surrogates)) max(0L, as.integer(p$n_surrogates)) else 99L
nmax <- if (!is.null(p$nmax)) max(50L, as.integer(p$nmax)) else 500L

d  <- ce_returns(p)   # dataset = "crisis_regime_panel" (fixed below by the server registry)
Y  <- d$R; nm <- d$cols; kk <- length(nm); n <- nrow(Y)
if (kk < 2L) ce_fail("regime_conditioned_te needs >= 2 series")
if (n < 500L) ce_fail(sprintf("too few rows (%d) for regime_conditioned_te", n))

## regime dates: repo copy first, else the installed package's own bundled
## copy (system.file), same fallback idiom as the panel itself.
regime_path <- file.path(REPO, "papers/contagion-channels/MST-contagion/data/stress_regimes.csv")
if (!file.exists(regime_path)) regime_path <- system.file("extdata", "stress_regimes.csv", package = "mstcontagion")
if (!nzchar(regime_path) || !file.exists(regime_path)) ce_fail("stress_regimes.csv not found (repo or package)")
reg <- utils::read.csv(regime_path); reg$date <- as.Date(reg$date)
regime_dates <- reg$date[if (regime == "crisis") reg$crisis else !reg$crisis]
if (!length(regime_dates)) ce_fail(sprintf("no dates flagged '%s' in stress_regimes.csv", regime))

t0 <- Sys.time()
ce_progress(0.05, "winsorising_and_decomposing", 0)

w <- apply(Y, 2, function(x) {
  q <- stats::quantile(x, c(.001, .999), na.rm = TRUE); pmin(pmax(x, q[1]), q[2])
})
colnames(w) <- nm
detail <- mstcontagion::mst_wavelet_panel(w, scale, winsorise = FALSE)

eps <- mstcontagion::mst_cap_episodes(mstcontagion::mst_episodes(d$dates, regime_dates), nmax)
if (!length(eps)) ce_fail(sprintf("no %s-regime episodes overlap the selected series/date range", regime))
n_regime_days <- sum(vapply(eps, length, integer(1)))

ncores <- ce_ncores(p)
total_pairs <- kk * (kk - 1L)
ce_progress(0.15, sprintf("regime_network_%d_pairs_B%d", total_pairs, B),
            as.numeric(difftime(Sys.time(), t0, units = "secs")))

net <- mstcontagion::mst_regime_network(detail, eps, k = k, lag = lag, B = B, cores = ncores)

ce_progress(0.95, "summarising", as.numeric(difftime(Sys.time(), t0, units = "secs")))

edges <- list()
for (i in seq_len(kk)) for (j in seq_len(kk)) if (i != j) {
  edges[[length(edges) + 1L]] <- list(
    from = nm[i], to = nm[j],
    te = round(net$te_obs[i, j], 6),
    p  = round(net$edge_p[i, j], 4)
  )
}
te_v <- vapply(edges, function(z) z$te, numeric(1))
p_v  <- vapply(edges, function(z) z$p,  numeric(1))
sig  <- is.finite(p_v) & p_v < 0.05
ord_sig <- which(sig)[order(-te_v[sig])]
top <- lapply(head(ord_sig, 5L), function(ii) edges[[ii]])

nodes <- lapply(seq_len(kk), function(i) list(
  asset = nm[i],
  net_te = round(net$net_obs[i], 6),
  p = round(net$node_p[i], 4),
  q = round(net$node_q[i], 4)
))
node_order <- order(-net$net_obs)
top_senders <- nodes[node_order[seq_len(min(3L, kk))]]

runtime <- as.numeric(difftime(Sys.time(), t0, units = "secs"))

ce_emit(list(
  method = "regime_conditioned_te",
  dataset = "crisis_regime_panel",
  regime = regime, scale = scale, k = k, lag = lag, n_surrogates = B,
  n_series = kk, n_regime_days = n_regime_days, n_episodes = length(eps),
  n_pairs = total_pairs, n_significant_edges = sum(sig),
  assets = nm,
  edges = edges,
  top_edges = top,
  nodes = nodes,
  top_net_senders = top_senders,
  runtime_s = round(runtime, 1),
  paper = "Parida, Bhandari & Sahu (2026), working paper, IIT Bhubaneswar; R package: github.com/avishekb9/mstcontagion",
  interpretation = sprintf(
    "Regime-conditioned directed transfer-entropy network (Kraskov k=%d, lag=%d, wavelet scale %s, max-norm CMI per Frenzel-Pompe) across %d markets, pooled over %d %s-regime trading days (%d episodes): %d of %d directed links are significant at p<0.05 vs %d IAAFT source surrogates, node-level Benjamini-Hochberg controlled.%s",
    k, lag, scale, kk, n_regime_days, regime, length(eps), sum(sig), total_pairs, B,
    if (length(top)) sprintf(" Strongest: %s->%s (TE=%.4f, p=%.3f).",
      top[[1]]$from, top[[1]]$to, top[[1]]$te, top[[1]]$p) else "")
))
