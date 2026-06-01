## Panel unit-root tests (plm::purtest) — Im-Pesaran-Shin and Levin-Lin-Chu.
## Treats the chosen G20 return series as a balanced panel (T x N) and tests the
## joint null of a unit root across panels. Returns both IPS and LLC statistics.
## params: {dataset, series:[2-18], lags?(default "AIC")}
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))
suppressMessages(library(plm))

p <- ce_params()
if (is.null(p$series) || length(p$series) < 2)
  ce_fail("panel_unit_root needs >=2 'series'")
d <- ce_returns(p)
Y <- d$R[stats::complete.cases(d$R), , drop = FALSE]
if (nrow(Y) < 50) ce_fail("too few complete rows for panel unit-root test")
## purtest expects case-exact "AIC"/"SIC"/"Hall"; the server lowercases enums, so map back.
lagmap <- c(aic = "AIC", sic = "SIC", hall = "Hall")
lags <- if (!is.null(p$lags) && tolower(p$lags) %in% names(lagmap)) unname(lagmap[tolower(p$lags)]) else "AIC"

run_purtest <- function(test) tryCatch({
  pt <- plm::purtest(Y, test = test, exo = "intercept", lags = lags, pmax = 6)
  s <- pt$statistic
  list(statistic = as.numeric(s$statistic), p_value = as.numeric(s$p.value))
}, error = function(e) list(statistic = NA_real_, p_value = NA_real_, error = conditionMessage(e)))

ips <- run_purtest("ips")
llc <- run_purtest("levinlin")
stat_ok <- is.finite(ips$p_value)
verdict <- if (stat_ok && ips$p_value < 0.05)
  "Reject panel unit root at 5% (IPS) -> panel is stationary." else
  "Fails to reject panel unit root at 5% (IPS)."

ce_emit(list(
  method = "panel_unit_root",
  dataset = if (!is.null(p$dataset)) p$dataset else "g20",
  series = d$cols, n_obs = nrow(Y), n_panels = ncol(Y), lags = lags,
  ips = list(statistic = ips$statistic, p_value = ips$p_value),       # Im-Pesaran-Shin W-t-bar
  llc = list(statistic = llc$statistic, p_value = llc$p_value),       # Levin-Lin-Chu
  interpretation = verdict
))
