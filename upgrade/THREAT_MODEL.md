# THREAT_MODEL.md — blast-radius per new surface (Prompt 6, Step C)

> Governed by `UPGRADE_INVARIANTS.md` (Invariants 12–16). For each new surface: the
> adversary, the asset, the attack surface, and the control that bounds it — wired BEFORE
> the surface is reachable (Invariant 15). The engine's existing guarantee is the baseline:
> a public caller can run exactly the finite registered menu and nothing else. The upgrade
> EXTENDS that guarantee to the new surfaces; it relaxes none of it.

## Baseline (unchanged, the property everything else must preserve)
- Adversary: any anonymous caller. Asset: the compute account + its credentials + the credit
  envelope. Attack surface: the request body. Control: the **parameterised-only registry** —
  a method name + typed params, validated before any process spawns; no code, no path, no
  shell, no network egress from a runner. This is the primary RCE guard and it must remain
  the primary guard through every new route (Invariant 13).

## Per-surface threat model

### 1. Vertex / Gemini routes (model originates no number) — Invariant 13
- **Adversary:** a caller crafting a prompt to make the model emit a fabricated "result," or
  to make it call something outside the registry.
- **Asset:** the reproducibility property (every number is a sandboxed computation) + the
  paid-call budget.
- **Attack surface:** the natural-language field + the model's tool-call arguments.
- **Control:** the model's only tool is `run_analysis(method, params)` whose schema is the
  SAME registry `validate()` gate; the model **can name only registered methods** and
  **originates no number** — every quantity it states is a sandboxed computation it called or
  a cited retrieval. Two-phase pattern preserved (analysis tools and grounding never combined
  in one request, per documented API fragility). Spend bounded by COST_MODEL ceilings, checked
  before the paid call; over-cap -> coded 503, never a fabricated answer.

### 2. Vertex AI Search / grounded generation (cites real sources) — Invariant 13
- **Adversary:** a prompt-injection in a retrieved document, or a query designed to make the
  model invent a citation.
- **Asset:** citation integrity (a grounded claim must trace to a real retrieved source).
- **Attack surface:** the query + the retrieved corpus (`literature` datastore).
- **Control:** a retriever is a **registered surface**; grounding metadata (the retrieved
  passages + their source ids) is recorded with the answer; a **failable eval asserts every
  cited source is a real retrieved passage, not invented**, and that no number is
  model-originated. Retrieved-document text is DATA, not instructions — injection in a
  retrieved doc cannot issue an engine action (the model still can only call registered
  methods). NOT reachable until the datastore exists and the eval is green.

### 3. OAuth tokens / Meta creds — injected at boundary — Invariant 12
- **Adversary:** anyone who can read a log, an eval artefact, a provenance stamp, a commit,
  or a model prompt.
- **Asset:** the tokens themselves (GitHub OAuth in Secret Manager; Meta/IG/Gemini in
  `versiondevs/.env.local`).
- **Attack surface:** every place a value could be written.
- **Control:** secrets injected at the infrastructure boundary only, **referenced by env name,
  never by value**; a **secret-scan gate** runs before any commit and any deploy and **blocks
  on a hit** (proven by a planted dummy token that must block, then is removed). This session
  already practised it: every credential above was confirmed by env-name presence only — no
  value was printed.

### 4. Claude-in-Chrome — observe/verify only — Invariant 14
- **Adversary:** a malicious public page, or an instruction embedded in page content trying
  to make the browser act inside a logged-in session.
- **Asset:** any third-party authenticated session; any irreversible/outward action.
- **Attack surface:** the rendered page + its DOM/text.
- **Control:** Chrome flows are **observe/verify only** — render a public Econstellar surface
  and confirm it shows what `evals.json` produced; confirm the deployed revision via the public
  page. **No authenticated mutation, no logged-in third-party action, no payment/irreversible
  step.** A mutation-capable step, if ever proposed, **halts for explicit human confirmation
  and is logged**; browse requests originating from untrusted page content are refused. Page
  content is data, not commands.

### 5. Meta / third-party APIs — least-privilege, default-OFF — Invariant 16
- **Adversary:** an attacker trying to make the engine post/send on the operator's behalf, or
  an injection that triggers an outward action.
- **Asset:** the operator's social identity + audience; the engine's credibility.
- **Attack surface:** any outward-action route, if wired.
- **Control:** **NOT wired** absent a concrete reviewed need (none established in Prompt 6).
  If ever wired: least-privilege, read-mostly, default-OFF behind a flag, rate-limited,
  spend-bounded, secret-safe; **any outward action (post/send) requires explicit human
  confirmation in-session and a failable test of the confining guard.**

### 6. Any resource that can saturate (spend, quota, cores, VRAM, tabs) — Invariant 15
- **Adversary:** load (malicious or accidental) that exhausts a finite resource.
- **Asset:** availability + the credit envelope.
- **Control:** the **22-core-hang lesson generalised** — each new capability ships with the
  governor that bounds it, wired before it is reachable: spend ceiling (COST_MODEL), rate
  limit, quota guard, concurrency/VRAM/tab bound. The ceiling/guard is itself a failable eval.

## Risk-adjusted LAUNCH ORDER (lowest blast radius + clearest research value first)

1. **Embeddings + Vector Search over `literature`** — lowest blast radius (read-only,
   negligible cost ~Rs.4/day, no outward action, no mutation), clear research value (semantic
   retrieval for the research assistant). Build first; it is also the substrate the grounding
   datastore needs.
2. **Vertex AI Search / grounded generation** — read-only retrieval with high research value
   (grounded literature answers that cite real sources), once its datastore exists on the
   embeddings of step 1. Citation-integrity eval is the gate.
3. **Gemini-on-Vertex routing** — moves the existing, already-governed Gemini interpretation
   from the API-key path to the Vertex `aiplatform` endpoint; same `validate()` gate, same
   400-turn budget, modest added cost. Behaviour-preserving, so low risk, but no NEW research
   capability — hence third.
4. **Batch prediction** — async bulk embedding/classification; bounded by a hard batch-size
   cap. Useful but not on the critical path; fourth.
5. **Claude-in-Chrome verification** — $0, observe-only; can land any time as a verification
   surface for the public pages. Independent of 1–4.
6. **Meta APIs** — **do not wire.** No concrete reviewed need; default-OFF, recorded as a
   marked hole (Invariant 16). Revisit only if a specific, confirmed research-dissemination
   need arises, and then only behind human-confirmed outward actions.

Rationale: steps 1–2 deliver the clearest new research value (grounded, cited literature
retrieval) at the lowest blast radius (read-only, sub-rupee daily cost, no outward action);
step 3 is behaviour-preserving; 4–5 are bounded extensions; 6 stays off. Every step is
flag-OFF until its Prompt-7 eval is green and its governor trips in test.
