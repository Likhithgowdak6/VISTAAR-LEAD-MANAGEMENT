# Deploying crm-api (Phase 0)

## Why this service is not in `docker-compose.yml`

The production host's `docker-compose.yml` carries **uncommitted local edits** — loopback-only
port bindings (`127.0.0.1:27017:27017` and friends) that are not in the repository.

Committing any change to that file would make `git pull --ff-only` fail on the server with
*"Your local changes to the following files would be overwritten by merge"* — and it would keep
failing on **every future pull**, including ones for completely unrelated work. The cause would
not be obvious months later.

So the service block below is applied to the server's file **by hand**, and the repository never
owns `docker-compose.yml`. This document is the record of what to paste.

If the loopback bindings are ever committed upstream so the server's file matches the repo, this
can be folded into `docker-compose.yml` and this file deleted.

---

## 1. Back up, and verify the backup

`cmp -s` with `&&` matters: a `diff ... ; echo "ok"` would print its confirmation even when the
files differ, and a `.bak.*` glob would compare against the wrong file once a second backup
exists.

```bash
cd ~/vistaar && BACKUP="docker-compose.yml.bak.$(date +%Y-%m-%d-%H%M%S)" && cp docker-compose.yml "$BACKUP" && cmp -s docker-compose.yml "$BACKUP" && echo "Backup verified: $BACKUP"
```

Record the port bindings as they are now, so the edit can be checked against them afterwards:

```bash
cd ~/vistaar && grep -n "ports:" -A 2 docker-compose.yml > /tmp/ports.before && cat /tmp/ports.before
```

## 2. Paste this block

Immediately **before** the `volumes:` line at the end of the file. Purely additive — nothing
above it changes.

```yaml
  # The Python CRM API - Phase 0 of the Node -> Python migration.
  #
  # Serves ONLY /api/v1/health* until Caddy is told otherwise. No background jobs, no schedulers,
  # no writes: the Node backend on :5001 still owns all thirteen runners and every write path,
  # and will until modules are moved one at a time. Two services running the same sweep would
  # send a customer the same message twice.
  crm-api:
    build:
      context: ./crm-api
    container_name: wam-crm-ai-crm-api
    depends_on:
      mongo:
        condition: service_healthy
      redis:
        condition: service_healthy
    # HOST NETWORKING, AND THIS IS NOT A SHORTCUT.
    #
    # The Node backend runs on the host under systemd, so MONGODB_URI and REDIS_URL say
    # localhost:27017 and localhost:6379. Inside a bridged container `localhost` is the
    # container itself, so those URIs resolve to nothing - the first deploy of this service
    # returned 503 with ServerSelectionTimeoutError and ConnectionError for exactly that reason.
    #
    # Sharing the host's namespace makes those values mean the same thing in both backends,
    # which is what allows one set of connection strings with nothing duplicated and nothing to
    # keep in sync. The alternative - rewriting them to mongodb://mongo:27017 - would mean a
    # second copy of the connection details and a new way for the two to drift apart.
    #
    # There is no `ports:` mapping as a result; compose rejects one under host networking. The
    # loopback restriction is enforced instead by uvicorn binding 127.0.0.1 in the Dockerfile.
    network_mode: host
    environment:
      # EXACTLY THREE SECRETS, NAMED ONE BY ONE. `env_file: ./backend/.env` would have been
      # shorter and would have handed this container all ~90 variables in that file - WhatsApp
      # tokens, Meta credentials, provider keys - none of which it has any use for. These are
      # interpolated from backend/.env at `up` time, so there is still only ONE copy of the JWT
      # signing secret on disk and nothing to rotate twice.
      #
      # `:?` MAKES A MISSING VALUE FAIL THE COMMAND rather than start a broken container.
      # Verified: `--env-file` REPLACES the default .env rather than adding to it, so a bare
      # `docker compose up -d` would otherwise bring this up with an empty Mongo URI and a JWT
      # secret of "" - which accepts no tokens and looks like an auth outage.
      MONGODB_URI: ${MONGODB_URI:?pass --env-file .env --env-file backend/.env}
      REDIS_URL: ${REDIS_URL:?pass --env-file .env --env-file backend/.env}
      JWT_ACCESS_SECRET: ${JWT_ACCESS_SECRET:?pass --env-file .env --env-file backend/.env}
      # Only so `meta.environment` matches Node's health response exactly.
      NODE_ENV: ${NODE_ENV:-production}
      # The readiness probe asks the server for its replica-set name rather than trusting the
      # URI - see app/db.py for why a ping-only check passes here and fails months later.
      EXPECTED_REPLICA_SET: rs0

      # ---- Added in Phase 3, for POST /api/v1/templates/generate ----
      #
      # FOUR MORE, STILL NAMED ONE BY ONE. The rule above has not been relaxed: this container
      # gets the variables it uses and nothing else. It now calls ai-brain-service, so it needs
      # that service's address and key - the same four values Node already reads, interpolated
      # from the same backend/.env, so there is still one copy of each on disk.
      #
      # NO `:?` ON THESE THREE, deliberately, and the difference matters. A missing Mongo URI
      # means a container that cannot do anything, so it should refuse to start. A missing AI
      # brain URL means ONE route answers 409 "the AI brain service is not enabled" while every
      # other route works - which is exactly what Node does when AI_BRAIN_ENABLED is false, and
      # is far better than refusing to serve /settings and /templates because an optional
      # integration is unconfigured.
      AI_BRAIN_ENABLED: ${AI_BRAIN_ENABLED:-false}
      AI_BRAIN_SERVICE_URL: ${AI_BRAIN_SERVICE_URL:-}
      AI_BRAIN_SERVICE_KEY: ${AI_BRAIN_SERVICE_KEY:-}
      AI_BRAIN_REQUEST_TIMEOUT_MS: ${AI_BRAIN_REQUEST_TIMEOUT_MS:-90000}
```

### The Phase 3 environment change, in full

**What is added:** four variables on the `crm-api` service only. Nothing else in
`docker-compose.yml` changes, and no variable is added to `backend/.env` — all four already
exist there and are read by Node today.

| Variable | Secret? | Why crm-api needs it |
|---|---|---|
| `AI_BRAIN_ENABLED` | no | Gate. False means `/templates/generate` answers 409 |
| `AI_BRAIN_SERVICE_URL` | no | The address of ai-brain-service |
| `AI_BRAIN_SERVICE_KEY` | **yes** | Sent as `X-Service-Key`. Never logged, never in an error body, never in a health response — handled exactly like `JWT_ACCESS_SECRET` |
| `AI_BRAIN_REQUEST_TIMEOUT_MS` | no | Shared timeout, default 90000 |

**Why not `env_file: ./backend/.env`:** unchanged from Phase 0. That file holds ~90 variables
including WhatsApp tokens and Meta credentials, none of which this container has any use for.

**Risk:** low. Three of the four have safe defaults, so a mistyped or missing value degrades one
route to 409 rather than breaking the service. The key is the only secret, and it is a
service-to-service key for a process on the same box, not a customer credential.

**Rollback:** remove the four lines and `docker compose up -d crm-api`. `/templates/generate`
then answers 409 until the Caddy block for `/api/v1/templates*` is also removed, at which point
Node serves it again.

## 3. Verify nothing else moved

```bash
cd ~/vistaar && grep -n "ports:" -A 2 docker-compose.yml | diff /tmp/ports.before - ; echo "exit=$?"
```

Expect **no change at all** - `crm-api` uses host networking and declares no `ports:`, so the
existing bindings should be byte-identical. `exit=0` here — `diff` reports that a
difference exists. If anything touching `27017`, `6379`, `5434` or `8091` appears, **stop** and
restore from `$BACKUP`.

## 4. Build and start

**Requires Docker Compose ≥ 2.24.0** for multiple `--env-file`. Check first:

```bash
docker compose version
```

**Both flags, every time, root `.env` first.** Omitting either breaks something: without
`backend/.env` the service refuses to start (by design); without root `.env` the
`ai-brain-service` loses its configuration on next recreate.

```bash
cd ~/vistaar && docker compose --env-file .env --env-file backend/.env build crm-api
```

```bash
cd ~/vistaar && docker compose --env-file .env --env-file backend/.env up -d crm-api
```

## 5. Verify directly, before Caddy sends it anything

```bash
curl -s localhost:5002/api/v1/health
```

Expect exactly:

```json
{"data":{"status":"ok","service":"wam-backend"},"meta":{"environment":"production"}}
```

```bash
curl -s localhost:5002/api/v1/health/readiness | head -c 400; echo
```

Expect `"status":"ready"` and `"replicaSet":{"ok":true,...,"actual":"rs0"}`.

**If `replicaSet.ok` is false, stop.** It means `MONGODB_URI` lacks `replicaSet=rs0`, and the
readiness endpoint will be returning 503. Nothing is broken — the Node backend is untouched and
Caddy is still sending everything to it — but this must be fixed before any module that needs a
transaction is migrated. That is the whole reason the probe checks topology instead of pinging.

## 6. Only then, Caddy

Add **above** the existing `/api/v1/*` handler. Longest-prefix-first means only health moves.

```
handle /api/v1/health* {
    reverse_proxy localhost:5002
}
```

`handle`, not `handle_path`: it forwards the matched prefix **unchanged**, which is why the
FastAPI routes are spelled `/api/v1/health` rather than `/health`.

```bash
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

Then compare the public endpoint against what Node used to return:

```bash
curl -s https://vistaarcrm.duckdns.org/api/v1/health
```

## Rollback — three independent levels

| Level | Action | Effect |
|---|---|---|
| Caddy | remove the `handle` block, reload | health returns to Node instantly |
| Container | `docker compose stop crm-api` | Node unaffected |
| Compose file | `cp "$BACKUP" docker-compose.yml` | file restored byte-for-byte |

`backend/` is never modified by any of this, so the Node backend cannot be affected by a
rollback at any level.

---

## 7. Full Cutover: Phases 0–11 (FastAPI owns all CRM business logic)

Once all phases are verified locally, the entire `/api/v1/*` API surface can be directed to FastAPI on `:5002`.

### MongoDB Unique Index Setup
Before starting the daily scheduler in Python or Node, ensure the compound index exists:
```javascript
// Run in mongosh or MongoDB client:
use wam-crm;
db.dailyjobruns.createIndex(
  { organizationId: 1, job: 1, dateKey: 1 },
  { unique: true, name: "uniq_daily_job_run" }
);
```

### Full Production Environment Variables for `crm-api` in `docker-compose.yml`
```yaml
  crm-api:
    build:
      context: ./crm-api
    container_name: wam-crm-ai-crm-api
    depends_on:
      mongo:
        condition: service_healthy
      redis:
        condition: service_healthy
    network_mode: host
    environment:
      # Core
      MONGODB_URI: ${MONGODB_URI:?pass --env-file .env --env-file backend/.env}
      REDIS_URL: ${REDIS_URL:?pass --env-file .env --env-file backend/.env}
      JWT_ACCESS_SECRET: ${JWT_ACCESS_SECRET:?pass --env-file .env --env-file backend/.env}
      NODE_ENV: ${NODE_ENV:-production}
      EXPECTED_REPLICA_SET: rs0

      # AI Brain & LLM
      AI_BRAIN_ENABLED: ${AI_BRAIN_ENABLED:-false}
      AI_BRAIN_SERVICE_URL: ${AI_BRAIN_SERVICE_URL:-}
      AI_BRAIN_SERVICE_KEY: ${AI_BRAIN_SERVICE_KEY:-}
      AI_BRAIN_REQUEST_TIMEOUT_MS: ${AI_BRAIN_REQUEST_TIMEOUT_MS:-90000}

      # Timezone & Security
      WHATSAPP_BUSINESS_TIMEZONE: ${WHATSAPP_BUSINESS_TIMEZONE:-Asia/Kolkata}
      BCRYPT_ROUNDS: ${BCRYPT_ROUNDS:-12}
      AUTH_COOKIE_CROSS_SITE: ${AUTH_COOKIE_CROSS_SITE:-false}

      # Push & Deep Links
      PUSH_ENABLED: ${PUSH_ENABLED:-false}
      FIREBASE_PROJECT_ID: ${FIREBASE_PROJECT_ID:-}
      FIREBASE_CLIENT_EMAIL: ${FIREBASE_CLIENT_EMAIL:-}
      FIREBASE_PRIVATE_KEY: ${FIREBASE_PRIVATE_KEY:-}
      FRONTEND_ORIGIN: ${FRONTEND_ORIGIN:-}

      # Media Storage
      MEDIA_STORAGE_DIR: ${MEDIA_STORAGE_DIR:-var/media}
      MEDIA_INBOUND_DOWNLOAD_ENABLED: ${MEDIA_INBOUND_DOWNLOAD_ENABLED:-true}

      # Meta Lead Ads Integration
      META_LEAD_ADS_ENABLED: ${META_LEAD_ADS_ENABLED:-false}
      META_APP_ID: ${META_APP_ID:-}
      META_APP_SECRET: ${META_APP_SECRET:-}
      META_REDIRECT_URI: ${META_REDIRECT_URI:-}
      META_WEBHOOK_VERIFY_TOKEN: ${META_WEBHOOK_VERIFY_TOKEN:-}

      # Background Runners & WhatsApp Flags
      WHATSAPP_ENABLED: ${WHATSAPP_ENABLED:-true}
      WHATSAPP_OUTBOUND_DELIVERY_ENABLED: ${WHATSAPP_OUTBOUND_DELIVERY_ENABLED:-true}
      LEAD_IMPORT_ENABLED: ${LEAD_IMPORT_ENABLED:-true}
      NURTURE_ENABLED: ${NURTURE_ENABLED:-true}
      DAILY_JOBS_ENABLED: ${DAILY_JOBS_ENABLED:-true}
      EVENT_REMINDERS_ENABLED: ${EVENT_REMINDERS_ENABLED:-true}
      OWNER_CALL_ESCALATION_ENABLED: ${OWNER_CALL_ESCALATION_ENABLED:-true}
```

### Full Caddy Configuration
In `/etc/caddy/Caddyfile`:

```
# Realtime SSE requires disabling proxy buffering so events stream immediately
handle /api/v1/realtime* {
    reverse_proxy localhost:5002 {
        header_up X-Accel-Buffering "no"
        flush_interval -1
    }
}

# All other API routes routed to FastAPI
handle /api/v1/* {
    reverse_proxy localhost:5002
}

# Frontend SPA remains unchanged
handle {
    root * /var/www/vistaar/dist
    try_files {path} /index.html
    file_server
}
```

Validate and reload Caddy:
```bash
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

