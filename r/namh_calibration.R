## NAMH x Network-Economics CALIBRATION SUITE (Part 2 of the R&D programme).
##
## Computes the per-window empirical counterparts of Theorems A/B/C of
## net-papers/namh-networks-program/theory/namh-networks.tex against the
## CANONICAL saved NAMH run (results_{annual,quarterly}.rds) -- NOT a re-run of
## the tower-minutes pipeline. Every quantity is base-R (eigen/solve), no new
## dependency, and is checked by test/namh-calibration.test.mjs against
## pre-registered failable bands (the golden.test.mjs idiom).
##
## THE ONE INTELLECTUAL CORRECTION made here vs designs/calibration.md (which was
## authored by the pre-proof-hardening workflow): the design selected
## lambda_min((A+A^T)/2) as the game well-posedness diagnostic, following BKD's
## generic "lowest eigenvalue" wording. But NAMH's game is strategic COMPLEMENTS
## (A >= 0 enters the potential with a + sign), so the binding concavity scalar is
## lambda_MAX((A+A^T)/2) < 1 -- the LARGEST symmetric-part eigenvalue (Theorem
## B(d); BKD p.901: "the highest eigenvalue is important in games of pure
## complements"). Using |lambda_min| is precisely the substitutes error for which
## bridges #2/#6/#9/#10 were rejected. We therefore report lambda_max_sym as the
## HEADLINE well-posedness scalar (margin = 1 - lambda_max_sym) and lambda_min_sym
## only as the labelled substitutes counterfactual.
##
## usage: Rscript namh_calibration.R '{"annual_rds":"...","quarterly_rds":"...","out_dir":"..."}'
##        (all keys optional; defaults to the canonical absolute paths)

suppressMessages(library(jsonlite))

args <- commandArgs(trailingOnly = TRUE)
P <- if (length(args) >= 1 && nzchar(args[[1]])) fromJSON(args[[1]]) else list()
NAMH_OUT <- "/home/ecolex/versiondevs/ivy-fineco/papers/namh/NAMH_researchr_new/output"
annual_rds    <- if (!is.null(P$annual_rds))    P$annual_rds    else file.path(NAMH_OUT, "results_annual.rds")
quarterly_rds <- if (!is.null(P$quarterly_rds)) P$quarterly_rds else file.path(NAMH_OUT, "results_quarterly.rds")
out_dir       <- if (!is.null(P$out_dir))       P$out_dir       else "/home/ecolex/versiondevs/net-papers/namh-networks-program/analysis"
LAMBDA <- 5            # HWTE fractal-similarity decay (design constant) -> omega Lipschitz const 1+2*lambda
TOL_ID <- 1e-8         # T1 deterministic-identity tolerance (engine namh_reproduce default)

fnorm <- function(M) sqrt(sum(M * M))

## Diagonal-symmetrizability residual (Theorem B(e) / design B2 check).
## A is diag-symmetrizable iff exists D>0 with D A D^{-1} symmetric. Necessary:
## sign-symmetric support (A_ij>0 <=> A_ji>0). When support IS sign-symmetric, the
## metric defect is the least-squares residual of log(A_ij/A_ji) = -2(delta_i-delta_j):
## fit delta by graph-Laplacian LS, return RMS residual (0 iff symmetrizable).
diag_symm_residual <- function(A) {
  n <- nrow(A)
  pairs_both <- 0L; pairs_one <- 0L
  rows <- integer(0); cols <- integer(0); rhs <- numeric(0)
  for (i in seq_len(n)) for (j in seq_len(n)) {
    if (i >= j) next
    aij <- A[i, j]; aji <- A[j, i]
    if (aij > 0 && aji > 0) {
      pairs_both <- pairs_both + 1L
      rows <- c(rows, i); cols <- c(cols, j)
      rhs  <- c(rhs, -0.5 * log(aij / aji))   # delta_i - delta_j target
    } else if (xor(aij > 0, aji > 0)) {
      pairs_one <- pairs_one + 1L              # one-directional -> structural obstruction
    }
  }
  support_edges <- sum(A[row(A) != col(A)] > 0)
  reciprocity <- if (support_edges > 0) (2 * pairs_both) / support_edges else NA_real_
  # if any one-directional edge exists, not diag-symmetrizable regardless of weights
  if (pairs_one > 0) return(list(resid = Inf, reciprocity = reciprocity,
                                 symmetrizable = FALSE, support_edges = support_edges))
  if (pairs_both == 0) return(list(resid = NA_real_, reciprocity = reciprocity,
                                   symmetrizable = NA, support_edges = support_edges))
  # graph-Laplacian least squares: incidence M (one row per reciprocal pair), gauge delta_1 = 0
  M <- matrix(0, nrow = length(rhs), ncol = n)
  for (e in seq_along(rhs)) { M[e, rows[e]] <- 1; M[e, cols[e]] <- -1 }
  M <- M[, -1, drop = FALSE]
  fit <- tryCatch(stats::lm.fit(M, rhs), error = function(err) NULL)
  resid <- if (is.null(fit)) NA_real_ else sqrt(mean(fit$residuals^2))
  list(resid = resid, reciprocity = reciprocity,
       symmetrizable = is.finite(resid) && resid < 1e-8, support_edges = support_edges)
}

analyze <- function(rds_path, freq) {
  r <- readRDS(rds_path); W <- r$windows; n <- length(W)
  recs <- vector("list", n)
  for (k in seq_len(n)) {
    w <- W[[k]]
    A <- w$HWTE; phi <- w$phi; E <- w$E; N <- nrow(A)
    Asym <- (A + t(A)) / 2
    ev   <- eigen(A, only.values = TRUE)$values            # directed spectrum (complex)
    evs  <- eigen(Asym, symmetric = TRUE, only.values = TRUE)$values
    rho  <- max(Mod(ev)); spec_absc <- max(Re(ev))
    lam_max_sym <- max(evs); lam_min_sym <- min(evs)
    inf_norm <- max(rowSums(abs(A)))                        # ||A||_inf = max in-strength
    one_norm <- max(colSums(abs(A)))                        # ||A||_1   = max out-strength
    ## T1: directed Katz-Bonacich/Leontief identity E* = (I-A)^{-1} phi vs stored E
    IA  <- diag(N) - A
    inv <- tryCatch(solve(IA), error = function(err) matrix(NA, N, N))
    Estar <- as.numeric(inv %*% phi)
    t1_resid <- max(abs(Estar - E))
    ## T1 sub-test: monotone comparative static -> (I-A)^{-1} >= 0 entrywise
    n_neg_inv <- sum(inv < -1e-12, na.rm = TRUE)
    ## T2: measured inverse-norm (the ~1.5 that corrects the bogus cap of 20) + budget constants
    inv_norm <- max(rowSums(abs(inv)))
    inv_norm_bound <- if (inf_norm < 1) 1 / (1 - inf_norm) else Inf
    maxTE <- max(w$TE_eff[is.finite(w$TE_eff)], na.rm = TRUE)
    K_A <- maxTE * (1 + 2 * LAMBDA)                         # omega Lipschitz constant route
    d_max <- max(rowSums(w$adj_mag != 0))                   # max in-degree on the 30-edge support
    ## T3: asymmetry index + diagonal-symmetrizability
    asym_index <- fnorm(A - t(A)) / fnorm(A + t(A))
    ds <- diag_symm_residual(A)
    ## directed-walk (Neumann) spillover shares by order k  (||A^k phi||_1 / ||E*||_1)
    Eabs <- sum(abs(Estar)); ak <- phi; shares <- numeric(4)
    for (kk in 0:3) { shares[kk + 1] <- sum(abs(ak)) / Eabs; ak <- as.numeric(A %*% ak) }
    recs[[k]] <- list(
      freq = freq, k = k, era = w$era,
      start = as.character(w$start), end = as.character(w$end), N = N,
      inf_norm = inf_norm, one_norm = one_norm,
      rho = rho, spec_abscissa = spec_absc, acyclic = as.integer(rho < 1e-12),
      lam_max_sym = lam_max_sym, lam_min_sym = lam_min_sym,
      wp_margin = 1 - lam_max_sym, abs_lam_min = abs(lam_min_sym),
      asym_index = asym_index,
      support_reciprocity = ds$reciprocity, diag_symm_resid = ds$resid,
      diag_symmetrizable = ds$symmetrizable, support_edges = ds$support_edges,
      Q = w$modularity, n_comm = w$n_comm,
      t1_resid = t1_resid, n_neg_inv = n_neg_inv,
      inv_norm = inv_norm, inv_norm_bound = inv_norm_bound,
      K_A = K_A, d_max = d_max,
      neumann_share_k0 = shares[1], neumann_share_k01 = shares[1] + shares[2],
      contraction_holds = as.integer(inf_norm < 1),
      wellposed_holds = as.integer(lam_max_sym < 1))
  }
  recs
}

## ---- run both frequencies ----
A_recs <- analyze(annual_rds, "annual")
Q_recs <- analyze(quarterly_rds, "quarterly")
num <- function(recs, f) vapply(recs, function(x) as.numeric(x[[f]]), numeric(1))

mk_summary <- function(recs, label) {
  inf <- num(recs, "inf_norm"); rho <- num(recs, "rho")
  lmax <- num(recs, "lam_max_sym"); lmin <- num(recs, "lam_min_sym")
  asym <- num(recs, "asym_index"); t1 <- num(recs, "t1_resid")
  invn <- num(recs, "inv_norm"); acyc <- num(recs, "acyclic")
  recp <- num(recs, "support_reciprocity"); negs <- num(recs, "n_neg_inv")
  list(
    label = label, n_windows = length(recs),
    t1_max_resid = max(t1), t1_total_neg_inv = sum(negs),
    inf_norm_max = max(inf), inf_norm_mean = mean(inf), n_inf_ge_1 = sum(inf >= 1),
    rho_max = max(rho), rho_mean = mean(rho), n_acyclic = sum(acyc),
    lam_max_sym_max = max(lmax), lam_max_sym_min = min(lmax),
    wp_margin_min = 1 - max(lmax), n_wellposed = sum(lmax < 1),
    abs_lam_min_max = max(abs(lmin)),
    asym_index_min = min(asym), asym_index_max = max(asym), n_potential_game = sum(asym < 1e-9),
    inv_norm_max = max(invn), inv_norm_min = min(invn), inv_norm_mean = mean(invn),
    recip_max = max(recp, na.rm = TRUE), n_diag_symmetrizable = sum(vapply(recs, function(x) isTRUE(x$diag_symmetrizable), logical(1))),
    ## the cross-scalar finding: windows where contraction fails but game well-posedness holds
    n_contraction_fail_but_wellposed = sum(inf >= 1 & lmax < 1))
}
sumA <- mk_summary(A_recs, "annual"); sumQ <- mk_summary(Q_recs, "quarterly")

## ---- EGJ phase-plane: era aggregates of (integration=rho, diversification=1-Q) ----
era_agg <- function(recs) {
  eras <- unique(vapply(recs, function(x) x$era, character(1)))
  out <- lapply(eras, function(e) {
    sel <- Filter(function(x) x$era == e, recs)
    list(era = e, n = length(sel),
         rho_mean = mean(num(sel, "rho")), Q_mean = mean(num(sel, "Q")),
         div_mean = 1 - mean(num(sel, "Q")))
  })
  out
}
egj_annual <- era_agg(A_recs)

## ---- write artifacts ----
dir.create(out_dir, showWarnings = FALSE, recursive = TRUE)
full <- list(
  meta = list(generated_from = "canonical saved run (results_*.rds); no pipeline re-run",
              annual_rds = annual_rds, quarterly_rds = quarterly_rds,
              lambda = LAMBDA, tol_identity = TOL_ID,
              note = "lambda_max_sym is the binding complements well-posedness scalar (Thm B(d)); lambda_min_sym is the substitutes counterfactual only."),
  annual = A_recs, quarterly = Q_recs,
  summary = list(annual = sumA, quarterly = sumQ),
  egj_phase_plane_annual = egj_annual)
writeLines(toJSON(full, auto_unbox = TRUE, digits = 10, na = "null", pretty = TRUE),
           file.path(out_dir, "calibration-results.json"))
## flat per-window CSV (annual + quarterly)
flat <- do.call(rbind, lapply(c(A_recs, Q_recs), function(x) data.frame(
  freq = x$freq, k = x$k, era = x$era, start = x$start, end = x$end, N = x$N,
  inf_norm = x$inf_norm, one_norm = x$one_norm, rho = x$rho, spec_abscissa = x$spec_abscissa,
  acyclic = x$acyclic, lam_max_sym = x$lam_max_sym, lam_min_sym = x$lam_min_sym,
  wp_margin = x$wp_margin, asym_index = x$asym_index, support_reciprocity = x$support_reciprocity,
  diag_symm_resid = x$diag_symm_resid, Q = x$Q, n_comm = x$n_comm,
  t1_resid = x$t1_resid, n_neg_inv = x$n_neg_inv, inv_norm = x$inv_norm,
  inv_norm_bound = x$inv_norm_bound, K_A = x$K_A, d_max = x$d_max,
  neumann_share_k01 = x$neumann_share_k01,
  contraction_holds = x$contraction_holds, wellposed_holds = x$wellposed_holds,
  stringsAsFactors = FALSE)))
write.csv(flat, file.path(out_dir, "calibration-per-window.csv"), row.names = FALSE)

## ---- emit compact summary JSON on stdout (for the band-guard test) ----
cat(toJSON(list(method = "namh_calibration",
                summary = list(annual = sumA, quarterly = sumQ),
                egj_annual = egj_annual,
                out_dir = out_dir),
           auto_unbox = TRUE, digits = 10, na = "null"))
