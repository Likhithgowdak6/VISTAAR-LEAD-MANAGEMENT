# WhatsApp Cloud API

The CRM can connect a WhatsApp number in two ways, chosen **per number** when you add it:

| | Link by QR (Baileys) | Official Cloud API |
|---|---|---|
| Setup | Scan a QR from your phone | Paste three values from Meta |
| Transport | Unofficial linked-device connection | Official Meta API; current Meta pricing applies |
| Account restrictions | Subject to WhatsApp restrictions | Subject to Meta policies and quality limits |
| Connection | Linked device session | Server API credentials |
| Messaging a lead who has not written first | Any message | **Approved template only** |
| Replying within 24h of their last message | Any message | Any message |

Both can run side by side. Existing numbers are unaffected and stay on Baileys.

---

## The 24-hour rule

This is the one thing that changes how the inbox works day to day, so it is worth
understanding before you switch a number over.

Meta allows free-form messages only within **24 hours of the customer's last message to you**.
That period is called the *customer service window*. Outside it, WhatsApp accepts **only a
pre-approved template** and rejects everything else.

It matters here because leads from Meta Lead Ads **have not messaged you** — they filled in a
form. The window was never open, so the first message to a new lead must be a template.

The CRM handles this honestly rather than quietly:

- the composer shows how long is left, and says plainly when only a template will send;
- it refuses a free-form send that WhatsApp would reject, instead of letting it bounce;
- it **never** silently substitutes a template for what you typed — the customer would receive
  words nobody chose.

---

## One-time Meta setup

You need a Meta app with the WhatsApp product. If you already use Meta Lead Ads in this CRM, you
can use the same app.

### 1. Get your three values

Meta dashboard → your app → **WhatsApp → API Setup**:

- **Phone number ID** — the long number under your phone number (not the phone number itself)
- **WhatsApp Business Account ID** — on the same screen
- **Access token** — see the warning below

> **Use a permanent System User token.** The token shown on the API Setup screen expires in 24
> hours, and when it does, messages stop with no warning. Create one under
> **Business Settings → System Users → Generate token**, with the `whatsapp_business_messaging`
> and `whatsapp_business_management` permissions.

### 2. Point Meta's webhook at this server

Meta dashboard → your app → **WhatsApp → Configuration → Webhook**:

- **Callback URL**: `https://<your-domain>/api/v1/whatsapp/cloud/webhook`
- **Verify token**: whatever you set as `WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN` below

Then **subscribe to the `messages` field**. Without that subscription Meta accepts the webhook
and delivers nothing, which is the single most common reason a correctly configured number
receives no messages.

> This is a **separate** callback URL from the Lead Ads webhook (`/api/v1/meta/webhook`). Meta
> stores one per product. Keeping them apart means rotating the WhatsApp verify token cannot stop
> leads arriving.

### 3. Server environment

```
WHATSAPP_CLOUD_ENABLED=true
WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN=<any long random string you also type into Meta>
```

`WHATSAPP_CLOUD_APP_SECRET` is optional. The webhook signature is verified against
`META_APP_SECRET` by default, which is correct when one Meta app serves both products. Set it
only if WhatsApp lives in a different app than your lead forms.

> **The webhook fails closed.** With no app secret configured, every delivery is refused rather
> than accepted. That is deliberate: this endpoint is public and writes into customer inboxes.

Restart the backend after changing these.

---

## Connecting a number

1. **Accounts → Add a WhatsApp number**, pick **Official WhatsApp API**
2. Press **Connect** on the new row
3. Paste the phone number ID, WABA ID and access token

The server checks the credentials against Meta before saving anything, and shows you the
**verified name** that came back. Read it. The most likely mistake is not a bad token — that
fails loudly — but the right token with the **wrong phone number ID**, which connects cleanly and
then sends from somebody else's number.

Connection also verifies that the number belongs to the supplied WABA, then calls
`POST /<WABA-ID>/subscribed_apps` to subscribe the token's app to that business account.
If either step fails, credentials are not saved as connected. The token must belong to the
same Meta app whose webhook and app secret are configured on this installation.

The token is encrypted at rest and never shown again; only its last four characters are
displayed. There is no endpoint that reads it back. To rotate it, paste a new one.

---

## Templates

Templates are created and approved **in the Meta dashboard**, not here. The CRM caches them so
agents can pick one without waiting on Meta.

- **Accounts → Sync templates** pulls the current list
- The composer's picker offers only **approved, supported text** templates
- The Accounts page shows all of them, including rejected ones — that is where to look when a
  template is missing from the picker

Approval usually takes minutes to hours. After a template is approved, press **Sync templates**;
nothing polls Meta on a schedule, because templates change rarely and the one moment it matters
is when somebody is sitting at the screen waiting.

### Sending one

In a thread on a Cloud number, the composer offers **Choose a template** whenever the window is
closed. Fill in the blanks, read the preview, send.

The wording cannot be edited. Meta holds the approved text and performs the substitution; what
travels is the template's name and your values. The preview is the only chance to catch a wrong
value, which is why it updates as you type.

Supported templates contain a text body, optional text header and optional footer, with
numbered parameters such as `{{1}}`. Media headers, buttons, named parameters and other
component formats are excluded from the picker and rejected again by the send API. They
remain visible in the administrator's synced template list. Selecting another sending
number loads that number's templates and resets the previous number's service window.

---

## Delivery receipts

Cloud numbers report back when a message is **delivered** and **read**.
Receipts arrive out of order, so a message only ever moves forward — a late "delivered" cannot
overwrite "read".

A **failed** receipt records why. `window_closed` means the 24-hour window shut while the message
was queued, usually because quiet hours held it. Send a template instead.

## Webhook durability and server routing

The public Cloud webhook must reach **Node on port 5001**, before the generic Python API
route on port 5002. `deploy/Caddyfile` includes this ordered handler:

```caddy
handle /api/v1/whatsapp/cloud/* {
    reverse_proxy 127.0.0.1:5001
}
```

Merge that handler into the existing production Caddy site before its generic `/api/v1/*`
handler, retaining other live site settings. Frontend files are served from `/srv/vistaar`.
Development Vite needs the matching `/api/v1/whatsapp/cloud` proxy to port 5001; the local
`frontend/vite.config.ts` edit is excluded from commits by this project's workflow.

Signed events are encrypted using the existing encryption key and persisted with a majority
write before HTTP 200. Database failures return an error so Meta can redeliver. The Node
inbox runner claims events with a renewable lease and retries failed processing after a
restart. Processing remains idempotent on inbound provider message IDs. Pending events have
no expiry; completed payloads are cleared and their deduplication records expire after seven
days. Keep the Node service running with `WHATSAPP_CLOUD_ENABLED=true`, preserve its encryption
key, and monitor the `whatsappcloudwebhookinbox` collection for growing pending/processing
backlogs and repeated retry warnings. MongoDB must permit creation of the inbox indexes.

## Release acceptance

Local tests use mocked Meta calls and do not prove external delivery. Before enabling a real
number, configure the production webhook/app secret and run a controlled test with your own
recipient: inbound message, freeform reply inside the window, approved template outside it,
delivery/read receipts, and a restricted member account. Confirm queued webhooks resume after
a Node restart. Do not enable unrelated business sweeps while the Python worker owns them.

This is manual administrator onboarding. Embedded Signup, Meta App Review/advanced access
and business verification for onboarding other businesses are separate platform requirements;
they are not implemented or granted by this code change.

References: [Meta WABA subscriptions](https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/subscribed_apps/),
[Meta WABA phone numbers](https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/).

---

## Troubleshooting

**Messages are not arriving.**
Check the `messages` field is subscribed in the Meta webhook configuration — subscribing the
webhook and subscribing the field are two separate steps. Then check the server log for
`WhatsApp Cloud webhook named a phone number id no account owns`, which means the number is
connected in Meta but not finished here.

**Every delivery is refused with 403.**
No app secret is configured. Set `META_APP_SECRET` (or `WHATSAPP_CLOUD_APP_SECRET`) and restart.

**Sends fail with "the 24-hour window has closed".**
Working as intended. Send an approved template.

**Sends fail with "the token expired or was revoked".**
You are probably using the temporary 24-hour token. Replace it with a permanent System User
token.

**A number shows a quality warning.**
Meta rates each number GREEN / YELLOW / RED based on how people respond to your messages. RED is
the warning before Meta limits how many people you can message per day. Slow down and check what
is being sent.
