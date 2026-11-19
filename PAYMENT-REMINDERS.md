# Invoice payment reminders — Phase 5

Implemented locally; not deployed. This extends the existing payment follow-up runner and
owner approval flow. It does not replace sales follow-ups or import the payment bot's scheduler.

## Starting a sequence

The existing runner asks the owner about a won booking at least one day after its event.
The owner must explicitly answer its approval code with `pending`. A due invoice alone does
not authorize messages. The invoice must belong to the same workspace, conversation and contact.
Exactly one outstanding issued/sent invoice is required; multiple outstanding invoices require
manual review. Bookings without an invoice retain the existing single generic reminder.
Existing one-shot approvals are not automatically upgraded.

Up to three reminders are allowed: the first after approval, the second at least three days
after the first successful send, and the third at least four days after the second. The existing
daily runner processes eligibility, so these are minimum intervals, not exact appointment times.
Only `sent`, `delivered` or `read` status advances the sequence; merely queueing does not.
Provider acceptance does not guarantee delivery to the customer's handset.

## Balances, promises and stopping

Each reminder includes the invoice number and remaining balance from the payment ledger.
An existing Razorpay link is included only when its amount matches that balance. No link is
created automatically. Partial payments invalidate queued messages with outdated amounts.
Both Python and the Node WhatsApp gateway recheck billing state immediately before sending.
Database read failures prevent delivery and remain visible through the existing failure handling.

A payment promise recognized by the existing commitment extractor postpones collection until
the promised date plus 24 hours. This requires an `await_lead` commitment and explicit payment
wording; a generic promise to transfer photos does not postpone payment collection. The durable
commitment record survives clearing the generic follow-up fields. Existing commitment retry
and inbound supersession handling remain in use; no additional LLM or scheduler is introduced.

Full payment, invoice closure, owner `collected`, opt-out, automation pause, a changed booking
stage, revoked approval, or manual takeover stops the sequence. `Collected` stops chasing but
does not fabricate a payment ledger entry: record the actual payment through the payment API.
Invoice reminder pauses defer sending. Stopped sequences do not restart automatically after
a payment is voided. Failed delivery or the three-reminder limit creates an owner follow-up task
and stops automation for that sequence. A closed Cloud API messaging window requires owner
review; this feature does not silently substitute a template.

## Reliability and gateway configuration

Atomic conversation approval, invoice leases and deterministic outbound keys protect retries
and concurrent owner answers. The runner recovers approval interrupted before invoice setup.
Ambiguous approval codes never select an arbitrary booking.

In gateway deployments (`WHATSAPP_GATEWAY_ONLY=true`), Node forwards owner payment replies to
Python at `CRM_API_URL` (default `http://127.0.0.1:5002`). Both services must share the existing
`WHATSAPP_GATEWAY_SERVICE_KEY`, or the existing `AI_BRAIN_SERVICE_KEY` fallback. Requests use
`POST /internal/v1/payments/owner-reply` and `X-Service-Key`. Keep `/internal/*` excluded from
public ingress. An unavailable bridge asks the owner to retry rather than falling back to a
separate billing implementation. Standalone Node mode retains its legacy flow.

API and worker initialize the reminder indexes. Invoice API responses expose `promiseDate`
and `paymentFollowUp` (`state`, `remindersSent`, `nextAt`), without internal lease fields.
Invoice management UI belongs to Phase 7; recurring invoice generation belongs to Phase 6.

## Validation

Focused tests cover owner gates, tenant/contact binding, cadence, payment races, stale queued
amounts, promises, delivery failure, restart recovery and internal authentication. Node tests
exercise the final delivery guard and owner bridge. The optional
`crm-api/tools/check_billing_mongo.py` accepts only an explicitly supplied disposable localhost
MongoDB URI; it creates and removes its own unique test database and calls no payment provider.
It verifies real indexes, concurrent payment/approval deduplication and ledger-based cancellation.

No live Razorpay charges or WhatsApp messages were sent while implementing this phase.

Local validation completed: Python 14,460 passed / 28 skipped; Node 3,510 passed;
backend and frontend production builds passed; scoped Node lint passed. The disposable
MongoDB 8 check passed and its container/database were removed. The frontend retains its
existing bundle-size warning. Skipped Python tests are not counted as validated behavior.
