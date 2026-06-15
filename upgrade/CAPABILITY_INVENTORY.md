# CAPABILITY_INVENTORY.md — live read-only inventory (Prompt 6, Step A)

> Governed by `UPGRADE_INVARIANTS.md`. Built from read-only calls this session
> (2026-06-15), project `hopeful-flash-485308-v3` (#672903689767), account
> `avishekb@iitbbs.ac.in`. Invariant 7: every line below is a live call's output or a
> committed fact; values not re-checked are marked. Invariant 3: holes marked, never
> filled. NO production change was made by this prompt. Secrets confirmed by env-name
> presence only — no value was printed, logged, or stored.

## Standing coordinates (live-verified this session)
- `GET /health` -> `{ok:true, sandbox:"timeout", methods:26, timeout_s:90, revision:"shssm-compute-00036-llf"}` (cross-checks the Cloud Run latest-ready revision below).
- Active account `avishekb@iitbbs.ac.in`; project `hopeful-flash-485308-v3`; OAuth access token mintable (length only, value never printed).

## Cloud Run services (live: `gcloud run services list`)
| Service | URL | Latest ready revision | Role |
|---|---|---|---|
| `shssm-compute` | `…shssm-compute-b7ui3oxaqq-el.a.run.app` | **`shssm-compute-00036-llf`** | the kernel (26 methods) — cross-checked via `/health` |
| `neuricx-intel` | `…neuricx-intel-…` | `neuricx-intel-00007-kdj` | NEURICX news-intelligence |
| `shssm-form-api` | `…shssm-form-api-…` | `shssm-form-api-00003-42q` | form/intake API |
| `shssm-staging` | `…shssm-staging-…` | `shssm-staging-00012-nw6` | staging surface |

## BigQuery (live: `bq ls`)
Datasets: `grid`, `literature`, `neuricx`, `panels`, `robustness`, `systemic_risk`.
Tables confirmed: `neuricx.articles`, `neuricx.snapshots`, `systemic_risk.daily`,
`robustness.badges`, `grid.nodes`. (`literature`, `panels` datasets present; table
enumeration not exhaustively run this session — marked partial.)

## Enabled APIs relevant to the upgrade (live: `gcloud services list --enabled`)
| API | Status | Upgrade relevance |
|---|---|---|
| `aiplatform.googleapis.com` | ENABLED | Vertex AI (Gemini on Vertex, embeddings, batch prediction) |
| `generativelanguage.googleapis.com` | ENABLED | Gemini via API key — **already wired** in the engine (`/api/chat`, `/api/research`) |
| `discoveryengine.googleapis.com` | ENABLED | **Vertex AI Search / grounded generation** |
| `vectorsearch.googleapis.com` | ENABLED | Vector Search (embeddings retrieval) |
| `bigquery.googleapis.com` | ENABLED | warehouse (SRI / claims / literature) |
| `cloudscheduler.googleapis.com` | ENABLED | the live 06:00 UTC SRI tick |
| `secretmanager.googleapis.com` | ENABLED | boundary secret store |
| `run.googleapis.com` | ENABLED | the kernel host |
| `dialogflow.googleapis.com` | ENABLED | the existing CX agent |
| `modelarmor.googleapis.com` | ENABLED | model-safety filter (available, unwired) |
| `places-backend` / `geocoding-backend` | ENABLED | NEURICX geocoding |

## Secret Manager (names only — live `gcloud secrets list`)
`shssm-github-github-oauthtoken-e55fd4` (GitHub OAuth), plus three infra TLS/nginx
secrets. The Meta/IG/Gemini creds are NOT in Secret Manager; they live in
`versiondevs/.env.local` (boundary file), confirmed by env-name presence only:
`GOOGLE_API_KEY`, `FB_APP_ID`, `FB_APP_SECRET`, `INSTAGRAM_TOKEN`,
`VITE_INSTAGRAM_TOKEN`, `VITE_INSTAGRAM_ACCOUNT_ID`, `VITE_GITHUB_TOKEN`,
`REPLICATE_API_TOKEN` — all PRESENT (no value read). `GOOGLE_APPLICATION_CREDENTIALS`,
`GCP_PROJECT_ID` absent from `.env.local` (the Vertex SA JSON is at
`versiondevs/sa/hopeful-flash-vertex.json` per the project contract — not re-read this
session, Invariant 7).

## Capability classification (available / enabled-but-unwired / not-available)
| Capability | Class | Evidence | Note |
|---|---|---|---|
| Gemini interpretation (chat/research) | **WIRED + LIVE** | engine `/api/chat`, `/api/research` (documented; two-phase, search and tools not combined) | already governed by 10/min, 5/min, 400 paid/day |
| Gemini on **Vertex** (`aiplatform`) endpoint | **ENABLED, UNWIRED** | `aiplatform` enabled; model GET -> HTTP 404 (reachable, not a GET resource) | upgrade = route through Vertex vs the API-key path |
| **Vertex AI Search / grounding** (`discoveryengine`) | **ENABLED, NO DATASTORE** | API enabled; datastore list -> 503 transient (none confirmed) | needs a datastore built over `literature` before it can ground; marked hole |
| **Embeddings / Vector Search** | **ENABLED, UNWIRED** | `vectorsearch` + `aiplatform` enabled | for literature retrieval; unwired |
| **Batch prediction** | **ENABLED, UNWIRED** | `aiplatform` enabled | async bulk; unwired |
| Claude-in-Chrome verify | **AVAILABLE (client-side)** | MCP tools available in-session | observe/verify only (Invariant 14) |
| Meta / Instagram APIs | **CREDS PRESENT, DEFAULT-OFF** | env-names present in `versiondevs/.env.local` | NOT wired into the engine; Invariant 16 keeps OFF absent a concrete reviewed need |
| BigQuery warehouse | **WIRED + LIVE** | `systemic_risk.daily`, `neuricx.*`, `robustness.badges`, `grid.nodes` | already the engine's store |

## Holes marked (Invariant 3 — not filled)
- Vertex AI Search datastore list returned 503 (transient) — **no datastore confirmed provisioned**; treated as not-available until built, not assumed present.
  - **UPDATE 2026-06-15 (filled):** datastore `econstellar-literature` + engine `econstellar-literature-search` provisioned; **63 docs** imported from `literature.papers`; live search returns real `paper_id`s. grounded_search is now LIVE. (The four upgrade capabilities — embeddings / grounded_search / gemini_vertex / batch_predict — are all flag-ON and live-verified; see `UPGRADE_LEDGER.md`.)
- `literature` / `panels` BigQuery table enumeration not exhaustively run this session.
- The Vertex SA JSON contents were not re-read (boundary file; env-name/path only).
- `generativelanguage` model-list call returned no parseable models over the OAuth path this session (the engine uses the API-key path, which is the documented working route); marked as not-re-probed rather than asserted.
