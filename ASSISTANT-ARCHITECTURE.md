# Vistaar CRM assistant — architecture

_Investigation output required by §2, updated with the decisions taken. Implementation begins at
Stage 1; nothing beyond it is built yet._

---

## 1. What already exists

### Services

| Service | Runtime | Has | Does not have |
|---|---|---|---|
| `crm-api` | Python 3.11, FastAPI, Docker, **host network**, `127.0.0.1:5002` | **MongoDB**, **Redis**, auth, permissions, org isolation, 133 routes, every repository | **No LLM SDK of any kind** |
| `crm-worker` | Same image, `python -m app.worker` | 14 background runners | — |
| `ai-brain-service` | Python, Docker, **bridge network**, `:8091` | **`anthropic==0.125.0`**, **LangGraph**, **Postgres** | **No MongoDB** |
| `vistaar.service` | Node, systemd, `:5001` | Baileys WhatsApp socket | Everything else (migrated out) |

### The AI boundary

`crm-api/app/ai_brain.py` is an HTTP client, and its docstring states the rule:

> The brain stays the single owner of AI behaviour; this service asks it questions.

Exactly one process holds an Anthropic key, and it is not the one with the database.

### Data

MongoDB `rs0`: `conversations`, `messages`, `contacts`, `followuptasks`, `activitylogs`,
`callrecords`, `leadsources`, `tags`, `stages`, `users`, `organizations`, `aiknowledge`.

Postgres holds only LangGraph checkpoints — no business data, explicitly safe to wipe.

---

## 2. Four places the brief did not match the code

**Facts the brief could not have known, each of which changed a decision.**

### 2.1 The environment variables named in §3 do not exist

Real names, from `docker-compose.yml`:

```
AI_BRAIN_LLM_API_KEY
AI_BRAIN_LLM_PROVIDER     (default: anthropic)
AI_BRAIN_LLM_MODEL        (default: claude-haiku-4-5-20251001)
```

### 2.2 LangGraph is already in the stack

A dependency of `ai-brain-service` with Postgres checkpointing wired up. §3 asked for
justification before introducing it; it is already there.

### 2.3 Most of §5 already exists, and is better than an LLM at it

`crm-api/app/lead_score.py` (356 lines) already produces what §5 asks for:

```
event date given   +20 | venue given       +15 | budget given         +15
replied to the AI  +20 | asked for a quote +15 | asked about a date   +15

80-100 HOT | 50-79 WARM | 20-49 COLD | 0-19 LOW INTENT
```

Deterministic, explainable signal by signal, stored as `leadScore`, already tested. Alongside it:
`sales_rejection.py`, `classification.py`, `event_date.py`, `lead_field_rules.py`, and the stored
`aiFacts`, `aiIntent`, `aiCategory`, `leadQualificationStatus`, `promisedFollowUpAt`.

**Decided: the assistant reads and explains this score using conversation evidence. It does not
compute a second one.** It adds only what is genuinely missing — objections, missing information,
recommended next action, and message-level evidence.

### 2.4 No vector infrastructure, and MongoDB 8 self-hosted has no vector search

That is Atlas-only. §4A therefore needs a real decision, taken in §4 below.

---

## 3. Decided architecture

**Orchestration stays in `ai-brain-service`. `crm-api` is the trusted data-access and
permission-enforcement layer.** The AI service never touches MongoDB.

```
owner ──> crm-api /assistant/*  ──>  ai-brain-service (LangChain agent)
                 ^                              │
                 └──── internal tool API ───────┘
                       (authenticated, org-scoped)
```

Every tool call is an HTTP request back into `crm-api`, which enforces permissions and
organisation isolation exactly as it does for the 133 existing routes. There is no second
permission system.

### 3.0 THE BLOCKER BELOW IS AVOIDABLE — and production already avoids it

**Investigated for Stage 3. This supersedes §3.1: no network change is needed.**

There is already a working assistant in production, and it is built on a pattern where
**`ai-brain-service` never calls back into `crm-api` at all**:

| Step | Where | What |
|---|---|---|
| 1 | `crm-api` → brain | `POST /v1/assistant/plan` — brain decides what to look up. *Answers nothing.* |
| 2 | `crm-api`, in-process | Runs the query itself, organisation injected server-side |
| 3 | `crm-api` → brain | `POST /v1/assistant/answer` — brain phrases it. `data` is *"Already fetched by the caller. The only thing statable."* |

See `crm-api/app/owner_assistant.py` and `ai-brain-service/app/main.py:464`. Every one of the
brain's twelve endpoints is stateless request/response; it is handed what it needs and holds no
database.

`crm-api` → brain **already works today** (crm-api is on host networking, the brain publishes
8091 on the host, and `AI_BRAIN_SERVICE_URL=http://localhost:8091`). Only the reverse direction
is broken, and the reverse direction is one this architecture does not need.

**Recommended for Stage 3: extend this pattern to a multi-step tool loop.** The brain returns
*which tool to call with which arguments*; `crm-api` executes it in-process against the Stage 1
registry and calls the brain again with the result. The loop counter lives in `crm-api`.

This keeps every decision taken:

- Orchestration — prompt, model call, tool choice — stays in `ai-brain-service`.
- `crm-api` remains the only thing touching MongoDB and the only thing enforcing permissions.
- No second permission system, because there is no second entry point.

**Consequence for the approved `aud=assistant-tools` token: it is not needed for this design.**
A token exists to authenticate an inbound HTTP call, and there is no inbound tool endpoint —
the tools are called in-process by the same service that validated the user's session. Building
it now would mean building authentication for a call path the evidence says not to create. It
stays designed and un-built; if the brain ever does need to call back, §3.2 is the design.

This is strictly safer than a callback: a token that is never minted cannot be exfiltrated by
prompt injection.

### 3.1 The blocker, for the record — only if a callback is ever chosen

This has to be solved before any tool call works, and it is infrastructure, not code:

- `crm-api` runs with `network_mode: host` and uvicorn binds **`127.0.0.1:5002`**.
- `ai-brain-service` runs on the **default bridge network** (`ports: '8091:8091'`).

Inside a bridged container, `127.0.0.1` is the container itself. **`ai-brain-service` cannot
reach `crm-api` today.** This is the same trap `crm-api/DEPLOY.md` already documents — the first
deploy of `crm-api` returned 503 for exactly this reason.

Options:

| | Change | Consequence |
|---|---|---|
| **A** | Give `ai-brain-service` `network_mode: host` | **Worse than it looks — see below.** Its `ports:` mapping must be removed and uvicorn's `--host` changed from `0.0.0.0` to `127.0.0.1`, **or it becomes publicly reachable** |
| B | `extra_hosts: host-gateway` + bind `crm-api` on the bridge gateway too | More moving parts; `crm-api` would listen on a second interface |
| C | Put both on a user-defined bridge network | Cleanest in Docker terms, but `crm-api` uses host networking precisely so `localhost` means the same thing as it does for Node — changing that re-opens a solved problem |

**Option A also breaks LangGraph checkpointing, which my earlier write-up missed.** The brain
reaches Postgres as `DATABASE_URL: postgresql://ai_brain:ai_brain@ai-brain-db:5432/...` — a
Docker DNS name that resolves *only* on a bridge network. Under `network_mode: host` there is
no embedded DNS, so `ai-brain-db` stops resolving and the URL would also have to be rewritten
to `localhost:5434`. That is three coupled edits (ports, uvicorn bind, database URL), any one
of which silently breaks something different, applied by hand to a file the repository does not
own.

**Revised recommendation: none of them.** Use §3.0 and change no network configuration.

Note for whoever does touch this file: `crm-api/DEPLOY.md` records that the server's
`docker-compose.yml` carries **uncommitted loopback-binding edits** (`127.0.0.1:27017:27017`
and friends) that are not in the repository. The repo's `'8091:8091'`, `'27017:27017'` and
`'6379:6379'` publish on every interface; the server's file is believed not to. **That cannot
be confirmed from the repository** — it needs reading on the host.

### 3.2 How the user's identity reaches a tool call — UNRESOLVED, needs a decision

`ai-brain-service` has no concept of a user today. The brief requires that organisation identity
be derived server-side and that Claude never supply it. Two viable designs:

**(a) Forward the caller's own access token.** `crm-api` passes the user's JWT to
`ai-brain-service`, which attaches it to each tool call. `crm-api` validates it with the existing
`authenticate` dependency — org and permissions come from the signed token, so Claude cannot
influence them.

*Risks:* the user's full-power token sits in the AI service's memory for the duration of a run,
and access tokens expire in ~15 minutes, which a long multi-tool run could outlive.

**(b) A scoped, short-lived assistant token.** `crm-api` mints a token with `aud=assistant-tools`,
a ~5-minute lifetime, and the caller's org, user id and permissions. The tool endpoints accept
only this audience.

*Benefit:* blast radius. If a prompt-injection attack ever exfiltrates the token, it is read-only,
expires in minutes, and cannot be replayed against the main API.

**Recommendation: (b).** It costs one small token-minting function and removes a whole class of
exposure. **This is the single most important open decision and needs sign-off before Stage 3.**

### 3.3 Assignment-level visibility is a privilege-escalation risk

A staff user holding only `conversations.read_assigned` sees their own threads in the inbox. The
assistant **must** be subject to the same rule, or "summarise our hottest leads" becomes a way to
read colleagues' conversations.

The existing gate (`conversation_access.py`) already encodes this. Every tool that returns
conversation or message data must go through it rather than querying the collection directly.
Tested explicitly in Stage 1.

---

## 4. Vector storage and embeddings

**Decided: a replaceable vector-store abstraction.** MongoDB + NumPy cosine is the first
implementation, explicitly as a prototype, with benchmarks before it is treated as final.

| | Fit | Cost |
|---|---|---|
| **Embeddings in MongoDB, cosine in NumPy** | No new infrastructure; org filter is a plain Mongo query, so §9 isolation uses the same mechanism as everything else | Brute force. Needs benchmarking; will not scale indefinitely |
| **pgvector in the existing Postgres** | Real ANN index, reuses a running container | `crm-api`/`ai-brain-service` gains a Postgres client |
| A dedicated vector DB | Best at scale | Violates §14 |

**To be measured before finalising (§3 of the decisions):** index size and retrieval latency at
realistic volumes — 10k, 50k and 200k message chunks — with the org filter applied.

**Embedding model: local and multilingual.** WhatsApp content here is mixed English/Hindi and
transliterated Hinglish, which rules out English-only models. Candidate:
`paraphrase-multilingual-MiniLM-L12-v2` (~470 MB installed with torch, 384 dimensions) or
`multilingual-e5-small`. **Quality must be evaluated on real CRM content before it is adopted**,
including transliterated text, and the model size and memory footprint documented — this matters
on a box that has already been memory-constrained.

**Never embedded:** encrypted contact fields (phone, email), auth tokens, API keys, session
state. The redaction rules in `crm-api/app/redaction.py` already enumerate the sensitive key
names and should gate the indexing pipeline.

---

## 5. Model choice

**Decided: reuse the configured model, with an assistant-specific override that defaults to it.**
No silent switching.

The configured model is `claude-haiku-4-5-20251001`, which suits the existing short-form jobs.
Multi-step agent planning is harder work. Before recommending a change, benchmark Haiku against
a stronger model on real multi-step CRM questions and report accuracy, latency and cost.

---

## 6. Implementation stages

| Stage | Contents | Status |
|---|---|---|
| **1** | **Read-only CRM tools in `crm-api`, Pydantic validation, org-isolation tests. No LLM.** | **done** — see §8 |
| **2** | **Lead intelligence: explains the existing score with conversation evidence** | **done** — see §9 |
| **3** | **Multi-step tool loop driven by `crm-api` (§3.0), retrieval, persistence, API, UI** | **done** — see §11 |
| 4 | Assistant conversation persistence and multi-turn context | **done** — folded into Stage 3 |
| 5 | Embedding model evaluation + indexing pipeline | not started |
| 6 | RAG retrieval wired into the agent | **lexical done**; dense retrieval not implemented — §11 |
| 7 | Public assistant API | **done** — folded into Stage 3 |
| 8 | Background indexing — resource impact costed before any production run | not started |

---

## 7. Open questions

| # | Question | Blocks | Recommendation |
|---|---|---|---|
| 1 | ~~Network path between the services~~ | nothing | **Resolved by investigation — §3.0. No change needed.** |
| 2 | ~~Tool-call authentication~~ | nothing | **Not needed under §3.0; design retained in §3.2 if a callback is ever chosen.** |
| 3 | Per-tool permission mapping | Stage 1 | Each tool declares the permission it needs; default deny |
| 4 | Tool-call budget per question | Stage 3 | Hard cap; an agent loop can otherwise spend unboundedly |
| 5 | Are assistant tool calls audited? | Stage 3 | Yes — `audit.py` exists and reads are worth recording here |
| 6 | Prompt injection via indexed customer messages | Stage 6 | Org comes from the token, never an argument; tools validate every parameter |
| 7 | Should `get_contact_detail` be assignment-scoped? (§8) | nothing | It currently matches `GET /contacts/{id}`, which is org-scoped only. Tightening the tool alone would make the assistant stricter than the app for no gain — tighten both, or neither |

---

## 8. Stage 1 — built

`crm-api/app/assistant_tools.py`, `crm-api/tests/test_assistant_tools.py`. Six tools:
`search_leads`, `get_lead_detail`, `get_conversation_messages`, `find_inactive_leads`,
`get_pending_reminders`, `get_contact_detail`. No LLM, no writes, no `organization_id` argument
anywhere.

**62 tests. Full suite 13,687 passed / 28 skipped.**

### What the tests are worth

A suite that passes first try proves only that it agrees with the code. 17 mutations were applied
to the module, each breaking a security property it claims to hold, each run in its own
subprocess. **17/17 killed** — but only after two rounds:

- **A real gap.** `assigned_to=context.actor_id` → `None` in `get_pending_reminders` survived.
  Nothing seeded reminders for two users, so the assistant could have returned a colleague's
  private notes — the kind that have no conversation attached — and every organisation-isolation
  test would still have passed, because those notes are inside the right organisation. Five tests
  added, including that an **administrator** gets no more than a staff member here. This is the
  one tool `read_all` must not widen.
- **A bad mutation, not a gap.** "Parse arguments before the permission check" collapsed two
  lines into one expression that still ran after the check — an equivalent refactor dressed as a
  mutation. Rewritten to actually hoist the parse above the check; then it died.

### Three decisions worth recording

1. **`_intent_band` reads the stored `leadScore` and names the band.** It does not compute
   anything. Per the decision not to duplicate `lead_score.py` — a rival score would give two
   different answers to "is this lead hot" depending on which path asked. `bool` is excluded
   explicitly: it is a subclass of `int` in Python, so `True` would otherwise band as low intent.
2. **`LEAD_SUMMARY_FIELDS` is an allowlist.** A field added to the conversation schema later is
   invisible to the assistant until somebody decides it is safe. A denylist exposes every new
   field by default, and the encrypted contact fields are one rename away.
3. **`get_contact_detail` is organisation-scoped, not assignment-scoped** — matching the existing
   route exactly, and returning a strict subset of its fields. Documented in the source and
   raised as open question 7 rather than silently diverging in either direction.

### Not built at Stage 1, and deliberately

No tool authentication yet (§3.2) — these are callable in-process only. Nothing exposes them over
HTTP, which is the right order: the mechanism that decides *who* may call a tool should be
designed once, after the tools exist, not grown one endpoint at a time.

---

## 9. Stage 2 — built

`crm-api/app/lead_intelligence.py`, `crm-api/tests/test_lead_intelligence.py`, plus a seventh
tool `get_lead_intelligence` wired into the Stage 1 registry behind the same visibility gate.

**66 + 5 tests. 25/25 mutations killed on the first sweep.**

### It explains the score, it does not compute one

`explain_lead` **reads** `leadScore`, `leadScoreBand` and `leadScoreSignals` from the
conversation. It never calls `compute_lead_score`. A test pins this with a deliberately stale
row whose facts would compute to 50 while storage says 10 — the module must report 10, because
reconciling the two is `recompute_lead_score`'s job and a second opinion here would mean the
assistant and the lead's own inbox row disagreed about whether a lead is hot.

The band is read from storage too, not derived from the score, for the same reason.

### What it adds

| | |
|---|---|
| **Evidence** | the message behind each fired signal |
| **Objections** | price, timing, competitor, trust, decision-maker — English *and* Hinglish |
| **Missing information** | the unfired fact signals, as questions |
| **Recommended action** | one next step, with a stated reason |

### Three decisions worth recording

1. **Evidence is attribution and says so.** Nothing in the schema records which message caused a
   signal to fire, so the payload carries a `basis` field — `matched` when the scorer's *own*
   predicate (`default_is_quotation_request`) located it, `fact_value` when a stored fact was
   found verbatim in the text — and an `evidenceNote` stating it is an attribution. Reusing the
   scorer's predicates rather than writing new matchers is what stops evidence from ever
   contradicting the score. A fact that came from a Meta lead form and appears in no message is
   reported with `messageId: null` rather than being dropped or attributed to a guess.
2. **Only inbound messages can carry an objection.** Our own *"is the price a concern for you?"*
   contains every price-objection phrase there is; matching it would have the business objecting
   to itself and then drive `address_objection` at high urgency on a thread where nobody
   objected. Tested explicitly.
3. **The recommendation ladder is ordered for safety, not for score.** `opted_out` and
   `sales_rejected` are checked first and return immediately, so no combination of a hot score,
   an open objection and a month of silence can produce a contact recommendation for somebody
   who asked not to be contacted. Tested against exactly that hostile combination rather than
   the easy case.

A fourth, smaller one: a fact recorded as *"not decided yet"* is distinguished from a fact that
is absent, reusing `is_unanswered_value`'s existing undecided vocabulary. Re-asking a question
the customer already failed to answer reads as not having listened, so the recommendation says
to check whether it has changed instead.

---

## 10. Found while reading, fixed, and unrelated to the assistant

**`who_spoke_last` was always `"us"`.** `ai_brain_service.classify_conversation_outcome`
compared `direction == "inbound"` against message rows that `inbound_router.py` writes as
`"in"`, so the comparison was false for every customer message ever stored. The AI brain was
told the business had spoken last even immediately after a customer replied, on every follow-up
outcome decision. `build_transcript`, ten lines above in the same function, compared correctly
against `"in"` — which is how two contradictory comparisons sat side by side unnoticed. Nothing
tested it.

The fix is not `"inbound"` → `"in"`: the `messages` collection stores **four** spellings
depending on the writer.

| Writer | Stores |
|---|---|
| `inbound_router.py` — customer's message | `"in"` |
| `outbound_messages.py` — our reply | `"outbound"` |
| `owner_conversation.py` — owner's own thread, both ways | `"inbound"` / `"outbound"` |
| `google_calendar_reminders.py` (`MESSAGE_DIRECTION_OUT`) | `"out"` |

So `== "in"` would have been correct for the customer and newly wrong for the owner thread. New
module `crm-api/app/message_direction.py` is now the single place that knows this, with
`is_inbound` / `is_outbound` / `speaker_of`; unrecognised values are neither, rather than
defaulting to a side. `lead_intelligence.py` uses it too.

Not normalising the stored data: rewriting a production collection is a migration with real
risk and no urgency, and teaching the readers costs nothing.

`nurture_sweep.py:265` already handled both inbound spellings and is left alone.

---

## 11. Stage 3 — built

Multi-step reasoning, retrieval, persistence, an HTTP API and the frontend.

### The loop, and where each half runs

```
crm-api ──POST /v1/assistant/agent-turn──> ai-brain-service   (decides: tools, or answer)
   │                                              │
   │  <───────── "call search_leads(...)" ────────┘
   ├── execute_tool(...) in-process, inside the caller's ToolContext
   └── loop, result appended                      (max 6 steps)
```

**No inbound tool endpoint and no assistant token**, per §3.0. The brain cannot reach back into
`crm-api`, so there is no credential for prompt injection to steal and no second place where
organisation scoping could be got wrong.

| Added | Where |
|---|---|
| `complete_with_tools` | `ai-brain-service/app/llm.py` — Anthropic tool use |
| `run_turn` + `/v1/assistant/agent-turn` | `ai-brain-service/app/assistant_agent.py`, `main.py` |
| The loop | `crm-api/app/assistant_agent.py` |
| Retrieval | `crm-api/app/assistant_retrieval.py` |
| Thread persistence | `crm-api/app/assistant_threads.py` |
| HTTP API | `crm-api/app/routers/assistant.py` |
| UI | `frontend/src/pages/AssistantPage.tsx`, `components/assistant/` |

### Why there is no LangGraph in the assistant

This service already runs a LangGraph graph with Postgres checkpointing, and that is right for
what it does: the lead conversation graph **pauses** at `owner_approval` via `interrupt()` and
stays frozen until a human decides. Checkpointing exists for exactly that.

The assistant has no pause. It is a read-only Q&A loop that runs to completion in seconds, and —
decisively — **`ai-brain-service` cannot run that loop at all**, because the loop body is a tool
call against MongoDB and that service has no database. A graph there would be a one-node graph
whose only edge returns to the caller, adding a Postgres write per turn and explaining nothing.

### RAG: what is and is not implemented

**Implemented:** a replaceable `Retriever` abstraction with a **lexical** backend — IDF-weighted
term overlap with sqrt length normalisation, pure Python, scope applied as a MongoDB query
filter.

**NOT implemented: dense/embedding retrieval.** `numpy`, `torch` and `sentence-transformers` are
not installed in `crm-api`. Adding ~470 MB to a host that has already been memory-constrained, on
the strength of an un-run benchmark, is precisely the decision that was deferred.
`get_retriever()` is the single swap point; a backend needs only `search`.

**Retrieval never replaces live queries.** It answers "what was said before", never "how many
leads are hot" — a stale indexed answer to a counting question would be confidently wrong. Its
output is passed as *labelled background*, never merged into the user's question, so the model
can tell what was asked from what was fetched.

**The risk it would have been:** every other path to conversation text goes through
`conversation_access`. Retrieval is a second path, and its output lands in the prompt unmediated
by any tool. Scoped to the organisation only, "what did we agree about December?" would quietly
return a colleague's thread. `search` therefore takes a `ToolContext` and applies the same scope
resolver the tools use — there is no organisation-only variant to call by mistake.

### Threads belong to a person

Every read and write filters on `(organizationId, userId)` together, owner from the session. A
thread holds answers computed under the asker's permissions, and is replayed into the model on
every later question in it — so a staff member reading an admin's thread would bypass the Stage 1
gate using data fetched legitimately for someone else. There is no organisation-wide listing.

`trim_history` cuts only at a plain user turn: Anthropic requires every `tool_use` to be answered
by its `tool_result`, and a naive slice eventually cuts between them, surfacing as a provider 400
on a later question with nothing pointing at the trim.

### Tested

| Suite | Tests |
|---|---|
| `test_assistant_agent.py` | 22 — isolation per step, refusals as data, loop termination |
| `test_assistant_retrieval.py` | 21 — scope, ranking, tokenising, the dense seam |
| `test_assistant_threads.py` | 16 — ownership, trimming, serialisation |
| `test_assistant_routes.py` | 21 — identity from session, camelCase contract |
| `assistant-page.test.tsx` | 22 — scope honesty, read-only honesty, context continuity |

Loop mutation sweep: 9/9 killed, after one real gap — `test_A_REFUSAL_IS_DATA_NOT_A_CRASH` only
checked `is_error`, so replacing the `HTTPException` handler with the generic one survived.
`HTTPException` *is* an `Exception`, so the run still did not crash; the difference is whether
the model is told "you do not have access to this conversation" or "the tool failed
unexpectedly". Only the first lets the assistant explain itself.

### Two fixes the work forced

- **`AskIn` now takes camelCase** (`threadId`, `useHistory`) with `populate_by_name`. Every other
  route in this API is camelCase; the fields are optional, so a client following convention
  would have had `threadId` silently ignored and every question would have started a new thread
  with no error anywhere.
- **`scrollIntoView` is guarded** in `AssistantPage`. It is absent in jsdom and in some embedded
  webviews, and an unguarded call throws from inside an effect — unmounting the screen over a
  scroll nicety.

### Not verified

The UI is covered by 22 component tests and compiles into the production bundle, but **has not
been exercised in a browser against a live backend**: that needs an authenticated session with
Mongo and Redis running, which would mean touching production. End-to-end behaviour — a real
Anthropic tool loop over real leads — is therefore untested, and the first run against a live
brain is where a wire-format mismatch would surface.

---

## 12. Integration verification

Run against a **local** Mongo and Redis, in an isolated database (`wam_crm_ai_assistant_e2e`).
Production was not contacted and no production data was read or written. See
`crm-api/ASSISTANT-LOCAL-TESTING.md` to reproduce.

### Four defects found, all fixed

**1. Markdown rendered literally — found only by opening a browser.** The model writes
`**bold**`, bullets and pipe tables whether asked to or not. The renderer printed them verbatim,
so a real answer read `**Ananya Reddy is hot (score 92)**`. The 22 component tests all passed
because they asserted on text content, which matches either way. Now parsed into React elements
— never `dangerouslySetInnerHTML`, because the answer is derived from WhatsApp messages written
by strangers. 19 tests, three of which are XSS attempts through a quoted customer message.

**2. The test suite could reach a real database.** `app/config.py` loads
`env_file=("../backend/.env", …)`, so `settings.mongodb_uri` is a live connection string while
tests run. Locally that is a developer's own Mongo; **on the production host it is production**,
because `crm-api` runs with `network_mode: host` and `localhost:27017` is production there. Any
test that forgot to patch `db.get_database` would have read and written real customer data, and
a passing test that touched a real database looks exactly like one that did not.
`tests/conftest.py` now refuses real Mongo connections and real outbound HTTP.

The first version of that guard broke 14 tests by blocking `httpx` wholesale — several suites
legitimately build an `AsyncClient` over `MockTransport`/`ASGITransport`, which never opens a
socket. It now refuses only `AsyncHTTPTransport`, the real one.

**3. `assistantthreads` had no index.** `list_threads` filters on `(organizationId, userId)` and
sorts by `updatedAt`. Unindexed that is a collection scan plus an in-memory sort on every sidebar
load — fine with ten threads, quietly worse every week, and nothing ever fails.
`ensure_assistant_thread_indexes` now runs in the worker bootstrap alongside the existing ones.

**4. Retrieval's conversation cap was unsorted.** `_visible_conversations` took 500 rows with no
sort, so a studio with more leads than that got an arbitrary subset — partial in a way nothing
surfaces, and potentially different between two identical questions. Now ordered by most recent
activity, with the limitation documented at the call site.

### What was proven end to end

Against real HTTP, real JWT verification, real session lookup, real permission resolution, real
Mongo, real tools, real retrieval, real persistence. **34/34 scenario assertions.**

The two that matter most were run against the **real Anthropic model**, not a stub:

- A follow-up (*"why is that one hot?"*) resolved "that one" from thread context, called
  `get_lead_intelligence`, quoted the customer's actual words, and surfaced the price objection
  that Stage 2's detector found.
- A **staff user asked for a colleague's lead by name, including her budget**, and was told
  *"I found no leads matching 'Ananya Reddy' in your pipeline"*. The scope resolver returned
  nothing, so the model had nothing to leak.

Failure paths were exercised with a scriptable stub, because a real model cannot be asked to
attempt a forbidden thing reliably, and cannot be asked to fail at all: cross-organisation tool
calls, colleague-thread access, thread ownership, invalid arguments, a missing lead, and the
brain being down (clean 5xx, not a hang).

### Still not verified

- **Load and concurrency.** One user at a time, a handful of questions. Nothing about many
  concurrent assistant sessions against one Mongo has been measured.
- **Long-conversation trimming in practice.** `trim_history` is unit-tested; no local thread
  reached 40 turns.
- **Retrieval quality at scale.** Four seeded messages. Lexical ranking against tens of
  thousands is untested, and is the measurement the dense-backend decision needs.
- **Cost per question.** Not measured. Each question is up to 6 model calls.

### Two gaps worth deciding on before this ships

**No rate limit.** `check_ai_draft_rate_limit` exists and is applied to AI draft generation — one
model call. `/assistant/ask` is up to six, and has no limit at all. A user holding the tab down
is an unbounded bill.

**No audit entries.** `audit.py` is used by the analytics, auth, contacts and users routers. The
assistant reads lead data across an organisation and records nothing. Open question 5 in §7
anticipated this; it is still open.

---

## 13. Stage 4 — production readiness

### Rate limiting

Three counters, all keyed on the session's user and organisation — **never on a thread**, which
is the bypass a "New conversation" click would otherwise be.

| Counter | Default | Env var |
|---|---|---|
| user / minute | 5 | `ASSISTANT_RATE_LIMIT_PER_MINUTE` |
| user / hour | 20 | `ASSISTANT_RATE_LIMIT_PER_HOUR` |
| org / hour | 150 | `ASSISTANT_ORG_RATE_LIMIT_PER_HOUR` |

**How 20 was chosen, and what it is not.** `check_ai_draft_rate_limit` allows a configured 30 an
hour — and `backend/.env` really does set `AI_DRAFT_RATE_LIMIT_PER_HOUR=30`, not the code
default of 60. A draft is *one* model call; an assistant question is up to six. Matching 30
would have allowed 180 model calls an hour under a number that looks like the same budget.

20/hour is ~40 model calls in typical use (most questions resolve in one tool call plus an
answer) and 120 worst case. **It is a judgement call, not a derived figure** — strict model-call
parity with drafts would be 5 questions an hour, which is unusable for a conversational feature.

All three counters increment even when one has tripped: returning early would let a client stuck
behind the per-minute limit retry forever without ever exhausting the hour, and the organisation
counter would never see the traffic.

Fails open when Redis is unreachable, matching both existing limiters — but `degraded` is
returned and logged, because while it is open the spend ceiling is gone.

**10/10 mutations killed**, including a thread id smuggled into the key and an off-by-one that
refused at the limit rather than above it.

### Audit logging

Four new event types, declared in **both** `backend/src/constants/audit-events.ts` and
`crm-api/app/audit.py`. The Mongoose schema enum-validates `eventType`; Python writes through
Motor and bypasses that, so omitting the Node side would not have failed — it would have
produced rows no Node code could name.

One row per question, carrying actor, organisation, session, thread, tool names, the record ids
reached, step count, failures and outcome. **Not the question and not the answer**: the answer
quotes customer WhatsApp messages verbatim, and copying those into a collection read by incident
investigators is the opposite of what an audit log is for.

**A gap found and closed:** Node's schema rejects metadata containing `password`, `accessToken`,
`body` and similar. Python's `create_audit_log` enforced none of it — the guarantee held in one
service and was a convention in the other. It now enforces both Node's pattern *and*
`redaction.py`'s broader PII rule, because neither is a superset: Node catches `body`,
`redaction` catches `phone` and `ciphertext`.

Audit failures are logged, not raised — the opposite of `CLIENT_PII_REVEALED`, deliberately. The
assistant is read-only and the data was already visible to the caller, so a logging outage must
not become a feature outage. `SensitiveKeyError` is the exception and always re-raises.

### Usage and cost

Token counts come from Anthropic's own `usage` block, passed through `ai-brain-service`
untouched. Nothing is estimated from string length.

**Cost defaults to zero.** `ASSISTANT_INPUT_COST_PER_MTOK` and `ASSISTANT_OUTPUT_COST_PER_MTOK`
are 0 until an owner enters rates from their own invoice, and the summary reports
`costConfigured: false` so the UI can say "not set" rather than render a confident 0.00.
Hardcoding a published price would be inventing a number that drifts silently.

`GET /assistant/usage` is gated on `settings.manage`, not on the assistant's own permission — a
usage page is a view onto who-did-what and staff must not read colleagues' activity from it.

Verified live: 2,156 in / 76 out for a one-call question, 4,927 in / 159 out for a two-call one.

### Retrieval benchmark — measured, not changed

| conversations | messages | p50 ms | max ms |
|---|---|---|---|
| 50 | 1,000 | 20.1 | 44.9 |
| 200 | 4,000 | 31.4 | 46.0 |
| 500 | 10,000 | 37.2 | 52.0 |
| 1,000 | 20,000 | 45.9 | 50.1 |
| 2,000 | 40,000 | 48.7 | 77.1 |
| 5,000 | 50,000 | 61.6 | 67.8 |

**Latency is not the problem and will not become one.** 62 ms at 5,000 conversations, against a
model call that takes 3–20 seconds — retrieval is well under 1% of the response time.

**But the flat curve past 500 is the cap working, not the algorithm scaling.** At 5,000
conversations only 500 are in scope: retrieval silently covers the most recent 10%. The limit is
**coverage, not speed**, and no amount of indexing changes that while the cap stands.

**Recommendation — not implemented, needs approval.** `_visible_conversations` exists to do two
things: enforce scope and supply display names. For an admin (`read_all`) the enumeration is
unnecessary — messages could be filtered on `organizationId` alone, with `SCAN_LIMIT` bounding
the work and display names resolved for the top-k afterwards. That removes the coverage cap
exactly where it bites, with no new dependency. Staff keep the enumeration, and a staff member
with more than 500 assigned conversations is not a real case.

**Dense retrieval is still not warranted on this evidence.** It would solve a latency problem
that does not exist, at ~470 MB on a memory-constrained host, and would still need the same
scope filter — so it is not a drop-in either.

### Frontend

Reviewed in a real browser against the local backend, and three things changed:

- **A reading measure.** Answers ran the full 1440 px with no line-length cap. Prose is now
  capped at 68ch and the transcript column at `max-w-3xl`; the header and composer still span
  the pane.
- **Tables size to content.** `w-full` put half a screen of whitespace between a lead's name and
  its score — harder to read than the markdown it replaced. Now `w-auto` in a scrollable
  wrapper, with a header band and denser cells.
- **A distinct rate-limit state.** Amber, not red, with the backend's own wording and a live
  countdown. A red "something went wrong" box says the feature is broken, and the reasonable
  response to that is to retry immediately — exactly what the limit exists to stop.

No glassmorphism, no new gradients, no new palette. `surface`, `chip` and the slate/amber scales
already in `index.css`.

---

## 14. Stage 4.1 — retrieval coverage and fail-closed throttling

### Retrieval now has two paths

**Admin (`conversations.read_all`) — no conversation enumeration.** Messages are filtered on
`organizationId` directly, bounded by `SCAN_LIMIT`. A caller who may read every conversation in
the organisation gained nothing from enumerating them first except the cap, so the cap is gone
for them.

**Restricted (`read_assigned` only) — unchanged.** A staff member's slice is *defined* by which
conversations are assigned to them, so the list **is** the scope and there is no equivalent
shortcut. `MAX_SCOPED_CONVERSATIONS` still applies here, where it caps one person's own assigned
leads rather than a whole studio. **Nothing was broadened to improve coverage.**

### Two things the enumeration was doing that had to be rebuilt

1. **It excluded deleted conversations.** The admin path now resolves ranked candidates back to
   their conversations with `deletedAt: None`, which supplies display names in the same query.
   Candidates are over-fetched 3× so deleted rows dropping out cannot shorten the answer.
2. **It made a missing organisation safe by accident.** `{"organizationId": None}` matches
   documents where the field is null or absent — it does *not* match nothing. An empty
   conversation list used to produce an empty result; with no enumeration there is no second
   filter left. `_require_organization` now raises `MissingOrganizationScope` on anything that
   is not a usable id, and converts a string id rather than letting it silently match nothing.

### Benchmark — before and after, same run

Both contexts hold the same data and the same actor; only the permission differs, so `capped`
exercises the old enumeration path and `admin` the new one. The needle is a phrase in the
**oldest** conversation.

| convs | msgs | capped p50 | admin p50 | capped reaches it? | admin reaches it? |
|---|---|---|---|---|---|
| 200 | 201 | 11.2 ms | 9.6 ms | yes | yes |
| 500 | 501 | 17.5 ms | 12.8 ms | **NO** | **yes** |
| 1,000 | 1,001 | 18.3 ms | 19.4 ms | **NO** | **yes** |
| 1,400 | 1,401 | 17.8 ms | 24.7 ms | **NO** | **yes** |
| 500 | 10,001 | 52.2 ms | 39.1 ms | NO | **NO** |
| 2,000 | 40,001 | 46.8 ms | 62.5 ms | NO | **NO** |

**COVERAGE IS IMPROVED, NOT UNLIMITED.** The last two rows are the honest part: past
`SCAN_LIMIT` (1,500 messages) *neither* path reaches the oldest message, because the message
budget binds before the conversation count does. The change removes the conversation cap for
admins; it does not remove `SCAN_LIMIT`, and a studio with more than ~1,500 messages still has
older history outside retrieval's reach.

Latency is unchanged in practice — every figure is under 65 ms against a model call of 3–20
seconds.

### Rate limiting now fails CLOSED

`login_rate_limit.py` and `check_ai_draft_rate_limit` both fail open, and for them that is
right. This one does not, and the asymmetry is deliberate: behind this limiter are up to six
paid Anthropic calls, so failing open does not degrade a feature — it removes the only ceiling
on spend at exactly the moment nobody is watching.

| Situation | Result | Status |
|---|---|---|
| Caller exceeded their own budget | `limited` | **429** |
| Redis unreachable, timing out, or erroring | `unavailable` | **503** |
| `REDIS_URL` not configured at all | `unavailable` | **503** |

**429 and 503 are never conflated.** Reporting an outage as 429 would tell somebody they had
exceeded a limit they never touched, and the retry advice differs — 15 seconds versus an hour.

**The operational trade-off, stated plainly:** a Redis outage disables the assistant completely.
That is intended, not a side effect. It is survivable because the assistant is read-only and
additive — every other part of the CRM keeps working, and the data it reads is reachable through
the ordinary UI. The 503 message says so, so a paused assistant does not read as a broken CRM.

Recovery needs no restart: `cache.get_client` caches a redis-py client whose pool reconnects on
its own. Tested.

Treating *unconfigured* Redis as unavailable is a deliberate departure from
`check_ai_draft_rate_limit`, which treats it as "no limiter, carry on" — correct for one model
call, wrong for six. A deployment that can spend money on Anthropic but cannot reach a counter
should not be spending it.

**No second limiter and no in-memory fallback.** An in-process counter would not be shared
between replicas, so it would under-count by exactly the number of replicas and give a false
sense of a ceiling.

### New tests

| File | Tests | Covers |
|---|---|---|
| `test_assistant_retrieval_coverage.py` | 29 | admin coverage past the cap, both filters pinned independently, malformed organisation ids, over-fetch |
| `test_assistant_concurrency.py` | 19 | concurrent requests per user / per org, counter isolation, history boundary, tool permissions under concurrent runs |
| `test_assistant_rate_limit.py` (extended) | 38 | fail-closed on unreachable / timeout / arbitrary error, recovery without restart, 429-vs-503, no infrastructure in the body or logs |
| `assistant-page.test.tsx` (extended) | 37 | the 503 state, question preserved, recovery without reload |

Retrieval mutation sweep: **10/10 killed** — after a first pass found 3 survivors. Two of them
mattered: the admin message query's organisation filter and the candidate resolver's both
survived deletion, because **each was covering for the other**. Removing either alone changed
nothing observable; removing both would leak. Each is now pinned at its own level.

### What remains unverified

- **Multi-replica rate limiting.** The concurrency tests use an atomic in-process fake, which
  matches Redis's `INCR` semantics for one process. Nothing here exercises two `crm-api`
  replicas racing on the same key. Atomicity there is Redis's job, but it is untested.
  (The first version of that fake had a read-then-write race and the tests were asserting on a
  defect the real code cannot have; the fake was corrected.)
- **Retrieval at genuine production volume.** The benchmark seeds synthetic text up to 50,000
  messages on a local Mongo. Ranking *quality* at that size is not measured, only latency and
  reachability.
- **Real Redis failure in production conditions.** Fail-closed is tested against fakes raising
  `ConnectionError`, `TimeoutError` and arbitrary exceptions. A partial Redis failure — slow but
  not failing, or evicting keys under memory pressure — behaves as if the limit were lower, and
  is not simulated.
