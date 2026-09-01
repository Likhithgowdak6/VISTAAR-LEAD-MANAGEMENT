# Vistaar Lead Management

A WhatsApp-first CRM with an AI sales agent for an events/media business. Leads arrive over
WhatsApp (direct DMs or imported from ad campaigns), the AI qualifies them on its own, and every
actual sales reply waits for the owner's approval before it is sent.

## The one rule that shapes the design

**The AI auto-sends qualifying questions. Everything else — sales replies, proposals, pricing —
requires a human approval.** The owner approves from WhatsApp itself by replying with a code
(`1` send, `2` edit, `3` skip), so no dashboard visit is needed to keep a conversation moving.

## Architecture

Three services, deliberately split:

| Service | Stack | Owns |
|---|---|---|
| `backend/` | Node · Express · TypeScript · MongoDB · Redis | All data, all WhatsApp I/O, all scheduling |
| `ai-brain-service/` | Python · FastAPI · LangGraph · Postgres | The "thinking": qualifying, drafting, proposals, classification |
| `frontend/` | React · Vite · TypeScript | Dashboard, inbox, settings, AI knowledge base |

`ai-brain-service` is stateless with respect to business data — it holds only LangGraph
checkpoints (which step a conversation is paused on). Conversations, messages, leads and contacts
all live in Mongo, owned by the backend. The backend calls the brain over HTTP with everything it
needs on each request.

Why the split: the LangGraph agent is Python, the CRM is TypeScript. Rather than rewrite one in
the other, they talk over an authenticated HTTP boundary (`X-Service-Key`).

## What the agent actually does

1. **Gateway filtering** — groups, WhatsApp Channels and broadcast lists are dropped; they are
   not leads.
2. **Lead created** → a 🔔 alert goes to the owner's number.
3. **Qualification** — bundled questions, capped at six, sent without approval.
4. **Drafted reply** → an approval card to the owner with reply codes `1` / `2` / `3`.
5. **Approved send** — the reply goes to the lead, with a human-like delay.
6. **Proposal** — JSON → DOCX → PDF, attached and sent on approval.
7. **Nurture** — follow-ups on day 2, 5, 9 and 15; marked cold after 20.
8. **Owner takeover** — the moment the owner types in a lead's chat, the agent goes silent. At
   9am the next morning it reads the conversation and decides how to proceed.
9. **Daily digest** — a 9am summary of what happened and what needs a decision.
10. **Escalation** — when the agent cannot make a call (repeated discount pressure, an unreadable
    voice note, anything off-script) it sends a "✋ Needs you" card instead of guessing.

Also: per-service conversation playbooks (16 service types, each with its own approach), a lead
scoring model with hot-lead alerts, event-date extraction with pre-event owner reminders, an
editable AI knowledge base, and opt-out handling.

## Running it

**Prerequisites:** Node 20+, Python 3.11+, Docker.

```bash
# 1. Infrastructure (Mongo replica set, Redis, Postgres, ai-brain-service)
docker compose up -d

# 2. Backend
cd backend
cp .env.example .env      # fill in secrets - see below
npm install
npm run dev               # http://localhost:5001

# 3. Frontend
cd frontend
cp .env.example .env
npm install
npm run dev               # http://localhost:5173
```

The Vite dev server proxies `/api` to the backend, so a single tunnel (ngrok, etc.) serves both
and there is no CORS to configure.

### Secrets you must set

There are **two** env files, and the model key goes in the root one, not the backend one.

`backend/.env` — the Node app:

| Variable | What it is |
|---|---|
| `JWT_ACCESS_SECRET` | 32+ chars |
| `ENCRYPTION_KEY_V1` | field-level encryption key |
| `CONTACT_LOOKUP_HMAC_KEY` | blind-index key — **never rotate**, lookups would orphan |
| `AI_BRAIN_SERVICE_KEY` | shared secret between backend and ai-brain-service |
| `SEED_SUPER_ADMIN_PASSWORD` | 12+ chars |
| `ANTHROPIC_API_KEY` | only for the dashboard's own "draft a reply" button (`AI_ENABLED`); the agent does not use it |

`.env` at the project root — read by `docker-compose`, configures the brain container:

| Variable | What it is |
|---|---|
| `AI_BRAIN_SERVICE_KEY` | must match `backend/.env` exactly |
| `AI_BRAIN_LLM_PROVIDER` | `anthropic` (default), `groq`, or `openai` |
| `AI_BRAIN_LLM_API_KEY` | the model key — this is the one the sales agent thinks with |
| `AI_BRAIN_LLM_MODEL` | defaults to `claude-haiku-4-5-20251001` |

See `.env.example` in both places. `.env` files are gitignored. Do not commit real keys.

### Changing the model

Everything the agent says — qualifying questions, drafted replies, proposals, the won/lost
call — runs through one key, set in the root `.env`. Switching provider or model is those three
lines and `docker compose up -d --build ai-brain-service`; no code changes.

The default is **Claude Haiku 4.5** ($1 per million input tokens, $5 output), which works out
around $0.05 for a full lead conversation including a proposal. `claude-sonnet-5` is the step up
for better judgement on the harder calls — reading discount pressure, writing a proposal someone
will actually read — at roughly double that.

One constraint if you raise the timeout: `AI_BRAIN_LLM_TIMEOUT_SECONDS` x
(`AI_BRAIN_LLM_MAX_RETRIES` + 1) must stay **below** `backend/.env`'s
`AI_BRAIN_REQUEST_TIMEOUT_MS`, or the brain spends money finishing an answer the backend has
already given up on.

### Feature flags worth knowing

Everything risky is off by default. `WHATSAPP_ENABLED`, `WHATSAPP_OUTBOUND_DELIVERY_ENABLED`,
`AI_BRAIN_ENABLED`, `NURTURE_ENABLED`, `DAILY_JOBS_ENABLED`, `EVENT_REMINDERS_ENABLED`,
`LEAD_IMPORT_ENABLED` and `META_LEAD_ADS_ENABLED` each gate a subsystem, so a plain API server or
a test run never sends anything — or, for the last two, never reaches out to Google or Meta.

`WHATSAPP_TEST_ALLOWED_NUMBERS` is a test-phase safety net: a CSV of phone numbers that are the
*only* numbers the system will talk to. Leave it empty in production; set it while testing so a
stray message cannot reach a real lead.

## Meta Lead Ads: pulling leads straight from Meta

Leads can reach the CRM two ways, and both end up in the same inbox with the same de-duplication:

- **Google Sheet** — Meta writes leads into a link-shared sheet and the CRM polls its CSV export.
  No Google credentials; the sheet just has to be "anyone with the link can view".
- **Meta Lead Ads (direct)** — the CRM asks the Graph API for the form's leads itself. No sheet.

The direct path is off until it is configured. Turn it on with `META_LEAD_ADS_ENABLED=true` in
`backend/.env` (and `LEAD_IMPORT_ENABLED=true`, which is what actually starts the poller), restart
the backend, then go to **Lead sources → Meta Lead Ads** and paste a Page access token.

### What the client has to do on Meta's side

1. **A Meta app** (developers.facebook.com) with the *Facebook Login* and *Webhooks/Marketing API*
   products as appropriate. The token is generated against this app.
2. **Connect the page to the app.** A Page access token only reads a page's leads if that page is
   linked to the app — through Business Manager, or by the page admin authorising the app.
3. **Permissions on the token.** At minimum:
   - `leads_retrieval` — read the leads a form has collected. This is the one that matters.
   - `pages_show_list` — list the pages the person administers, so the dashboard can offer a
     picker instead of asking for a page id.
   - `pages_read_engagement` — read the page's own metadata (its name, its lead forms).

   Meta has been known to also require `pages_manage_ads` to list `leadgen_forms` on some app
   configurations. **We have not been able to verify this against a live app**, so if the "test
   connection" step succeeds but the form list comes back empty, add `pages_manage_ads` and try
   again. Picking "Every form on this page" does not need the form list, so that is the workaround
   in the meantime.
4. **Lead access for the person generating the token.** Reading leads needs more than page admin
   in some Business Manager setups — Meta calls it *Leads Access*, assigned per page under
   Business Settings. If the token tests fine but every form returns zero leads, this is the usual
   cause.
5. **App Review.** `leads_retrieval` normally requires App Review before the app can be used by
   anyone who does not have a role (admin/developer/tester) on the app itself. For a single
   business using its own app on its own page, giving the token's owner a role on the app avoids
   review; a wider rollout does not.

### Getting a long-lived Page access token

Short-lived tokens die in about an hour, which is no use to a poller. The usual exchange is:

1. Get a short-lived **User** access token for someone with admin rights on the page (Graph API
   Explorer, with the permissions above ticked).
2. Exchange it for a long-lived User token (~60 days):
   `GET /oauth/access_token?grant_type=fb_exchange_token&client_id=<app-id>&client_secret=<app-secret>&fb_exchange_token=<short-lived-token>`
3. Call `GET /me/accounts` **with that long-lived User token**. The `access_token` on each page in
   the response is a long-lived **Page** access token, and page tokens derived this way do not
   carry their own expiry.

Paste that Page token into the dashboard. Do not put it in `.env` and do not commit it anywhere —
it is stored AES-GCM encrypted in the database, is never returned by any API response, and the
dashboard only ever shows its last four characters.

### Tokens still expire, and what happens when one does

"Does not expire" is not the same as "works forever". A Page token stops working when the person
it was derived from changes their password, when the app's permissions are revoked or the app is
removed from the page, when Meta invalidates it for a security event, or when that person loses
their page role. Meta answers those with error code `190`.

When that happens the source is marked **Needs attention** on the Lead sources page — a distinct
state from "Sync failed", precisely because no amount of retrying will fix it — with the reason
written out in plain language. The fix is to generate a new Page access token and paste it in;
nothing else about the source needs changing, and the lead history it already imported is
untouched. Leads submitted while the token was dead are picked up on the next successful poll,
because the source's watermark only advances over leads it actually imported.

Rate limits and Meta outages are treated differently: those are recorded as an ordinary failed
sync and simply retried on the next tick.

### Notes for whoever maintains this

- The Graph API version is pinned in **one** constant, `META_GRAPH_API_VERSION` in
  `backend/src/modules/lead-sources/meta-graph.client.ts`. Meta supports a version for roughly two
  years and then starts rejecting calls to it, so check it against Meta's Graph API changelog
  periodically and bump it deliberately.
- Adding the Meta source kind changed one database index. `LeadSource`'s unique
  `(organizationId, sheetId, gid)` index is now partial, filtered on the presence of a `sheetId`,
  so Meta sources (which have none) do not all collide on a single null key. MongoDB cannot change
  an index's options in place, so on an existing database run it once:
  ```bash
  cd backend && npm run migrate:lead-source-indexes -- --apply
  ```
  Existing sheet sources keep importing throughout — the index guards *creating* a duplicate
  source, it is not something the poller reads. Without the migration, sheet sources are entirely
  unaffected and only the creation of a second Meta source would fail.

## Tests

```bash
cd backend  && npm test && npm run lint && npx tsc --noEmit
cd frontend && npm test && npm run lint && npx tsc --noEmit
cd ai-brain-service && python smoke_test.py
```

## Known constraints

- **Baileys** is an unofficial WhatsApp Web library. There is a real account-ban risk; use a
  number you can afford to lose.
- **Model rate limits** are per usage tier on Anthropic (requests and tokens per minute). The
  agent handles a 429 as a quota refusal rather than a bug and logs it distinctly, but it cannot
  conjure headroom — a busy stretch on a low tier still means queued replies.
