## SOCH-A (scale ordering by adaptation speed) robustness badge — Phase 31 closure.
##
## Re-runs the PUBLISHED ordering test `soch_test_ordering` (package sochcontagion,
## Bhandari & Parida 2026, GPL-3 — the paper's OWN code, not a reimplementation)
## on directed WQTE profiles rebuilt by the package's own `soch_profiles`, across
## a grid of the two nuisance parameters (quantile tau, wavelet levels J).
##
## SOCH-A states: pairs containing slower (emerging) markets peak at COARSER
## wavelet scales — a positive slope of peak scale k* on the pair's emerging
## count. The published baseline (tau = 0.05, J = 5) reports p = 0.042.
##
## PRE-REGISTERED pass rule (fixed before execution, docs/PHASE31_CLOSURE.md):
##   pass(config) = slope > 0 AND p_value < 0.05   (the paper's own standard)
## pass_rate = share of grid configs passing. This is a SENSITIVITY analysis of
## one maintained hypothesis under nuisance variation — not a discovery sweep —
## so no cross-config multiplicity correction, by design (the ksg_robustness /
## soch_robustness convention). The directional share (slope > 0 regardless of
## p) is reported separately in the emit for honest reading.
##
## Net-isolated: emits JSON only; the BigQuery badge row is written by the
## trusted orchestrator, never from inside the sandbox.
##
## params: {dataset?(g20), tau_grid?([.05,.10]), j_grid?([4,5,6]), filter?(la8)}
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
suppressMessages(library(sochcontagion))

p  <- ce_params()
d  <- ce_returns(p)
R  <- d$R[stats::complete.cases(d$R), , drop = FALSE]
nm <- colnames(R)
if (nrow(R) < 512L) ce_fail("too few complete rows for soch_a_robustness (need >= 512)")

mg       <- sochcontagion::market_groups
advanced <- intersect(mg$advanced, nm)
emerging <- intersect(mg$emerging, nm)
markets  <- c(advanced, emerging)
if (length(advanced) < 2L || length(emerging) < 2L)
  ce_fail("SOCH-A needs both advanced and emerging markets present (slowness proxy must vary)")

num_grid <- function(x, default) {
  if (is.null(x)) return(default)
  v <- suppressWarnings(as.numeric(unlist(x)))
  if (length(v) == 0L || any(is.na(v))) ce_fail("soch_a_robustness: bad numeric grid")
  unique(v)
}
tau_grid <- num_grid(p$tau_grid, c(0.05, 0.10))
j_grid   <- as.integer(num_grid(p$j_grid, c(4, 5, 6)))
wf       <- if (!is.null(p$filter)) p$filter else "la8"

configs <- list()
for (tau in tau_grid) for (J in j_grid) configs[[length(configs) + 1L]] <- list(tau = tau, J = J)

t0 <- Sys.time()
res <- vector("list", length(configs))
for (i in seq_along(configs)) {
  cfg <- configs[[i]]
  ce_progress(fraction = (i - 1) / length(configs),
              stage = sprintf("profiles tau=%.2f J=%d (%d/%d)", cfg$tau, cfg$J, i, length(configs)),
              elapsed_s = as.numeric(difftime(Sys.time(), t0, units = "secs")))
  r <- tryCatch({
    prof <- soch_profiles(R, markets, tau = cfg$tau, J = cfg$J, filter = wf)
    tst  <- soch_test_ordering(prof, emerging = emerging)
    list(tau = cfg$tau, J = cfg$J, ok = TRUE,
         slope = as.numeric(tst$slope), t = as.numeric(tst$t), p_value = as.numeric(tst$p_value),
         n_profiles = length(prof), err = NA_character_)
  }, error = function(e) list(tau = cfg$tau, J = cfg$J, ok = FALSE,
                              slope = NA_real_, t = NA_real_, p_value = NA_real_,
                              n_profiles = NA_integer_, err = conditionMessage(e)))
  res[[i]] <- r
}

okr        <- Filter(function(r) isTRUE(r$ok), res)
pass       <- vapply(okr, function(r) isTRUE(r$slope > 0 && r$p_value < 0.05), logical(1))
sign_only  <- vapply(okr, function(r) isTRUE(r$slope > 0), logical(1))
base       <- Filter(function(r) isTRUE(r$ok) && r$tau == 0.05 && r$J == 5L, res)

ce_emit(list(
  method      = "soch_a_robustness",
  source      = "sochcontagion::soch_profiles + soch_test_ordering — the paper's own published code",
  paper       = "arXiv:2606.04113",
  claim       = "SOCH-A: peak scale increases with pair slowness (positive slope; published p = 0.042 at tau=.05, J=5)",
  criterion   = "pass = slope > 0 AND p < 0.05 per (tau, J) config; sensitivity analysis, no cross-config multiplicity correction (pre-registered)",
  markets     = list(advanced = advanced, emerging = emerging),
  grid        = list(tau = tau_grid, J = j_grid, filter = wf),
  configs     = res,
  n_grid      = length(configs),
  n_estimable = length(okr),
  pass_rate   = if (length(okr)) mean(pass) else NA_real_,
  positive_slope_rate = if (length(okr)) mean(sign_only) else NA_real_,
  baseline    = if (length(base)) base[[1]] else NULL,
  elapsed_s   = as.numeric(difftime(Sys.time(), t0, units = "secs"))
))
