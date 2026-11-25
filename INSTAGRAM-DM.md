# Instagram DM automation

Brings Instagram DMs into the existing inbox, lets staff reply from there, and optionally answers
with a welcome or keyword reply. Per workspace, **automation off by default**.

---

## Which Meta API, and why

Two paths exist. This uses the **Facebook Login path** (Messenger Platform's Instagram Messaging),
not Instagram Login on `graph.instagram.com`.

The reason is reuse: this repo already holds a long-lived Facebook **user** token per workspace in
`MetaConnection` for Lead Ads, and already mints Page tokens from it. On the Facebook Login path,
connecting Instagram needs **no second authorisation and no second Meta app** — the admin picks a
Page they already authorised. On the Instagram Login path it would be a separate login, separate
permissions and a separate credential to mislay.

Verified against Meta's current docs (November 2026):

| | |
|---|---|
| Permissions | `instagram_basic`, `instagram_manage_messages`, `pages_manage_metadata` (the dashboard also adds `pages_show_list`, `pages_read_engagement`) |
| Webhook | The **`instagram`** topic, subscribed on the Page |
| Send | `POST /{version}/{PAGE_ID}/messages`, body `{recipient:{id:IGSID}, message:{text}}` |
| Tasks on the Page | **MODERATE** to set up, **MESSAGE** to send |
| Window | **24 hours** from the customer's last message; `HUMAN_AGENT` extends it to **7 days** |
| Text limit | **1,000 bytes**, UTF-8 |
| Access | Standard Access reaches only app Admins/Developers/Testers. Advanced Access needs App Review for `instagram_manage_messages` |

Graph version is pinned to **v27.0** in `instagram.client.ts`, separately from the Lead Ads
importer's v25.0 — bumping the shared constant to ship Instagram would change how every existing
lead is fetched as a side effect.

---

## The channel field, and every conversation written before it

`Conversation.channel` and `Message.channel` are new, and **absent on every row that predates
them** — which is almost all of them.

The rule, enforced in one place per service:

- **Node** — `channelOf()` in `constants/channels.ts`. Absent, null, or anything unrecognised
  reads as `whatsapp`. Reading `conversation.channel` directly gives `undefined` for most of the
  database, so nothing does.
- **Python** — `conversation_serializer` resolves it before it leaves the server, so the dashboard
  never decides what absent means.
- **React** — `ChannelBadge` renders nothing for WhatsApp *or* for undefined.

`WHATSAPP_CHANNEL_FILTER` (`{channel: {$in: ['whatsapp', null]}}`) exists for any query that newly
needs to exclude Instagram. `{channel: 'whatsapp'}` alone matches none of the historical data —
the symptom would be an empty inbox on a working database.

**Required fields were made conditional, not optional.** `whatsappAccountId` is still required
when the channel is not `instagram`, on both Conversation and Message. Relaxing it outright would
have let a WhatsApp thread be written without an account — the invariant every existing query
depends on — to make room for a channel that does not use the field.

On Message, `whatsappAccountId` is left **null** rather than removed, because the unique index
`(organizationId, whatsappAccountId, providerMessageId)` is what stops a redelivered webhook
writing a message twice. With every Instagram message sharing a null there, that index still reads
as *one message per provider id per workspace*.

---

## How a DM reaches the right inbox

1. Meta POSTs to `/api/v1/instagram/webhook`. The signature is verified against
   `INSTAGRAM_APP_SECRET` (falling back to `META_APP_SECRET`), **failing closed** if neither is
   set.
2. The raw body is written to an encrypted durable inbox, keyed on `sha256(rawBody)`, and *then*
   acknowledged. Meta gets its 200 fast; processing survives a restart.
3. `entry[].id` — the Instagram account the DM was sent to — resolves to one workspace through a
   **globally unique index** on `InstagramAccount.instagramAccountId`. A delivery for an account
   nobody has connected is **dropped**, not filed against a default tenant.
4. The sender's IGSID becomes a contact keyed `ig:<IGSID>`, the thread becomes a Conversation with
   `channel: 'instagram'`, and the message is inserted.

### Duplicate deliveries

Two layers, because neither alone is enough:

- The inbox collides on the **body hash**, so a byte-identical retry is dropped.
- The messages collection collides on the **Meta message id**, which catches a retry whose
  envelope timestamp differs — which Meta does send.

A collision returns `isNew: false`, and **that is what stops a second automatic reply**.

---

## Automation

Four gates, every one of which must pass before a character reaches a customer:

1. `account.automationEnabled` — **off by default**, per account.
2. `conversation.aiAutomationEnabled` — the **per-thread takeover**. This is the same flag WhatsApp
   uses, so a handover means one thing across the CRM.
3. A reply must actually be configured. An empty welcome is not a blank message.
4. The 24-hour window must be open — checked even though a reply to an inbound message normally is,
   because a retry of an old delivery is not.

A **keyword beats the welcome**: somebody whose first message is "what is the price?" wants the
price, and the welcome has no second chance to be useful.

Keyword matching is **case-insensitive substring, first match wins** — so the order in the settings
list is the priority, which an admin can see and reorder. The honest limit: "what do you charge?"
contains neither `price` nor `availab` and gets the welcome. Add synonyms rather than expecting
fuzzy matching, which would start answering the wrong questions confidently.

**The reply is written before it is sent.** It carries a derived idempotency key, so a duplicated
webhook collides and the send is skipped. Sending first would mean a retry sends again and only
then discovers it was a duplicate — and a second "thanks for getting in touch" is the most visible
possible bug on this feature.

**`HUMAN_AGENT` is never used by automation.** The tag declares to Meta that a person is replying;
using it for a bot is a false statement about who is on the other end, with the account's messaging
access as the penalty. Staff replies may use it; automatic ones do not.

### Takeover

**Take over / Resume** sits in the thread header on Instagram conversations, for anyone with
`messages.send` — whoever may answer a customer may stop the automation answering over them. It
writes `aiAutomationEnabled` and `aiAutomationPausedReason: 'human_takeover'`.

It is hidden on WhatsApp threads (which have their own, older handover wiring) and hidden entirely
when the workspace has automatic replies switched off — a button that cannot do anything is a lie
about what the system does.

**The automation re-checks the flag immediately before it sends**, not only before it composes.
Between composing a reply and the Graph call there is a real window — one HTTPS round trip, or a
retry's worth after a restart — in which staff can press Take over. Without the second check, a
human who grabs a thread still watches the bot answer over them, which is precisely what the
control exists to prevent. The queued reply is marked `failed_permanent` with
`lastDeliveryError: 'HUMAN_TAKEOVER'` so the thread shows what happened rather than losing it.

The same step claims the message atomically (`queued` → `sending`), which also stops two
concurrent drains sending one reply twice. The idempotency key stops a second *row*; it does not
stop a second *send* of one row.

## Replying by hand

Staff reply through the ordinary composer. The send endpoint
(`POST /api/v1/conversations/:id/messages`, in Python) branches on the conversation's channel:

- **Absent channel means WhatsApp**, so the branch is an equality test against `instagram` and
  never a test for "not whatsapp". Every conversation written before the field existed takes the
  WhatsApp path unchanged.
- An Instagram reply is sent **synchronously**, unlike WhatsApp's queue-and-drain. WhatsApp queues
  because a Baileys socket may be down and a template may need approval; Instagram is one HTTPS
  call that either works or does not, and a reply an agent is watching should go or say why.
- The message row is **written before the send**, so a failure shows in the thread as a failed
  message rather than vanishing.

The Instagram Page token lives in Node, so Python asks Node to spend it over
`/internal/v1/instagram/send` — the same internal bridge and service key owner notifications
already use. Two services holding one secret is how a key rotation becomes an outage.

**The 7-day window is enforced in both services.** Python checks it so the composer can refuse
before anybody types; Node checks it because that endpoint is reachable by anything holding the
service key, and a window enforced only by its caller is not enforced. Seven days rather than
twenty-four hours because this path is only ever a person replying, which is exactly what the
`HUMAN_AGENT` tag is for.

Attachments are refused explicitly this release rather than silently dropped.

## Meta dashboard setup

1. **The Instagram account must be professional and connected to a Facebook Page.** If it is not,
   nothing below works and Meta's error does not say why.
2. **In the Instagram app:** Settings → *Messages and story replies* → *Message controls* →
   *Connected Tools* → **Allow Access to Messages** → on.
   This is the single most-missed step. Without it, sends fail with a permission error that names
   nothing.
3. **In the Meta App Dashboard:** add the Instagram use case to the app that already holds your
   Lead Ads integration. Confirm `instagram_basic`, `instagram_manage_messages` and
   `pages_manage_metadata` are requested.
4. **Webhooks** → subscribe the **`instagram`** topic for the Page, with:
   - Callback URL `https://<your-domain>/api/v1/instagram/webhook`
   - Verify token = whatever you set as `INSTAGRAM_WEBHOOK_VERIFY_TOKEN`
   - Fields: at minimum `messages`
5. **The authorising user needs the MODERATE task** on the Page to set this up, and **MESSAGE** for
   sends to work.
6. **App Review** for `instagram_manage_messages` before you can message anyone who is not an app
   Admin, Developer or Tester. In development mode, test with those accounts only.

### In Vistaar

**Settings → Instagram** (requires `settings.manage`):

1. If Facebook is not connected yet, connect it under **Lead Sources** first — Instagram reuses
   that authorisation.
2. Pick the Instagram account from the list. A Page with no Instagram account attached is shown
   greyed rather than hidden, so "my Page isn't in the list" is answerable.
3. Write a welcome and/or keyword replies.
4. **Only then** switch automation on.

---

## Deployment

**Node and the frontend change; Python changes only its conversation serializer.** Mongo gains two
collections (`instagramaccounts`, `instagramwebhookinbox`) which Mongoose creates on first write.

```bash
# 1. Two new environment variables, both defaulting to empty so an installation that has not
#    connected Instagram boots unchanged.
cd ~/vistaar && grep -E "INSTAGRAM_(APP_SECRET|WEBHOOK_VERIFY_TOKEN)" backend/.env || echo "NOT SET — add them before enabling the webhook"
```

```bash
# 2. Caddy needs the new route BEFORE the webhook will reach Node at all
sudo grep -A 2 "api/v1/instagram" /etc/caddy/Caddyfile
```

⚠️ **This route is load-bearing.** `handle /api/*` sends everything else to Python on 5002, so
without `handle /api/v1/instagram/* { reverse_proxy 127.0.0.1:5001 }` every DM is lost behind a
404 nobody is watching for. Copy the block from `deploy/Caddyfile`, then:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

```bash
# 3. Build and restart Node
cd ~/vistaar/backend && npm ci && npm run build && sudo systemctl restart vistaar
```

```bash
# 4. Recreate the Python services for the serializer change
cd ~/vistaar && docker compose --env-file .env --env-file backend/.env up -d --no-deps --build crm-api crm-worker
```

```bash
# 5. Frontend, assets before index.html as in PAYMENT-RELEASE.md
cd ~/vistaar/frontend && VITE_API_BASE_URL=/api/v1 npm run build
```

```bash
# 6. Confirm the webhook is reachable and refuses an unsigned POST
curl -s -o /dev/null -w "verify handshake: %{http_code}\n" "https://<your-domain>/api/v1/instagram/webhook?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=1"
```

Expect **403**. A 404 means Caddy is still routing to Python. A 200 means the verify token is
empty, which would let anyone subscribe their own account.

---

## What passed, and what needs live Meta testing

**Verified with mocks, no network:** 67 Node tests plus 9 Python and 5 React.

- Channel compatibility: absent / null / unknown all read as WhatsApp, on all three services
- Signature verification: valid, wrong secret, tampered body, missing header, **fails closed**
  with no secret, `META_APP_SECRET` fallback, Instagram secret preferred
- Parsing: echoes marked, no-message-id events skipped, entry-id fallback, one malformed event in
  a batch not costing the others, multiple entries
- Automation: keyword matching and its limits, blank keyword not matching everything, welcome only
  on a first message, nothing configured sending nothing
- Send client: 1,000-byte limit measured in **bytes**, `HUMAN_AGENT` only when asked, token in a
  header not the URL, and the full error taxonomy (revoked token, permission, unreachable
  recipient, rate limit, 5xx)
- **WhatsApp compatibility: 1,135 existing conversation / message / whatsapp tests still pass**

**Requires live Meta testing and is not claimed here:**

- That Meta accepts the webhook subscription against a real Page
- That a real DM arrives, routes to the right workspace and appears in the inbox
- That a reply actually sends — which needs App Review or an app-role test account
- Whether a revoked token returns the code the taxonomy expects
- Rate limits under volume, and whether 24-hour window refusals really report 551

Nothing in this feature has been exercised against Meta. Treat it as implemented and unproven.

---

## A live Meta test, step by step

Everything below needs a real Meta app. Nothing in this repo has touched Meta.

1. **Put the app in Development mode** and add yourself as a Tester. In Development mode you can
   only message app Admins, Developers and Testers — which is exactly what you want for a first
   test, and is why you do not need App Review yet.
2. **Subscribe the webhook.** Meta App Dashboard → Webhooks → Instagram → Callback URL
   `https://vistaarcrm.duckdns.org/api/v1/instagram/webhook`, verify token =
   `INSTAGRAM_WEBHOOK_VERIFY_TOKEN`, field `messages`. Meta performs the GET handshake
   immediately; a failure here is almost always the Caddy route or a token mismatch.
3. **Connect the account** in Vistaar: Settings → Instagram → Connect. If the list is empty, the
   panel will tell you whether it is "no Instagram account attached to this Page" or "reconnect
   Facebook" — they need different fixes.
4. **Send yourself a DM** from a second Instagram account that is a Tester on the app. It should
   appear in the inbox within seconds, badged *Instagram*.
   - Nothing arrives → check `docker compose logs crm-api` is NOT involved (it should not be), then
     `sudo journalctl -u vistaar -n 100` for the Node service. A 404 means Caddy.
   - Arrives but no automatic reply → expected. Automation is off by default.
5. **Reply by hand** from the composer. This proves the Page token, the `MESSAGE` task and the
   *Allow Access to Messages* toggle all together. A permission error here is almost always that
   toggle.
6. **Turn on automatic replies**, write a welcome, and DM from a *third* tester account (the
   welcome only fires on a thread's first message).
7. **Test takeover:** press *Take over*, then DM again. Nothing should be sent, and the thread
   should show the suppressed reply.
8. **Test duplicates:** in the App Dashboard, use *Send to Server* to replay the same webhook
   payload twice. The second delivery must produce no second message and no second reply.

Only after all eight should the app go to App Review for `instagram_manage_messages`, which is
what lets it message people who are not app testers.

## Still to build

- Attachments are not handled — text DMs only. An image arrives as a message with no text.
- The composer does not yet warn that the Instagram window is closing; it refuses on send.
- No per-thread view of which automatic reply fired, beyond the message itself in the thread.
- Instagram threads do not take part in the AI brain's WhatsApp-specific nurture and follow-up
  flows; the welcome and keyword replies are the whole of the automation.
