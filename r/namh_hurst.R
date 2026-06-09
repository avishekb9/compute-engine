## NAMH rolling-window Hurst PANEL — the PUBLISHED method.
##
## Calls the published package `namh` (Bhandari & Sahu 2026, v0.1.0, GPL-3,
## github.com/avishekb9/namh) DIRECTLY: `namh::estimate_hurst_panel` runs
## Detrended Fluctuation Analysis DFA-ell (Peng et al. 1994) on a rolling window
## per market. This is the FIRST NAMH primitive and supplies the node-weight
## phi(H) = 1 - 2|H - 0.5| that feeds the NAMH fixed point E* = (I-A)^{-1}(phi+g1).
## Like `soch_profile` (and unlike the `wqte` substrate reimplementation) this is
## the live engine running the paper's own code, not a reimplementation.
##
## REPRODUCE TARGET: papers/namh/output/diagnostics/01_hurst_panel.csv, the
## canonical paper-v3 panel (24 markets x 20 NON-overlapping windows, DFA-1).
## The canonical config is NON-DEFAULT and is the default HERE: window=252,
## STEP=252 (contiguous yearly blocks, verified from the cached date ranges),
## order=1, s_min=10, n_scales=20. The package's own defaults (step=21) give
## ~231 OVERLAPPING windows, NOT the paper's 20 — do not use them for repro.
## Reproduction is NOT bit-exact (DFA realisation differences ~1e-2); the honest
## Delta is reported by namh_reproduce / reproduce.html, never assumed zero.
##
## params: {dataset?(g20_24), series?[subset], window?(252), step?(252),
##          order?(1), s_min?(10), n_scales?(20), audit?(false), panel?(false)}
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
suppressMessages(library(namh))

p <- ce_params()
ds <- if (!is.null(p$dataset)) p$dataset else "g20_24"
p$dataset <- ds

ip <- function(v, d) { if (is.null(v)) return(d); x <- as.integer(v); if (is.na(x)) ce_fail("non-integer param"); x }
window   <- ip(p$window,   252L)
step     <- ip(p$step,     252L)
order    <- ip(p$order,      1L)
s_min    <- ip(p$s_min,     10L)
n_scales <- ip(p$n_scales,  20L)
audit    <- isTRUE(p$audit)            # ADF/KPSS per window; off by default (does NOT affect H)
full     <- isTRUE(p$panel)            # emit the full long panel for reproduce verification
if (window < 4 * s_min) ce_fail("window too short for s_min (need window >= 4*s_min)")
if (step < 1 || order < 1 || order > 3 || s_min < 4 || n_scales < 4) ce_fail("param out of range")

d <- ce_returns(p)                     # respects dataset whitelist + series subset + start/end
if (!requireNamespace("xts", quietly = TRUE)) ce_fail("xts not installed (required by estimate_hurst_panel)")
X <- xts::xts(d$R, order.by = d$dates)
colnames(X) <- d$cols

## published panel estimator: named list, one data.frame per market, with
## date_start/date_end appended (columns: start_idx,end_idx,H,H_se,F_R2,adf_p,kpss_p)
panel <- namh::estimate_hurst_panel(X, window = window, step = step, order = order,
                                    s_min = s_min, n_scales = n_scales,
                                    stationarity_audit = audit)

phi <- function(h) 1 - 2 * abs(h - 0.5)          # NAMH node-weight (local efficiency)
per_series <- lapply(names(panel), function(m) {
  h  <- panel[[m]]
  Hv <- h$H[is.finite(h$H)]
  list(market = m,
       n_windows = nrow(h),
       n_valid   = length(Hv),
       H_mean = if (length(Hv)) mean(Hv) else NA_real_,
       H_sd   = if (length(Hv) > 1) stats::sd(Hv) else NA_real_,
       H_first = if (length(Hv)) Hv[1] else NA_real_,
       H_last  = if (length(Hv)) Hv[length(Hv)] else NA_real_,
       phi_mean = if (length(Hv)) mean(phi(Hv)) else NA_real_)   # mean local efficiency
})

out <- list(
  method  = "namh_hurst",
  dataset = ds,
  config  = list(window = window, step = step, order = order, s_min = s_min,
                 n_scales = n_scales, stationarity_audit = audit),
  n_series  = length(panel),
  n_windows = max(vapply(panel, nrow, integer(1))),
  per_series = per_series,
  source = "Published method: namh::estimate_hurst_panel (v0.1.0, Bhandari & Sahu 2026, GPL-3) — DFA-l Hurst (Peng et al. 1994) supplying the NAMH node-weight phi(H)=1-2|H-0.5|. Live engine running the paper's own code."
)

if (full) {
  ## long panel for reproduce verification: market, window, date_start, date_end, H, H_se, F_R2
  rows <- list()
  for (m in names(panel)) {
    h <- panel[[m]]
    for (i in seq_len(nrow(h))) {
      rows[[length(rows) + 1L]] <- list(
        market = m, window = i,
        date_start = as.character(h$date_start[i]),
        date_end   = as.character(h$date_end[i]),
        H = h$H[i], H_se = h$H_se[i], F_R2 = h$F_R2[i])
    }
  }
  out$panel <- rows
}

ce_emit(out)
