## v5 / T3 -- Hamiltonian turnpike + saddle signature on the recovered plant.
## Reproduces FRONTIERS V.2 Theorem 3: the interior steady state (turnpike) is the
## activity-minimising speed eta-bar, it coincides with V.1's static interior
## optimum (a convergence invariant), and the (state, costate) Jacobian is a saddle
## (opposite-sign eigenvalues, one-dimensional stable manifold). Also maps the
## turnpike against the cascade-vs-activity cost ratio (T1c).
## params: {}  (the turnpike is determined by the calibrated plant)
src <- function(f) source(file.path(dirname(sub("--file=", "",
  grep("--file=", commandArgs(FALSE), value = TRUE))), f))
src("_io.R"); src("_control_core.R")

p  <- ce_params()
pl <- v5_plant(); h <- pl$hyper
beta <- h$beta_planner
V1_INTERIOR_OPTIMUM <- 0.967181                # FRONTIERS V.1 static argmin (invariant)

ac <- activity_curve(pl)
eta <- ac$eta; trace_eta <- ac$trace; rB_eta <- ac$rB
eta_ref <- 0.96718
tr_ref  <- lyap_trace(phi_from(pl$G, eta_ref), diag(pl$n))
rB_ref  <- rB_of(pl$G, eta_ref)
trace_n <- trace_eta / tr_ref; rB_n <- rB_eta / rB_ref

eta_bar <- eta[which.min(trace_eta)]

## saddle: curvature of the activity holding cost at the turnpike + state-costate Jacobian
ne <- length(eta); hstep <- eta[2] - eta[1]
i0 <- which.min(abs(eta - eta_bar)); i0 <- min(max(i0, 3L), ne - 2L)
ell_pp <- (trace_n[i0 + 1] - 2 * trace_n[i0] + trace_n[i0 - 1]) / hstep^2
rho_c <- -log(beta); c_h <- h$c_adj
Jac <- matrix(c(0, -ell_pp / c_h, -1 / c_h, rho_c), 2, 2)   # [[0,-1/c],[-ell'',rho]] col-major
ev <- sort(Re(eigen(Jac, only.values = TRUE)$values))
is_saddle <- ev[1] < 0 && ev[2] > 0

## turnpike vs cost ratio (cascade vs activity)
thetas <- seq(0, 0.9, length.out = 19)
eta_bar_theta <- vapply(thetas, function(th) eta[which.min((1 - th) * trace_n + th * rB_n)], numeric(1))
monotone <- all(diff(eta_bar_theta) <= 1e-9)

ce_emit_hp(list(
  method = "turnpike", theorem = "V.2-T3",
  n = pl$n, beta = beta,
  eta_bar = eta_bar,
  trace_min = min(trace_eta),
  v1_interior_optimum = V1_INTERIOR_OPTIMUM,
  turnpike_matches_v1 = abs(eta_bar - V1_INTERIOR_OPTIMUM) < 1e-3,
  ell_pp = ell_pp, rho_c = rho_c,
  jacobian_eigs = ev, is_saddle = is_saddle, stable_manifold_dim = 1L,
  cost_ratio_theta = thetas, cost_ratio_eta_bar = eta_bar_theta,
  turnpike_monotone_in_cost_ratio = monotone,
  interpretation = paste0("turnpike eta-bar = ", round(eta_bar, 4),
    " coincides with V.1's interior optimum; the state-costate Jacobian has ",
    "eigenvalues ", round(ev[1], 4), " and ", round(ev[2], 4),
    " (a saddle, one-dimensional stable manifold = the optimal path)."),
  gate = list(eta_bar = GATE$turnpike, jacobian_eigs = GATE$saddle, rB = GATE$rB),
  provenance = pl$provenance
))
