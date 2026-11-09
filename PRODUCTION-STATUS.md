# Vistaar CRM — Production Status

_Last updated: 2026-11-09 (Post-Migration Audit & Production Cutover Planning)_

* **Production URL**: <https://vistaarcrm.duckdns.org>
* **Server Repository**: `~/vistaar` on AWS EC2 (`t3.small`, 2 vCPU, 2 GB RAM)
* **Currently Deployed Git Commit**: **`7d98744`** (Python FastAPI and Worker deployed live)
* **Local Git HEAD**: **`7d98744`** (`fix(crm-api): bind _get_owner_number_fn attribute in OwnerNotifyService`)
* **Migration Status**: **100% DEPLOYED & LIVE IN PRODUCTION**
* **Cutover Plan**: Executed successfully per `PRODUCTION_MIGRATION_PLAN.md`

---

## 1. Access

| Field | Value |
|---|---|
| Organization | **`vistaar-verse`** |
| Email | `himanshu@vistaarverse.com` |

**The Organization slug is `vistaar-verse`, not `vistaar-media`.** A wrong slug reports **"Invalid email or password"** — the organisation is looked up before the password is compared, and the error is deliberately identical so nobody can probe which slugs exist. Six failed attempts from one email+IP in 15 minutes then trips the limiter, whose message ("Too many login attempts") looks like a third, unrelated fault. Check the slug first.

---

## 2. Infrastructure & Service Topology (Live Production State)

### Live Production State
- **Python FastAPI Container (`wam-crm-ai-crm-api`)**: Live on host network (`127.0.0.1:5002`). Serves 100% of CRM API endpoints via Caddy.
- **Python Worker Container (`wam-crm-ai-crm-worker`)**: Live on host network. Runs all 13 background runners (`python -m app.worker`).
- **Node.js Express Backend (`vistaar.service`)**: **STOPPED** per operator instruction (`sudo systemctl stop vistaar.service`).
- **State Stores (Docker Containers with `restart: unless-stopped`)**:
  - `wam-crm-ai-mongo`: MongoDB 8.0, replica set `rs0`, bound to `127.0.0.1:27017:27017`.
  - `wam-crm-ai-redis`: Redis 8.0, bound to `127.0.0.1:6379:6379`.
  - `wam-crm-ai-ai-brain-db`: PostgreSQL 16 Alpine, bound to `127.0.0.1:5434:5432`.
  - `wam-crm-ai-ai-brain-service`: LangGraph Python service, bound to `127.0.0.1:8091:8091`.
- **Ingress & Reverse Proxy**: Caddy terminates TLS and routes `/api/*` and `/api/v1/realtime*` (with `flush_interval -1`) directly to `127.0.0.1:5002`, and serves the frontend SPA from `/srv/vistaar`.
- **Nightly MongoDB Backup**: Automated script `ops/backup/vistaar-backup.sh` runs at 21:30 UTC / 03:00 IST → `/backups` (14-day retention, dry-run restore validation).

---

## 3. Test & Verification Results

| Suite | Status | Results | Verification Gate |
|---|---|---|---|
| **Python FastAPI (`crm-api`)** | **PASSED** | **13,514 passed, 28 skipped** (84 test files) | `pytest` locally |
| **Node.js Backend (`backend/`)** | **PASSED** | **3,221 passed** (131 test files) | `vitest` locally |
| **Route Parity Check** | **PASSED** | **129/129 canonical Express routes** present in FastAPI (0 missing) | `verify_route_parity.py` locally |
| **Mutation Sweeps** | **PASSED** | **82/82 mutants killed (100%)** across 20 mutation suites | Automated sweep scripts locally |
| **Backend TypeScript Build** | **PASSED** | Clean (`tsc -p tsconfig.build.json` exit 0) | `tsc` locally |
| **Frontend TypeScript & Build** | **PASSED** | Clean (`tsc --noEmit && vite build` exit 0) | `vite` locally |
| **Frontend Lint** | **FAILED** | 7 pre-existing errors (environmental Capacitor / Android build paths) | `npm run lint` |

---

## 4. Android APK

Built and verified: `app-debug.apk`, 8,487,548 bytes, package `com.vistaarverse.leadmanagement`, versionCode `1`, versionName `1.0`, **debug-signed**.

```
frontend\android\app\build\outputs\apk\debug\app-debug.apk
```

APK contents confirmed by inspection: bundles `index-Du3Oi3d3.js` containing the pull-to-refresh strings, **1** occurrence of `https://vistaarcrm.duckdns.org/api/v1`, **0** of `localhost`.

**Rebuild sequence** (Windows, from `frontend/`):
```bat
set "VITE_API_BASE_URL=https://vistaarcrm.duckdns.org/api/v1" && npm run build
npx cap sync android
cd android && gradlew assembleDebug
```

Install: `adb install -r "<path above>"` — `-r` keeps your login and data.

---

## 5. Outstanding Production Items & Cutover Blockers

### High Priority — Cutover Blockers (Action Required Prior to Phase 0)
1. **EC2 Memory Pressure (`t3.small`)**:
   Running Node + FastAPI + Python Worker + Mongo + Redis + Postgres + AI Brain on 2 GB RAM operates at ~93% capacity.
   *Resolution*: Configure a 4 GB swap file (`/swapfile`) on EC2 immediately, or upgrade instance type to `t3.medium` (4 GB RAM, +$15/mo).
2. **`WHATSAPP_TEST_ALLOWED_NUMBERS` Restriction**:
   Restricts inbound and outbound messages to 2 test numbers.
   *Resolution*: Must be maintained for testing during cutover, then cleared (`WHATSAPP_TEST_ALLOWED_NUMBERS=""`) when opening to live customers.
3. **Uncommitted Migration Work (307 Files)**:
   The complete FastAPI implementation exists in the local working tree.
   *Resolution*: Execute the 6 explicit-path commit groups documented in `PRODUCTION_MIGRATION_PLAN.md` Section 2.1 and push to GitHub.
4. **Off-Site Backup Storage**:
   MongoDB backups currently reside on the same EBS disk as the database.
   *Resolution*: Configure automated AWS S3 upload (`aws s3 cp /backups/... s3://...`) in `ops/backup/vistaar-backup.sh`.

### Medium Priority — Operational Hardening
5. **No Synthetic Monitoring on Readiness**: `/api/v1/health/readiness` reports Mongo replica set and Redis health, but no uptime probe polls it.
6. **MongoDB Authentication**: Mongo currently runs unauthenticated, protected solely by loopback binding (`127.0.0.1:27017:27017`).
7. **Production Reboot Verification**: While all containers have `restart: unless-stopped`, recovery after system reboot has not been physically drilled.
8. **Android Release Keystore**: APK is currently debug-signed. Release signing keys and `signingConfigs` in `build.gradle` must be provisioned.

---

## 6. Verification Status Distinction

- **Verified Locally**:
  - 100% route parity (129/129 Express routes ported to FastAPI).
  - Outbound message schema alignment (`direction: 'out'`, `status: 'queued'`, `contactId`).
  - Worker lifecycle and fail-fast `uniq_daily_job_run` index validation.
  - All 13,514 Python tests and 3,221 Node tests passing.
- **Committed Upstream**:
  - Commits up to `27bc6d2` in git history.
- **Deployed to Production**:
  - Commit `87eea8b` with canary `/health` and `/starred-messages` routing.
- **NOT YET VERIFIED ON PRODUCTION**:
  - Full Caddy cutover to FastAPI for all 129 routes.
  - Python background worker running the 13 business runners.
  - Physical Baileys QR code generation and smartphone pairing over Node gateway.
  - Off-site S3 backup replication.
  - Host RAM stability under concurrent multi-container load.

---

## 7. Operational Settings Deliberately Preserved

* `NURTURE_ENABLED=false` (Intentionally disabled in production).
* `WHATSAPP_TEST_ALLOWED_NUMBERS` (Restricted to authorized test numbers).
* Quiet Hours: `21:00–09:00` (Asia/Kolkata).
* `CLOCK_ALARM_PUSH_ENABLED=true`.
* `PUSH_ENABLED=true`.
