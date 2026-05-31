# SHSSM Compute Engine — Cloud Run image (R econometrics + Node orchestrator).
# On Cloud Run, gVisor is the isolation boundary, so the server's bwrap path is
# skipped (auto-detected) and it runs analyses via the `timeout` fallback. The
# container has no secrets and the G20 data is the only bundled dataset.
FROM rocker/r-ver:4.4.1

# Fast binary R installs via Posit Package Manager (auto-match the distro codename).
RUN . /etc/os-release && \
    R -e "options(repos=c(CRAN=paste0('https://packagemanager.posit.co/cran/__linux__/', Sys.getenv('CODENAME','jammy'), '/latest'))); \
          .codename <- '${VERSION_CODENAME}'; \
          options(repos=c(CRAN=paste0('https://packagemanager.posit.co/cran/__linux__/', .codename, '/latest'))); \
          install.packages(c('jsonlite','readxl','urca','tseries','vars','waveslim','quantreg'))" && \
    R -e "for (p in c('jsonlite','readxl','urca','tseries','vars','waveslim','quantreg')) if(!requireNamespace(p,quietly=TRUE)) stop(paste('MISSING',p))"

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
COPY data-root ./data-root

# COMPUTE_REPO points at the bundled data root so _io.R finds
# papers/contagion-channels/data/G20.xlsx
ENV COMPUTE_REPO=/app/data-root
ENV HOST=0.0.0.0
ENV PORT=8080
ENV COMPUTE_TIMEOUT_S=90
EXPOSE 8080
CMD ["node", "server/compute-server.mjs"]
