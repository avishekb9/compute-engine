# SHSSM Compute Engine

A sandboxed, open-source **econometrics workbench** — an EViews / RATS / OxMetrics-style
analytics surface backed by R, with an AI analyst chatbot. Built for the research
platform of the School of Humanities, Social Sciences & Management, IIT Bhubaneswar.

> Part of the Research Engine ecosystem. Standalone Node service + R analysis
> scripts + a single-page dashboard. No build step, near-zero npm dependencies.

## What it does

Pick a method + data series in the dashboard (or ask the chatbot in natural
language) → the engine runs the analysis **inside a `bwrap` sandbox** (no network,
read-only filesystem, wall-clock timeout) → results render as KPIs, tables and
charts.

### Methods (open-source R replacements for commercial tools)

| Method | Package | Commercial analogue |
|---|---|---|
| Unit Root Test (ADF + KPSS) | `urca`, `tseries` | EViews "Unit Root Test" |
| VAR + Impulse Responses | `vars` | EViews/RATS "VAR" |
| DFA Hurst Exponent (long memory) | base R | — |
| GARCH(1,1) Volatility | `tseries` | EViews/OxMetrics "GARCH" |
| Wavelet Variance (MODWT) | `waveslim` | — |
| Wavelet-Quantile Spillover (WQTE) | `waveslim` + `quantreg` | contagion-channels / WaveQTE |
| SOCH Scale Profile (published `sochcontagion`) | `sochcontagion` | — |
| Wavelet Coherence (MODWT, by scale) | `waveslim` | — |
| Rolling Connectedness (time-varying Diebold-Yilmaz) | `vars` | — |
| Quantile VAR (tail dependence) | `quantreg` | — |

> The table above samples the catalog; the live registry now serves **26 methods** in total
> (see `ARCHITECTURE.md` §A2 for the full registry with verified values and pre-registered
> bands). The most recent additions are the reproduction and formal-verification methods
> (`namh_reproduce`, `namh_pipeline`, `soch_robustness`), and the transfer-entropy search now
> offloads to the GPU with a governed CPU fallback (see `ARCHITECTURE.md` §A3–§A4).

### AI analyst chatbot

Natural language → Gemini 2.5 Flash **function-calling** → `run_analysis(method,
series, …)` against the same validated registry the UI uses → sandboxed execution →
Gemini explains the numbers for a finance researcher. e.g. *"Is China's market
stationary?"* runs the ADF/KPSS test and returns a verdict.

## Security model

- **Parameterized only.** The user selects a method from a fixed registry and
  schema-validated params. The runner scripts are part of this repo — never
  user-supplied — so there is **no arbitrary-code-execution surface**.
- Every analysis runs under **bubblewrap** (`bwrap`): `--unshare-net` (no network),
  `--ro-bind / /` (read-only FS), `--tmpfs /tmp` (fresh scratch), `--die-with-parent`,
  wrapped in `timeout`. Falls back to `timeout` alone if `bwrap` is absent.
- The server holds **no secrets**. The chatbot reads `GOOGLE_API_KEY` from the
  environment at runtime (never committed).

## Run

```bash
# prerequisites: Node 18+, R 4.x with: vars urca tseries waveslim quantreg igraph
#                jsonlite readxl ; and `bwrap` (bubblewrap) for the sandbox.
# data: a checkout containing papers/contagion-channels/data/G20.xlsx (see below)

cd compute-engine
export COMPUTE_REPO=/path/to/ivy-fineco        # repo root holding the data
export GOOGLE_API_KEY=...                       # only needed for the chatbot
node server/compute-server.mjs                  # → http://127.0.0.1:3200
```

- Dashboard: `http://127.0.0.1:3200/`
- Catalog: `GET /api/compute/catalog`
- Run: `POST /api/compute/run  {method, params}`
- Chat: `POST /api/chat  {message}`
- Health: `GET /health`

## Data

The engine reads daily G20 equity log-returns from
`$COMPUTE_REPO/papers/contagion-channels/data/G20.xlsx` (18 markets, 2006–2026).
This file is **not bundled** here. Point `COMPUTE_REPO` at a checkout that has it,
or adapt the `DATASETS` map in `server/compute-server.mjs`. (Dataset upload is a
planned enhancement.)

## Layout

```
compute-engine/
├── server/compute-server.mjs   # Node orchestrator: registry · validation · bwrap sandbox · /api/chat
├── r/                          # R analyses (each: Rscript x.R '<params-json>' → JSON on stdout)
│   ├── _io.R  adf.R  var_irf.R  dfa_hurst.R  garch.R  wavelet.R  wqte.R
├── py/_io.py                   # Python runner scaffold (future methods)
└── web/index.html              # single-page dashboard + chat panel
```

## Status & roadmap

- **Now:** 26 methods, bwrap sandbox, AI chatbot, Cloud Run deployment + an async
  workstation tower with GPU-accelerated transfer entropy — all verified on real G20 data.
- **Next:** dataset upload; packaged `contagionchannels` / `WaveQTE` estimators;
  VECM, panel-IV, local projections, DSGE (via `gEcon`); deployment;
  optionally a Vertex AI Agent Builder front-end for the chatbot.

## Licence

Research/academic use. © Dr. Avishek Bhandari, SHSSM, IIT Bhubaneswar.
