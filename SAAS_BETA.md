# Free SaaS beta (Baileys)

This release adds self-service organizations to the existing CRM. It keeps the current UI and
Baileys provider. It does not charge customers or integrate a payment processor.

## Included

- Create a workspace and its owner, then sign in with Google or email and password.
- Atomic organization, user, session and audit creation; duplicate workspace addresses are rejected.
- Existing team permissions, shared inbox, AI knowledge and Baileys QR/pairing flows.
- Settings > Workspace: business details, onboarding checklist and usage.
- A tenant-owned company knowledge card carries the business identity into both AI code paths;
  changing workspace details updates this card. Shared prompts no longer assume the original studio name.
- Five active human team members (including the owner) and one non-removed WhatsApp account.
- Disabled users and the internal AI assistant do not consume seats. Re-enabling a user checks capacity.
- Resource admission shares an organization revision write inside a Mongo transaction across Python
  and Node, preventing simultaneous creates from exceeding the workspace cap.
- Legacy organizations retain their existing limits and data. No migration changes their plan.
- Signup can be closed or protected by an invitation code. A Redis-backed signup limiter fails closed.

## Service routing (required)

Python `crm-api` on 5002 serves authentication, signup, workspace and CRM routes.
Python sends owner alerts through a service-authenticated internal Node gateway. This gateway
checks account ownership and resolves the recipient from that organization's settings. It never
accepts an arbitrary phone number. Keep `/internal/*` private and out of public ingress.

Node `backend` on 5001 owns **all** `/api/v1/whatsapp-accounts*` routes, QR codes, Baileys sockets,
inbound ingestion and actual outbound delivery. The Python session manager is not a Baileys provider.

Use [deploy/Caddyfile](deploy/Caddyfile) in production. The Vite development proxy has the same split.
An older ingress pointing every API request at Node will not expose signup or workspace settings.

## Local setup

Requires Node, Python, Docker, and the existing backend/root environment files. Keep the same JWT,
encryption and contact lookup keys across services. Never regenerate the lookup key on an existing install.

```powershell
# From the project root. Compose does NOT automatically load backend/.env.
docker compose --env-file .env --env-file backend/.env up -d

# Separate terminal: Baileys gateway. Disable duplicate business sweeps here.
cd backend
$env:WHATSAPP_GATEWAY_ONLY='true'
npm ci
npm run dev

# Separate terminal: dashboard
cd frontend
npm ci
npm run dev
```

Set WHATSAPP_GATEWAY_ONLY=true on the production Node supervisor too. This disables its business
sweeps while retaining realtime, Baileys sessions, inbound AI handling and outbound delivery.
Keep WhatsApp connection and outbound delivery enabled on Node when testing real sends. Python's
worker owns the business sweeps; API workers have ENABLE_BACKGROUND_RUNNERS=false. Do not run a
second independent scheduler for the same business jobs. Follow the existing migration guide's
runner ownership settings when upgrading an established deployment.

For a local Python API instead of the Compose API, install crm-api/requirements-dev.txt into a
virtual environment and run `python -m uvicorn app.main:app --host 127.0.0.1 --port 5002` there.
The background worker is a separate `python -m app.worker` process.

New settings in backend/.env (passed to Python by Compose):

```dotenv
SAAS_SIGNUP_ENABLED=true
SAAS_SIGNUP_INVITE_CODE=
# Optional dedicated internal key; defaults to AI_BRAIN_SERVICE_KEY when empty.
WHATSAPP_GATEWAY_SERVICE_KEY=
WHATSAPP_GATEWAY_URL=http://127.0.0.1:5001
```

For an invitation-only beta, put a private code in SAAS_SIGNUP_INVITE_CODE. Do not put that code
or service keys in any VITE_ variable. Set SAAS_SIGNUP_ENABLED=false to close registration without
affecting existing logins. The signup form follows these settings automatically.

Visit the existing sign-in page, choose **Create a workspace**, and enter your business, owner,
email and password. Then follow the Settings checklist and connect a WhatsApp
number from Team & Accounts using Baileys. No seed script is required for new organizations.

## Deployment

1. Back up MongoDB and encryption keys. Keep the lookup key unchanged.
2. Set NODE_ENV=production in the environment used by both backends and Compose.
3. Configure FRONTEND_ORIGIN and HTTPS. Use VITE_API_BASE_URL=/api/v1 for the web build,
   then build frontend and backend. Android builds need the full deployed HTTPS API address
   instead; follow DEPLOY.md for the mobile build.
4. Copy frontend/dist to /srv/vistaar/. Set CRM_DOMAIN for Caddy and use deploy/Caddyfile.
5. Run Node under a supervisor; run Compose CRM API/worker and the AI service.
6. MongoDB and Redis must remain private. Compose now publishes infrastructure only on loopback;
   enforce a host firewall too. Allow public ingress only through HTTPS. Keep 5001 and 5002 private.
7. Configure a nonempty AI_BRAIN_SERVICE_KEY on both sides before enabling AI. An unset key now
   returns 503 rather than granting unauthenticated access.
8. Confirm /api/v1/health/readiness, signup, login/refresh, independent workspaces, Baileys pairing,
   approved delivery and recovery after restarting the gateway.

Index creation is additive and fails startup if existing duplicate organization slugs or per-org
emails violate uniqueness. Fix those records deliberately before retrying; this code never deletes them.
Existing Postgres credentials are retained for compatibility; rotate them separately before a public rollout.

Business profile timezone is currently informational. Existing automation scheduling still follows
WHATSAPP_BUSINESS_TIMEZONE for this deployment. Do not promise per-workspace scheduling zones yet.

## Verification

```powershell
cd crm-api
.\venv\Scripts\python.exe -m pytest -q
# Includes tests/test_saas.py: signup, sessions, tenant isolation, quotas and owner destinations.

cd ../backend
npm test
npm run typecheck
npm run build

cd ../frontend
npm test
npm run build
```

Signup, quota and gateway unit tests use isolated Mongo/Redis/HTTP doubles.
The backend typecheck, lint and build are checked. The frontend still has pre-existing lint
findings in unrelated components; the SaaS components are checked separately. Real replica-set concurrent admission,
real Baileys pairing/delivery, restart recovery and backup restoration must also be exercised on your
staging infrastructure before inviting outside customers. No live customer messages are sent by tests.

Email verification for password-only accounts, password recovery email, subscription billing, a platform support console and
self-service data export/deletion are not part of this free beta. Use invitation-only onboarding
until recovery and support procedures are established.

Google sign-in setup and the authorized-origin requirement are documented in [GOOGLE_SIGN_IN.md](GOOGLE_SIGN_IN.md).
