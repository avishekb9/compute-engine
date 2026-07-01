## Shared control-operator core for the ECONSTELLAR v5 Bellman/Riccati layer.
## Pure, transparent linear algebra over the M3-faithful calibrated plant shipped
## in fixtures/v5_control_plant.json (provenance: FRONTIERS V.2 results.json,
## seed 20260618). No network, no writes, no arbitrary code. Every quantity it
## returns reproduces a V.2 results.json golden value; see each operator's runner.
##
## CERTIFICATION GATE (Project V, binding): each returned quantity is stamped with
## its identification class -- STRONG (eta, affine map, |lambda_min(Gtilde)|, r(B),
## Perron projection) is controllable + reportable; PROXY (F with explicit beta,
## edge direction) is hedged; UNIDENTIFIED (individual G_ij, delta_i) is NEVER a
## control target. The control operators act on the spectrum, never a named edge.

suppressMessages({ library(jsonlite) })

## ---- high-precision emit ---------------------------------------------------
## The engine's default ce_emit serialises at 8 decimal places; for O(1)..O(1e3)
## quantities that caps live reproduction at the display-rounding floor (~5e-9),
## which is NOT a computational error. These four operators are anchored to the
## V.2 results.json golden values and the v5 gate asks for <= 1e-9, so we serialise
## the control layer at 12 dp -- the underlying linear algebra matches the published
## sim to ~1e-13 (the chaos-band Lyapunov MAGNITUDE excepted: sensitive dependence,
## reproducible only in sign + onset). Same Inf/NA handling as ce_emit.
ce_emit_hp <- function(obj) {
  cat(toJSON(obj, auto_unbox = TRUE, digits = 12, na = "null")); quit(status = 0)
}

## ---- fixture ---------------------------------------------------------------
.v5_script_dir <- function() {
  f <- sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))
  if (length(f)) dirname(f[[1]]) else "r"
}
v5_plant <- function() {
  path <- file.path(.v5_script_dir(), "fixtures", "v5_control_plant.json")
  if (!file.exists(path)) ce_fail(paste("v5 control fixture missing:", path))
  fx <- fromJSON(path, simplifyMatrix = FALSE)
  G <- matrix(unlist(fx$G_cal), nrow = fx$n, byrow = TRUE)
  list(G = G, eta = fx$eta_cal, lam_max = fx$lam_max_g, rB = fx$rB_cal,
       n_edges = fx$n_edges, n = fx$n, hyper = fx$hyper,
       names = unlist(fx$asset_names), provenance = fx$`_provenance`)
}

## ---- spectral primitives (identical maps to V.2) ---------------------------
phi_from <- function(G, eta) (1 - eta) * diag(nrow(G)) - eta * G
rho_of   <- function(M) max(Mod(eigen(M, only.values = TRUE)$values))
lammax_sym <- function(A) max(eigen((A + t(A)) / 2, symmetric = TRUE, only.values = TRUE)$values)
rB_of    <- function(G, eta) eta * lammax_sym(G)            # D = I => Gtilde = G

## discrete Lyapunov  Sigma = Phi Sigma Phi' + Q  via vec(Sigma)=(I-Phi(x)Phi)^-1 vec(Q)
lyap_trace <- function(Phi, Q) {
  if (rho_of(Phi) >= 1 - 1e-9) return(Inf)
  n <- nrow(Phi)
  vecS <- solve(diag(n * n) - kronecker(Phi, Phi), as.vector(Q))
  sum(diag(matrix(vecS, n, n)))
}

## ---- T1: discounted LQ-Gaussian regulator ----------------------------------
## Stabilising solution of the discounted DARE by the Riccati (value) recursion,
## which converges to the unique stabilising P for a discounted-stabilisable system.
discounted_dare <- function(A, Bc, R, Q, beta, tol = 1e-14, maxit = 200000) {
  n <- nrow(A); P <- R; it <- 0L
  ## phase 1: Riccati value recursion -- globally convergent from P0=R (no
  ## stabilising-gain prerequisite), drives the gain into the stabilising region.
  repeat {
    it <- it + 1L
    F  <- solve(Q + beta * crossprod(Bc, P %*% Bc), beta * crossprod(Bc, P %*% A))
    Pn <- R + beta * crossprod(A, P %*% A) - beta * crossprod(A, P %*% Bc) %*% F
    Pn <- (Pn + t(Pn)) / 2
    if (max(abs(Pn - P)) < 1e-11 || it >= maxit) { P <- Pn; break }
    P <- Pn
  }
  ## phase 2: policy-iteration (Kleinman) polish -- quadratically convergent to the
  ## exact stabilising DARE solution via the discounted Lyapunov solve, so P matches
  ## a Schur solver to machine precision (closes the ~1e-9 value-recursion tail).
  for (k in 1:60) {
    F   <- solve(Q + beta * crossprod(Bc, P %*% Bc), beta * crossprod(Bc, P %*% A))
    Acl <- A - Bc %*% F
    M   <- R + crossprod(F, Q %*% F)
    vecP <- solve(diag(n * n) - beta * kronecker(t(Acl), t(Acl)), as.vector(M))
    Pn  <- matrix(vecP, n, n); Pn <- (Pn + t(Pn)) / 2
    if (max(abs(Pn - P)) < tol) { P <- Pn; break }
    P <- Pn
  }
  F <- solve(Q + beta * crossprod(Bc, P %*% Bc), beta * crossprod(Bc, P %*% A))
  list(P = P, F = F, iters = it)
}
value_const <- function(P, C, beta) beta / (1 - beta) * sum(diag(crossprod(C, P %*% C)))

## infinite-horizon discounted cost of the linear policy u = -K x; Inf if not
## discounted-stabilising (sqrt(beta) rho(A-BcK) >= 1).
policy_cost <- function(A, Bc, K, R, Q, beta, C, x0) {
  Acl <- A - Bc %*% K
  rho_cl <- rho_of(Acl)
  if (sqrt(beta) * rho_cl >= 1 - 1e-9) return(list(J = Inf, rho_cl = rho_cl))
  M <- R + crossprod(K, Q %*% K)
  n <- nrow(A)
  vecP <- solve(diag(n * n) - beta * kronecker(t(Acl), t(Acl)), as.vector(M))
  P <- matrix(vecP, n, n)
  J <- as.numeric(crossprod(x0, P %*% x0)) + beta / (1 - beta) * sum(diag(crossprod(C, P %*% C)))
  list(J = J, rho_cl = rho_cl)
}

## ---- T2: nonlinear Bellman value iteration on the speed eta -----------------
## Holding cost = the calibrated stationary activity trace(Sigma_x)(eta); the
## control adjusts eta at quadratic cost. Returns the fixed point, the policy, the
## successive-difference norms (the beta-rate contraction), and the iterate count.
GH7_NODES <- c(-3.7504397177257425, -2.366759410734541, -1.1544053947399682, 0.0,
               1.1544053947399682, 2.366759410734541, 3.7504397177257425)
GH7_WTS   <- c(0.000548268855972217, 0.03075712396758652, 0.2401231786050127,
               0.45714285714285724, 0.2401231786050127, 0.03075712396758652,
               0.000548268855972217)

activity_curve <- function(plant) {
  h <- plant$hyper; G <- plant$G; n <- plant$n
  eg <- seq(h$eta_grid$lo, h$eta_grid$hi, length.out = h$eta_grid$n)
  Sig <- diag(n)
  tr <- vapply(eg, function(e) lyap_trace(phi_from(G, e), Sig), numeric(1))
  rb <- vapply(eg, function(e) rB_of(G, e), numeric(1))
  list(eta = eg, trace = tr, rB = rb)
}

value_iteration <- function(eta_grid, holding, u_grid, beta, c_adj, shock_sd,
                            tol = 1e-9, maxit = 4000) {
  lo <- eta_grid[1]; hi <- eta_grid[length(eta_grid)]
  shock <- shock_sd * GH7_NODES
  ne <- length(eta_grid); nu <- length(u_grid); ns <- length(shock)
  stage <- (c_adj / 2) * u_grid^2
  ## next-state grid (ne x nu x ns), clipped to [lo,hi]
  nxt <- outer(eta_grid, u_grid, `+`)                       # ne x nu
  nxt3 <- array(rep(as.vector(nxt), ns), dim = c(ne, nu, ns)) +
          aperm(array(rep(shock, each = ne * nu), dim = c(ne, nu, ns)), c(1, 2, 3))
  nxt3 <- pmin(pmax(nxt3, lo), hi)
  V <- numeric(ne); diffs <- numeric(0)
  for (it in 1:maxit) {
    Vint <- approx(eta_grid, V, xout = as.vector(nxt3), rule = 2)$y
    Vint <- array(Vint, dim = c(ne, nu, ns))
    EV <- apply(Vint, c(1, 2), function(z) sum(z * GH7_WTS))   # ne x nu
    Q <- matrix(holding, ne, nu) + matrix(stage, ne, nu, byrow = TRUE) + beta * EV
    Vn <- apply(Q, 1, min)
    d <- max(abs(Vn - V)); diffs <- c(diffs, d); V <- Vn
    if (d < tol) break
  }
  Vint <- approx(eta_grid, V, xout = as.vector(nxt3), rule = 2)$y
  Vint <- array(Vint, dim = c(ne, nu, ns))
  EV <- apply(Vint, c(1, 2), function(z) sum(z * GH7_WTS))
  Q <- matrix(holding, ne, nu) + matrix(stage, ne, nu, byrow = TRUE) + beta * EV
  policy <- u_grid[apply(Q, 1, which.min)]
  list(V = V, policy = policy, diffs = diffs, iters = length(diffs))
}

## ---- gate stamping (M2) -----------------------------------------------------
GATE <- list(
  eta = "STRONG", affine_map = "STRONG", lam_min_gtilde = "STRONG",
  rB = "STRONG", perron = "STRONG", value_function = "STRONG",
  policy = "STRONG", turnpike = "STRONG", saddle = "STRONG",
  closed_loop_rho = "STRONG", contraction = "STRONG",
  F_index = "PROXY", edge_direction = "PROXY",
  G_ij = "UNIDENTIFIED", delta_i = "UNIDENTIFIED"
)
## A control request naming an UNIDENTIFIED object is refused (honest 400-style).
gate_guard_target <- function(target) {
  cls <- GATE[[target]]
  if (is.null(cls)) cls <- "UNIDENTIFIED"
  if (cls == "UNIDENTIFIED")
    ce_fail(paste0("control target '", target,
                   "' is UNIDENTIFIED (individual interaction weights / response ",
                   "intensities are not recovered); admissible targets are the ",
                   "spectrum and the Perron ranking only (Project V gate)."))
  cls
}
