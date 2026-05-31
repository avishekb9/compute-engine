# Vertex Agent Builder — "SHSSM Econometrics Analyst"

Status (2026-05-31): **LIVE & verified end-to-end** — natural language → agent → compute_engine tool → Cloud Run R analysis → analyst explanation. Verified: "Is the UK market stationary?" → ADF −52.64 + KPSS 0.156 → stationary.

## What's already done (verified)

- **Public compute API on Cloud Run** — the agent's tool calls this:
  `https://shssm-compute-b7ui3oxaqq-el.a.run.app`
  - `GET /health` → ok; `POST /api/compute/run {method, params}` → real results.
  - Verified over public HTTPS: ADF India −49.18; WQTE USA→India 0.0391.
- **Dialogflow CX agent** "SHSSM Econometrics Analyst"
  - project `hopeful-flash-485308-v3`, location **global**
  - agent id `fd984817-4292-4bc2-af78-f4551bf8ecbc`
- **OpenAPI tool** `compute_engine` id `ddc64f1c-ad4b-4e05-b5d0-d2ec905a75bb`
  - schema = `agent/openapi-tool.yaml`, server = the Cloud Run URL above
- **Playbook** "Econometrics Analyst" id `7f793d84-5a25-4ca2-99ed-81c103ddd184`
  - goal + 5 steps + `referencedTools = [compute_engine]`; agent.startPlaybook set to it.

## How it was built (all via REST — no Console needed)

The agent is already generative + tool-using. Key step that flipped it from the
no-NLU default flow to working: set `agent.startPlaybook` to the playbook path
(PATCH `?updateMask=startPlaybook`). Steps below are the optional Console polish.

1. Console → **Agent Builder → Conversational Agents** (or Dialogflow CX),
   project **hopeful-flash-485308-v3**, region **global**.
2. Open **SHSSM Econometrics Analyst**.
3. Confirm it's running the **playbook** "Econometrics Analyst" as the start
   resource (Agent settings → "Start resource" / "Generative"); pick a Gemini
   model (e.g. gemini-2.5-flash) for the playbook if prompted.
4. Open the playbook → confirm the **compute_engine tool** is attached.
5. Click **Test Agent** and ask: *"Is the UK equity market stationary? Run the
   test."* → it should call the tool and explain the ADF/KPSS result.
6. (Optional) **Publish** → enable the Dialogflow Messenger / web widget and
   embed it in the econstellar dashboard.

Funded by the GenAI App Builder credit (₹94.8K, exp 2027-04-19).

## Already-working alternative

The custom **Gemini `/api/chat`** endpoint in the compute server does the same
NL → tool → analysis → explanation loop and is verified end-to-end. Agent Builder
is the polished, publishable product layer on top of the same Cloud Run tool.

## Recreate from scratch (if needed)

```bash
TOKEN=$(gcloud auth print-access-token --account avishekb@iitbbs.ac.in)
BASE=https://global-dialogflow.googleapis.com/v3/projects/hopeful-flash-485308-v3/locations/global
H=(-H "Authorization: Bearer $TOKEN" -H "x-goog-user-project: hopeful-flash-485308-v3" -H "Content-Type: application/json")
# 1) agent  → POST $BASE/agents {displayName,defaultLanguageCode:en,timeZone}
# 2) tool   → POST $BASE/agents/<AID>/tools {displayName:compute_engine,openApiSpec:{textSchema:<openapi-tool.yaml>}}
# 3) playbook → POST $BASE/agents/<AID>/playbooks {displayName,goal,instruction:{steps:[...]},referencedTools:[<tool path>]}
#    (do NOT put ${TOOL:...} tokens in step text — reference via referencedTools only)
# 4) PATCH $BASE/agents/<AID>?updateMask=startPlaybook {startPlaybook:<playbook path>}
# 5) finish the generative/model binding in the Console (above).
```

---

## Web widget — Dialogflow Messenger on econstellar (2026-05-31)

**DONE — embedded + pushed live.** The `<df-messenger>` v1 web component is wired
into `research-engine.html` on `avishekb9/econstellar` `main` (commit `bc71925`,
pushed `eb12c2d..bc71925`), served at
https://avishekb9.github.io/econstellar/research-engine.html . Confirmed the
raw-GitHub copy carries the widget (agent-id present); the GitHub-Pages CDN
refreshes within a minute or two of the push. The widget is themed to the
dashboard's true-black / cyan (`#00d4ff`) / green (`#00ff88`) palette in JetBrains
Mono and pins a chat bubble bottom-right. Snippet uses the verified triple:
`location=global`, `project-id=hopeful-flash-485308-v3`,
`agent-id=fd984817-4292-4bc2-af78-f4551bf8ecbc`.

**IMPORTANT — authoritative checkout:** the live site is the GitHub remote. Clone
it fresh (`git clone https://github.com/avishekb9/econstellar`) to edit. The copy
at `ivy-fineco/prototypes/econstellar/` is NOT a git repo and is stale (461 lines
vs the remote's 466) — editing it does nothing to the public site.

**ONE REMAINING STEP (PI / Console — an access-control change, so not done
programmatically):** enable the agent's *Dialogflow Messenger* integration with
**Unauthenticated API** so anonymous visitors can use it. The bubble renders
without this, but message sends fail until it is on.
1. Open the agent:
   https://dialogflow.cloud.google.com/cx/projects/hopeful-flash-485308-v3/locations/global/agents/fd984817-4292-4bc2-af78-f4551bf8ecbc
2. **Manage → Integrations → Dialogflow Messenger → Connect.**
3. API enablement → **Unauthenticated API → Enable.**
4. (Recommended) set the integration's **domain allowlist** to
   `avishekb9.github.io` so third parties cannot embed the widget and spend the
   GenAI credit.
5. The Console's generated snippet matches what is already embedded — no page
   re-edit needed.

**Cost / abuse note:** a public unauthenticated agent means each visitor query
calls Gemini (the playbook) and may call the Cloud Run compute engine. Funded by
the GenAI App Builder credit (₹94,812). Cloud Run is capped (max-instances 2,
scale-to-zero); the domain allowlist above is the main extra safeguard.

**Zero-toggle alternative:** the compute engine's own public `/api/chat` (same
NL→tool→analysis→explain loop) is already on Cloud Run, so a small custom widget
POST-ing to `https://shssm-compute-b7ui3oxaqq-el.a.run.app/api/chat` would work
with no Console step — use this if public Dialogflow exposure is undesirable.
