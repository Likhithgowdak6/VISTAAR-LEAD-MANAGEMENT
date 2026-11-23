# Vistaar payment-project merge: Claude Code handover

> Publication update, 19 November 2026: the user requested this merge be versioned and
> published to GitHub in 20 sequential pushes. References below to local/uncommitted work
> describe the validation snapshots; use Git HEAD/origin/main for current publication state.
> Production deployment and historical-data migration have not been performed. Migration
> was explicitly excluded by the user.


Prepared 19 November 2026; updated the same day after Phases 6 and 7. Read this before editing.
The working tree contains substantial uncommitted implementation. As of this update the whole
tree has been validated together — see "After Phases 6 and 7" below — so there is no longer a
gap between the last green run and the current files.

## Objective and repositories

Preserve the existing Vistaar CRM and add useful invoicing/payment features from the payment bot.
Do not replace the CRM, its authentication, contacts, WhatsApp integrations or UI.

- Current CRM: `C:/Users/LIKHITH GOWDA K/Downloads/final project 1/wam-crm-ai`
- Payment bot source: `C:/Users/LIKHITH GOWDA K/Desktop/vistaar-payment-bot`
- CRM Git HEAD when inspected: `a472fc8` (`docs: document Cloud API configuration and release requirements`).
- Source project previously inspected at `c3da7f0`; inspect its current Git state before relying on it.
- Payment merge work is local and uncommitted. It has not been pushed or deployed by this task.
- Preserve `frontend/vite.config.ts`: it has separate local changes and must not enter merge commits.
- Do not reset, clean, overwrite or broadly stage the dirty working tree. Inventory it first.

## Architecture and rules

Python `crm-api` owns billing logic and MongoDB records. Production ordinary `/api/*` requests
go to Python on port 5002; WhatsApp account/Cloud gateway endpoints go to Node. Node additionally
has a narrow authenticated owner-payment bridge and read-only final delivery checks.
The older plan sentence saying Node gets nothing predates this necessary Phase 5 bridge.

Reuse existing organization tenancy, permissions, encrypted CRM contacts, media storage,
outbound message queue, workers, owner approval and commitment extraction. No second auth,
client database, scheduler, Baileys sender or standalone payment-bot frontend.

Money is integer paise. Invoices reference existing contacts; optional conversation binding is
explicit. Keep tenant filters on every financial operation. Provider secrets use existing
encryption with purpose-bound AAD; never replace the CRM encryption key.

Reminders must go through the CRM queue and existing quiet hours, opt-out, allowlist,
delivery retry and Cloud API messaging-window controls. An invoice due date alone never
authorizes a payment reminder. Keep the won-booking + completed-event + owner-pending gate.

## Completed locally: Phases 0–7

0. Foundations: billing profile (GSTIN, state, address, bank, IFSC, UPI, invoice prefix) on the
   organization; settings API; `invoices.read`, `invoices.manage`, `payments.record` permissions
   aligned across Node, Python and frontend permission definitions.
1. Invoice domain/API: tenant-scoped invoices attached to CRM contacts, embedded items,
   atomic numbering, lifecycle operations and serializers. Ported money/line-item domain
   and tests; CGST/SGST versus IGST, discounts and rounding. PDF and stored total agree,
   including stored `roundOffPaise`. Overdue/partial-paid observations are derived.
2. Invoice PDF: preserved payment-bot billbook layout and amount-in-words logic. Adapter
   maps CRM documents to the renderer; PDF stored through CRM media storage and downloaded
   through a permission-checked invoice route. Source bot was not modified.
3. Payment ledger: record and void payments, partial balances and invoice status transitions.
   Provider deduplication, nullable-field partial indexes and balance reconciliation.
   Atomic invoice effect markers allow retry recovery after ledger insertion but before
   cached balance increment, without counting money twice.
4. Razorpay: per-tenant encrypted configuration, durable payment-link intents, uncertain-create
   recovery, idempotency, signed raw-body webhook processing, authenticated capture checks,
   cancellation and worker reconciliation. Provider notifications/reminders disabled;
   no automatic second sender. See `RAZORPAY.md`, but inspect current code for route changes.
5. Invoice-aware payment chase: existing owner code (`B4 pending`, for example) binds one
   outstanding invoice to the booking. Multiple unpaid invoices require manual review;
   no invoice retains the legacy single generic reminder. Up to three accepted sends,
   minimum gaps 3 days then 4 days after prior successful sends, through the existing daily
   payment runner. Fresh ledger balances and exact-balance existing links; partial payment
   cancels stale queued amounts. Explicit payment promises use existing commitment extraction,
   durable `lastLeadCommitment`, and promised date + 24 hours. Payments, opt-out, owner settled,
   automation pause/manual takeover and other eligibility changes stop sending. Failed delivery,
   closed Cloud window or cap hands follow-up to owner. Owner `collected` does not invent money.
   Atomic approvals, leases and deterministic keys handle retries/recovery. Node and Python
   guard immediately before sending. API exposes promise/reminder state without lease internals.

6. Recurring invoices: `domain/recurrence.py` (pure calendar arithmetic, no I/O),
   `recurring_invoices_repository.py`, `recurring_invoices_service.py`,
   `recurring_invoice_runner.py`, `recurring_invoice_serializer.py` and
   `routers/recurring_invoices.py`. Intervals are 1, 2, 3, 6 or 12 months on a chosen day.
   Three decisions are deliberate and should not be "fixed" without reading the tests:
   - A day-31 template bills 28 February and then returns to the 31st in March. The day comes
     from the template, never from the clamped date, so one short month cannot permanently
     move a client's billing day.
   - The next run advances from the OCCURRENCE, not from `today`. A run that is late by three
     days does not push the whole schedule three days later, which is how a monthly retainer
     drifts into the following month over a year.
   - A template may generate `draft` or `issued`. Issuing unattended allocates a real invoice
     number with nobody present, so the choice is explicit per template and shown on the row.
   Duplicate generation is prevented by a unique index on the INVOICES collection over
   `(organizationId, recurringTemplateId, recurringPeriod)` with
   `partialFilterExpression {recurringTemplateId: {$ne: null}}` — not `sparse`, which skips
   missing fields rather than explicit nulls and would therefore not apply to ordinary invoices.
   The sweep claims a template under a 300-second lease, and within one run excludes both
   templates it has just advanced and templates that have just failed, so one sweep cannot bill
   a backlog in a burst or retry a failure fifty times.
   The runner is registered as `recurring_invoices` and is deliberately NOT gated on
   `whatsapp_enabled`: generation produces documents, never messages. Nothing in this phase can
   message a client.
7. Billing UI inside the existing SPA. New `billing` view in `AppShell`, permission-filtered
   tabs (Invoices / Recurring / Settings), reusing the existing auth context, permission
   helpers, `SectionScreen`, `EmptyState`, `Spinner` and mobile back-layer hook. Clients are
   chosen through `listConversations` because the CRM has NO contacts-list endpoint — a contact
   is reached through its lead thread, and that payload already carries `contactId`,
   `displayName` and search. No new backend endpoint was needed for any of Phase 7.
   Money is rendered from the server's formatted strings and compared on the server's integer
   paise; `lib/money.ts` never divides paise to display a figure. The one float in the feature
   is the invoice form's estimated total, which is labelled an estimate and never submitted.
   No send action exists anywhere in the billing UI, by design: customer messaging stays behind
   the owner approval flow.

## Important files

- `PAYMENT-MERGE-PLAN.md`: original merge rationale, phases and non-goals.
- `RAZORPAY.md`: provider behavior, configuration and release acceptance requirements.
- `PAYMENT-REMINDERS.md`: actual reminder behavior, gates, limits and gateway configuration.
- `crm-api/app/domain/`, `billing_profile.py`, `invoice_*`, `invoices_*`.
- `crm-api/app/payments_repository.py`, `payments_service.py`, `payment_serializer.py`.
- `crm-api/app/payment_links_repository.py`, `razorpay_*.py`, `routers/razorpay*.py`.
- `crm-api/app/invoice_payment_chase.py`, `payment_followup.py`, `routers/payment_gateway.py`.
- `crm-api/app/domain/recurrence.py`, `recurring_invoice*.py`, `recurring_invoices_*.py`,
  `routers/recurring_invoices.py`.
- `frontend/src/api/billing.ts` (kept separate from the 1,800-line `endpoints.ts`),
  `frontend/src/lib/money.ts`, `frontend/src/pages/BillingPage.tsx`,
  `frontend/src/components/billing/*`, `frontend/src/components/ConfirmDialog.tsx`.
- `crm-api/app/main.py`, `worker.py`, `runners.py`: routing/index/job registration.
- `backend/src/modules/ai-brain/payment-followup.client.ts` and `payment-followup.service.ts`.
- `backend/src/modules/whatsapp/delivery/payment-message.guard.ts` and delivery service.
- Both backends' conversation/message models and commitment/outbound handling were extended.
- Focused Python tests: billing profile, invoice domain/numbering/PDF/service, payments,
  Razorpay, invoice payment chase. Node tests cover owner bridge and final delivery cancellation.
- `crm-api/tools/check_billing_mongo.py`: explicit disposable-localhost integration check.

## Validation history — distinguish snapshot from current working tree

The completed Phase 5 snapshot passed:

- Python: **14,460 passed, 28 skipped**, 532 seconds.
- Node: **3,510 passed**, 150 files.
- Backend TypeScript build, frontend production build, and scoped Node ESLint checks passed.
- Real disposable MongoDB 8: financial indexes, concurrent payment deduplication, crash
  recovery, cash payments, active-link uniqueness, concurrent owner approvals queueing once,
  and ledger payment blocking queued reminders. Test database/container removed afterward.
- Frontend retains its existing bundle-size warning.
- No live Razorpay charges or WhatsApp messages sent. No production deployment performed.

Evidence logs: `crm-api/phase5-full-suite.log`, `backend/phase5-full-suite-confirmed.log`,
`backend/phase5-promise-test.log`, `backend/phase5-lint.log`, `backend/phase5-build.log`,
`frontend/phase5-build-confirmed.log`. Logs can be ignored by Git; do not commit artifacts.

### After Phases 6 and 7 (19 November 2026)

- Python `crm-api`: **14,536 passed, 28 skipped**, 416 seconds, 0 failed.
  Phase 6 contributed 76 tests — 48 on the calendar arithmetic (month ends, leap years, the
  day-31 rule, advancing from the occurrence) and 28 on the repository, service and sweep
  (claim/lease, period-key idempotency, concurrent runs, failure isolation).
- Frontend: **991 passed across 83 files**, 0 failed. Phase 7 contributed 145 of those, in
  `src/tests/billing-*.test.tsx|ts` — permissions, money formatting, the payments ledger,
  invoice list and detail, the invoice form, recurring schedules, and Razorpay.
- Frontend `tsc --noEmit` clean; `npm run build` succeeded (the pre-existing bundle-size
  warning remains, unchanged by this work).
- One real defect was found and fixed by running these: `test_runners.py` asserts the exact set
  of registered runner names, and Phase 6 added one. That assertion is doing its job — if it
  fails again, a runner was registered or removed, which is worth noticing.
- Node `backend` was not re-run for Phases 6 and 7: neither phase touches Node. Its last
  confirmed figure is the Phase 5 one above.
- No live Razorpay calls, no WhatsApp messages, no deployment, no commits, no production data
  touched. `frontend/vite.config.ts` was not modified.

### The Razorpay duplicate-path question is RESOLVED

The handover above flagged `razorpay_public.py`, `razorpay_reconcile.py` and the singular
`payment-link`/`reconcile` routes in `routers/invoices.py` as needing reconciliation. That was
done. The outcome:

- The tested, documented flow is the one in `RAZORPAY.md`: plural
  `GET|POST /api/v1/invoices/{id}/payment-links`, plus
  `POST .../payment-links/{linkId}/reconcile` and `/cancel`, and the public webhook at
  `POST /api/v1/payments/razorpay/webhook/{token}` served by `razorpay_routes.public_router`.
- A parallel set of untested duplicates had been written alongside it and, because it was
  registered first, the duplicate webhook route was SHADOWING the tested one. The duplicates
  were removed; the tested flow is untouched and remains authoritative.
- Verified afterwards: duplicate-route scan reports none, and the Python suite returned to the
  Phase 5 figure exactly (14,460) before Phase 6 added to it.

There is now one authoritative financial flow. If a second one appears again, delete the new
one rather than the documented one.

## Remaining work, in order

The 19 November release-readiness update below supersedes the earlier snapshot. See
`PAYMENT-RELEASE.md` for exact acceptance, deployment, rollback, migration findings and limits.

1. Select the authoritative payment-bot export and determine whether its historical records
   are real/current enough to migrate. Local backup data exists; no migration has run.
2. Complete controlled Razorpay TEST-mode and approved WhatsApp-recipient acceptance in an
   isolated workspace, including webhook replay, partial collection and missed-webhook recovery.
   No real provider requests were made in the local checks.
3. Review scoped commits, excluding `frontend/vite.config.ts`, secrets and artifacts. Commit,
   push, deploy and rebuild the APK only when explicitly instructed. None has been done here.

## Local commands and configuration

Windows PowerShell; use `npm.cmd`/`npx.cmd` to avoid script-policy issues.
From `crm-api`: `.\venv\Scripts\python.exe -m pytest -q --tb=short`.
From `backend`: `npm.cmd test`, `npm.cmd run build`.
From `frontend`: `npm.cmd run build`.
PowerShell can misrepresent native stderr warnings when redirecting; `cmd /c` with exit-code
capture was used to confirm successful frontend build and final Node test exits.

Gateway mode: `WHATSAPP_GATEWAY_ONLY=true`; Node `CRM_API_URL` defaults to
`http://127.0.0.1:5002`. Shared `WHATSAPP_GATEWAY_SERVICE_KEY`, or existing
`AI_BRAIN_SERVICE_KEY` fallback. Internal owner bridge: `/internal/v1/payments/owner-reply`,
`X-Service-Key`; keep `/internal/*` off public ingress. Never paste secrets into chat/logs.

Available backups beside the repository in `final project 1`:
`Vistaar-before-razorpay-phase4-20261118T182449Z.zip` and
`Vistaar-before-phase5-20261118T184959Z.zip`. They predate the later work and are not a
replacement for backing up the CURRENT dirty tree before further changes.

## Separate earlier requests, outside this merge

The general sales follow-up restarting after a client replies and then goes quiet was deferred;
the invoice payment chase is not a blanket fix for that sales-follow-up issue. Separate
category-specific agents were discussed but not established as completed in this merge.
Do not claim either requirement is done without inspecting its own implementation.


## Release-readiness completion ? 19 November 2026

Continued Claude's unfinished changes; backed up the dirty tree to
`../Vistaar-before-release-readiness-20261119T080801Z.zip`. Existing source, environment files
and the user's separate `frontend/vite.config.ts` change were preserved. HEAD remains a472fc8;
no commit, push, deployment, source migration or APK build was performed.

Completed/fixed:

- Legal recurring partial index and sequential recurring-number retry recovery; verified on real
  MongoDB 8. Both HTTP and worker now call the shared `app/billing_indexes.py`, including recurring
  indexes, and refuse startup if financial indexes fail. Startup regression tests added.
- Finished recurring template edit/history paths and manual payment attempt idempotency end to
  end. Recognize completed attempts before checking the new balance and recover interrupted
  ledger/cache writes. Distinct attempt details conflict; concurrent identical full payments
  produce one credit. Frontend retains the same key for an uncertain retry.
- Preserve extra recurring lines, quantity, discounts, bill-to identity, notes and terms when
  editing the compact form; retain zero-day terms and original invoice references on recovery;
  skip inactive organizations; moving a billing day earlier retains its pending month.
- Lease-token fencing protects newer workers from stale release/advance. Edits/pause during
  an active generation lease return a conflict for retry rather than racing the generator.
- Payment-link controls now match `creating`, `created`, `unknown` from the real API. Pending
  intents block competing links; failed history is visible and cannot authorize new creation;
  an uncertain provider result is not advertised as a usable link.
- Actual browser testing exposed the app header blocking invoice-dialog controls. Billing
  dialogs now portal above the shell, trap keyboard focus, handle Escape/topmost nesting and
  restore the opener. Added `useBillingModalFocus.ts`, keyboard tests and reproducible
  `frontend/tools/check-billing-browser.mjs` with all-local synthetic API/session traffic.

Validation:

- Full Python regression: **14,568 passed / 28 skipped**. This run preceded the final startup
  helper wiring and the small concurrent-manual-payment balance-race check. The final source
  then passed **197 focused Python tests**, including startup failure, billing indexes, recurring,
  payments, Razorpay, invoice chase and runner registration. No second full Python run is claimed.
- Node full suite: **3,510 passed**, production build passed.
- FINAL frontend full suite: **1,014 passed across 84 files**; **168 billing tests across 9 files**.
  Frontend production build and scoped ESLint passed. Existing bundle-size warning remains.
  The old Phase 7 narrative said 113; its own eight listed file counts total 145, now corrected.
- Real MongoDB integration passed concurrency, index legality, retry recovery, tenant/period
  isolation, backlog/failure limits, no-message/no-link generation, manual full-payment attempts,
  and owner approval/delivery-balance guards. Disposable databases/container cleaned up.
- Chrome desktop/mobile synthetic journey passed create/issue/PDF preview/payment, recurring
  edit, empty/failure states, read-only controls, settings secrets, mobile More navigation,
  keyboard focus/Escape and mobile horizontal-overflow checks. Screenshots inspected locally.
- Logs: `crm-api/release-full-suite.log`, `release-final-focused.log`, `release-mongo.log`;
  `backend/release-full-suite.log`, `release-build.log`; frontend `release-full-suite.log/json`,
  `release-build.log`, `release-lint.log`, `release-browser.log`. Keep artifacts out of commits.

Read-only migration assessment found the July source backup with 8 clients, 27 invoices,
1 recurring template and 0 payment rows, plus historical logs/messages. This is evidence of
records, not proof of current live data or whether they are demos. No remote database was
contacted. See PAYMENT-RELEASE.md for the dry-run mapping/reconciliation plan.

Remaining limits are documented, including possible number gaps on pre-insert interruption
or concurrent issued allocation, the compact first-line recurring editor, loaded-page invoice
search and absence of automatic refunds. Local tests do not replace real provider acceptance.


## Independent release verification — 19 November 2026 (second pass)

A separate pass over the same working tree, run against real infrastructure rather than mocks.
It reaches the same two conclusions as the section above about the index and the retry, and
adds independent evidence, two browser-only defects, and a CI guard. Nothing was committed,
pushed or deployed; `frontend/vite.config.ts` was not touched.

### Confirmed against MongoDB 8.2.12, not mongomock

A disposable `mongo:8` container (8.2.12) was used throughout, and removed afterwards. Two
defects were reproduced from first principles before being fixed, so the fixes are evidenced
rather than assumed:

- **`$ne` in a partial filter is rejected outright.** `create_index` raises
  `OperationFailure: Expression not supported in partial index`, which means the index does not
  exist — and neither does any index created after it in the same function. It hit
  `invoices.razorpayLinkId` AND the recurring uniqueness index, i.e. the one its own module
  docstring calls "the one that actually guarantees it". mongomock accepts `$ne`, so a fully
  green unit suite proved nothing here. Both now use `$type` (`"string"` / `"objectId"`), and
  all five billing index builders were re-probed against the real server and create cleanly.
- **A retry burned an invoice number.** `next_invoice_number` is an atomic `$inc`, so a number
  allocated before an insert that then hits the duplicate key is spent. Three retries produced
  three holes in a GST sequence. `generate_from_template` now checks for the period's existing
  invoice *before* allocating. This is not the uniqueness guarantee — the index still decides,
  and two genuinely simultaneous callers can still spend one number between them — it removes
  the gaps from the sequential retry path, which is the one that actually happens.

`crm-api/tools/check_billing_mongo.py` was extended to cover, on the real server: the unique
index existing and being unique (asserted by name, because `create_index` raising is the exact
failure being guarded); 20 concurrent generations producing exactly one invoice; crash-retry
duplicating neither invoice nor number; independence across tenants, templates and periods, with
ordinary null-template invoices coexisting; a three-month backlog billing one period per sweep;
a failing template claimed once per sweep rather than retried to the limit; generation queuing no
message and creating no payment link; and concurrent same-key manual payments crediting once,
with the key scoped per tenant.

### A CI guard, so this class of bug cannot return silently

`crm-api/tests/test_billing_index_specs.py` records the index specifications each builder would
send and asserts every `partialFilterExpression` uses only operators MongoDB permits
(`$eq $exists $gt $gte $lt $lte $type $and $or $in`). It also asserts the two load-bearing
unique indexes are requested at all, on the right collection, and partial rather than sparse.
The real-Mongo tool catches this only when somebody runs it with a database to hand; this runs
every time.

Not covered: `ensure_assistant_thread_indexes`, `ensure_assistant_usage_indexes` and
`ensure_google_calendar_indexes` take no database override, so they could not be probed. They
are pre-existing CRM code untouched by this merge and use no partial filters.

### Browser verification found two defects tests could not

Run against a real local stack — disposable replica-set MongoDB on 27118, `crm-api` on 5099,
Vite on 5174 with `VITE_API_PROXY_TARGET` (an env var, so `vite.config.ts` stayed untouched) —
seeded by the new `crm-api/tools/seed_billing_demo.py`. Both defects were invisible to jsdom,
which has no layout:

- **The recurring billing history squashed its own row.** The expanded panel was a third child
  of the row's `sm:flex-row`, so it competed for width and crushed "Monthly on day 5 · Sharma
  Weddings" into a two-word column on a 1440px screen. Row and history are now siblings in a
  column.
- **A line total was clipped on a phone.** The item table sat in `overflow-hidden`; at 375px the
  four columns overflow and the right edge of the figure was simply cut off. Now `overflow-x-auto`
  with `min-w-[22rem]` and non-wrapping amounts, and the summary below still repeats every total.

Verified working in the browser: desktop and mobile layouts; Billing in both navs; tabs with
correct `role="tablist"`/`aria-selected`; invoice list with en-IN grouping, status badges,
overpayment shown as overpaid rather than clamped, and Settled; detail with CGST+SGST on an
intra-state invoice; PDF download returning a real `%PDF-1.4` headed TAX INVOICE carrying the
*seeded tenant's* name and both GSTINs (so the multi-tenancy leak stays fixed); payment
recording including the server's own over-balance refusal and a clean retry afterwards; a voided
payment struck through with its reason; recurring list, expandable history, and an edit saving
through `PUT /recurring-invoices/{id}` without rewriting invoices already generated; Razorpay
settings disconnected with `Connect` disabled and both secret fields `type=password` and empty;
Escape closing a dialog; invoice rows being real buttons, so Enter activates them. A `manager`
(read-only) session showed no tab strip at all, no New invoice, and a detail dialog whose only
buttons were `×`, `View PDF` and `Close`.

### Two gaps against the Phase 7 brief, now closed

- **Recurring template editing** had no route. Added `PUT /api/v1/recurring-invoices/{id}`
  (`invoices.manage`, tenant-scoped) and `update_template_contents`. The client is deliberately
  NOT editable: a template owns a billing history and repointing it would reattribute one
  client's invoices to another. Moving the billing day recomputes from the PENDING occurrence,
  not from today — recomputing from today silently drops a period an overdue template was about
  to bill.
- **Generated-invoice history** had no way to be read. Added a `recurringTemplateId` filter to
  the existing invoice list rather than a second endpoint, so there is one place the organisation
  scope is applied. Verified a cross-tenant template id returns nothing.

### Validation (full runs, after every change above)

- Python `crm-api`: **14,571 passed, 28 skipped, 0 failed** (520s) — a genuine full run on the
  combined tree, superseding the partial claim in the previous section.
- Node `backend`: **3,510 passed across 150 files**; `npm run build` passed.
- Frontend: **1,015 passed across 84 files**; `tsc --noEmit` clean; `npm run build` passed with
  only the pre-existing bundle-size warning.
- Billing tests now number **169 across 9 files**: money 30, recurring 28, razorpay 27,
  invoice-form 20, invoice-detail 18, payments 17, permissions 14, invoice-list 12, modal 3.
- Real-MongoDB tool: all four PASS lines, disposable databases and both containers removed.

**Test-count correction.** The original Phase 7 summary said 113. That figure was stale — it
predated the last three test files. Its own listed per-file counts totalled 145 at the time, and
the current figure is 169. The 113 should not be quoted again.

## Billing UI fixes — 23 November 2026

### Status, by the only four words that matter

| | |
|---|---|
| **Implemented** | The three billing UI fixes below, with tests. |
| **Published** | Committed and pushed to `origin/main`. |
| **Deployed** | NOT YET at the time of writing. The previous deployment shipped `faa219b`, which predates these commits — so until a new frontend build is published to `/srv/vistaar`, production still has all three defects. |
| **Unverified** | Everything about the live system. No production host was contacted during this work: no SSH, no live database, no provider call. Any claim about what production is doing needs evidence gathered on the box. |

This is frontend-only. No backend application code changed, so the Python and Node results
below are reused unchanged from 19 November on the same HEAD.

### What was wrong, and what each fix actually does

**1. A refused payment locked somebody out of correcting it.**
The retry guard holds an idempotency key whenever an attempt's outcome is unknown, which is
right — hand-recorded money has no provider id, so a lost response plus a second press is how a
client gets credited twice. But the first cut released that key on *any* 4xx, and the version
before it released on none, so an ordinary over-the-balance typo left the person being told
"the previous payment may already have been recorded" when the server had just told them the
opposite.

The rule is now: a 4xx **except 408 and 429** proves the application answered and wrote nothing,
so the key is released and the figure can be corrected. A 408 is a timeout and a 429 may come
from a proxy in front of the app — in both cases an earlier attempt may still be in flight, so
the key is held. Everything else (no response, 5xx) is unknown by definition and holds.

That left one honesty problem: the message told people to reopen the form, and reopening did
nothing, because discarding a held attempt on a toggle is exactly how the double-credit gets
back in. So there is now a deliberate escape hatch — *Reload ledger and start a new payment* —
which fetches the ledger first, so the decision is made against evidence rather than a guess,
and only then releases the key. It says plainly that anything recorded afterwards is a separate
payment.

A `PAYMENT_ATTEMPT_CONFLICT` now also reloads the ledger (awaited before the message is set, or
`load` would clear the error off the screen) so the conflicting payment is visible rather than
merely described.

**2. A line total was clipped off the edge of a phone.**
The item table lived inside `overflow-hidden`, and at 375px four money columns do not fit, so
the right-hand edge of the figure was silently cut. The first attempt made it scrollable, which
is technically reachable and a poor way to show money — a scrollbar somebody has to discover.
Below `sm` each line is now stacked (description, `qty × rate`, total) so every column is on
screen at once; the table is kept for `sm:` and up. Rupee figures carry `whitespace-nowrap`
throughout, including the summary rows, because a figure broken across two lines reads as two
different numbers. Measured in a browser at 375px: zero horizontally-scrollable elements.

**3. The expanded invoice history crushed the schedule it belonged to.**
The history was a third child of the row's `sm:flex-row` line and competed for width, squashing
"Monthly on day 5 · Sharma Weddings" into a two-word column on a 1440px screen. Fixed with
`sm:flex-wrap` on the row plus `w-full` on the history, so it cannot fit beside its siblings and
takes a line of its own. Deliberately not an extra wrapper element — that would have re-indented
a hundred lines for a layout change.

### Validation

- Frontend: **1,031 passed across 84 files** (was 1,015), `tsc --noEmit` clean, `npm run build`
  passed with only the pre-existing bundle-size warning.
- Billing tests now **185 across 9 files**: money 30, recurring 31, razorpay 27, payments 26,
  invoice-detail 22, invoice-form 20, invoice-list 12, permissions 14, modal 3.
- Browser, at 375px and 1440px, against a synthetic mock API (no database, no provider, and the
  fixture deliberately lives outside the repository): the stacked line items show the full
  ₹1,77,000.00 with no overflow anywhere; the uncertain-outcome path shows the escape hatch,
  refuses a changed amount while the outcome is unknown, and after *Reload ledger* records the
  new payment under a fresh key; the recurring history spans its own full-width line with the
  schedule text intact.
- Backend reused, unchanged: Python **14,581 passed / 28 skipped**, Node **3,525 across 152
  files**. No backend code was touched.

### Tests worth not deleting

The layout tests assert structure, not pixels — jsdom has no layout, which is precisely why both
defects survived a green suite. They pin the two-variant item list and the full-width history on
a wrapping row, so collapsing either back to its broken shape fails. The payment tests cover
408/429/5xx holding the key, a definitive 4xx releasing it, the form toggle NOT releasing it,
and the reload-then-release path.

### Generated artifacts

`release-*.log` and `release-*.json` are now gitignored at the repository root, including one
level down. They are regenerated on every run and large enough to bury a real diff.

## User decision ? historical migration excluded

The user explicitly decided not to migrate the old payment project's historical data.
Phase 8 is intentionally skipped. Do not build/run an importer or copy old clients, invoices,
payments, templates or logs. Preserve the source project as-is. Earlier migration assessments
remain historical context only. Continue with the new CRM billing features and release steps;
GitHub publishing must follow the user's clarified instruction.
