# Razorpay integration — Phase 4

This adds backend payment collection to the existing CRM. Invoice/reminder UI remains Phase 7;
the richer payment chase remains Phase 5. Connecting Razorpay does not send a WhatsApp, SMS or
email, and creating a link does not activate a reminder schedule.

## Source and storage

The source project is `C:/Users/LIKHITH GOWDA K/Desktop/vistaar-payment-bot`.
Its provider behavior has been adapted to CRM contacts, permissions and MongoDB; its auth,
SQL database, separate Baileys service and reminder scheduler are not copied.

Razorpay settings live on each organization. The API key secret and webhook secret use the
existing AES-GCM key ring with distinct purpose-bound AAD. Never replace the CRM encryption key
when enabling this feature. Credentials are never returned through a read route.

`payment_links` stores link intents and provider identifiers; `payments` remains the ledger.
All financial queries include the authenticated organization or the signed endpoint's tenant.

## API

- `GET /api/v1/settings/razorpay` — connection summary and webhook path; `settings.manage`.
- `PUT /api/v1/settings/razorpay` — `keyId`, `keySecret`, `webhookSecret`; same permission.
  Validates keys using a read-only provider request before saving them.
- `GET /api/v1/invoices/{id}/payment-links` — scoped link history; `invoices.read`.
- `POST /api/v1/invoices/{id}/payment-links` — `idempotencyKey` and optional decimal-string
  `amount` in rupees; `invoices.manage`. Omit amount for the current ledger balance.
- `POST /api/v1/invoices/{id}/payment-links/{linkId}/reconcile` — checks provider receipts;
  `invoices.manage`.
- `POST /api/v1/invoices/{id}/payment-links/{linkId}/cancel` — reconciles first, then cancels;
  `invoices.manage`.
- `POST /api/v1/payments/razorpay/webhook/{token}` — public, authenticated by raw-body HMAC.

The existing Python API route handles the webhook. No new Caddy forwarding rule is needed.
The connection response includes `webhookPath`; prepend the production HTTPS origin when
configuring Razorpay. `webhookUrl` is also populated when FRONTEND_ORIGIN is configured.

## Provider settings

Create a webhook in the matching Razorpay test/live account with its own secret, then subscribe
to `payment_link.paid`, `payment.captured`, `payment_link.cancelled` and `payment_link.expired`.
Save that exact secret through the connection route. A previous webhook secret remains accepted
for 24 hours after rotation so older signed deliveries can finish retrying.

The test/live mode is visible in link responses. Links cannot be polled with credentials from
the other mode. Changing to another merchant's keys can also make old links inaccessible: settle
or explicitly review outstanding links before moving merchant accounts.

Amounts are integer paise in storage/provider requests; this API accepts decimal strings in
rupees. Links disable provider-managed notifications and reminders, and do not send customer
phone numbers to Razorpay. Collect a partial invoice amount by creating a separate link for
that amount, rather than enabling partial payments on one link.

## Recovery and reconciliation

An intent is committed before contacting Razorpay. Its reference is immutable and unique.
Repeated HTTP keys and concurrent attempts cannot create competing active links. A definite
credential/request rejection releases the active intent; use a new request key after correcting
it. An uncertain response stays `unknown`; reconciliation searches by reference and never
automatically creates another link. An unresolved intent remains visible for manual review.

A signed event does not itself prove which invoice was paid. Only a local link mapping can
select an invoice, and authenticated Razorpay reads must confirm captured status, order,
currency and amount. Arbitrary invoice IDs in payment notes are ignored.

The worker checks due links every ten minutes, with database leases and a bounded batch.
Expired/cancelled links remain eligible for daily checks for late captures. Paid links stop
polling only after the ledger is durably recorded. This job never sends a message.

Each ledger effect is incremented once using an invoice marker in the same MongoDB update.
A retry recovers a failure between insert and increment. Overpayments are recorded as money
received, even when cash or another payment already settled the invoice; balance can be negative
for a human to review. Refund automation is not included. Existing paid/voided payment records
from an earlier deployment without effect markers would require a migration before this change;
the current uncommitted invoice phases have not been deployed by this task.

## Validation and release

Focused tests use Mongo mocks with real unique indexes enabled and httpx MockTransport. They
cover signatures/tenant isolation, raw bytes, retries, captured-payment validation, concurrency,
unknown create results, credential rotation, cancellation and missed-webhook reconciliation.
No live provider requests or payment notifications are made by the tests.

A separate integration check was run against a disposable MongoDB 8 container. Reproduce with
`python -m tools.check_billing_mongo --uri mongodb://127.0.0.1:PORT`, explicitly pointing at a
disposable local instance. The tool never reads MONGODB_URI; it creates/removes only its own
uniquely named test database. It verifies indexes, concurrent deduplication, crash recovery,
cash payments and active-link uniqueness. Normal pytest retains its no-network guard.

Before production activation, run a controlled Razorpay test-mode payment, webhook redelivery,
partial invoice collection and missed-webhook reconciliation. Real merchant credentials, dashboard
webhooks and the deployed API/worker must be configured for that acceptance test.
This phase has not been pushed, deployed, or tested with a live Razorpay merchant.

Provider references:
- [Create a link](https://razorpay.com/docs/api/payments/payment-links/create-standard/)
- [Find by reference](https://razorpay.com/docs/api/payments/payment-links/fetch-all-standard/)
- [Webhook signatures and retries](https://razorpay.com/docs/webhooks/validate-test/)
- [Webhook payloads](https://razorpay.com/docs/webhooks/payment-links/)
