## SOCH-B (shape direction-symmetry) robustness badge — Phase 31 / Pathway C.
##
## Re-runs the PUBLISHED symmetry test `soch_test_symmetry` (package sochcontagion,
## Bhandari & Parida 2026, GPL-3 — the paper's OWN code, not a reimplementation)
## across a grid of its nuisance parameters (quantile tau, wavelet levels J) on a
## fixed market set, and reports how stable the SOCH-B prediction is. SOCH-B says
## the directed WQTE scale-profile SHAPE is direction-symmetric; the pass criterion
## is the package's own `holds` flag (observed symmetry divergence D below the
## bootstrap null 95th percentile). The badge is the fraction of (config x pair)
## tests that hold.
##
## Default market set = the 8 advanced markets (market_groups$advanced -> 8C2 = 28
## unordered pairs), i.e. the "28/28" ground-truth set.
##
## Net-isolated: emits JSON only; the BigQuery badge row is written by the trusted
## orchestrator, never from inside the sandbox.
##
## params: {dataset?(g20), group?(advanced|emerging|all), tau_grid?([.05,.10]),
##          j_grid?([4,5]), n_boot?(200), filter?(la8)}
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
suppressMessages(library(sochcontagion))

p  <- ce_params()
d  <- ce_returns(p)
R  <- d$R[stats::complete.cases(d$R), , drop = FALSE]
nm <- colnames(R)
if (nrow(R) < 512L) ce_fail("too few complete rows for soch_robustness (need >= 512)")

grp <- if (!is.null(p$group)) p$group else "advanced"
mg  <- sochcontagion::market_groups
markets <- switch(grp,
  advanced = mg$advanced, emerging = mg$emerging, all = nm,
  ce_fail("group must be advanced|emerging|all"))
markets <- intersect(markets, nm)
if (length(markets) < 2L) ce_fail("need >= 2 markets present for SOCH-B")

num_grid <- function(x, default) {
  if (is.null(x)) return(default)
  v <- suppressWarnings(as.numeric(unlist(x)))
  if (length(v) == 0L || any(is.na(v))) ce_fail("soch_robustness: bad numeric grid")
  unique(v)
}
tau_grid <- num_grid(p$tau_grid, c(0.05, 0.10))
j_grid   <- as.integer(num_grid(p$j_grid, c(4, 5)))
B        <- if (!is.null(p$n_boot)) max(50L, as.integer(p$n_boot)) else 200L
wf       <- if (!is.null(p$filter)) p$filter else "la8"

t0 <- Sys.time()
configs <- list()
for (tau in tau_grid) for (J in j_grid) configs[[length(configs) + 1L]] <- list(tau = tau, J = J)

## one (tau,J): the published symmetry test over all pairs of `markets`.
one_cfg <- function(cfg) {
  s <- tryCatch(soch_test_symmetry(R, markets, tau = cfg$tau, J = cfg$J, B = B, filter = wf),
                error = function(e) conditionMessage(e))
  if (!is.data.frame(s))
    return(list(tau = cfg$tau, J = cfg$J, n_pairs = NA_integer_, holds = NA_integer_,
                ok = FALSE, err = as.character(s)))
  list(tau = cfg$tau, J = cfg$J, n_pairs = nrow(s), holds = sum(s$holds), ok = TRUE, err = NA_character_)
}
## modest outer parallelism (configs are independent); keep below core count so an
## internally-threaded test isn't oversubscribed.
ncores <- max(1L, min(length(configs), parallel::detectCores() %/% 4L, 4L))
res <- parallel::mclapply(configs, one_cfg, mc.cores = ncores, mc.preschedule = FALSE)

oks <- vapply(res, function(z) isTRUE(z$ok), logical(1))
if (!any(oks)) ce_fail(paste("soch_robustness: all configs failed; first:", res[[1]]$err))
n_ok        <- sum(oks)
total_tests <- sum(vapply(res[oks], function(z) z$n_pairs, numeric(1)))
total_holds <- sum(vapply(res[oks], function(z) z$holds,   numeric(1)))
pass_rate   <- if (total_tests > 0) total_holds / total_tests else NA_real_
badge <- if (is.na(pass_rate)) "untested" else if (pass_rate >= 0.90) "robust" else if (pass_rate >= 0.60) "conditional" else "fragile"

## baseline anchor: tau=0.05 with the smallest J in the grid (closest to the paper's headline).
base_i <- which(vapply(res, function(z) isTRUE(z$ok) && z$tau == 0.05, logical(1)))
base_i <- if (length(base_i)) base_i[which.min(vapply(res[base_i], function(z) z$J, numeric(1)))] else which(oks)[1]
baseline <- list(tau = res[[base_i]]$tau, J = res[[base_i]]$J,
                 holds = res[[base_i]]$holds, n_pairs = res[[base_i]]$n_pairs)

grid_out <- lapply(res, function(z) list(tau = z$tau, J = z$J, n_pairs = z$n_pairs,
                                         holds = z$holds, ok = z$ok))
runtime <- as.numeric(difftime(Sys.time(), t0, units = "secs"))

ce_emit(list(
  method = "soch_robustness", mode = "badge",
  target = "SOCH-B (directed WQTE scale-profile shape symmetry)",
  dataset = if (!is.null(p$dataset)) p$dataset else "g20",
  group = grp, n_markets = length(markets), markets = markets,
  grids = list(tau = tau_grid, J = j_grid), n_boot = B, filter = wf,
  n_configs = length(configs), n_ok = n_ok,
  n_grid_points = as.integer(total_tests),
  baseline = baseline,
  pass_rate = if (is.na(pass_rate)) NA else round(pass_rate, 4),
  badge = badge,
  criterion = "pass = package soch_test_symmetry `holds` (observed symmetry divergence D < bootstrap null q95) for each (tau,J,pair); badge robust>=0.90, conditional>=0.60, else fragile",
  grid = grid_out,
  runtime_s = round(runtime, 1),
  source = "Published method: sochcontagion::soch_test_symmetry (Bhandari & Parida 2026, GPL-3) — the live engine running the paper's own code.",
  interpretation = sprintf(
    "SOCH-B shape-symmetry robustness over tau{%s} x J{%s} on the %d %s markets (%d pairs/config, B=%d bootstrap): %d of %d (config x pair) symmetry tests hold -> pass_rate=%.3f -> badge '%s'. Baseline (tau=%.2f, J=%d): %d/%d pairs hold.",
    paste(tau_grid, collapse = ","), paste(j_grid, collapse = ","),
    length(markets), grp, if (n_ok > 0) res[[which(oks)[1]]]$n_pairs else 0L, B,
    as.integer(total_holds), as.integer(total_tests),
    if (is.na(pass_rate)) 0 else pass_rate, badge,
    baseline$tau, baseline$J, baseline$holds, baseline$n_pairs)
))
