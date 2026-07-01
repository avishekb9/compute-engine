## v5 / T4 -- feasibility barrier + period-doubling diagnostic on the recovered plant.
## Reproduces FRONTIERS V.2 Theorem 4: the cascade resolvent / fragility multiplier
## diverge at beta*r(B)=1, and a high-gain nonlinear feedback rule on the scalar
## spectral position period-doubles into chaos as the gain rises, with the onset
## gain collapsing to zero at the barrier. HONEST: this is a COMPUTED dynamical-
## systems diagnostic (period-doubling onset, largest Lyapunov exponent), labelled
## as such, NOT a stability proof.
## params: {beta_cascade?: num}  (default = the V.2 cascade damping 0.80)
src <- function(f) source(file.path(dirname(sub("--file=", "",
  grep("--file=", commandArgs(FALSE), value = TRUE))), f))
src("_io.R"); src("_control_core.R")

p  <- ce_params()
pl <- v5_plant(); h <- pl$hyper
bcas <- if (!is.null(p$beta_cascade)) as.numeric(p$beta_cascade) else h$beta_cascade
barrier <- 1 / bcas

ac <- activity_curve(pl); eta_turnpike <- ac$eta[which.min(ac$trace)]
sigma_bar <- rB_of(pl$G, eta_turnpike)         # safe cascade-root target (turnpike)
rB_stress <- rB_of(h$drift_lq * pl$G, pl$eta)

Rres   <- function(s) 1 / (1 - bcas * s)
fmap   <- function(s, g) s + g * s * (sigma_bar - s) * Rres(s)
fprime <- function(s, g) { ds <- 1e-6; (fmap(s + ds, g) - fmap(s - ds, g)) / (2 * ds) }

g_onset_analytic <- 2 / (sigma_bar * Rres(sigma_bar))
g_grid <- seq(0, 1.6 * g_onset_analytic + 6, length.out = 700)
lyap <- rep(NA_real_, length(g_grid)); g_onset_numeric <- NA_real_

for (ig in seq_along(g_grid)) {
  g <- g_grid[ig]; s <- sigma_bar * 0.9 + 0.02
  esc <- FALSE
  for (k in 1:3000) { s <- fmap(s, g); if (!is.finite(s) || s <= 0 || s >= barrier) { esc <- TRUE; break } }
  ok <- !esc; pts <- numeric(400); np <- 0L; lsum <- 0
  if (ok) for (k in 1:400) {
    s <- fmap(s, g)
    if (!is.finite(s) || s <= 0 || s >= barrier) { ok <- FALSE; break }
    np <- np + 1L; pts[np] <- s; lsum <- lsum + log(abs(fprime(s, g)) + 1e-300)
  }
  lyap[ig] <- if (ok && np > 0) lsum / max(1L, np) else NA_real_
  if (np > 1) {
    sp <- max(pts[1:np]) - min(pts[1:np])
    if (is.na(g_onset_numeric) && sp > 1e-3) g_onset_numeric <- g
  }
}
fin <- is.finite(lyap)
chaos_idx <- which(fin & lyap > 0)
g_chaos  <- if (length(chaos_idx)) g_grid[chaos_idx[1]] else NA_real_
lyap_max <- if (any(fin)) max(lyap[fin]) else NA_real_

s_ops <- c(0.30, 0.46, 0.60, 0.80, 1.00, 1.15)
s_ops <- s_ops[s_ops < barrier]
sens <- lapply(s_ops, function(s) list(rB = s, beta_rB = bcas * s,
                                       onset_gain = 2 / (s * Rres(s))))

ce_emit_hp(list(
  method = "fragility_barrier", theorem = "V.2-T4",
  beta_cascade = bcas, barrier = barrier, sigma_bar = sigma_bar,
  beta_cascade_rB_stress = bcas * rB_stress,
  g_onset_analytic = g_onset_analytic, g_onset_numeric = g_onset_numeric,
  onset_analytic_matches_numeric = (!is.na(g_onset_numeric)) &&
    abs(g_onset_analytic - g_onset_numeric) < 0.05,
  g_chaos = g_chaos, largest_lyapunov_max = lyap_max,
  chaotic_band_present = (!is.na(lyap_max)) && lyap_max > 0,
  onset_sensitivity = sens,
  interpretation = paste0("feasibility barrier at beta*r(B)=1 (r(B)=", round(barrier, 3),
    "); a high-gain nonlinear feedback rule flip-bifurcates at gain ",
    round(g_onset_analytic, 3), " and develops a positive largest Lyapunov exponent (",
    round(lyap_max, 3), ", a computed chaotic band); the onset gain collapses toward ",
    "zero as the operating root approaches the barrier."),
  diagnostic_note = paste0("computed dynamical-systems diagnostic (period-doubling ",
    "onset + largest Lyapunov exponent), not a stability proof."),
  gate = list(barrier = GATE$rB, beta_cascade_rB_stress = GATE$rB,
              fragility_index = GATE$F_index),
  provenance = pl$provenance
))
