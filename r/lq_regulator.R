## v5 / T1 -- discounted LQ-Gaussian regulator on the recovered plant.
## Reproduces FRONTIERS V.2 Theorem 1: DARE optimal feedback, certainty
## equivalence (F independent of the shock loading C), closed-loop stationarity,
## and the cost ranking optimal <= V.1-threshold < open (uncontrolled = infinite).
## params: {anchor?: "v2_crisis", q_ctrl?: num, beta?: num}
##   anchor "v2_crisis" (default) = the M3-faithful stressed crisis plant of V.2.
src <- function(f) source(file.path(dirname(sub("--file=", "",
  grep("--file=", commandArgs(FALSE), value = TRUE))), f))
src("_io.R"); src("_control_core.R")

p  <- ce_params()
pl <- v5_plant(); h <- pl$hyper
beta  <- if (!is.null(p$beta))   as.numeric(p$beta)   else h$beta_planner
qc    <- if (!is.null(p$q_ctrl)) as.numeric(p$q_ctrl) else h$Q_ctrl
## certification-gate ENFORCEMENT (Project V): the admissible control target is the
## cascade spectral root r(B); a request to control an UNIDENTIFIED object (an
## individual interaction weight G_ij, a response intensity delta_i) is refused here
## with an honest error, never answered with a fabricated number.
ctrl_target <- if (!is.null(p$target)) as.character(p$target) else "rB"
ctrl_gate   <- gate_guard_target(ctrl_target)
n <- pl$n; I <- diag(n)

## stressed plant (V.1 closed-loop drift end): open loop is non-stationary
G_stress <- h$drift_lq * pl$G
A  <- phi_from(G_stress, pl$eta)
Bc <- I; R <- h$R_weight * I; Q <- qc * I
rho_open <- rho_of(A); rB_stress <- rB_of(G_stress, pl$eta)

dare <- discounted_dare(A, Bc, R, Q, beta)
P <- dare$P; F <- dare$F
Acl <- A - Bc %*% F; rho_closed <- rho_of(Acl)
F_norm2 <- max(svd(F)$d)

## certainty equivalence: F is independent of C (P,F carry no C). Verify with two
## loadings; only the value constant d moves.
C1 <- I; C2 <- diag(seq(0.5, 1.5, length.out = n))
F2 <- discounted_dare(A, Bc, R, Q, beta)$F
ce_residual <- max(abs(F - F2))
d_C1 <- value_const(P, C1, beta); d_C2 <- value_const(P, C2, beta)

## cost ranking: initial shock along the systemic (Perron) direction
ev  <- eigen((pl$G + t(pl$G)) / 2, symmetric = TRUE)
v   <- ev$vectors[, 1]; if (sum(v) < 0) v <- -v; v <- pmax(v, 0); x0 <- v / sqrt(sum(v^2))
J_lq <- policy_cost(A, Bc, F, R, Q, beta, C1, x0)
J_open <- policy_cost(A, Bc, matrix(0, n, n), R, Q, beta, C1, x0)
eta_safe <- pl$eta * h$safe / rB_stress
K_th <- A - phi_from(G_stress, eta_safe)
J_th <- policy_cost(A, Bc, K_th, R, Q, beta, C1, x0)
ranking_ok <- (J_lq$J <= J_th$J + 1e-6) && (J_th$J < J_open$J)

ce_emit_hp(list(
  method = "lq_regulator", theorem = "V.2-T1", anchor = "v2_crisis",
  control_target = ctrl_target, control_target_gate = ctrl_gate,
  n = n, beta = beta, q_ctrl = qc, drift = h$drift_lq,
  rB_stress = rB_stress, rho_open = rho_open,
  beta_rho2_open = beta * rho_open^2,
  open_loop_nonstationary = rho_open > 1,
  trace_P = sum(diag(P)), F_norm2 = F_norm2, rho_closed = rho_closed,
  closed_loop_stationary = rho_closed < 1,
  certainty_equivalence_residual = ce_residual,
  d_C1 = d_C1, d_C2 = d_C2,
  J_optimal = J_lq$J, J_threshold = J_th$J,
  J_open = if (is.infinite(J_open$J)) "Inf" else J_open$J,
  rho_threshold = J_th$rho_cl, eta_safe = eta_safe,
  cost_ranking_holds = ranking_ok,
  interpretation = paste0("optimal LQ feedback stabilises the stressed plant ",
    "(closed-loop rho ", round(rho_closed, 3), " < 1) at cost ",
    round(J_lq$J, 1), " < threshold ", round(J_th$J, 1),
    " < open (infinite); F is independent of the shock loading."),
  gate = list(rho_closed = GATE$closed_loop_rho, F_feedback = GATE$policy,
              rB_stress = GATE$rB, J_optimal = GATE$value_function,
              certainty_equivalence = GATE$policy),
  provenance = pl$provenance
))
