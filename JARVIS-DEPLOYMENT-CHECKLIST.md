# JARVIS CRM Assistant — Production Deployment Checklist

**Target Host:** AWS EC2 (`t3.small`, Ubuntu, `~/vistaar`)  
**Production URL:** <https://vistaarcrm.duckdns.org>  
**Branch:** `feat/crm-assistant`  
**Deployment Model:** Containerized Python FastAPI (`crm-api`), Python Worker (`crm-worker`), LangGraph Brain (`ai-brain-service`), Dockerized MongoDB & Redis, with systemd-managed Node.js Baileys Gateway (`vistaar.service`) and host Caddy reverse proxy.

---

## 1. Before Deployment

### 1.1 Required Environment Variables

Ensure the following variables are present in the server's `.env` and `backend/.env` files before triggering builds:

| Variable | Target File | Status / Requirement | Purpose |
|---|---|---|---|
| `REDIS_URL` | `backend/.env` | **Required** (e.g. `redis://localhost:6379`) | Assistant rate limiting fail-closed dependency. |
| `AI_BRAIN_SERVICE_URL` | `backend/.env` | **Required** (e.g. `http://localhost:8091`) | Ingress URL for `ai-brain-service`. |
| `AI_BRAIN_ENABLED` | `backend/.env` | **Required** (`true`) | Feature flag enabling communication with brain service. |
| `AI_BRAIN_SERVICE_KEY` | `.env` & `backend/.env` | **Required** (Shared secret) | Authenticates `crm-api` to `ai-brain-service` via `X-Service-Key`. |
| `AI_BRAIN_LLM_PROVIDER` | `.env` | **Required** (`anthropic`) | Provider selection for brain service. |
| `AI_BRAIN_LLM_API_KEY` | `.env` | **Required** (`sk-ant-...`) | Anthropic API key for multi-step reasoning. |
| `AI_BRAIN_LLM_MODEL` | `.env` | **Required** (`claude-haiku-4-5-20251001` or `claude-3-5-sonnet-20241022`) | Target LLM model. |
| `DATABASE_URL` | `docker-compose.yml` | **Configured** (`postgresql://ai_brain:ai_brain@ai-brain-db:5432/ai_brain_checkpoints`) | Postgres checkpoint store for ai-brain. |
| `ASSISTANT_RATE_LIMIT_PER_MINUTE` | `backend/.env` | Optional (default: `5`) | Sliding-window per-user limit. |
| `ASSISTANT_RATE_LIMIT_PER_HOUR` | `backend/.env` | Optional (default: `20`) | Sliding-window per-user limit. |
| `ASSISTANT_ORG_RATE_LIMIT_PER_HOUR` | `backend/.env` | Optional (default: `150`) | Sliding-window organization-wide limit. |
| `ASSISTANT_INPUT_COST_PER_MTOK` | `backend/.env` | Optional (default: `0.0`) | Provider input rate per million tokens. |
| `ASSISTANT_OUTPUT_COST_PER_MTOK` | `backend/.env` | Optional (default: `0.0`) | Provider output rate per million tokens. |

> [!NOTE]
> `crm-api` runs on `network_mode: host` in production. It accesses `localhost:8091` (`ai-brain-service`), `localhost:6379` (`redis`), and `localhost:27017` (`mongo`).

### 1.2 Required Infrastructure Services

Confirm that all core dependencies are healthy prior to deployment:

```bash
docker compose ps
```
- `wam-crm-ai-mongo` (healthy)
- `wam-crm-ai-redis` (healthy)
- `wam-crm-ai-ai-brain-db` (healthy)
- `vistaar.service` (active via `sudo systemctl status vistaar.service`)

### 1.3 Database Prerequisites

- **MongoDB Collections:**
  - `assistantthreads` (Created on first user conversation).
  - `assistantusage` (Created on first answered question).
  - `auditlogs` (Existing collection; receives `ASSISTANT_*` event types).
- **Index Verification:**
  - Indexes are verified and ensured automatically on startup by `crm-worker` (`ensure_assistant_thread_indexes` and `ensure_assistant_usage_indexes`).
  - No manual schema migrations or `mongosh` commands are required.

### 1.4 Backup Requirements

Run an explicit pre-deployment backup of MongoDB before deploying code:

```bash
# [AFFECTS LOCAL DISK / BACKUP STORAGE ONLY]
docker exec wam-crm-ai-mongo mongodump --archive=/tmp/pre_jarvis_backup.gz --gzip
docker cp wam-crm-ai-mongo:/tmp/pre_jarvis_backup.gz ~/backups/pre_jarvis_$(date +%F_%H%M%S).gz
```

### 1.5 Security & Hygiene Pre-Checks

- Verify that `frontend/vite.config.ts` remains intact with target `http://localhost:5002`.
- Verify that `WHATSAPP_TEST_ALLOWED_NUMBERS` is maintained if WhatsApp testing isolation is currently active.
- Verify that no API keys or database connection strings are checked into git.

---

## 2. Deployment Procedure

> [!IMPORTANT]
> The following commands represent the exact sequence to deploy JARVIS. Commands that restart containers or compile production assets are labeled accordingly.

### Step 1: Pull the latest code on EC2
```bash
# [AFFECTS WORKING TREE ON SERVER]
cd ~/vistaar
git pull origin feat/crm-assistant
```

### Step 2: Build the updated `crm-api` image
```bash
# [BUILDS CONTAINER IMAGE - ZERO DOWNTIME]
docker compose --env-file .env --env-file backend/.env build crm-api
```

### Step 3: Build the updated `ai-brain-service` image
```bash
# [BUILDS CONTAINER IMAGE - ZERO DOWNTIME]
docker compose --env-file .env --env-file backend/.env build ai-brain-service
```

### Step 4: Recreate `ai-brain-service` container
```bash
# [RESTARTS AI BRAIN CONTAINER - BRIEFLY RESTARTS PORT 8091]
docker compose --env-file .env --env-file backend/.env up -d --no-deps ai-brain-service
```

### Step 5: Recreate `crm-api` container
```bash
# [RESTARTS CRM-API CONTAINER - BRIEFLY RESTARTS PORT 5002]
docker compose --env-file .env --env-file backend/.env up -d --no-deps crm-api
```

### Step 6: Recreate `crm-worker` container (Ensures new indexes are asserted)
```bash
# [RESTARTS WORKER PROCESS - RESUMES BACKGROUND POLLING]
docker compose --env-file .env --env-file backend/.env up -d --no-deps crm-worker
```

### Step 7: Build & Distribute Frontend SPA
```bash
# [BUILDS PRODUCTION ASSETS - UPDATES /srv/vistaar DIRECTORY]
cd ~/vistaar/frontend
npm ci
VITE_API_BASE_URL=/api/v1 npm run build
sudo cp -r dist/* /srv/vistaar/
```

### Step 8: Reload Caddy (if required)
```bash
# [RELOADS HOST REVERSE PROXY]
sudo systemctl reload caddy
```

---

## 3. After Deployment Verification

### 3.1 Health & Service Verification
1. Verify `crm-api` readiness:
   ```bash
   curl -s http://localhost:5002/api/v1/health/readiness | jq .
   ```
   Expect: `"status": "ready"`, mongo `ready`, redis `ready`.

2. Verify `ai-brain-service` process health:
   ```bash
   curl -s http://localhost:8091/health | jq .
   ```
   Expect: `{"ok": true}`.

3. Verify Anthropic API model connectivity:
   ```bash
   curl -s -H "X-Service-Key: <SERVICE_KEY>" http://localhost:8091/health/llm | jq .
   ```
   Expect: `{"ok": true, "provider": "anthropic", "model": "claude-haiku-4-5-20251001", "latency_ms": ...}`.

4. Verify Node.js WhatsApp service remains healthy:
   ```bash
   sudo systemctl status vistaar.service
   curl -s http://localhost:5001/api/v1/health | jq .
   ```
   Confirm that WhatsApp socket connection remains intact.

### 3.2 JARVIS Functional Validation
1. **Access Control & Permissions:**
   - Sign in as Admin (`himanshu@vistaarverse.com` under `vistaar-verse`). Navigate to `/assistant`. Confirm sidebar loads threads and empty state displays read-only notice.
   - Sign in as Staff member with `conversations.read_assigned`. Confirm staff cannot view unassigned threads or access `/assistant/usage`.
2. **Read-Only Verification:**
   - In JARVIS, ask: *"Can you change the lead stage of John to Won?"* or *"Send a message to this lead saying hello"*.
   - Confirm JARVIS explicitly declines: states it is strictly read-only and explains how to perform the action in the CRM UI.
3. **Multi-Turn Grounding:**
   - Question 1: *"Which lead has the highest score?"*
   - Question 2: *"Why is that lead hot?"*
   - Confirm JARVIS remembers the lead from turn 1 and quotes evidence from `get_lead_intelligence`.
4. **Rate Limit Verification:**
   - Ask 6 questions within 60 seconds.
   - Confirm turn 6 shows amber `AssistantRateLimit` banner with countdown ("You can ask again in about 60 seconds").
   - Confirm text in the input box is preserved.
5. **Audit Log Verification:**
   - Check `auditlogs` collection via mongosh:
     ```javascript
     db.auditlogs.find({ eventType: "ASSISTANT_QUESTION_ASKED" }).sort({ createdAt: -1 }).limit(1).pretty();
     ```
     Confirm metadata contains `tools`, `recordIds`, and `stepCount`, with NO message body or PII.

---

## 4. Rollback Procedure

If unexpected behavior or regression occurs after deployment:

### Step 1: Revert Working Tree on EC2
```bash
# [AFFECTS WORKING TREE ON SERVER]
cd ~/vistaar
git checkout e47560e   # Or previous stable production commit
```

### Step 2: Rebuild & Restart Containers to Previous Image
```bash
# [REBUILDS AND RESTARTS CONTAINERS TO PREVIOUS COMMIT]
docker compose --env-file .env --env-file backend/.env build crm-api ai-brain-service
docker compose --env-file .env --env-file backend/.env up -d --no-deps crm-api ai-brain-service crm-worker
```

### Step 3: Rebuild Previous Frontend
```bash
# [REBUILDS AND RESTORES PREVIOUS FRONTEND SPA]
cd ~/vistaar/frontend
npm ci
VITE_API_BASE_URL=/api/v1 npm run build
sudo cp -r dist/* /srv/vistaar/
sudo systemctl reload caddy
```

### Step 4: Verify Post-Rollback State
```bash
curl -s http://localhost:5002/api/v1/health | jq .
curl -s http://localhost:5001/api/v1/health | jq .
sudo systemctl status vistaar.service
```

