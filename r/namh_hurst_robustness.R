## NAMH Hurst-panel robustness badge — phi-weight ranking stability (Phase 31 closure).
##
## The NAMH framework's deterministic surface: namh::estimate_hurst_panel (v0.1.0,
## Bhandari & Sahu 2026, GPL-3 — the paper's OWN code) on the g20_24 panel. The
## canonical config (window=252, step=252 non-overlapping, order=1, s_min=10,
## n_scales=20) reproduces the cached published panel bit-exact (max|Δ| 4.9e-9).
##
## Claim badged: the cross-sectional ORDERING of NAMH node weights
## phi(H) = 1 - 2|H - 0.5| (which series sit nearest efficiency) is a property
## of the data, not of the estimation config.
##
## PRE-REGISTERED pass rule (fixed before execution, docs/PHASE31_CLOSURE.md):
##   pass(config) = Spearman rank correlation of per-series mean phi
##                  (config vs canonical) >= 0.70
## over the grid window x order x s_min, with step tied to window (the canonical
## non-overlapping convention) and n_scales fixed at 20. The canonical config is
## the anchor (rho = 1 by construction) and is EXCLUDED from pass_rate.
## Sensitivity analysis of one maintained quantity — no multiplicity correction.
##
## NOTE the honest scope: this badges the Hurst/phi surface ONLY. The NAMH
## surrogate-FDR network remains an honest AMBER hole (0/552 edges under the
## paper's own BH-FDR gate) and is NOT badged here.
##
## Net-isolated: emits JSON only; the badge row is written by the orchestrator.
##
## params: {dataset?(g20_24), window_grid?([126,252,504]), order_grid?([1,2]),
##          smin_grid?([8,10,12]), n_scales?(20)}
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
suppressMessages(library(namh))
if (!requireNamespace("xts", quietly = TRUE)) ce_fail("xts not installed")

p <- ce_params()
p$dataset <- if (!is.null(p$dataset)) p$dataset else "g20_24"

num_grid <- function(x, default) {
  if (is.null(x)) return(default)
  v <- suppressWarnings(as.numeric(unlist(x)))
  if (length(v) == 0L || any(is.na(v))) ce_fail("namh_hurst_robustness: bad numeric grid")
  unique(v)
}
window_grid <- as.integer(num_grid(p$window_grid, c(126, 252, 504)))
order_grid  <- as.integer(num_grid(p$order_grid, c(1, 2)))
smin_grid   <- as.integer(num_grid(p$smin_grid, c(8, 10, 12)))
n_scales    <- if (!is.null(p$n_scales)) as.integer(p$n_scales) else 20L

CANON <- list(window = 252L, step = 252L, order = 1L, s_min = 10L)

d <- ce_returns(p)
X <- xts::xts(d$R, order.by = d$dates)
colnames(X) <- d$cols

phi <- function(h) 1 - 2 * abs(h - 0.5)
## per-series mean phi for one config — mirrors r/namh_hurst.R exactly
phi_vec <- function(window, step, order, s_min) {
  panel <- namh::estimate_hurst_panel(X, window = window, step = step, order = order,
                                      s_min = s_min, n_scales = n_scales,
                                      stationarity_audit = FALSE)
  v <- vapply(names(panel), function(m) {
    Hv <- panel[[m]]$H[is.finite(panel[[m]]$H)]
    if (length(Hv)) mean(phi(Hv)) else NA_real_
  }, numeric(1))
  v[order(names(v))]
}

t0 <- Sys.time()
ce_progress(fraction = 0, stage = "canonical anchor (window=252, order=1, s_min=10)", elapsed_s = 0)
base <- tryCatch(phi_vec(CANON$window, CANON$step, CANON$order, CANON$s_min),
                 error = function(e) ce_fail(paste("canonical config failed:", conditionMessage(e))))

configs <- list()
for (w in window_grid) for (o in order_grid) for (s in smin_grid) {
  if (w < 4L * s) next                                   # estimator domain: window >= 4*s_min
  configs[[length(configs) + 1L]] <- list(window = w, step = w, order = o, s_min = s)
}

res <- vector("list", length(configs))
for (i in seq_along(configs)) {
  cfg <- configs[[i]]
  ce_progress(fraction = i / (length(configs) + 1),
              stage = sprintf("w=%d o=%d s_min=%d (%d/%d)", cfg$window, cfg$order, cfg$s_min, i, length(configs)),
              elapsed_s = as.numeric(difftime(Sys.time(), t0, units = "secs")))
  is_canon <- (cfg$window == CANON$window && cfg$order == CANON$order && cfg$s_min == CANON$s_min)
  r <- tryCatch({
    v <- phi_vec(cfg$window, cfg$step, cfg$order, cfg$s_min)
    common <- intersect(names(v)[is.finite(v)], names(base)[is.finite(base)])
    rho <- if (length(common) >= 5L) suppressWarnings(stats::cor(v[common], base[common], method = "spearman")) else NA_real_
    list(window = cfg$window, order = cfg$order, s_min = cfg$s_min, ok = TRUE, canonical = is_canon,
         spearman_phi = as.numeric(rho), n_series = length(common),
         top3 = paste(names(sort(v, decreasing = TRUE))[1:3], collapse = ","), err = NA_character_)
  }, error = function(e) list(window = cfg$window, order = cfg$order, s_min = cfg$s_min, ok = FALSE,
                              canonical = is_canon, spearman_phi = NA_real_, n_series = NA_integer_,
                              top3 = NA_character_, err = conditionMessage(e)))
  res[[i]] <- r
}

okr  <- Filter(function(r) isTRUE(r$ok) && !isTRUE(r$canonical), res)
pass <- vapply(okr, function(r) isTRUE(r$spearman_phi >= 0.70), logical(1))

ce_emit(list(
  method      = "namh_hurst_robustness",
  source      = "namh::estimate_hurst_panel — the paper's own published code",
  paper       = "NAMH (paper-v3, Bhandari & Sahu 2026)",
  claim       = "cross-sectional phi(H) ranking (efficiency ordering of the 24 series) is config-stable",
  criterion   = "pass = Spearman(phi ranking, config vs canonical 252/1/10) >= 0.70; canonical anchor excluded from pass_rate; step = window (non-overlapping); n_scales = 20 (pre-registered)",
  dataset     = p$dataset,
  grid        = list(window = window_grid, order = order_grid, s_min = smin_grid, n_scales = n_scales),
  canonical   = CANON,
  baseline_top3 = paste(names(sort(base, decreasing = TRUE))[1:3], collapse = ","),
  configs     = res,
  n_grid      = length(configs),
  n_estimable = length(okr),
  pass_rate   = if (length(okr)) mean(pass) else NA_real_,
  elapsed_s   = as.numeric(difftime(Sys.time(), t0, units = "secs"))
))
