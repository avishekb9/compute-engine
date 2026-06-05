## CHANNEL ATTRIBUTION (Table 5) — the PUBLISHED method.
##
## Unlike the transparent substrate methods, this calls the published CRAN
## package `contagionchannels` (Bhandari, Parida & Sahu 2026, arXiv:2604.26546,
## GPL-3) DIRECTLY — it runs the paper's own two-stage detection-and-attribution
## pipeline, not a reimplementation. `run_contagion_pipeline()` reproduces the
## paper's Table 5: per-crisis-episode shares of five mutually exclusive
## transmission channels (Trade / Financial / Geopolitical / Behavioral /
## Monetary Policy), attributed via Stage-1 WQTE detection + Stage-2 IV/2SLS.
##
## Data is the package's OWN bundled LazyData (g20_returns + channel_proxies +
## crisis_periods) — NOT the engine's ce_returns / g20.xlsx panel.
##
## params: {episodes?(all 8), scale?(5), tau?(0.5), edge_quantile?(0.75), n_cores?}
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
suppressMessages(library(contagionchannels))

## The eight crisis sub-periods defined in the paper (order = crisis_periods).
EPISODES_ALL <- c("PreCrisis","GFC","ESDC","CSC","PreCOVID","COVID","RusUkr","MidEastTariffs")

p <- ce_params()

## episodes: optional subset of the 8 names; default all 8. Validate the subset.
episodes <- if (!is.null(p$episodes)) as.character(p$episodes) else EPISODES_ALL
bad <- setdiff(episodes, EPISODES_ALL)
if (length(bad)) ce_fail(paste("unknown episodes:", paste(bad, collapse = ", "),
                               "— must be a subset of", paste(EPISODES_ALL, collapse = ", ")))
if (!length(episodes)) ce_fail("'episodes' must name at least one of the 8 periods")

scale <- if (!is.null(p$scale)) as.integer(p$scale) else 5L
if (is.na(scale) || scale < 1L || scale > 8L) ce_fail("'scale' must be an integer 1-8")
tau <- if (!is.null(p$tau)) as.numeric(p$tau) else 0.5
if (!is.finite(tau) || tau <= 0 || tau >= 1) ce_fail("'tau' must be in (0,1)")
edge_quantile <- if (!is.null(p$edge_quantile)) as.numeric(p$edge_quantile) else 0.75
if (!is.finite(edge_quantile) || edge_quantile <= 0 || edge_quantile >= 1) ce_fail("'edge_quantile' must be in (0,1)")
n_cores <- if (!is.null(p$n_cores)) as.integer(p$n_cores) else max(1L, parallel::detectCores() - 2L)
if (is.na(n_cores) || n_cores < 1L) n_cores <- 1L

## CRITICAL: ALWAYS run ALL 8 episodes internally — the pipeline computes its
## absolute edge threshold from threshold_period="PreCrisis", so PreCrisis must
## be present. Filtering to the requested subset happens AFTER, so the emitted
## numbers always match the paper regardless of which subset was requested.
d   <- load_paper_data()
ch  <- build_channel_composites(d$proxies)
res <- run_contagion_pipeline(d$returns, ch, d$periods,
         scale = scale, tau = tau, threshold_period = "PreCrisis",
         edge_quantile = edge_quantile, n_cores = n_cores)

ps <- res$period_shares                 # cols: Period, Trade, Financial, Geopolitical, Behavioral, Monetary, Dominant (already PERCENT, 1 dp)

## per-episode network n_links + density come from stage1[[period]]$summary
emit_eps <- list()
for (pname in episodes) {
  row <- ps[ps$Period == pname, , drop = FALSE]
  if (nrow(row) == 0) next             # period had < 50 obs or no links — skip honestly
  sm <- res$stage1[[pname]]$summary
  emit_eps[[length(emit_eps) + 1]] <- list(
    period = pname,
    shares = list(Trade = row$Trade, Financial = row$Financial,
                  Geopolitical = row$Geopolitical, Behavioral = row$Behavioral,
                  Monetary = row$Monetary),
    dominant = row$Dominant,
    n_links  = if (!is.null(sm)) sm$n_edges else NA_integer_,
    density  = if (!is.null(sm)) sm$density else NA_real_,
    exploratory = pname %in% c("GFC", "COVID")
  )
}
if (!length(emit_eps)) ce_fail("no requested episodes produced attributable links")

interpretation <- paste0(
  "Dominant transmission channel per episode — ",
  paste(vapply(emit_eps, function(e) paste0(e$period, ": ", e$dominant), character(1)), collapse = "; "),
  ". Shares are percent of |theta| across the five channels, attributed via the paper's ",
  "two-stage WQTE-detection + IV/2SLS pipeline (Table 5).")

ce_emit(list(
  method  = "channel_attribution",
  source  = "contagionchannels::run_contagion_pipeline — the paper's own published code, not a reimplementation",
  paper   = "arXiv:2604.26546",
  channels = c("Trade","Financial","Geopolitical","Behavioral","Monetary_Policy"),
  scale = scale, tau = tau, edge_quantile = edge_quantile,
  threshold = res$threshold,
  episodes = emit_eps,
  interpretation = interpretation
))
