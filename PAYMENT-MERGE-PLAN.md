# Merging vistaar-payment-bot into the CRM

> Publication update, 19 November 2026: the user requested this merge be versioned and
> published to GitHub in 20 sequential pushes. References below to local/uncommitted work
> describe the validation snapshots; use Git HEAD/origin/main for current publication state.
> Production deployment and historical-data migration have not been performed. Migration
> was explicitly excluded by the user.


**Decision: port the invoicing and payments domain into `crm-api` (Python/Mongo). Take nothing the
CRM already does. Delete the rest.**

The payment bot is ~183 Python files, but most of it is a second copy of things this CRM already
does better. What is genuinely missing here — and worth every hour of the port — is about
**2,500 lines**: GST invoicing, PDF generation, payments, Razorpay, and recurring billing.

---

## 1. Why crm-api, and not the Node backend

Production routes `/api/*` to the Python `crm-api` on `:5002`. Only
`/api/v1/whatsapp-accounts*` and `/api/v1/whatsapp/cloud/*` go to Node. Invoices and payments are
ordinary API routes, so they belong in Python — and as a bonus, a Python route needs **no Caddyfile
change at all**, unlike the WhatsApp Cloud webhook.

Node gets nothing from this merge.

---

## 2. What we take, and what we drop

### Take — the CRM has no equivalent

| From the payment bot | Lines | Why it survives |
|---|---|---|
| `invoices/billbook.py` | 993 | A tuned GST invoice PDF renderer. Expensive to rewrite, impossible to re-derive from a spec. |
| `invoices/generator.py` | 457 | PDF orchestration and the legacy fallback layout. |
| `payments.py` | 352 | `record_payment`, total-paid / balance-due, partial payment links. |
| `webhooks/razorpay.py` | 301 | Per-tenant webhook, signature verification, payment events. |
| `payments_reconciliation.py` | 252 | Matching incoming payments to the right invoice. |
| `recurring.py` | 213 | Recurring templates and next-run-date arithmetic. |
| `invoices/items.py` | 142 | Line items: quantity × rate, discount, tax. **The money math.** |
| `invoices/razorpay.py` | 122 | Payment link creation and expiry. |
| `invoices/numbering.py` | 52 | The invoice number sequence. |
| `providers/credentials.py`, `webhook_tokens.py` | — | Per-tenant provider credentials. |
| `BusinessProfile` fields | — | GSTIN, state, bank, IFSC, UPI. Invoice identity the CRM has no concept of. |

### Drop — the CRM already does it, and does it better

| From the payment bot | Use instead | Note |
|---|---|---|
| `Organization`, `User`, `Membership` | CRM auth, roles, permissions | A second tenancy model is the worst outcome available here. |
| `AuditLog` | `audit.py` | |
| `Client` | **`contacts`** | The single biggest win: a lead and a billed client become one record. CRM contacts also carry encrypted PII and a blind index; the payment bot stores plaintext. |
| `ReminderLog`, `ScheduledAction`, `reminders/engine.py`, `reminders/debt.py` | `reminder_*`, `followup_tasks`, `commitment_retry` | The bot's whole "engine" is 3 functions. The CRM's is a dozen modules. |
| `PromiseLog` | `promise_follow_up.py`, `lead_commitment.py` | |
| `CallLog` | `call_records.py` | |
| `Document`, `DocumentChunk` | `ai_knowledge_*`, `assistant_retrieval.py` | |
| `ClientReply`, `WhatsAppMessage` | `conversations`, `messages` | |
| `OutboxMessage` | `outbound_messages.py`, `realtime_outbox.py` | |
| `whatsapp-service/` (its own Baileys) | CRM's Baileys + Cloud API | **Deleted outright.** See §3. |
| `channels/sms.py`, `email_sender.py`, `exotel.py`, `call.py`, `voice/` | — | WhatsApp is the channel for payment chasing. The CRM uses Vapi for calls if ever needed. |
| `scheduler.py`, `worker.py` | `worker.py`, `runners.py`, `daily_scheduler.py` | |
| `storage/backends.py` | `media_storage.py` | |
| `dashboard/routes.py` + `static/*.html` | React SPA | |
| `alembic/`, `migrations/`, `database.py`, SQLAlchemy | Mongo via `db.py` | |
| `oauth/` | `google_auth.py`, `google_calendar_oauth.py` | |

---

## 3. When reminders are allowed to start — already built

Payment chasing must not begin until the lead is **won** and the service has actually been
delivered. The CRM already enforces exactly that, in
`find_bookings_awaiting_payment_prompt`:

```python
query = {
    **NOT_DELETED,
    "stage": "won",                                      # the lead was won
    "eventDate": {"$ne": None, "$lte": ended_before},    # the event finished (> 1 day ago)
    "paymentPromptSentAt": None,                         # not already asked
    "paymentSettledAt": None,                            # not already settled
}
```

and then a second gate on top of it: the sweep asks **the owner** "collected or pending?" with a
one-time approval code, and only chases the client if the owner answers *pending*. Conversations
already carry `paymentPromptSentAt`, `paymentPromptCode` and `paymentSettledAt`, with atomic claim
and release so two runners cannot double-prompt.

**None of this gets rebuilt.** It is the right design and it is already in production: an event
that was paid in cash on the day never reaches the client, because the owner says so first.

So the rule for this merge is:

> An invoice may exist from the moment a lead is **won** — quotes and advances happen at booking
> time. But the invoice **does not create its own reminder schedule**. Reminders stay off until the
> existing gate fires: stage `won`, event finished, owner confirms pending.

This has a concrete consequence: the payment bot's due-date-driven scheduler is **not** ported as a
trigger. Its `due_date` survives as an invoice attribute — printed on the PDF, used to label
something overdue — not as an independent reason to message somebody.

### What is actually missing today

Once the owner says *pending*, the CRM sends **exactly one** message, with no amount in it:

> *"Hi {name}, hope you loved the photos! Just a gentle reminder that the payment for the shoot is
> still pending…"*

…then creates a follow-up task and hands the thread to the owner. Ask again and it replies
*"Already sent them one reminder. It's with you now."*

That is the gap the payment bot fills:

| Today | After the merge |
|---|---|
| No amount, no invoice | A real invoice: line items, GST, due date, PDF |
| No way to pay | A Razorpay payment link in the message |
| Exactly one reminder, then silence | A short escalation ladder, stopping the moment it is paid |
| "I'll pay Friday" is not tracked | Promise date recorded and chased if missed |
| Settled is a yes/no flag | Partial payments and a running balance |
| Owner must notice payment manually | The webhook marks it paid and stops the chase |

---

## 4. The one rule that is not negotiable

**Every payment reminder goes out through the CRM's existing outbound queue.** Not a second
sender, not a direct Baileys call, not a direct Cloud API call.

The payment bot ships its own Baileys instance. If it kept it, payment messages would bypass
**quiet hours, opt-out, the allowlist, the echo guard, delivery retries, and the Cloud API's
24-hour window and template rules** — every safety control in this product. It would also mean two
WhatsApp numbers messaging the same client, which doubles ban exposure and confuses the customer.

So a reminder becomes an ordinary outbound message row with a `paymentContext`, and the existing
delivery runner sends it. One sender, one set of rules.

---

## 5. Data model — new Mongo collections

Mirroring existing CRM conventions: `organizationId` on everything, soft fields over hard deletes,
`select: false` equivalents for secrets.

- **`invoices`** — `organizationId`, `contactId` *(not a new Client)*, `invoiceNumber`, line-item
  totals, `status`, `dueDate`, `promiseDate`, GST split, `pdfObjectKey`, Razorpay link fields,
  `remindersPausedUntil`, `paidAt`
- **`invoice_items`** — embedded in the invoice document, not a separate collection; they are never
  queried independently
- **`payments`** — `invoiceId`, `amount`, `mode` (online/cash), `collectedBy`, `reference`, `paidAt`
- **`payment_links`** — provider link id/url, amount, expiry, status
- **`recurring_invoice_templates`** — cadence, `dayOfMonth`, `nextRunDate`, item template
- **Organization billing profile** — extends existing org settings rather than a new collection:
  `gstin`, `state`, `address`, bank name/account/IFSC, `upiId`
- **Razorpay credentials** — `keyId`, encrypted `keySecret`, encrypted `webhookSecret`, using
  `encryption.py` with a **purpose-bound AAD** exactly like the Meta and Cloud tokens

### Money: integer paise, not float

The payment bot stores money as SQL `Float` (`amount`, `gst_amount`, `cgst_amount`, …). That is a
real defect — floating point cannot represent `0.1` and invoice totals drift by a paisa under
repeated discount/tax arithmetic.

The port stores **integer paise** throughout. The GST formulas are carried over unchanged in
*shape*; only the representation changes. Phase 1 includes a differential test: the same inputs
through the old `Decimal` path and the new integer path must agree to the paisa across a generated
matrix of quantity / rate / discount / tax-rate combinations.

### GST is not a detail

CGST+SGST applies when the business state matches the client's state; IGST when it does not. That
comparison drives which numbers appear on the invoice and is a legal requirement, not a display
choice. It is ported verbatim and tested against known-good invoices.

---

## 6. Phases

Each phase ends green and shippable. Nothing is deployed without being asked.

**Phase 0 — Foundations ✅ done**
Permissions `invoices.read` / `invoices.manage` / `payments.record`, added to all three places
that must agree (`backend/src/constants/permissions.ts`, `crm-api/app/permissions.py`,
`frontend/src/lib/permissions.ts`). Billing identity — GSTIN, state, address, bank, UPI and a
per-tenant `invoicePrefix` — on the organization document, with `GET`/`PUT /api/v1/settings/billing`.

Deferred deliberately: `reportlab` lands with Phase 2 and `razorpay` with Phase 4, rather than
adding dependencies nothing imports yet. The encrypted Razorpay credential store moves to Phase 4
for the same reason.

**Phase 1 — Invoice domain, no sending ✅ done**
`invoices` collection with embedded line items, atomic per-tenant numbering, the GST/discount
maths in integer paise, and CRUD plus issue/cancel under `/api/v1/invoices`. Invoices attach to
existing CRM contacts.

The money and GST layer was **lifted rather than rewritten** — `src/vistaar/domain/` in the
payment bot turned out to be pure stdlib with no SQLAlchemy or FastAPI in it, so `money.py` and
`line_items.py` came across unchanged but for their import paths. Its own test suite came with
them, because those tests encode edge cases found the hard way.

**Phase 2 — PDF ✅ done**
`billbook.py` lifted to `app/invoice_pdf.py`, with `words.py` (amount in words, GST state codes)
to `app/domain/words.py`. Two import lines changed; nothing else. `reportlab` pinned to the
version it was tuned against.

`generator.py` was **not** lifted — 327 of its 457 lines are a second, older layout kept because
it "is the only record of what customers received before this date". That is the payment bot's
history, not this CRM's, which has never issued an invoice.

`app/invoice_pdf_service.py` adapts Mongo documents to the snake_case, rupee-`Decimal` shape the
renderer expects, so the layout file stays free of any schema knowledge. PDFs are written through
the existing `media_storage`, keyed by organisation and invoice, and served by
`GET /api/v1/invoices/{id}/pdf` gated on `invoices.read` — *not* through the media route, which
authorises keys against conversations.

**A Phase 1 correction came out of this.** The renderer prints a grand total rounded to the whole
rupee with a "Round Off" line; the payment bot's own `_invoice_total` did not round, so the
document said one figure and the system chased another and the invoice could never settle. Totals
are now rounded once, at write time, with `roundOffPaise` stored beside them. (Its other bug —
`_invoice_total` ignoring the invoice discount entirely — never reached this port.)

**Phase 3 — Payments ✅ done**
A `payments` ledger (separate collection — payments are appended by webhooks, read across
invoices, and need unique indexes on the provider's own ids). Recording, voiding, balances, and
status transitions. `invoices.amountPaidPaise` is a denormalised copy maintained with `$inc`;
`reconcile_invoice` is the guard that proves it still matches the ledger.

**Razorpay reconciliation moved to Phase 4.** It polls the provider for links whose webhook was
missed, so it needs credentials and an adapter that do not exist until then. What Phase 3 has is
the *internal* consistency check, which needs neither.

The status enum did **not** come across. The original stored seven statuses including `overdue`
and `partially_paid`; both are observations about numbers and dates rather than states a human
drives, and a stored one needs a sweep that can fall behind. This CRM stores the lifecycle
(`draft → issued → sent → paid/cancelled`) and derives the rest. The product decision the
original made explicit is preserved: a **partly** paid invoice is still chased.

Three bugs found while building it, two of them mine:

- **`sparse` should have been `partialFilterExpression`** — in both the payment indexes *and*
  the invoice-number index shipped in Phase 1. A sparse index skips *missing* fields, not
  explicit nulls, so every hand-recorded payment would have collided with every other, and an
  organisation's second **draft invoice would have failed to save**. Phase 1's tests missed it
  because they never created the indexes; they do now.
- **An invoice never left `paid`.** Voiding a payment, or repairing a downward drift, left the
  status settled — a debt nobody would ever chase.
- The source project's own `_invoice_total` ignored the invoice discount and did not round,
  while its PDF did both. Neither reached this port.

**Phase 4 — Razorpay ✅ built locally**
Per-tenant encrypted credentials, payment link creation/cancellation, a signed public Python
webhook, and a leased reconciliation poller. No Caddy change or second WhatsApp sender.

Source inspected: `C:/Users/LIKHITH GOWDA K/Desktop/vistaar-payment-bot` (the Desktop checkout
contains the reconciliation/domain modules referenced here; Documents also has another copy).

The Razorpay adapter uses the CRM's existing `httpx`; no SDK or global provider credentials.
An admin's credentials are tested with a read-only request before being saved. A new link is
preceded by a durable intent with an immutable reference, and Mongo enforces one active link per
invoice. A timeout leaves an unknown result for lookup by reference, never a blind second POST.
Partial invoice collections use separate links with `accept_partial=false`.

Webhooks identify exactly one tenant by a random endpoint token, verify the raw-body HMAC, and
resolve only locally created links. Provider captures are checked against the link's order,
amount and currency before recording money. A 200 follows the ledger and invoice writes;
failures remain retryable. Reconciliation performs the same checks for missed events.

Two earlier correctness gaps were fixed during this phase:

- MongoDB 8 rejects `$ne: null` in a partial index, although mongomock accepted it. The invoice
  uniqueness filter now uses `$type: string`, verified in a disposable real MongoDB container.
- A process interruption between the payment insert and invoice increment could leave the
  ledger ahead of the balance. An invoice applies each ledger effect with an atomic marker and
  increment, allowing retries to recover without counting a payment twice. Status updates use
  a compare-and-set guard against concurrent payments.

Financial indexes now fail startup if they cannot be created. API and worker both initialize
them before processing. See `RAZORPAY.md` for endpoint contracts and test/deployment requirements.

**Phase 5 — Extend the existing chase, do not replace it — implemented locally**
The trigger, the owner "collected or pending?" gate, the approval code, the atomic claim and the
follow-up task all stay exactly as they are. Three changes only:

1. `build_payment_chase_message` gains the invoice — amount due, invoice number, and the payment
   link — instead of a generic sentence with no number in it.
2. The one-shot chase becomes a short ladder, driven by the invoice's balance rather than by a
   due date. It stops immediately when the balance reaches zero, when the owner marks it settled,
   on opt-out, or when the owner takes the thread over. Capped, and silent once handed to the owner.
3. A client reply promising a date is recorded as a promise and chased if missed — through the
   existing `promise_follow_up` and `commitment_retry`, not a new mechanism.

The sweep itself keeps running inside the existing payment-follow-up runner. No new trigger, no
new scheduler, no second source of truth about when it is acceptable to message somebody.

Implementation details, gateway configuration, recovery behavior and limits are documented in
`PAYMENT-REMINDERS.md`. Local changes have not been pushed or deployed. The payment bot source
and existing CRM UI remain preserved; `frontend/vite.config.ts` stays outside merge commits.

**Phase 6 — Recurring invoices ✅ done**
Templates, calendar arithmetic, and generation through the existing daily scheduler.
`GET|POST /api/v1/recurring-invoices`, `POST /{id}/active`.

**Three safety decisions, made explicitly** — recurrence runs unattended, months after somebody
set it up:

- **Generated invoices are drafts by default.** Issuing takes a number from a permanent,
  gap-sensitive sequence and makes a document a client may be shown. `generateAs: "issued"` is
  opt-in.
- **Nothing is ever sent.** No payment link, no message. The source project created a Razorpay
  link inside the generator, which could put a payment request in front of a client with no
  human involved. Links are on-demand; messaging still needs the won + completed-event +
  owner-pending gate, which a recurring invoice cannot satisfy because it has no event.
- **One period per run.** A job three months behind bills the oldest missing period and stops.
  The backlog clears one per day rather than dropping three invoices on a client at once.

**Not billing twice** rests on a unique index over `(organizationId, recurringTemplateId,
recurringPeriod)` on the invoices collection — not on a lock. The source guarded this with a
Redis lock set to *fail open*, and its own comment conceded the result was duplicate invoices
whenever Redis was down. The lease on the template is only an efficiency; the index is the
guarantee, and it cannot fail open.

The calendar rule worth keeping came across unchanged: a template billed on the 31st bills on
28 February — clamped, not skipped — and **returns to the 31st in March**. Advancing from the
occurrence rather than from `today` is the other half: the source drifted the whole schedule
whenever a run was late.

Three real bugs surfaced in testing, all in my own sweep loop: it re-claimed a template it had
just advanced (billing a backlog in a burst) and re-claimed one whose generation had just failed
(retrying it fifty times in one run). Both are now excluded per run.

**Phase 7 — Frontend ✅ done**
A `Billing` view inside the existing SPA — not a second dashboard. It reuses the CRM's auth
context, permission helpers, `SectionScreen`, `EmptyState`, `Spinner` and mobile back-layer, and
appears in both the desktop nav and the mobile nav alongside everything else. The payment bot's
static HTML is discarded. **No new backend endpoint was needed**; every screen runs on the
Phase 0–6 APIs.

Three tabs, each gated on a permission the server already enforces: Invoices
(`invoices.read`), Recurring (`invoices.manage`), Settings (`settings.manage`). A single
available tab renders no tab strip, and a deep link to a tab the caller cannot open falls back
rather than showing a blank panel.

**Clients come from conversations, because the CRM has no contacts-list endpoint.** A contact is
reached through the lead thread it belongs to, and `listConversations` already carries
`contactId`, `displayName` and the same search the inbox uses; the invoice form dedupes it by
contact, so a client with two threads is one person to bill. This is the point of merging
billing *into* the CRM — the client being invoiced is the lead already in here.

**Rupees on screen, paise underneath.** `lib/money.ts` formats the server's decimal strings with
en-IN grouping (₹4,78,100.00, not ₹478,100.00) and compares the server's integers; it never
divides paise to produce a figure, and `toAmountString` refuses a pasted `"1,500"` rather than
loosely parsing it as 1. The invoice form's running total is the one float in the feature: it is
a preview so nobody types blind, it is labelled an estimate, and it is never submitted — the GST
split, discount and rounding are the server's.

**What the UI deliberately cannot do.** There is no send action anywhere in billing, no
"generate now" on a recurring template, and no hand-entered `online` payment mode (provider money
arrives through the webhook carrying an id that deduplicates it; a typed copy would be a second
row for the same money). Customer messaging stays behind the owner approval flow. Four
irreversible actions — cancel invoice, reverse payment, pause schedule, cancel payment link —
confirm first, and each says what will actually happen rather than "are you sure": that a
cancelled invoice keeps its number, that a reversed payment stays in the ledger and the balance
becomes owed again, that pausing does not move the next run date, that cancelling a link checks
Razorpay for a payment already made.

**Secrets never come back.** There is no endpoint that returns a provider secret, so the settings
panel can only report *that* Razorpay is connected and which key id; both secret fields stay
empty on a connected workspace and are cleared from component state the moment a new pair is
accepted. Test and live connections are badged, as are test-mode payment links — the two look
identical in a URL, and chasing a client with a link that cannot take money is a real mistake.

145 tests originally covered this (the earlier narrative incorrectly said 113): permissions and role-dependent empty states, money formatting, the payments
ledger, the invoice list and detail, the invoice form, recurring schedules, and Razorpay.

**Phase 8 — Data migration**
Only if the payment bot holds real data. A one-shot script: clients matched onto existing CRM
contacts by phone (via the blind index), then invoices, payments, and history. Written to be
re-runnable and to report unmatched clients rather than silently creating duplicates.

---

## 7. Risks

- **Contact matching.** The merge's value depends on a payment-bot client and a CRM contact being
  recognised as the same person. Matching is by normalised phone through the existing blind index.
  Anything unmatched is reported, never guessed.
- **Invoice numbering.** The sequence must not restart or collide after migration. Seeded from the
  highest existing number, and the uniqueness is enforced by a Mongo unique index rather than by
  application code.
- **GST correctness.** Legal exposure, not a display bug. Ported verbatim, tested against real
  historical invoices if any exist.
- **Razorpay webhook replay.** Payment events must be idempotent — the CRM already has an
  `idempotency` module to reuse.
- **Scope.** Phases 1–4 are the product. Phases 5–7 are what make it pleasant. Phase 8 may be
  unnecessary.

---

## 8. Explicitly not doing

SMS, email, Exotel, the realtime voice stack, the second Baileys service, the static HTML
dashboard, SQLAlchemy/Alembic, and the payment bot's own auth and tenancy. If voice chasing is ever
wanted, the CRM's Vapi integration is the place for it.


## Release-readiness update ? 19 November 2026

Phases 0?7 remain implemented locally. The subsequent review completed recurring edit/history
and manual-payment retry protection, fixed missing recurring-index startup initialization,
checked index legality and concurrent generation on real MongoDB 8, fenced stale leases,
preserved recurring data during edits, corrected payment-link state contracts, and corrected
billing-dialog stacking and keyboard handling in an actual desktop/mobile browser.

Final frontend validation is 1,014 tests (168 billing tests), with build, scoped lint and local
synthetic browser journey passing. Node: 3,510 tests and build passing. Python: full regression
14,568 passed / 28 skipped, followed by 197 focused tests covering the final startup/payment fixes.
See `PAYMENT-RELEASE.md` and the latest `CLAUDE-HANDOVER.md` update for snapshot boundaries.

Phase 8 assessment found historical source data; migration is conditional on choosing the
correct current export and workspace. No migration or production/provider action was performed.
The next steps are provider TEST-mode acceptance, explicit migration scope, and an approved
release using the deployment/rollback checklist. Nothing has been committed, pushed or deployed.


## User decision ? historical migration excluded

The user explicitly decided not to migrate the old payment project's historical data.
Phase 8 is intentionally skipped. Do not build/run an importer or copy old clients, invoices,
payments, templates or logs. Preserve the source project as-is. Earlier migration assessments
remain historical context only. Continue with the new CRM billing features and release steps;
GitHub publishing must follow the user's clarified instruction.
