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

### Secrets you must set in `backend/.env`

| Variable | What it is |
|---|---|
| `JWT_ACCESS_SECRET` | 32+ chars |
| `ENCRYPTION_KEY_V1` | field-level encryption key |
| `CONTACT_LOOKUP_HMAC_KEY` | blind-index key — **never rotate**, lookups would orphan |
| `GROQ_API_KEY` | LLM provider key |
| `AI_BRAIN_SERVICE_KEY` | shared secret between backend and ai-brain-service |
| `SEED_SUPER_ADMIN_PASSWORD` | 12+ chars |

`.env` files are gitignored. Do not commit real keys.

### Feature flags worth knowing

Everything risky is off by default. `WHATSAPP_ENABLED`, `WHATSAPP_OUTBOUND_DELIVERY_ENABLED`,
`AI_BRAIN_ENABLED`, `NURTURE_ENABLED`, `DAILY_JOBS_ENABLED` and `EVENT_REMINDERS_ENABLED` each
gate a subsystem, so a plain API server or a test run never sends anything.

`WHATSAPP_TEST_ALLOWED_NUMBERS` is a test-phase safety net: a CSV of phone numbers that are the
*only* numbers the system will talk to. Leave it empty in production; set it while testing so a
stray message cannot reach a real lead.

## Tests

```bash
cd backend  && npm test && npm run lint && npx tsc --noEmit
cd frontend && npm test && npm run lint && npx tsc --noEmit
cd ai-brain-service && python smoke_test.py
```

## Known constraints

- **Baileys** is an unofficial WhatsApp Web library. There is a real account-ban risk; use a
  number you can afford to lose.
- **Groq free tier** caps at 8,000 tokens/minute, which is the practical ceiling on how fast the
  agent can think during a busy stretch.
