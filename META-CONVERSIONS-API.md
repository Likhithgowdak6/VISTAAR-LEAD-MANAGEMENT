# Meta Conversions API (CRM lead events)

Reports what happens to Meta-sourced leads back to Meta, so an ad account can optimise for leads
that become customers rather than leads that merely arrive.

Per workspace, **disabled by default**, and independent of every other Meta feature in this repo.

---

## Why this is not web CAPI

Meta documents two different integrations, and using the wrong one produces an integration that
delivers successfully and matches nothing.

| | Web CAPI | **Conversions API for CRM** (this one) |
|---|---|---|
| Source of the event | A browser | A sales pipeline |
| Primary match key | `fbp` / `fbc` cookies, hashed email | **`user_data.lead_id`** — the Meta Lead Ads lead id |
| `action_source` | `website` | **`system_generated`** |
| Extra required data | `event_source_url` | `custom_data.event_source: "crm"` + `lead_event_source` |
| Event names | Meta's standard vocabulary | **Your own funnel stage names**, mapped in Events Manager |

Our leads come from Lead Ads instant forms and are worked in this CRM. There is no browser in the
loop and no pixel, so the CRM integration is the applicable one.

**The lead id is sent as an unhashed integer.** Email and phone are SHA-256 hashed; the lead id is
not. Hashing it destroys the match entirely, and the symptom is being told the CRM "isn't sending
events" while every event delivers with a 200.

### Meta's own eligibility bar

Worth reading before promising an advertiser anything — from Meta's Conversion Leads guidance:

- Lead Ads (Instant Forms), with the 15–17 digit lead id stored in the CRM
- At least ~200 leads/month
- Uploads at least once a day (we upload within a minute)
- The optimised stage happens within 28 days of the lead, at a 1–40% conversion rate
- **Lead Coverage ≥ 60%** — the share of leads Meta can match to an uploaded event

Coverage is why `lead_received` exists as a selectable milestone: without the raw lead event,
Meta sees qualified leads appearing for leads it was never told about.

---

## What gets reported

Four milestones, each driven by a state that actually changed in this CRM. A workspace selects
which to report, and **Meta requires at least two** — a stream reporting only purchases is
refused, because a conversion rate cannot be modelled from one point.

| Milestone | Meta event | Fires when | Hooked in |
|---|---|---|---|
| `lead_received` | `Lead` | A Meta lead is imported | `lead_pipeline.import_lead` |
| `lead_qualified` | `QualifiedLead` | Conversation stage → `qualified` | `conversations_repository.update_stage` |
| `lead_won` | `Won` | Conversation stage → `won` | `conversations_repository.update_stage` |
| `purchase` | `Purchase` | **A payment row is written to the ledger** | `payments_service.record_payment` |

The stage hooks sit in `update_stage` rather than in each of its callers, because it has several
and a missed one is a conversion Meta never hears about — a silence nobody notices.

**A purchase is money arriving, never an invoice being raised.** An invoice is a request to be
paid; reporting one as a conversion would optimise the ad account toward people who get billed
rather than people who pay. The hook is on `record_payment`'s `recorded` path only — the
`already_recorded` branch is a webhook or retry seeing money that was already counted.

Of eight pipeline stages only two are reported. `contacted`, `proposal_sent` and `negotiation`
are activity rather than qualification; reporting them would train the ad account on busyness.
`lost` and `closed` are not conversions.

---

## How a conversion cannot be counted twice

Three mechanisms, deliberately different in kind:

1. **A derived `event_id`.** `sha256(organizationId:eventKey:subjectId)` — never random. The same
   milestone always produces the same string, so a retry, a restart or a replay a week later is
   the same event.
2. **A unique index** on `(organizationId, eventId)` over `capi_events`, with
   `partialFilterExpression: {eventId: {$type: "string"}}`. Enqueuing twice is a no-op decided by
   the database, not by a prior read that could lose a race. It is created by
   `ensure_billing_indexes`, which **fails startup** if it cannot be built.
3. **Meta's own `event_id` deduplication**, using that same string. This is also what coordinates
   with a browser pixel: if a web integration ever fires the same conversion with this id, Meta
   keeps one.

`subject_id` is what the milestone is really about — the conversation *plus the stage* for a stage
change, the payment row for a purchase. So a thread moved to `qualified`, back to `contacted` and
forward again reports one qualification, while a part payment and the balance are two purchases.

---

## Privacy and data handling

- **No plaintext personal data is ever queued.** Email and phone are hashed at enqueue time, so a
  dump of `capi_events` contains digests and a Meta lead id — not a customer list.
- Email is lowercased and trimmed before hashing; phone is digits-only **including the country
  code**. A number stored without one is reported as absent rather than guessed at, because
  guessing produces a confident mismatch instead of a visible gap.
- The access token is AES-GCM encrypted with a purpose-bound AAD
  (`wam-crm-ai:v1:organization.capi.encryptedAccessToken`), stored on the organisation beside
  `billingProfile` and `razorpay`.
- **No endpoint returns the token.** The settings panel shows the dataset id and the last four
  characters, and nothing else.
- The token travels in the request **body**, never the query string, so it cannot be captured by
  a proxy or an access log.
- Historical records are untouched: nothing backfills, and Meta discards anything older than
  7 days anyway.

---

## Meta dashboard setup

Do this in **Events Manager**, not the App Dashboard.

1. **Pick or create a dataset.** Events Manager → *Data sources*. If the advertiser already runs a
   pixel, use that dataset so web and CRM events land together. Copy the numeric **Dataset ID**.
2. **Generate an access token.** Dataset → *Settings* → *Conversions API* → **Generate access
   token**. It must be generated under a user with access to the ad account. Treat it as a
   credential that can write conversions.
3. **Get a test event code.** Dataset → *Test events* → copy the `TEST…` code. **Set this first.**
   With it configured, everything lands in the Test Events tab and the advertiser's real
   reporting is untouched.
4. **Map the event names.** The CRM sends `Lead`, `QualifiedLead`, `Won`, `Purchase`. In Events
   Manager, confirm these appear and map them to funnel stages for Conversion Leads optimisation.
5. **Check Lead Coverage** under the dataset's diagnostics once real events flow. Below 60%, the
   usual cause is leads without a stored Meta lead id.
6. **Only then clear the test event code** in Vistaar settings, and switch delivery on.

### In Vistaar

**Settings → Meta Conversions API** (requires `settings.manage`):

1. Paste the Dataset ID, access token and test event code → **Connect dataset**.
   This stores the credential and starts nothing.
2. Tick at least two milestones → **Save what gets reported**.
3. **Start sending.** Delivery begins within a minute.
4. Watch *Delivery* on the same panel: queued / delivered / failed, and the reason for each
   failure.

---

## Deployment

**This round changes the Python service only** — `crm-api` and `crm-worker` — plus the frontend.
Node is untouched.

Because a new index is created at startup and `ensure_billing_indexes` fails closed, the API will
refuse to boot if `capi_events` cannot get its unique index. That is deliberate.

```bash
# 1. Confirm the revision on the box matches what you reviewed
git -C ~/vistaar log --oneline -1
```

```bash
# 2. Rebuild the Python images (new module, no new dependency)
cd ~/vistaar && docker compose --env-file .env --env-file backend/.env build crm-api crm-worker
```

```bash
# 3. Recreate only the Python services; Mongo and Redis volumes are retained
cd ~/vistaar && docker compose --env-file .env --env-file backend/.env up -d --no-deps crm-api crm-worker
```

```bash
# 4. Confirm the API booted, which proves the new index was created
cd ~/vistaar && docker compose logs --tail 40 crm-api | grep -iE "index|started|error"
```

```bash
# 5. Confirm the queue's unique index exists
cd ~/vistaar && docker compose exec -T crm-api python -c "
import asyncio
from app import db
async def main():
    await db.connect()
    print([i for i in (await db.get_database()['capi_events'].index_information()).items()])
asyncio.run(main())
"
```

```bash
# 6. Build and publish the frontend (assets first, index.html last)
cd ~/vistaar/frontend && VITE_API_BASE_URL=/api/v1 npm run build
```

Then publish exactly as in `PAYMENT-RELEASE.md`: back up `/srv/vistaar`, copy `dist/assets/*`
alongside the existing hashed assets, and replace `index.html` atomically last.

### Worker

The `capi_delivery` runner is registered in `create_all_runners()` and gated on
`ENABLE_BACKGROUND_RUNNERS`, like its neighbours. It is **not** gated on `WHATSAPP_ENABLED` — it
posts to Meta's ads infrastructure, not to a customer. Confirm it started:

```bash
cd ~/vistaar && docker compose logs --tail 60 crm-worker | grep -iE "capi|runner"
```

No new environment variable is required. `capi_poll_interval_ms` may be set to override the
60-second default.

---

## What is proven locally, and what is not

**Verified with mocks, no network:** payload shape, lead-id handling, hashing and normalisation,
the two-stage minimum, event-id stability, tenant isolation of batches, duplicate suppression,
expired-credential backoff, transient-failure retry, give-up-visibly, partial acceptance,
backfill expiry, test-event passthrough, and that stage changes and payments actually enqueue.

**Requires live Meta testing and cannot be asserted here:**

- That Meta accepts the payload shape against a real dataset
- That events appear in the **Test Events** tab
- Whether the event names map cleanly onto Conversion Leads stages in Events Manager
- The real **Lead Coverage** figure
- Whether a genuinely revoked token returns the error code the taxonomy expects
- Rate limits under volume

Until a test-mode run has been done, treat this as implemented and unproven.
