# Econstellar Phase 29 · Literature Ingestion (29.x)

Pulls recent econometrics papers from **arXiv**, extracts structured claims with
**Gemini 2.5 Flash**, and streams them into **BigQuery**
(`hopeful-flash-485308-v3.literature.papers`). Zero external dependencies — Node
built-ins + global `fetch` (Node ≥ 18; verified on v22).

## Files

| File | Purpose |
|------|---------|
| `ingest.mjs` | Pipeline + CLI + embedded self-test (`--selftest`). |
| `schema.json` | BigQuery table schema (29.2) — also the dry-run record contract. |
| `README.md` | This file. |

## CLI

```
node ingest.mjs [--days N] [--cats a,b,c] [--max N] [--dry] [--selftest]
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--days N` | `7` | Keep papers submitted within the last N days. |
| `--cats a,b,c` | `econ.EM,q-fin.RM,stat.AP` | arXiv categories to pull. |
| `--max N` | `50` | `max_results` per category request. |
| `--dry` | off | **No network calls.** Writes `./literature-dryrun.jsonl` (with `--selftest`'s fixture) and skips Gemini + BigQuery. A bare `--dry` (no fixture) does nothing and exits 0. |
| `--selftest` | off | Runs the offline parser / Gemini-parse / dry-mode verification suite. |

## Throttle & dry-mode handling (hard-won)

- **arXiv is rate-limited.** On rapid requests it returns the literal body
  `Rate exceeded.` — the parser treats that as an error (it is **not** valid Atom).
  The pipeline sleeps **≥ 3000 ms between arXiv requests** (arXiv etiquette) and
  follows redirects.
- **`--dry` makes zero network calls** (no proxy token fetch, no arXiv, no Gemini,
  no BigQuery). It is the only locally-verifiable path in a network-isolated
  sandbox. Each dry record carries `extraction: "skipped (dry)"` and `results: []`.

## Local verification (already run; reproduce on this box)

```bash
node --check ingest.mjs        # 1. syntax OK
node ingest.mjs --selftest     # 2-4. parser + gemini-parse + --dry/JSONL-vs-schema
```

The self-test asserts: 2 entries parsed (id/title/authors/published/category/
abstract/doi, incl. XML-entity decoding); a mock `generateContent` response parses
to the right `methods`/`datasets`/`claims` (FLOAT value + null preserved) and
builds a schema-correct record; and `--dry` over the fixture writes
`literature-dryrun.jsonl` whose every line is valid JSON carrying all
`schema.json` fields.

---

## LIVE run — **HOST activity** (not runnable in this sandbox)

The sandbox network is host-only and **cannot reach** arXiv / Gemini / BigQuery.
Run the live pipeline on the **host** (tower), where the proxy and outbound
network are available.

### Prerequisites

1. **Proxy on `:3001`** (provides the BigQuery OAuth bearer via
   `GET /api/gcloud-token`). Started from `versiondevs/` (`npm run proxy`).
2. **`GOOGLE_API_KEY`** in the environment (Gemini). It already lives in
   `versiondevs/.env.local`; export it for the run.
3. **BigQuery `literature` dataset + `papers` table must exist first.**

```bash
# 0. project + auth (host)
gcloud config set project hopeful-flash-485308-v3
export GOOGLE_API_KEY="$(grep '^GOOGLE_API_KEY=' /home/ecolex/versiondevs/.env.local | cut -d= -f2- | tr -d '\"'\''')"

# 1. create the dataset (idempotent: ignore "Already Exists")
bq --project_id=hopeful-flash-485308-v3 mk --dataset \
   --description "Econstellar Phase 29 literature ingestion" \
   hopeful-flash-485308-v3:literature

# 2. create the table from schema.json (RECORD/REPEATED-aware)
bq --project_id=hopeful-flash-485308-v3 mk --table \
   hopeful-flash-485308-v3:literature.papers \
   /home/ecolex/versiondevs/ivy-fineco/compute-engine/neuricx/literature/schema.json

# 3. run the ingest (proxy must be up on :3001)
cd /home/ecolex/versiondevs/ivy-fineco/compute-engine/neuricx/literature
node ingest.mjs --days 7
#   …or scope it: node ingest.mjs --days 14 --cats econ.EM,q-fin.RM --max 100
```

### Notes

- **Auth split (verified infra fact):** BigQuery needs an **OAuth bearer**
  (from the proxy / metadata server), **not** the `GOOGLE_API_KEY` — the key only
  works for Gemini. The SA needs `roles/bigquery.dataEditor` + `roles/bigquery.jobUser`.
- **Streaming inserts** (`insertAll`) land in the streaming buffer and can't be
  `DELETE`d for ~30–90 min — verify with `bq query` / the BigQuery console, don't
  expect immediate DML.
- Gemini is called as **plain `generateContent`** (no tools, no search) — never
  combine search + function-calling in one request.
- A Gemini JSON parse failure logs and **skips** that paper; the run never crashes.

### Env overrides

`GCLOUD_TOKEN_URL` (default `http://localhost:3001/api/gcloud-token`),
`BQ_PROJECT` / `BQ_DATASET` / `BQ_TABLE`, `GOOGLE_API_KEY`.
