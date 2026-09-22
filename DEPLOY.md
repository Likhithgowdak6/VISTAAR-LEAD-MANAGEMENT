# Deploying, and building the Android app

Two separate things, in this order. The app is a shell around the dashboard — it does **not**
contain the backend, so the server has to exist first.

---

## Part 1 — the server

### What has to run

| Service | Why it can't be skipped |
|---|---|
| backend (Node) | Holds the WhatsApp socket open, serves the API |
| ai-brain-service (Python) | Every AI reply, summary, template and assistant answer |
| MongoDB | All leads, conversations, contacts, the WhatsApp session |
| Redis | Realtime dashboard updates, outbound queue |
| Postgres | LangGraph checkpoints for ai-brain |

A VPS with **2 vCPU / 4 GB RAM** is comfortable. 2 GB works but leaves nothing spare.

### Steps

**1. A domain with HTTPS.** Point `crm.yourdomain.com` at the server. Get a certificate — Caddy
does this automatically and is the least work:

```
crm.yourdomain.com {
    reverse_proxy /api/* localhost:5001
    root * /srv/vistaar/frontend
    file_server
    try_files {path} /index.html
}
```

HTTPS is not optional. The mobile app's refresh cookie is `Secure`, and browsers discard `Secure`
cookies sent over plain HTTP — you'd get a login that works once and then throws you out.

**2. Clone and configure.** Copy `backend/.env`, then change:

```
NODE_ENV=production
FRONTEND_ORIGIN=https://crm.yourdomain.com,https://localhost
AUTH_COOKIE_CROSS_SITE=true
WHATSAPP_TEST_ALLOWED_NUMBERS=
OWNER_CALL_ESCALATION_DELAY_SECONDS=600
```

`https://localhost` is the Android WebView's origin — without it the app gets a CORS failure on
every request. `AUTH_COOKIE_CROSS_SITE=true` makes the refresh cookie `SameSite=None`, without
which the app is logged out on first refresh.

Generate fresh secrets. Do not reuse the ones from your laptop.

**3. Start it:**

```bash
docker compose up -d
cd backend && npm ci && npm run build && npm run start
```

Put the backend under a process manager (`pm2` or a systemd unit) so it restarts on crash and on
reboot. This is the difference between a server and a laptop.

**4. Re-pair WhatsApp.** The session is tied to the machine. Go to Accounts and scan the QR from
the phone that owns the number.

**5. Back up Mongo.** Nightly, off the box:

```bash
0 3 * * * docker exec wam-crm-ai-mongo mongodump --archive=/tmp/d.gz --gzip && docker cp wam-crm-ai-mongo:/tmp/d.gz /backups/$(date +\%F).gz
```

Everything — leads, conversations, contacts, the WhatsApp session — is in that one database.

### Before you point real traffic at it

- `WHATSAPP_TEST_ALLOWED_NUMBERS` **empty**, or every message from any other number is silently
  dropped before it reaches the dashboard.
- Remove the `dev-tools` module. It exposes a one-click wipe of all your data.
- Change the admin password from the test one.

---

## Part 2 — the Android app

### One-time setup

Install Android Studio (for the SDK and a signing key), then:

```bash
cd frontend
npm install @capacitor/core @capacitor/cli @capacitor/android
npx cap add android
```

`capacitor.config.ts` is already in the repo — appId `com.vistaarverse.leadmanagement`,
`androidScheme: 'https'`.

### Every build

```bash
cd frontend
VITE_API_BASE_URL=https://crm.yourdomain.com/api/v1 npm run build
npx cap sync android
npx cap open android
```

Then **Build → Generate Signed Bundle / APK** in Android Studio.

`VITE_API_BASE_URL` is baked in at build time. Get it wrong and the app points at
`http://localhost:5001` — which on a phone means the phone itself, so nothing loads and the error
looks like the server being down.

**Keep the signing keystore safe and backed up.** Lose it and you cannot ship an update to an
already-installed app; users have to uninstall and reinstall.

### What you get

The same dashboard, full screen, with its own icon. The responsive work is already done — the inbox
is a drill-down on a phone, the nav scrolls, the lead panel is full width.

### What it deliberately does not do

- **No push notifications.** Alerts still arrive on WhatsApp, which is where you already look.
  Push needs Firebase and a server-side sender.
- **No offline mode.** It's a live view of your pipeline; stale leads would be worse than none.
- **Updates need a rebuild.** Changing the dashboard means a new APK. (The PWA route avoids this,
  if that ever matters more than having a real installable file.)

---

## When something is wrong

| Symptom | Cause |
|---|---|
| Login works, then immediately signed out | `AUTH_COOKIE_CROSS_SITE` not `true`, or the API isn't on HTTPS |
| Every request fails in the app, fine in a browser | `https://localhost` missing from `FRONTEND_ORIGIN` |
| App loads, nothing ever appears | `VITE_API_BASE_URL` wrong or still localhost |
| Dashboard fine, no WhatsApp messages | Session not re-paired after the move, or the test allowlist is still set |
| Leads stop importing from Meta | Page token revoked, or the watermark is ahead of the leads |
