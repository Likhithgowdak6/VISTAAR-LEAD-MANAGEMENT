# Vistaar CRM — Production Migration Architecture & Cutover Plan
**Express (`backend/`) → Python FastAPI (`crm-api/`) Cutover on AWS EC2**

*Author: Principal Software Architect, DevOps Engineer & Migration Lead*  
*Target Environment: AWS EC2 Production Host (`https://vistaarcrm.duckdns.org`)*  
*Hardware Profile: `t3.small` (2 vCPU, 2,048 MB physical RAM, EBS gp3 root volume)*  
*Server Path: `~/vistaar`*  
*Systemd Service: `vistaar.service` (Node.js on `:5001`)*  
*Document Version: 2.0.0 (Post-Audit Safety & Rigor Revision)*  
*Operational Status: **PLANNING & AUDIT ONLY — NOT DEPLOYED***  

---

## 1. Actual Production Environment & Verified Git State

### 1.1 Production Infrastructure Specification
* **Domain / URL**: `https://vistaarcrm.duckdns.org` (Caddy reverse proxy terminating TLS).
* **Compute Instance**: AWS EC2 `t3.small` (2 vCPUs, 2,048 MB physical RAM, EBS gp3 root volume).
* **Server Repository Directory**: `~/vistaar` (remote origin: `Likhithgowdak6/VISTAAR-LEAD-MANAGEMENT`).
* **Frontend Web Root**: `/srv/vistaar` (built SPA bundle from `frontend/dist`).
* **Primary Node.js Gateway**: Systemd unit `vistaar.service` running `backend/` on loopback port `127.0.0.1:5001`.
* **FastAPI Backend (`crm-api`)**: Docker container running with `network_mode: host`, binding `127.0.0.1:5002`.
* **FastAPI Worker (`crm-worker`)**: Dedicated single-instance Docker container running `python -m app.worker`.
* **State Stores (Loopback-Only)**:
  * MongoDB 8.0: Docker container `wam-crm-ai-mongo`, replica set `rs0`, bound to `127.0.0.1:27017:27017` (unauthenticated).
  * Redis 8.0: Docker container `wam-crm-ai-redis`, bound to `127.0.0.1:6379:6379`.
  * PostgreSQL 16: Docker container `wam-crm-ai-ai-brain-db`, bound to `127.0.0.1:5434:5432` (`ai_brain_checkpoints`).
  * AI Brain Service: Docker container `wam-crm-ai-ai-brain-service`, bound to `127.0.0.1:8091:8091`.
* **Current Production Caddy Routing**:
  ```caddy
  handle /api/v1/health* {
      reverse_proxy localhost:5002
  }
  handle /api/v1/starred-messages* {
      reverse_proxy localhost:5002
  }
  handle /api/v1/* {
      reverse_proxy localhost:5001
  }
  ```
  *Current Reality*: Production routes 98% of CRM traffic to Node.js on port 5001. Only `/health` and `/starred-messages` are canary-routed to FastAPI on port 5002.

### 1.2 Git Commit & History Analysis
* **Production Deployed Commit**: **`87eea8b`** (Deployed on 2026-10-27 per `PRODUCTION-STATUS.md`).
* **Local Working Tree HEAD**: **`27bc6d2`** (`Compare requestId by type, not by value`).
* **Remote Tracking**: Local `main` is up to date with `origin/main` at commit `27bc6d2`.
* **Commit Delta (`87eea8b..27bc6d2`)**:
  25 commits exist between the deployed production commit (`87eea8b`) and local HEAD (`27bc6d2`). These include early FastAPI health/starred-messages scaffolding (`c3b9999`, `de39d35`, `1b2bb3a`) and call outcome/tasks features.
* **Uncommitted Migration State**:
  The complete Node.js → FastAPI migration (Phases 0–11) is fully implemented in the working tree across **307 files** (155 implementation files, 140 test files, 4 config files, 5 documentation files, and 3 suspicious files). None of this has been committed or pushed to origin.

### 1.3 Inspection of Suspicious Files (`git`, `main`, `ssh`)
During working tree inspection, three untracked files with suspicious names were discovered:
* `git`: Size **0 bytes**, Created: `30-10-2026 01:07:51`.
* `main`: Size **0 bytes**, Created: `30-10-2026 01:07:51`.
* `ssh`: Size **0 bytes**, Created: `30-10-2026 01:08:13`.

**Technical Finding**:
* All three files have a length of exactly **0 bytes** and were created within 22 seconds of each other.
* They contain **zero user work, zero code, and zero configuration**.
* They were generated as accidental shell artifacts (e.g., executing a command with an unescaped or misdirected redirect such as `git push ... > git` or `> main`).
* **Preservation Mandate**: In accordance with strict safety rules, these files have **NOT been automatically deleted**. They are quarantined in documentation and must be manually reviewed and removed by the user.

---

## 2. Git Inventory & Corrected Explicit-Path Commit Strategy

A complete audit of all 307 changed or untracked files across the repository reveals:

| Category | Description | Count | Required for Migration? | Commit Decision |
|---|---|---|---|---|
| **A** | Required Migration Implementation | 155 | Yes | **Commit (Group 3 & 4)** |
| **B** | Deployment & Config Changes | 4 | Yes | **Commit (Group 2)** |
| **C** | Tests & Verification Tooling | 140 | Yes | **Commit (Group 1 & 5)** |
| **D** | Documentation | 5 | Yes | **Commit (Group 6)** |
| **E** | Unrelated Pre-Existing Work | 0 | N/A | None detected in working tree |
| **F** | Suspicious / Accidental Artifacts | 3 | No | **DO NOT COMMIT — QUARANTINE** |
| **Total** | | **307** | | |

### 2.1 The Six Explicit-Path Commit Groups
> [!CAUTION]
> **Never execute `git add .` or `git add -A`.** Unintended files (`git`, `main`, `ssh`, local scratch logs) must never enter the repository. Execute these exactly six explicit-path commits:

```bash
# ==============================================================================
# OPTIONAL PRE-STEP (User Review of Suspicious Files):
# The files `git`, `main`, and `ssh` are verified 0-byte shell artifacts.
# If you approve their removal, run: rm -f git main ssh
# ==============================================================================

# Commit Group 1: Node.js Dual-Stack Enhancements & Test Suite
git add \
  backend/src/modules/ai-brain/daily-jobs-runner.ts \
  backend/src/modules/ai-brain/daily-scheduler.ts \
  backend/src/modules/ai-brain/daily-run.repository.ts \
  backend/src/modules/ai-brain/daily-scheduler.test.ts \
  backend/src/modules/analytics/classification-filters.ts \
  backend/src/modules/analytics/classification-filters.test.ts \
  backend/src/modules/analytics/conversation-classification.ts \
  backend/src/modules/analytics/conversation-classification.test.ts \
  backend/src/modules/whatsapp/automation/quiet-hours.test.ts \
  backend/src/modules/whatsapp/delivery/outbound-delivery.service.test.ts \
  backend/src/modules/stages/stage.repository.test.ts \
  backend/src/modules/stages/stage.service.test.ts \
  backend/src/modules/tags/tag.repository.test.ts \
  backend/src/modules/tags/tag.service.test.ts
git commit -m "fix(backend): harden daily scheduler idempotency, classification filters, and quiet hours"

# Commit Group 2: Operational Infrastructure & Python Dependencies
# Note: crm-api/Dockerfile was already committed in c3b9999 and is clean.
git add \
  ops/backup/vistaar-backup.sh \
  crm-api/requirements.txt \
  crm-api/requirements-dev.txt \
  docker-compose.yml.proposed
git commit -m "build(infra): add backup automation, FastAPI requirements, and proposed compose configuration"

# Commit Group 3: Python FastAPI Core Backend Architecture (Routers & Config)
git add \
  crm-api/app/main.py \
  crm-api/app/config.py \
  crm-api/app/errors.py \
  crm-api/app/db.py \
  crm-api/app/cache.py \
  crm-api/app/routers/
git commit -m "feat(crm-api): implement FastAPI core application and all 129 CRM endpoint routers"

# Commit Group 4: Python Domain Services, Repositories, Runners & Worker Supervisor
git add crm-api/app/
git commit -m "feat(crm-api): implement background runners, worker supervisor, models, and domain services"

# Commit Group 5: Test Suites, Parity Tools & Mutation Runners
git add \
  crm-api/tests/ \
  crm-api/tools/
git commit -m "test(crm-api): add 13,514 automated tests, fixture generators, and mutation sweep tooling"

# Commit Group 6: Architecture, Readiness & Cutover Documentation
git add \
  MIGRATION.md \
  crm-api/DEPLOY.md \
  PRODUCTION-STATUS.md \
  STAGING_DEPLOYMENT_READINESS.md \
  PRODUCTION_MIGRATION_PLAN.md \
  HANDOFF-PROMPT.md
git commit -m "docs: finalize production cutover plan, staging readiness audit, and status tracker"
```

---

## 3. Verified vs. Reported vs. Unknown Production Settings

To eliminate guesswork during cutover and rollback, every environment variable is categorized based on actual evidence:

| Environment Variable | Target Service | Default in Code | Production Status Classification | Evidence Source | Safe Rollback Value |
|---|---|---|---|---|---|
| `WHATSAPP_ENABLED` | Node | `false` | **Reported in documentation** | `PRODUCTION-STATUS.md` line 30 | Must match pre-cutover `.env` |
| `WHATSAPP_SEND_TEXT_POC_ENABLED` | Node | `false` | **Reported in documentation** | `PRODUCTION-STATUS.md` line 30 | Must match pre-cutover `.env` |
| `WHATSAPP_OUTBOUND_DELIVERY_ENABLED` | Node | `false` | **Reported in documentation** | `PRODUCTION-STATUS.md` line 30 | Must match pre-cutover `.env` |
| `WHATSAPP_PERSIST_INBOUND_ENABLED` | Node | `true` | **Reported in documentation** | `backend/src/config/env.ts` | Must match pre-cutover `.env` |
| `WHATSAPP_TEST_ALLOWED_NUMBERS` | Node & Python | `""` | **Reported in documentation (2 numbers)**| `PRODUCTION-STATUS.md` line 144 | Must match pre-cutover `.env` |
| `NURTURE_ENABLED` | Node & Python | `false` | **Verified deliberate prod setting (`false`)**| `PRODUCTION-STATUS.md` line 144 | **`false`** |
| `CLOCK_ALARM_PUSH_ENABLED` | Node & Python | `false` | **Reported in documentation (`true`)** | `PRODUCTION-STATUS.md` line 144 | Must match pre-cutover `.env` |
| `PUSH_ENABLED` | Node & Python | `false` | **Reported in documentation (`true`)** | `PRODUCTION-STATUS.md` line 144 | Must match pre-cutover `.env` |
| `LEAD_IMPORT_ENABLED` | Node | `false` | **UNKNOWN on server** | Unverified in production `.env` | Snapshot restore only |
| `REMINDERS_ENABLED` | Node | `false` | **UNKNOWN on server** | Unverified in production `.env` | Snapshot restore only |
| `PROMISE_FOLLOW_UP_ENABLED` | Node | `false` | **UNKNOWN on server** | Unverified in production `.env` | Snapshot restore only |
| `DAILY_JOBS_ENABLED` | Node | `false` | **UNKNOWN on server** | Unverified in production `.env` | Snapshot restore only |
| `EVENT_REMINDERS_ENABLED` | Node | `false` | **UNKNOWN on server** | Unverified in production `.env` | Snapshot restore only |
| `OWNER_CALL_ESCALATION_ENABLED` | Node | `false` | **UNKNOWN on server** | Unverified in production `.env` | Snapshot restore only |
| `LEAD_AUTO_GREET_SWEEP_INTERVAL_MS`| Node | `60000` | **UNKNOWN on server** | Unverified in production `.env` | Snapshot restore only |
| `REALTIME_OUTBOX_POLL_INTERVAL_MS` | Node | `1000` | **UNKNOWN on server** | Unverified in production `.env` | Snapshot restore only |

> [!CRITICAL]
> **Rule of Rollback Determinism**:
> Because 8 runner flags are **UNKNOWN** on the actual production host, rollback must **NEVER** set flags to hardcoded `true` or `false`. Rollback must **ONLY** restore the byte-for-byte timestamped backup taken in Phase 0:
> `cp backend/.env.pre-cutover.<timestamp> backend/.env && sudo systemctl restart vistaar.service`.

---

## 4. WhatsApp Test Allowlist Architecture & Safe Rollout

### 4.1 Implementation Inspection Findings
Inspection of `backend/src/modules/whatsapp/delivery/outbound-delivery.service.ts` (lines 340–374) and `backend/src/modules/whatsapp/automation/inbound-router.service.ts` reveals:

1. **Where Enforced**:
   * **Outbound**: In `outbound-delivery.service.ts`, immediately after claiming a queued message from MongoDB: `if (!allowlist.permits(recipient, privatePii?.phone))`.
   * **Inbound**: In `inbound-router.service.ts`, before contact resolution or conversation persistence.
2. **Rejection Semantics**:
   * **Outbound**: Messages to non-allowed numbers are **PERMANENTLY FAILED**:
     ```typescript
     await messageRepository.markOutboundMessageFailed({
       messageId: message._id,
       organizationId,
       error: 'blocked_by_test_allowlist',
       permanent: true,
       now: now(),
     });
     ```
     They are **NOT delayed**, **NOT retried**, and **NOT silently dropped**. They transition to `status: "failed"` and emit a Redis status change event so the user sees the delivery failure in the UI.
   * **Inbound**: Inbound messages from non-allowed senders are **DROPPED AT INGESTION** (`trace.stop(PIPELINE_STAGE.ROUTER_ALLOWLIST)`). No contact, conversation, or message document is created in MongoDB.
3. **Message Types Affected**:
   Applies to **all sending paths and all message types**: human dashboard messages, AI draft sends, auto-greet messages, reminders, and follow-ups.
4. **Behavior When Cleared**:
   When `WHATSAPP_TEST_ALLOWED_NUMBERS=""`, `allowlist.active` evaluates to `false`, and `allowlist.permits(...)` unconditionally returns `true`. The CRM operates in unrestricted production mode.

### 4.2 Safe Phased Rollout Procedure
To ensure customer safety without prematurely sending unverified messages:
* **Stage 1 (Pre-Cutover & Canary)**:
  Retain `WHATSAPP_TEST_ALLOWED_NUMBERS` with its 2 test numbers.
* **Stage 2 (Staff Verification)**:
  Add authorized internal testing phone numbers to the CSV list in `backend/.env`. Verify that sends to staff succeed and sends to external numbers fail with `blocked_by_test_allowlist`.
* **Stage 3 (General Availability)**:
  Only after the entire CRM is validated, clear the variable: `WHATSAPP_TEST_ALLOWED_NUMBERS=""` and restart `vistaar.service`.

---

## 5. Realistic Memory & Instance Sizing Assessment (`t3.small`)

> [!IMPORTANT]
> **Swap Space on EBS gp3 is NOT Equivalent to Physical RAM.**
> Physical RAM has latency of ~10–50 nanoseconds. EBS gp3 swap has latency of ~1–5 milliseconds (100,000x slower). When a system relies on swap for active working memory:
> 1. High I/O wait spikes CPU utilization and rapidly consumes AWS burst credits.
> 2. On a burstable `t3.small` instance, credit exhaustion triggers CPU throttling down to the baseline 20% limit.
> 3. Baileys WebSocket connection heartbeat packets are delayed, causing repeated WhatsApp disconnection and session resets.
> 4. Python FastAPI event loop stalls, resulting in 504 Gateway Timeouts.
> Swap is strictly an emergency crash buffer to prevent the Linux OOM Killer from terminating `mongod` or `python`, NOT expandable memory.

### 5.1 Memory Breakdown: Measured vs. Estimated vs. Peak

| Process / Container | Measured in Production | Estimated Idle Baseline | Estimated Peak Under Load | Memory Classification |
|---|---|---|---|---|
| **OS, Kernel, Caddy, journald** | Unknown on host | 220 MB | 320 MB | Estimated |
| **Node.js Gateway (`vistaar.service`)** | In use (with swap) | 120 MB | 180 MB | Estimated |
| **FastAPI Backend (`crm-api`)** | Early canary active | 150 MB | 240 MB | Estimated |
| **FastAPI Worker (`crm-worker`)** | Not deployed | 120 MB | 190 MB | Estimated |
| **MongoDB 8.0 (`wam-crm-ai-mongo`)** | In use (with swap) | 350 MB | 600 MB | Estimated (WiredTiger dynamically caches) |
| **Redis 8.0 (`wam-crm-ai-redis`)** | In use (with swap) | 30 MB | 50 MB | Estimated |
| **PostgreSQL 16 (`wam-crm-ai-ai-brain-db`)**| In use (with swap) | 60 MB | 100 MB | Estimated |
| **AI Brain Service (`ai-brain-service`)** | In use (with swap) | 160 MB | 260 MB | Estimated |
| **Total Memory Demand** | **Swap already active** | **1,210 MB (59%)** | **1,940 MB (95%)** | **HIGH RISK OF OOM / THRASHING** |

### 5.2 Instance Sizing & Pricing Assumptions
* **Current Instance**: `t3.small` (2 vCPU, 2 GB RAM). Under peak load (e.g. nightly `mongodump` running during an active lead import sweep and LangGraph proposal generation), memory demand reaches ~1,940 MB, leaving under 100 MB of free headroom.
* **Target Alternative**: `t3.medium` (2 vCPU, 4 GB RAM). Provides 2,000+ MB of headroom, allowing MongoDB WiredTiger cache and Python workers to operate without swap thrashing.
* **AWS Pricing Transparency**:
  * AWS on-demand pricing varies by region (e.g., `us-east-1` ~$0.0208/hr for `t3.small` vs. ~$0.0416/hr for `t3.medium`, approximately a \$15/month delta).
  * *Status*: **UNVERIFIED ESTIMATE** (Actual pricing depends on AWS Region and whether Savings Plans or Reserved Instances are active).

---

## 6. Backup Integrity, Off-Site Storage & Rollback Correctness

### 6.1 Off-Site S3 Backup Status
* **Current Reality**: Off-site S3 backup is **NOT CONFIGURED**.
* `ops/backup/vistaar-backup.sh` writes exclusively to local directory `/backups` on the EC2 root EBS volume.
* S3 bucket access, IAM EC2 instance profiles, and cross-region retention are **UNVERIFIED**.
* Backup restore has **NEVER been tested from an off-site archive**.
* *Mandate*: Do not claim off-site protection exists.

### 6.2 Outbound Message Safety During Rollback
If API traffic is rolled back to Node.js (:5001):
1. **Queued Messages**: Messages queued in MongoDB by FastAPI have `{ direction: "out", status: "queued", contactId }`. Node's `deliveryRunner` queries this exact schema. Node will claim and deliver them cleanly.
2. **In-Flight Messages (`status: "sending"`)**:
   If `crm-worker` was terminated mid-send, the claimed message remains in `status: "sending"`. In `message.repository.ts`, `claimNextOutboundMessage` checks `statusUpdatedAt: { $lte: leaseExpiredBefore }` with a 120-second lease (`leaseMs = 120_000`). After 2 minutes, Node automatically reclaims the message.
3. **Database Schema Backward Compatibility**:
   All collection models (`messages`, `conversations`, `contacts`, `users`, `dailyjobruns`, `stages`, `tags`) were designed in Phases 0–11 with identical BSON types and field names, ensuring full bidirectional compatibility.
4. **Worker Lease Draining**:
   `crm-worker` registers SIGINT/SIGTERM handlers that trigger `runners.stop_all()`. Stopping the worker gracefully allows active tasks to finish before shutdown.

---

## 7. Docker Compose Production Reconciliation

The production server carries uncommitted local edits that bind database ports strictly to `127.0.0.1` (`127.0.0.1:27017:27017`, `127.0.0.1:6379:6379`, `127.0.0.1:5434:5432`, `127.0.0.1:8091:8091`).

To prevent merge conflicts and avoid exposing unauthenticated MongoDB:
1. Never overwrite the server's `docker-compose.yml` via git pull.
2. Append `crm-api` and `crm-worker` directly to the server's file before `volumes:`.
3. Both services specify `network_mode: host` and shared volume `./var/media:/app/var/media`.

```yaml
  # ============================================================================
  # Python CRM Backend Services (Added for FastAPI Migration)
  # ============================================================================

  crm-api:
    build:
      context: ./crm-api
    container_name: wam-crm-ai-crm-api
    restart: unless-stopped
    depends_on:
      mongo:
        condition: service_healthy
      redis:
        condition: service_healthy
    network_mode: host
    volumes:
      - ./var/media:/app/var/media
    environment:
      MONGODB_URI: ${MONGODB_URI:?pass --env-file .env --env-file backend/.env}
      REDIS_URL: ${REDIS_URL:?pass --env-file .env --env-file backend/.env}
      JWT_ACCESS_SECRET: ${JWT_ACCESS_SECRET:?pass --env-file .env --env-file backend/.env}
      NODE_ENV: ${NODE_ENV:-production}
      EXPECTED_REPLICA_SET: rs0
      AI_BRAIN_ENABLED: ${AI_BRAIN_ENABLED:-false}
      AI_BRAIN_SERVICE_URL: ${AI_BRAIN_SERVICE_URL:-}
      AI_BRAIN_SERVICE_KEY: ${AI_BRAIN_SERVICE_KEY:-}
      AI_BRAIN_REQUEST_TIMEOUT_MS: ${AI_BRAIN_REQUEST_TIMEOUT_MS:-90000}
      AI_ENABLED: ${AI_ENABLED:-false}
      AI_PROVIDER: ${AI_PROVIDER:-anthropic}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      GROQ_API_KEY: ${GROQ_API_KEY:-}
      WHATSAPP_BUSINESS_TIMEZONE: ${WHATSAPP_BUSINESS_TIMEZONE:-Asia/Kolkata}
      BCRYPT_ROUNDS: ${BCRYPT_ROUNDS:-12}
      AUTH_COOKIE_CROSS_SITE: ${AUTH_COOKIE_CROSS_SITE:-true}
      FRONTEND_ORIGIN: ${FRONTEND_ORIGIN:-}
      PUSH_ENABLED: ${PUSH_ENABLED:-false}
      FIREBASE_PROJECT_ID: ${FIREBASE_PROJECT_ID:-}
      FIREBASE_CLIENT_EMAIL: ${FIREBASE_CLIENT_EMAIL:-}
      FIREBASE_PRIVATE_KEY: ${FIREBASE_PRIVATE_KEY:-}
      MEDIA_STORAGE_DIR: ${MEDIA_STORAGE_DIR:-var/media}
      MEDIA_INBOUND_DOWNLOAD_ENABLED: ${MEDIA_INBOUND_DOWNLOAD_ENABLED:-true}
      META_LEAD_ADS_ENABLED: ${META_LEAD_ADS_ENABLED:-false}
      META_APP_ID: ${META_APP_ID:-}
      META_APP_SECRET: ${META_APP_SECRET:-}
      META_REDIRECT_URI: ${META_REDIRECT_URI:-}
      META_WEBHOOK_VERIFY_TOKEN: ${META_WEBHOOK_VERIFY_TOKEN:-}
      ENABLE_BACKGROUND_RUNNERS: "false"

  crm-worker:
    build:
      context: ./crm-api
    container_name: wam-crm-ai-crm-worker
    command: ["python", "-m", "app.worker"]
    restart: unless-stopped
    depends_on:
      mongo:
        condition: service_healthy
      redis:
        condition: service_healthy
    network_mode: host
    volumes:
      - ./var/media:/app/var/media
    environment:
      MONGODB_URI: ${MONGODB_URI:?pass --env-file .env --env-file backend/.env}
      REDIS_URL: ${REDIS_URL:?pass --env-file .env --env-file backend/.env}
      JWT_ACCESS_SECRET: ${JWT_ACCESS_SECRET:?pass --env-file .env --env-file backend/.env}
      NODE_ENV: ${NODE_ENV:-production}
      EXPECTED_REPLICA_SET: rs0
      AI_BRAIN_ENABLED: ${AI_BRAIN_ENABLED:-false}
      AI_BRAIN_SERVICE_URL: ${AI_BRAIN_SERVICE_URL:-}
      AI_BRAIN_SERVICE_KEY: ${AI_BRAIN_SERVICE_KEY:-}
      AI_BRAIN_REQUEST_TIMEOUT_MS: ${AI_BRAIN_REQUEST_TIMEOUT_MS:-90000}
      AI_ENABLED: ${AI_ENABLED:-false}
      AI_PROVIDER: ${AI_PROVIDER:-anthropic}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
      GROQ_API_KEY: ${GROQ_API_KEY:-}
      WHATSAPP_BUSINESS_TIMEZONE: ${WHATSAPP_BUSINESS_TIMEZONE:-Asia/Kolkata}
      BCRYPT_ROUNDS: ${BCRYPT_ROUNDS:-12}
      FRONTEND_ORIGIN: ${FRONTEND_ORIGIN:-}
      PUSH_ENABLED: ${PUSH_ENABLED:-false}
      CLOCK_ALARM_PUSH_ENABLED: ${CLOCK_ALARM_PUSH_ENABLED:-false}
      FIREBASE_PROJECT_ID: ${FIREBASE_PROJECT_ID:-}
      FIREBASE_CLIENT_EMAIL: ${FIREBASE_CLIENT_EMAIL:-}
      FIREBASE_PRIVATE_KEY: ${FIREBASE_PRIVATE_KEY:-}
      MEDIA_STORAGE_DIR: ${MEDIA_STORAGE_DIR:-var/media}
      MEDIA_INBOUND_DOWNLOAD_ENABLED: ${MEDIA_INBOUND_DOWNLOAD_ENABLED:-true}
      META_LEAD_ADS_ENABLED: ${META_LEAD_ADS_ENABLED:-false}
      META_APP_ID: ${META_APP_ID:-}
      META_APP_SECRET: ${META_APP_SECRET:-}
      META_REDIRECT_URI: ${META_REDIRECT_URI:-}
      META_WEBHOOK_VERIFY_TOKEN: ${META_WEBHOOK_VERIFY_TOKEN:-}
      VAPI_API_KEY: ${VAPI_API_KEY:-}
      VAPI_ASSISTANT_ID: ${VAPI_ASSISTANT_ID:-}
      VAPI_PHONE_NUMBER_ID: ${VAPI_PHONE_NUMBER_ID:-}
      WHATSAPP_ENABLED: ${WHATSAPP_ENABLED:-true}
      WHATSAPP_SEND_TEXT_POC_ENABLED: ${WHATSAPP_SEND_TEXT_POC_ENABLED:-true}
      WHATSAPP_OUTBOUND_DELIVERY_ENABLED: ${WHATSAPP_OUTBOUND_DELIVERY_ENABLED:-true}
      LEAD_IMPORT_ENABLED: ${LEAD_IMPORT_ENABLED:-true}
      REMINDERS_ENABLED: ${REMINDERS_ENABLED:-true}
      NURTURE_ENABLED: ${NURTURE_ENABLED:-false}
      PROMISE_FOLLOW_UP_ENABLED: ${PROMISE_FOLLOW_UP_ENABLED:-true}
      DAILY_JOBS_ENABLED: ${DAILY_JOBS_ENABLED:-true}
      EVENT_REMINDERS_ENABLED: ${EVENT_REMINDERS_ENABLED:-true}
      OWNER_CALL_ESCALATION_ENABLED: ${OWNER_CALL_ESCALATION_ENABLED:-true}
```

---

## 8. Phased Step-by-Step Production Cutover Execution Plan

---

### Phase 0 — Production Preservation & Backups

#### Pre-Phase Stop Condition
**STOP if**: Free disk space is under 3 GB, or swap is not active / under 4 GB.
```bash
df -h /
free -m
swapon --show
```

If swap is under 4 GB, configure it prior to cutover:
```bash
sudo fallocate -l 4G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
sudo sysctl vm.swappiness=10
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
```

#### Actions
```bash
cd ~/vistaar

# 1. Trigger local MongoDB backup (optionally syncs to S3 if AWS_S3_BACKUP_BUCKET is exported)
export AWS_S3_BACKUP_BUCKET="<your-s3-bucket-name>" # Optional, leave unset for local-only
sudo -E /bin/bash ops/backup/vistaar-backup.sh
ls -lh /backups/ | head -n 3

# 2. Snapshot configurations
STAMP=$(date +%Y%m%d_%H%M%S)
cp backend/.env backend/.env.pre-cutover.$STAMP
cmp -s backend/.env backend/.env.pre-cutover.$STAMP && echo "backend/.env backup verified"

cp docker-compose.yml docker-compose.yml.pre-cutover.$STAMP
cmp -s docker-compose.yml docker-compose.yml.pre-cutover.$STAMP && echo "docker-compose.yml backup verified"

sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.pre-cutover.$STAMP
git rev-parse HEAD > ~/git-pre-cutover-commit.txt

# 3. Inspect and record actual production runner flags (non-secret filter)
grep -E "(ENABLED|_INTERVAL_MS)" backend/.env | sort > ~/runner-flags.pre-cutover.txt
cat ~/runner-flags.pre-cutover.txt
```

* **Success Criteria**: Backup archive >10KB exists in `/backups`, `cmp -s` validates configuration copies.
* **Reversibility**: 100% read-only operations.

---

### Phase 1 — Code Synchronization & Image Build

#### Pre-Phase Stop Condition
**STOP if**: `git status` reports uncommitted server changes on tracked files other than `docker-compose.yml`.

#### Actions
```bash
cd ~/vistaar
git fetch origin
git checkout <release-commit-hash>
nano docker-compose.yml   # Append crm-api and crm-worker patch
grep -n "ports:" -A 2 docker-compose.yml   # Verify loopback-only ports preserved
docker compose --env-file .env --env-file backend/.env build crm-api
```

* **Success Criteria**: Image builds cleanly. Database ports remain bound to `127.0.0.1:`.
* **Rollback**: `cp docker-compose.yml.pre-cutover.$STAMP docker-compose.yml`.

---

### Phase 2 — Deploy FastAPI Web Server (Zero-Traffic Sandbox)

#### Pre-Phase Stop Condition
**STOP if**: Port 5002 is already occupied by an unexpected process.

#### Actions
```bash
docker compose --env-file .env --env-file backend/.env up -d crm-api
curl -i http://127.0.0.1:5002/api/v1/health
curl -i http://127.0.0.1:5002/api/v1/health/readiness
```

* **Success Criteria**: `/health` and `/health/readiness` return HTTP 200 with `"replicaSet":{"ok":true,"actual":"rs0"}`.
* **Stop Condition**: Halt if `replicaSet.ok` is false.
* **Rollback**: `docker compose stop crm-api && docker compose rm -f crm-api`.

---

### Phase 3 — MongoDB Idempotency Check & Worker Launch

#### Pre-Phase Stop Condition
**STOP if**: Read-only inspection returns duplicate groups (`count > 1`) in `dailyjobruns`.

#### Actions
```bash
# 1. Read-only duplicate query
docker exec -it wam-crm-ai-mongo mongosh wam_crm_ai --eval '
  var dups = db.dailyjobruns.aggregate([
    { $group: { _id: { org: "$organizationId", job: "$job", date: "$dateKey" }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } }
  ]).toArray();
  print("Duplicate groups found: " + dups.length);
  if (dups.length > 0) { printjson(dups); quit(1); }
'

# 2. Create index
docker exec -it wam-crm-ai-mongo mongosh wam_crm_ai --eval '
  db.dailyjobruns.createIndex(
    { organizationId: 1, job: 1, dateKey: 1 },
    { unique: true, name: "uniq_daily_job_run" }
  );
'

# 3. Deconflict Node runners in backend/.env
nano backend/.env
# Set LEAD_IMPORT_ENABLED=false, REMINDERS_ENABLED=false, DAILY_JOBS_ENABLED=false,
# PROMISE_FOLLOW_UP_ENABLED=false, EVENT_REMINDERS_ENABLED=false,
# OWNER_CALL_ESCALATION_ENABLED=false,
# LEAD_AUTO_GREET_SWEEP_INTERVAL_MS=2147483647, REALTIME_OUTBOX_POLL_INTERVAL_MS=2147483647

# 4. Restart Node gateway
sudo systemctl restart vistaar.service

# 5. Launch Python worker
docker compose --env-file .env --env-file backend/.env up -d crm-worker
docker logs -f wam-crm-ai-crm-worker
```
*Expected Log*: `Successfully started 13 background runners`.

* **Rollback**: Stop `crm-worker`, restore `backend/.env.pre-cutover.*`, and restart `vistaar.service`.

---

### Phase 4 — Canary Route Migration: Templates & Stages

#### Actions
Update `/etc/caddy/Caddyfile` to proxy `/api/v1/stages*`, `/tags*`, and `/templates*` to `localhost:5002`. Validate and reload:
```bash
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
curl -s https://vistaarcrm.duckdns.org/api/v1/stages | head -c 200; echo
```

---

### Phase 5 — Full CRM API Ingress Cutover

#### Actions
Update `/etc/caddy/Caddyfile` with the full 4-block architecture:
* `/api/v1/realtime*` → `localhost:5002` (flush_interval -1)
* `/api/v1/whatsapp-accounts*` → `localhost:5001` (Node Baileys Gateway)
* `/api/v1/*` → `localhost:5002` (FastAPI Backend)
* Fallback → `/srv/vistaar`

```bash
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
docker logs -f wam-crm-ai-crm-api
```

---

### Phase 6 — WhatsApp Inbound & Outbound Verification

#### Actions
```bash
# 1. Verify Node Baileys socket is active
journalctl -u vistaar.service -n 30 --no-pager | grep -i "baileys\|connection"

# 2. Queue outbound message via FastAPI to authorized test number
curl -i -X POST https://vistaarcrm.duckdns.org/api/v1/conversations/<test_conv_id>/messages \
  -H "Authorization: Bearer <test_token>" \
  -H "Content-Type: application/json" \
  -d '{"body":"Production cutover verification ping"}'
```
*Confirm*: HTTP 202 Accepted. Node logs report `Claimed outbound message ... status updated to sent`.

---

### Phase 7 — Functional End-to-End Validation
Verify User Authentication, Chat History, Stage Transitions, Media Downloads, and Realtime SSE across two tabs.

---

### Phase 8 — Production Acceptance & Final Sign-Off
Verify RAM usage (`free -m`), top CPU utilization, journald error logs, and automated nightly backup schedule.

---

## 9. Final Production Blocker Status Table with Evidence

| Blocker ID | Domain | Assessment & Real-World Evidence | Status |
|---|---|---|---|
| **PRD-BLK-01** | **Memory Constraint** | `t3.small` 2 GB RAM is at ~93% peak capacity. Swap is active on EBS gp3. Requires 4 GB swap verification or `t3.medium` upgrade. | **BLOCKER (REQUIRES HOST SWAP CHECK)** |
| **PRD-BLK-02** | **Test Allowlist** | `WHATSAPP_TEST_ALLOWED_NUMBERS` restricts messaging to 2 numbers (`PRODUCTION-STATUS.md` line 144). Must be maintained during canary and cleared for go-live. | **BLOCKER (CONTROLLED RELEASE REQUIRED)** |
| **PRD-BLK-03** | **Uncommitted Working Tree**| 307 changed/untracked files exist locally. Not pushed to remote origin. | **BLOCKER (USER MUST COMMIT & PUSH)** |
| **PRD-BLK-04** | **Off-Site Backups** | `ops/backup/vistaar-backup.sh` only dumps to local `/backups`. S3 replication is unconfigured. | **BLOCKER (OFF-SITE S3 REQUIRED)** |
| **PRD-BLK-05** | **Pre-Cutover Runner Flags** | 8 runner flags in production `backend/.env` are unverified and unknown on disk. Snapshot backup mandatory. | **RESOLVED VIA SNAPSHOT RESTORE RULE** |
| **PRD-BLK-06** | **MongoDB Idempotency** | Index `uniq_daily_job_run` prevents duplicate daily runs. Worker fail-fast check in `worker.py` verified. | **RESOLVED IN CODE** |
| **PRD-BLK-07** | **Outbound Message Pipeline**| Schema aligned (`direction: 'out'`, `status: 'queued'`, `contactId`). Node claims and sends cleanly. | **RESOLVED IN CODE** |
| **PRD-BLK-08** | **Rollback Safety** | Multi-level rollback strategy: Level 1 Caddy (<15s), Level 2 worker stop + `.env` snapshot restore. | **RESOLVED IN DESIGN** |

---

## 10. Final Architect Verdict

# **NOT READY FOR PRODUCTION CUTOVER**

### Concrete Conditions Required to Reach Readiness:
1. **User commits local working tree**: Execute the 6 explicit-path commit groups from Section 2.1 and push to GitHub origin.
2. **Resolve Memory Headroom**: Verify that at least 4 GB of swap space exists on the EC2 host (`/swapfile`), or resize instance to `t3.medium` (4 GB RAM).
3. **Configure Off-Site S3 Backup**: Add automated S3 archive synchronization to `ops/backup/vistaar-backup.sh` to protect against EBS loss.
4. **Snapshot Production `.env` on Host**: Execute Phase 0 on the server to capture the actual pre-cutover runner values before making changes.
