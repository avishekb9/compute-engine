## Channel-attribution robustness badge — GFC Trade-dominance stability (Phase 31).
##
## Re-runs the PUBLISHED two-stage detection-and-attribution pipeline
## (contagionchannels::run_contagion_pipeline, Bhandari, Parida & Sahu 2026,
## arXiv:2604.26546, GPL-3 — the paper's OWN code) across the spec axes the
## package itself exposes: wavelet scale, detection quantile tau, and the edge
## threshold quantile. The baseline (scale=5, tau=0.5, edge_quantile=0.75)
## reproduces the paper's Table 5 to 0.000 pp with GFC dominant = Trade (27.9%).
##
## PRE-REGISTERED pass rule (fixed before execution, docs/PHASE31_CLOSURE.md):
##   pass(config) = Dominant(GFC) == "Trade"
## pass_rate over the grid. Identification is held fixed at the paper's own:
## threshold_period = "PreCrisis", all 8 episodes computed internally each run.
## Trade-share dispersion across configs is reported in the emit for honest
## reading (the badge is about channel ORDERING, not the 27.9 point estimate).
## Sensitivity analysis of one maintained claim — no multiplicity correction.
##
## Net-isolated: emits JSON only; the badge row is written by the orchestrator.
##
## params: {scale_grid?([4,5,6]), tau_grid?([.4,.5,.6]), eq_grid?([.70,.75,.80]), n_cores?}
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
suppressMessages(library(contagionchannels))

p <- ce_params()
num_grid <- function(x, default) {
  if (is.null(x)) return(default)
  v <- suppressWarnings(as.numeric(unlist(x)))
  if (length(v) == 0L || any(is.na(v))) ce_fail("channel_robustness: bad numeric grid")
  unique(v)
}
scale_grid <- as.integer(num_grid(p$scale_grid, c(4, 5, 6)))
tau_grid   <- num_grid(p$tau_grid, c(0.4, 0.5, 0.6))
eq_grid    <- num_grid(p$eq_grid, c(0.70, 0.75, 0.80))
n_cores    <- ce_ncores(p, 4L)
if (is.na(n_cores) || n_cores < 1L) n_cores <- 1L

d  <- load_paper_data()
ch <- build_channel_composites(d$proxies)

configs <- list()
for (s in scale_grid) for (tau in tau_grid) for (eq in eq_grid)
  configs[[length(configs) + 1L]] <- list(scale = s, tau = tau, eq = eq)

t0 <- Sys.time()
res <- vector("list", length(configs))
for (i in seq_along(configs)) {
  cfg <- configs[[i]]
  ce_progress(fraction = (i - 1) / length(configs),
              stage = sprintf("pipeline scale=%d tau=%.2f eq=%.2f (%d/%d)", cfg$scale, cfg$tau, cfg$eq, i, length(configs)),
              elapsed_s = as.numeric(difftime(Sys.time(), t0, units = "secs")))
  r <- tryCatch({
    out <- run_contagion_pipeline(d$returns, ch, d$periods,
             scale = cfg$scale, tau = cfg$tau, threshold_period = "PreCrisis",
             edge_quantile = cfg$eq, n_cores = n_cores)
    ps  <- out$period_shares
    g   <- ps[ps$Period == "GFC", , drop = FALSE]
    if (!nrow(g)) stop("no GFC row in period_shares")
    list(scale = cfg$scale, tau = cfg$tau, edge_quantile = cfg$eq, ok = TRUE,
         gfc_dominant = as.character(g$Dominant[1]),
         gfc_trade = as.numeric(g$Trade[1]), gfc_financial = as.numeric(g$Financial[1]),
         gfc_geopolitical = as.numeric(g$Geopolitical[1]), gfc_behavioral = as.numeric(g$Behavioral[1]),
         gfc_monetary = as.numeric(g$Monetary[1]), err = NA_character_)
  }, error = function(e) list(scale = cfg$scale, tau = cfg$tau, edge_quantile = cfg$eq, ok = FALSE,
                              gfc_dominant = NA_character_, gfc_trade = NA_real_, gfc_financial = NA_real_,
                              gfc_geopolitical = NA_real_, gfc_behavioral = NA_real_, gfc_monetary = NA_real_,
                              err = conditionMessage(e)))
  res[[i]] <- r
}

okr   <- Filter(function(r) isTRUE(r$ok), res)
pass  <- vapply(okr, function(r) identical(r$gfc_dominant, "Trade"), logical(1))
tr    <- vapply(okr, function(r) r$gfc_trade, numeric(1))
base  <- Filter(function(r) isTRUE(r$ok) && r$scale == 5L && r$tau == 0.5 && r$edge_quantile == 0.75, res)

ce_emit(list(
  method      = "channel_robustness",
  source      = "contagionchannels::run_contagion_pipeline — the paper's own published code",
  paper       = "arXiv:2604.26546",
  claim       = "GFC dominant transmission channel = Trade (Table 5: 27.9%)",
  criterion   = "pass = Dominant(GFC) == 'Trade' per (scale, tau, edge_quantile) config; threshold_period fixed at PreCrisis (the paper's identification); pre-registered",
  grid        = list(scale = scale_grid, tau = tau_grid, edge_quantile = eq_grid),
  configs     = res,
  n_grid      = length(configs),
  n_estimable = length(okr),
  pass_rate   = if (length(okr)) mean(pass) else NA_real_,
  gfc_trade_share = if (length(tr)) list(min = min(tr), median = stats::median(tr), max = max(tr)) else NULL,
  baseline    = if (length(base)) base[[1]] else NULL,
  elapsed_s   = as.numeric(difftime(Sys.time(), t0, units = "secs"))
))
