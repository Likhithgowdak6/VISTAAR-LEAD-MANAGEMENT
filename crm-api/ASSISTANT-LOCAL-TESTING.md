# Running the assistant locally

Everything below runs against a **local development database**. Nothing here touches production,
and the seed script refuses to run against a non-loopback host or a database named `wam_crm_ai`.

---

## 0. What you need running

Mongo and Redis. If the project's containers are already up, you have both:

```bash
docker ps --format "{{.Names}}\t{{.Status}}" | grep wam-crm-ai
```

Expected: `wam-crm-ai-mongo` and `wam-crm-ai-redis`, both healthy. If not:

```bash
docker compose up -d mongo redis
```

---

## 1. Seed an isolated database

This creates `wam_crm_ai_assistant_e2e` — a **separate database** on the same local Mongo. Your
own `wam_crm_ai` data is not read or modified.

```bash
cd crm-api && ./venv/Scripts/python.exe tools/seed_assistant_e2e.py
```

It prints the login details. Two organisations, three users:

| Org slug | Email | Role | Sees |
|---|---|---|---|
| `studio-a` | `asha@studio-a.test` | admin | both org A leads |
| `studio-a` | `vikram@studio-a.test` | staff | only Rahul Mehta |
| `studio-b` | `priya@studio-b.test` | admin | only org B's lead |

Password for all three: `AssistantE2E!2026`

---

## 2. Environment

```bash
cat > /tmp/e2e-env.sh <<'EOF'
export MONGODB_URI="mongodb://localhost:27017/wam_crm_ai_assistant_e2e?replicaSet=rs0"
export REDIS_URL="redis://localhost:6379/9"
export JWT_ACCESS_SECRET="e2e-local-only-secret-at-least-32-chars!"
export ENCRYPTION_KEY_V1="$(python -c 'import base64;print(base64.b64encode(b"e"*32).decode())')"
export ENCRYPTION_KEY_CURRENT_VERSION=1
export CONTACT_LOOKUP_HMAC_KEY="$(python -c 'import base64;print(base64.b64encode(b"e2e-hmac-key-16+").decode())')"
export NODE_ENV=development
export EXPECTED_REPLICA_SET=rs0
export ENABLE_BACKGROUND_RUNNERS=false
export AI_BRAIN_ENABLED=true
export AI_BRAIN_SERVICE_KEY="e2e-service-key"
export FRONTEND_ORIGIN="http://localhost:5174"
EOF
```

Redis database **9** and Mongo database `wam_crm_ai_assistant_e2e` keep this run off your dev
data. Ports 5055/5056/8098/8099/5174 avoid the production-shaped ones (5002/8091/5173).

---

## 3. Start a brain

**Either** the real one — this calls Anthropic and costs money:

```bash
cd ai-brain-service && LLM_API_KEY="$(grep '^AI_BRAIN_LLM_API_KEY=' ../.env | cut -d= -f2-)" LLM_PROVIDER=anthropic SERVICE_API_KEY=e2e-service-key DATABASE_URL="" python -m uvicorn app.main:app --host 127.0.0.1 --port 8098
```

**Or** the scriptable stub — free, deterministic, and the only way to test failure injection:

```bash
cd crm-api && ./venv/Scripts/python.exe tools/stub_brain.py 8099
```

---

## 4. Start crm-api

Against the **real** brain:

```bash
cd crm-api && source /tmp/e2e-env.sh && AI_BRAIN_SERVICE_URL=http://127.0.0.1:8098 ./venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 5056
```

Against the **stub**:

```bash
cd crm-api && source /tmp/e2e-env.sh && AI_BRAIN_SERVICE_URL=http://127.0.0.1:8099 ./venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 5055
```

---

## 5. The automated scenario suite

Needs the **stub** brain on 8099 and crm-api on 5055. 34 assertions covering multi-step tool
use, organisation isolation, assignment visibility, thread ownership, retrieval scoping, tool
failure, brain failure and auth.

```bash
cd crm-api && ./venv/Scripts/python.exe tools/assistant_e2e.py
```

---

## 6. The frontend

```bash
cd frontend && VITE_API_PROXY_TARGET=http://127.0.0.1:5056 npx vite --port 5174 --host 127.0.0.1
```

Open <http://127.0.0.1:5174>, sign in as `studio-a` / `asha@studio-a.test`, click **Assistant**.

Worth trying by hand:

- *"Why is my hottest lead hot?"* — multi-step: searches, then explains the score.
- *"Show me all my leads as a markdown table with name, score and stage."* — table rendering.
- Then *"why?"* — the follow-up must stay in the same thread and resolve "that one".
- Sign out, sign in as `vikram@studio-a.test`, ask *"Tell me everything about Ananya Reddy."*
  The correct answer is that no such lead was found: she is assigned to Asha.

---

## 7. Tearing down

```bash
docker exec wam-crm-ai-mongo mongosh --quiet --eval 'db.getSiblingDB("wam_crm_ai_assistant_e2e").dropDatabase()'
```

Then stop the four processes. Nothing else is left behind — Redis database 9 is cleared by
Mongo-independent expiry, and no file outside `/tmp` is written.
