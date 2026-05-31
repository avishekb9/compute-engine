## Detrended Fluctuation Analysis -> Hurst exponent (long-memory). Core NAMH
## primitive. params: {dataset, series:[one], min_box?, max_box?}
## DFA implemented directly (no extra pkg dependency) on the cumulative series.
source(file.path(dirname(sub("--file=", "", grep("--file=", commandArgs(FALSE), value = TRUE))), "_io.R"))

p <- ce_params()
if (is.null(p$series) || length(p$series) != 1) ce_fail("dfa needs exactly one 'series'")
d <- ce_returns(p)
x <- as.numeric(d$R[, 1]); x <- x[is.finite(x)]
N <- length(x)
if (N < 128) ce_fail("series too short for DFA")

## profile = cumulative sum of mean-centred series
y <- cumsum(x - mean(x))
minb <- if (!is.null(p$min_box)) as.integer(p$min_box) else 8
maxb <- if (!is.null(p$max_box)) as.integer(p$max_box) else floor(N / 4)
## log-spaced box sizes
boxes <- unique(round(exp(seq(log(minb), log(maxb), length.out = 20))))
boxes <- boxes[boxes >= 4 & boxes <= maxb]

flucts <- sapply(boxes, function(n) {
  nb <- floor(N / n)
  if (nb < 1) return(NA_real_)
  idx <- seq_len(nb * n)
  segs <- matrix(y[idx], nrow = n)
  tt <- seq_len(n)
  rms <- apply(segs, 2, function(seg) {
    fit <- lm.fit(cbind(1, tt), seg)
    sqrt(mean(fit$residuals^2))
  })
  sqrt(mean(rms^2))
})
ok <- is.finite(flucts) & flucts > 0
lx <- log(boxes[ok]); ly <- log(flucts[ok])
co <- coef(lm(ly ~ lx))
H <- unname(co[2])

ce_emit(list(
  method = "dfa_hurst",
  dataset = if (!is.null(p$dataset)) p$dataset else "g20",
  series = d$cols[1], n = N,
  hurst = H,
  interpretation = if (H > 0.55) "persistent / long-memory (H>0.55)"
                   else if (H < 0.45) "anti-persistent / mean-reverting (H<0.45)"
                   else "near random walk (H~0.5)",
  n_boxes = sum(ok),
  box_min = min(boxes[ok]), box_max = max(boxes[ok])
))
