# SHSSM Compute Engine — Cloud Run image (R econometrics + Node orchestrator).
# On Cloud Run, gVisor is the isolation boundary, so the server's bwrap path is
# skipped (auto-detected) and it runs analyses via the `timeout` fallback. The
# container has no secrets and the G20 data is the only bundled dataset.
FROM rocker/r-ver:4.4.1

# System runtime libs for igraph's binary (.so links against GLPK, libxml2, GMP).
# Must precede the R install so the post-install requireNamespace load succeeds,
# and they're needed at method runtime too. The other new packages (plm, lmtest,
# frequencyConnectedness, rugarch, rmgarch) are pure-R / Rcpp and need nothing extra.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libglpk40 libxml2 libgmp10 && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Fast binary R installs via Posit Package Manager (auto-match the distro codename).
RUN . /etc/os-release && \
    R -e "options(repos=c(CRAN=paste0('https://packagemanager.posit.co/cran/__linux__/', Sys.getenv('CODENAME','jammy'), '/latest'))); \
          .codename <- '${VERSION_CODENAME}'; \
          options(repos=c(CRAN=paste0('https://packagemanager.posit.co/cran/__linux__/', .codename, '/latest'))); \
          install.packages(c('jsonlite','readxl','urca','tseries','vars','waveslim','quantreg','plm','lmtest','frequencyConnectedness','igraph','rugarch','rmgarch','xts','RANN','fracdiff'))" && \
    R -e "for (p in c('jsonlite','readxl','urca','tseries','vars','waveslim','quantreg','plm','lmtest','frequencyConnectedness','igraph','rugarch','rmgarch','xts','zoo','MASS','RANN','fracdiff')) if(!requireNamespace(p,quietly=TRUE)) stop(paste('MISSING',p))"

# Published SOCH package (CRAN-candidate v0.1.0) from the bundled tarball — the
# soch_profile method runs the paper's own code (Bhandari & Parida 2026), not a
# reimplementation. Deps (waveslim, quantreg) are already installed above.
COPY sochcontagion_0.1.0.tar.gz /tmp/sochcontagion.tar.gz
RUN R CMD INSTALL /tmp/sochcontagion.tar.gz && \
    R -e "if(!requireNamespace('sochcontagion',quietly=TRUE)) stop('MISSING sochcontagion')" && \
    rm -f /tmp/sochcontagion.tar.gz

# Published contagion-channels package (CRAN v0.1.3, GPL-3) from the bundled tarball
# — the channel_attribution method runs the paper's own two-stage pipeline (Bhandari,
# Parida & Sahu 2026, arXiv:2604.26546), reproducing Table 5, not a reimplementation.
# Its bundled LazyData (g20_returns + channel_proxies + crisis_periods) is the data
# source. Deps (xts, zoo, waveslim, quantreg, igraph, MASS, parallel) are installed above.
COPY contagionchannels_0.1.3.tar.gz /tmp/contagionchannels.tar.gz
RUN R CMD INSTALL /tmp/contagionchannels.tar.gz && \
    R -e "if(!requireNamespace('contagionchannels',quietly=TRUE)) stop('MISSING contagionchannels')" && \
    rm -f /tmp/contagionchannels.tar.gz

# Published NAMH package (v0.1.0, GPL-3) from the bundled tarball — the namh_hurst /
# namh_te methods run the paper's own code (Bhandari & Sahu 2026): the DFA Hurst panel
# (Peng et al. 1994) and KSG transfer entropy (Kraskov et al. 2004), not reimplementations.
# Its bundled extdata (G20_24_returns_yahoo.rds = the g20_24 dataset, 24 series incl.
# commodities) is read via system.file in _io.R. Deps (xts, zoo, quantreg, igraph,
# tseries, RANN, fracdiff, Matrix, parallel) are installed above.
COPY namh_0.1.0.tar.gz /tmp/namh.tar.gz
RUN R CMD INSTALL /tmp/namh.tar.gz && \
    R -e "if(!requireNamespace('namh',quietly=TRUE)) stop('MISSING namh')" && \
    R -e "if(!nzchar(system.file('extdata','G20_24_returns_yahoo.rds',package='namh'))) stop('MISSING g20_24 extdata')" && \
    rm -f /tmp/namh.tar.gz

# Node 20 (the server is zero-dep ESM; only needs node:http/https/child_process/fs).
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates gnupg && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server ./server
COPY r ./r
COPY web ./web
COPY py ./py
COPY neuricx ./neuricx
COPY data-root ./data-root

# COMPUTE_REPO points at the bundled data root so _io.R finds
# papers/contagion-channels/data/G20.xlsx
ENV COMPUTE_REPO=/app/data-root
ENV HOST=0.0.0.0
ENV PORT=8080
ENV COMPUTE_TIMEOUT_S=90
EXPOSE 8080
CMD ["node", "server/compute-server.mjs"]
