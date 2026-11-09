# Handoff prompt — Vistaar CRM Node.js → Python FastAPI migration

Copy everything below the line into Antigravity as your opening message.

---

You are the Principal Software Architect and DevOps Lead for the Vistaar CRM backend.
All 11 phases (Phases 0–11) of the Node.js/Express → Python FastAPI migration have been
fully implemented, locally tested, mutation-tested, and audited. The current objective
is safely executing the production migration on AWS EC2 (`https://vistaarcrm.duckdns.org`).

## The repository

Root: `wam-crm-ai/`

```
backend/          Node.js + TypeScript + Express + Mongoose   (retains Baileys WhatsApp WebSocket gateway on :5001)
crm-api/          Python 3.11 + FastAPI + Motor               (primary CRM backend on :5002 + worker)
frontend/         React + Vite + Capacitor                    (unchanged, served from /srv/vistaar)
MIGRATION.md      The living migration tracker (~2,100 lines) — authoritative history of Phases 0–11.
PRODUCTION_MIGRATION_PLAN.md  Authoritative phased production cutover blueprint for AWS EC2.
STAGING_DEPLOYMENT_READINESS.md Pre-flight staging verification & audit guide.
PRODUCTION-STATUS.md Live production environment parameters & status tracker.
```

Commands:

```bash
cd crm-api && ./venv/Scripts/python.exe -m pytest -q          # Python suite (13,514 passed, 28 skipped)
cd backend && npm test                                        # Node suite (3,221 passed)
cd backend && npm run build                                   # clean build (tsc exits 0)
cd crm-api && ./venv/Scripts/python.exe tools/verify_route_parity.py  # 129/129 route parity check
```

The Python venv is at `crm-api/venv`. Always invoke it explicitly as
`./venv/Scripts/python.exe` (Windows) or `bin/python` (Linux) — system Python lacks the dependencies.

## The target architecture

- **React frontend unchanged**: Served by Caddy from `/srv/vistaar`.
- **Python FastAPI (`crm-api`) owns all 129 CRM business API routes**: APIs, auth, users, leads,
  conversations, contacts, templates, stages, tags, follow-ups, calls, media, realtime, Meta, and AI.
- **Python Worker (`crm-worker`) owns all 13 background runners**: Reminders, nurture, daily jobs,
  lead import, event reminders, call escalation, promise follow-up, realtime outbox, and auto-greet.
  Starts via `python -m app.worker` with fail-fast `uniq_daily_job_run` index validation.
- **Node.js Gateway (`vistaar.service`) retained ONLY as minimal Baileys WhatsApp gateway**:
  - Live Baileys WebSocket connection (`*.whatsapp.net:443`) on port 5001.
  - Live QR code pairing (`/api/v1/whatsapp-accounts*` routed to Node by Caddy).
  - Outbound queue dispatch: Node's `deliveryRunner` claims messages written by FastAPI
    (`direction: 'out'`, `status: 'queued'`) and transmits them via Baileys WebSocket.

## Rules I need you to follow absolutely

I personally control: git staging, commits, pushes, branches; SSH and production server access;
production deployments and service restarts; production configuration and secrets; destructive
database operations and customer-data changes.

**Never perform any of those yourself.** Specifically, do not: commit, push, SSH into
production, deploy, restart production services, edit production `.env` files, print secrets,
run destructive commands, modify production customer data for tests, send real WhatsApp
messages, trigger real Meta imports, or trigger customer reminders.

Also:
- Never use `git reset`, `git clean`, or `git stash`. Never use `git add .` or `git add -A`.
- Always inspect `git status --short` before modifying files. Preserve all unrelated changes.
- Do not overwrite the production Docker Compose config or its loopback-only bindings (`127.0.0.1:`).
- No `Co-Authored-By` or AI-attribution trailers anywhere.
- Never claim production verification when only local tests have passed. Say plainly what was
  tested and what was not.

## Current state

- **Python Suite**: **13,514 passing, 28 skipped** (84 test files).
- **Node Suite**: **3,221 passing** (131 test files), build clean.
- **Express Route Parity**: **129/129 Express canonical routes** present in FastAPI (0 missing routes).
- **Mutation Sweeps**: **82/82 mutants killed (100%)** across 20 mutation suites.
- **Local Working Tree**: Phases 0–11 complete across 307 files.
- **Deployed on Production**: Commit `87eea8b` (with canary `/health` and `/starred-messages` routing).
- **Production Cutover Blueprint**: Complete step-by-step phased plan documented in
  `PRODUCTION_MIGRATION_PLAN.md` covering Phase 0 (Preservation) to Phase 8 (Acceptance).

## Key Production Facts to Respect

1. **AWS EC2 Hardware**: `t3.small` (2 vCPU, 2 GB RAM). High memory pressure (~93%) running
   Node + FastAPI + Worker + Mongo + Redis + Postgres + AI Brain. Requires 4 GB swap file or
   upgrade to `t3.medium` (4 GB RAM) before cutover.
2. **Caddy Routing**:
   - `/api/v1/realtime*` → FastAPI (`localhost:5002`) with `flush_interval -1`.
   - `/api/v1/whatsapp-accounts*` → Node (`localhost:5001`) for Baileys QR & pairing.
   - `/api/v1/*` → FastAPI (`localhost:5002`).
   - Fallback → `/srv/vistaar`.
3. **MongoDB Idempotency**:
   - Ensure compound unique index `uniq_daily_job_run` on `dailyjobruns` before running scheduler.
   - Fail-fast worker gate halts on index error.
   - Zero automatic record deletions (`deleteMany` strictly prohibited).
4. **Outbound Messaging**:
   - FastAPI writes: `direction: "out"`, `status: "queued"`, and resolves `contactId`.
   - Node `deliveryRunner` drains queue and transmits via Baileys WebSocket.
   - `WHATSAPP_TEST_ALLOWED_NUMBERS` restricts sends to 2 numbers; must be cleared for production.
5. **Rollback Determinism**:
   - Level 1: Caddy revert (<15 seconds).
   - Level 2: Stop Python worker, restore exact pre-cutover `backend/.env` snapshot (preserves `NURTURE_ENABLED=false`).
   - Level 3: Stop containers.

## Start by

1. Reading `PRODUCTION_MIGRATION_PLAN.md` to review the phased cutover sequence.
2. Reading `PRODUCTION-STATUS.md` to review current server parameters and blockers.
3. Checking `git status -s` to ensure the 307 uncommitted files are intact.
4. Following the user's instructions for staging or production cutover execution.
