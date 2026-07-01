## v5 / T2 -- nonlinear Bellman value iteration on the recovered plant (the
## keystone: the contraction whose fixed point is the space's completion).
## Reproduces FRONTIERS V.2 Theorem 2: the Bellman operator contracts at the
## discount rate beta, value iteration converges to a unique value function, and
## the optimal policy's rest point is the turnpike (= V.1's interior optimum).
## params: {c_adj?: num, shock_sd?: num}  (defaults = the V.2 calibration)
src <- function(f) source(file.path(dirname(sub("--file=", "",
  grep("--file=", commandArgs(FALSE), value = TRUE))), f))
src("_io.R"); src("_control_core.R")

p  <- ce_params()
pl <- v5_plant(); h <- pl$hyper
c_adj    <- if (!is.null(p$c_adj))    as.numeric(p$c_adj)    else h$c_adj
shock_sd <- if (!is.null(p$shock_sd)) as.numeric(p$shock_sd) else h$shock_sd
beta <- h$beta_planner
## certification-gate ENFORCEMENT (Project V): structural control acts on the
## adjustment speed eta (STRONG); a request to control an UNIDENTIFIED object is
## refused here, never answered with a number.
ctrl_target <- if (!is.null(p$target)) as.character(p$target) else "eta"
ctrl_gate   <- gate_guard_target(ctrl_target)

ac <- activity_curve(pl)                       # genuine trace(Sigma_x)(eta) on G_cal
eta_ref <- 0.96718                             # V.1 interior optimum (normaliser)
tr_ref  <- lyap_trace(phi_from(pl$G, eta_ref), diag(pl$n))
trace_n <- ac$trace / tr_ref
u_grid  <- seq(h$u_grid$lo, h$u_grid$hi, length.out = h$u_grid$n)

vi <- value_iteration(ac$eta, trace_n, u_grid, beta, c_adj, shock_sd,
                      tol = h$vi_tol, maxit = h$vi_max_iter)
diffs  <- vi$diffs
ratios <- diffs[-1] / pmax(diffs[-length(diffs)], 1e-300)
tail_ratio <- median(ratios[(floor(length(ratios) / 2) + 1):length(ratios)])
du  <- u_grid[2] - u_grid[1]
rest <- which(abs(vi$policy) < du + 1e-12)
rest_eta <- if (length(rest)) ac$eta[rest[floor(length(rest) / 2) + 1]] else NA_real_

ce_emit_hp(list(
  method = "bellman_value", theorem = "V.2-T2",
  control_target = ctrl_target, control_target_gate = ctrl_gate,
  n = pl$n, beta = beta, c_adj = c_adj, shock_sd = shock_sd,
  iters = vi$iters,
  contraction_ratio = tail_ratio,
  contraction_matches_beta = abs(tail_ratio - beta) < 1e-6,
  policy_rest_eta = rest_eta,
  value_at_rest = vi$V[which.min(abs(ac$eta - rest_eta))],
  diffs_head = as.numeric(head(diffs, 6)),
  diffs_tail = as.numeric(tail(diffs, 3)),
  interpretation = paste0("the Bellman operator contracts at modulus ",
    round(tail_ratio, 4), " = beta; value iteration converges in ", vi$iters,
    " steps to a unique value function whose optimal-policy rest point eta = ",
    round(rest_eta, 4), " is the turnpike."),
  gate = list(contraction = GATE$contraction, value_function = GATE$value_function,
              policy_rest_eta = GATE$turnpike),
  provenance = pl$provenance
))
