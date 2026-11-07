# Vistaar CRM — Node.js → Python migration tracker

Living document. Updated as each module completes, not at the end.

**Target:** Python FastAPI owns CRM business logic. Node retains only the Baileys WhatsApp
socket. One MongoDB, one Redis, one Caddy, one domain.

**Current scale:** 68,565 lines of Node source across 31 modules, 38,547 lines of tests.

---

## Status

| Phase | Modules | Routes | State |
|---|---|---|---|
| 0 | health | `/api/v1/health*` | ✅ **Deployed & verified in production** |
| 1 | starred-messages | `/api/v1/starred-messages` | 🟡 **Implemented, tested, awaiting deployment** |
| 2 | **stages + tag catalogue** (re-scoped) | `/stages`, `/tags` | 🟡 **Implemented, tested, awaiting Phase 1 deployment first** |
| 3 | organizations, message-templates, notes | `/settings`, `/templates` | ⬜ Not started |
| 4 | contacts, users, media | `/contacts`, `/users` | ⬜ Not started |
| 5 | analytics | `/analytics` | ⬜ Not started |
| 6 | auth routes | `/auth` | ⬜ Not started |
| 7 | messages, calls, push, realtime | `/messages`, `/calls`, `/push`, `/realtime` | ⬜ Not started |
| 8 | followups + 13 runners | `/follow-ups` | ⬜ Not started |
| 9 | conversations, lead-sources, ai, ai-knowledge | `/conversations`, `/lead-sources`, `/meta` | ⬜ Not started |
| 10 | ai-brain | `/ai-brain` | ⬜ Not started |
| 11 | whatsapp business logic | `/whatsapp-accounts` | ⬜ Not started |

---

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

## Phase 1 — starred-messages 🟡

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

### Deployment — not yet performed

1. Pull, rebuild `crm-api`, restart it (see `crm-api/DEPLOY.md`)
2. Verify `:5002` directly
3. **Run `tools/compare_responses.py` against both services while Node still owns the route**
4. Only then add the Caddy `handle /api/v1/starred-messages*` block
5. Verify publicly

**Rollback:** remove the Caddy block, reload. Node still serves the route throughout.

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
| `tests/test_stages.py` | 45 tests |
| `tests/test_tags.py` | 31 tests |

**Python suite: 150 passing** (was 74). Run against an in-memory MongoDB through the real
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
