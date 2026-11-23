# Payment merge: release and rollback

> Publication update, 19 November 2026: the user requested this merge be versioned and
> published to GitHub in 20 sequential pushes. References below to local/uncommitted work
> describe the validation snapshots; use Git HEAD/origin/main for current publication state.
> Production deployment and historical-data migration have not been performed. Migration
> was explicitly excluded by the user.


Prepared 19 November 2026. This is a reviewable checklist, not a record of production actions.
The merge remains local, uncommitted and undeployed. No real payment or WhatsApp send was made.

## Readiness work completed

- Corrected illegal partial-index filters, and initialize every financial index from the shared
  `app/billing_indexes.py` in both HTTP and worker startup. Recurring uniqueness failure now
  prevents serving/running jobs; tests exercise both startup paths.
- Real MongoDB 8 verified concurrent recurring generation, post-insert crash retries without
  another invoice number, independent tenants/templates/periods, one overdue period per sweep,
  failure isolation and no outgoing messages/links. Manual full-payment and owner approval
  concurrency also verified against Mongo, not only mocks.
- Recurring edits/history and manual-payment idempotency finished. Identical retries recover
  after settlement or interrupted cached balance updates; changed attempt details conflict.
- Schedule edits preserve quantities, extra lines, discounts, billing identity, notes and terms.
  Zero-day due terms remain zero, inactive organizations are skipped, earlier billing-day edits
  keep the pending month, retry recovery retains the invoice reference, and lease tokens prevent
  an expired worker releasing/advancing a newer claim. Editing/pausing a leased template returns
  a retryable conflict rather than silently racing generation.
- Billing modals are portalled above the header/navigation. Focus enters the dialog, Tab wraps,
  Escape closes the top dialog when idle, and focus returns to its opener.
- Payment-link controls use the actual `creating`/`created`/`unknown` contract. An uncertain
  intent blocks another link; cancellation is offered for `created`. Failed history is visible
  and blocks creation; an uncertain create response is not described as a usable link.

## Validation evidence

- Full Python regression: `crm-api/release-full-suite.log`, 14,568 passed / 28 skipped.
  Subsequent startup wiring and the final payment race handling additionally passed the
  197-test focused run in `crm-api/release-final-focused.log`. The full Python run predates those
  last small changes; do not describe its count as a second full run of the final source.
- Node full suite: `backend/release-full-suite.log`, 3,510 passed; production build passed.
- Final frontend suite/build/lint: `frontend/release-full-suite.log`, `release-full-suite.json`,
  `release-build.log`, `release-lint.log`: 1,014 tests passed across 84 files, including
  168 billing tests across 9 files; build and scoped lint passed.
- Mongo integration: `crm-api/release-mongo.log`; accepts only an explicit disposable localhost
  URI and removes its own uniquely named test databases. Its dedicated container is removed
  after the check; unrelated existing containers are not modified.
- Actual Chrome journey: `frontend/tools/check-billing-browser.mjs`, `frontend/release-browser.log`.
  All API responses and the session are synthetic; external hosts are blocked. Exercises invoice
  create/issue/PDF preview/payment, schedule edit, empty/error states, read-only permissions,
  desktop/mobile navigation, keyboard focus/Escape and no horizontal mobile overflow.
  Screenshots are in the local temp directory `vistaar-release-browser-qa/artifacts`.
  The PDF check validates the UI request/preview path with synthetic bytes, not the production
  PDF renderer; invoice-PDF Python tests cover the renderer separately.
- Frontend bundle-size warning remains. Skipped Python tests are not counted as verified behavior.

### Superseding full runs — second pass, 19 November 2026

Every suite was re-run in full after further fixes (two browser-only layout defects, the
recurring edit/history endpoints, and an index-specification guard). These numbers describe the
CURRENT source and supersede the counts above, including the caveat about the Python run
predating the last changes:

- Python `crm-api`: **14,571 passed / 28 skipped / 0 failed**, 520s. A genuine full run of the
  final source.
- Node `backend`: **3,510 passed across 150 files**; `npm run build` passed.
- Frontend: **1,015 passed across 84 files**; `tsc --noEmit` clean; `npm run build` passed.
- Billing tests: **169 across 9 files** (money 30, recurring 28, razorpay 27, invoice-form 20,
  invoice-detail 18, payments 17, permissions 14, invoice-list 12, modal 3). An earlier summary
  claimed 113; that was stale by three files and should not be quoted.
- Real MongoDB **8.2.12**, disposable container, removed afterwards: the extended
  `crm-api/tools/check_billing_mongo.py` passes all four checks, now including recurring
  concurrency, crash-retry number preservation, tenant/template/period independence, backlog
  pacing, failed-template limits, no-message/no-link generation, and per-tenant manual payment
  attempt keys.
- A second browser pass drove the **real** `crm-api` against a disposable replica-set MongoDB
  with `crm-api/tools/seed_billing_demo.py` — so the PDF check exercised the production renderer
  end to end, returning a real `%PDF-1.4` headed TAX INVOICE with the seeded tenant's own name
  and both GSTINs. This complements, rather than replaces, the synthetic-response run above.

## Source-data assessment and migration plan

Read-only inspection found the source backup:
`C:/Users/LIKHITH GOWDA K/Desktop/vistaar-payment-bot/backups/data_backup_20260727_090502.json`.
It contains 8 clients, 27 invoices, 2 invoice items, 1 recurring template, 0 payment rows,
221 reminder logs, 46 call logs, 13 WhatsApp messages and 1 client reply. No customer values or
secrets were copied into this report. The discovered `.mypy_cache/*.db` files are developer
caches, not business databases. No local business SQLite database was found in that inspection.

This proves historical records exist, not that they are current, real rather than demo, or the
complete live database. No remote source database was contacted. Before migration, the owner
must select the authoritative export and destination workspace and decide whether historical
records should be imported. Never assume this July backup is today's ledger.

### Second-pass read-only evidence, 19 November 2026

A later pass over the same file counted aggregate properties only — no names, numbers, emails,
tokens or amounts per client were read out. Every signal points the same way: **this export
looks like development data, not a live book of business.**

- **6 of the 8 clients** carry `test`, `demo`, `sample` or `dummy` in their name, company or
  email; 8 clients share only **6 distinct phone numbers**.
- **Not one client has a GSTIN**, which an Indian B2B book billing GST would not look like.
- Invoice amounts run from **₹1.00** to ₹50,000 across 27 invoices totalling ₹1,75,539.
- Invoice numbers are inconsistent in a telling way: 19 well-formed, but also `VIS-TEST-###`
  and four carrying random hex tails (`VIS-####-#A#CD#`). Those tails are the source project's
  own give-up fallback, which `invoice_numbering.py` documents and this CRM deliberately
  replaced — a real issued invoice should never look like that.
- **The payments table is empty (0 rows)** even though 3 invoices are marked paid, and there
  are only 2 line items for 27 invoices. There is no payment history to migrate.
- Records span **3 June – 27 July 2026**, about eight weeks, and the repository's last commit is
  **19 August 2026** — three months before this assessment.

**What remains unknown, and cannot be resolved locally.** The project's `DATABASE_URL` points at
a hosted Supabase Postgres pooler (endpoint deliberately not reproduced here; read it from that
project's own `.env` if it is ever needed), not a local database. There is no local volume or
container for it: its Compose project (`vistaar`,
`pgvector/pgvector:pg16`) has no container and no `vistaar_*` volume on this machine, and the
running `vistaar-agent-*` Postgres is a different application entirely (its tables are `leads`,
`proposals`, `service_plans`, `wa_lines` — no `invoices` or `clients`). So the July backup is
the only local evidence, and whatever the hosted database holds today is unknown. That question
can only be answered by a read-only query against that hosted instance, which this assessment
deliberately did not run: it would mean using live credentials against a remote service.

**Note a possible conflict.** The section at the end of this document records a user decision to
exclude historical migration entirely. The assessment above was produced because a later
instruction asked for a read-only Phase 8 assessment. Both are satisfied — nothing was migrated
and no remote database was contacted — but if the standing decision holds, the dry-run plan
below stays unbuilt. Confirm with the owner before treating either as current.

If migration is wanted, implement a dry-run-first importer:

1. Preserve the export and validate its schema, financial sums, identifiers and timestamps.
   Report malformed/missing line items and duplicate invoice numbers; never invent missing data.
2. Normalize source phones using the CRM utility and match existing contacts through its blind
   index. Require unique matches; report unmatched/ambiguous clients without creating duplicates.
3. Keep a tenant-scoped mapping keyed by source-project identity plus original record ID. A retry
   must reuse the same mapping and financial records, never count money twice.
4. Convert money with Decimal/integer-paise rules. Reconcile original persisted/PDF totals before
   importing history; flag discrepancies instead of silently recalculating historical invoices.
5. Preserve issued numbers and status, seed each tenant/year counter using its highest existing
   sequence, and preserve a source audit reference. Reconcile imported ledger/cache/status.
6. Import recurring schedules paused for review. Do not reactivate reminders, stale queued
   messages, payment links, call logs or a second scheduler from the old bot.
7. Review a dry-run report and backup/restore rehearsal before any explicitly authorized write.

No migration has been implemented or executed by this readiness task.

## Remaining acceptance before real activation

Use an isolated workspace/staging deployment and Razorpay TEST credentials first. A test-mode
provider request still leaves the local machine: none has been made in this task.

- Configure the per-workspace keys through `PUT /api/v1/settings/razorpay` or Billing Settings.
  Confirm secret fields remain empty after saving. Preserve the existing CRM encryption key.
- Configure the returned webhook path under the staging HTTPS origin, with the exact matching
  webhook secret and the events documented in `RAZORPAY.md`.
- Complete a controlled test payment, partial collection, webhook redelivery, missed-webhook
  reconciliation, cancellation after payment, and ledger/invoice/PDF balance agreement.
- Validate owner pending/collected, opt-out, manual takeover, quiet hours and Cloud closed-window
  behavior through the existing delivery queue using approved test recipients. No new sender.
- Check persistence/restart recovery on the deployed API and worker, not only the browser mocks.
- Confirm migration scope and any pre-existing financial rows/index conflicts before release.

Known limits: sequential retries after invoice insertion reuse its number, but allocation and
insertion are separate writes, so an interruption before insertion or concurrent issued
generation can leave sequence gaps; uniqueness prevents duplicate numbers/invoices. Generated
drafts remain the default. The compact recurring editor edits its first line and preserves other
lines/fields; use the API for changes it does not expose. Invoice list search is over the loaded
50-row page. Refund automation is not included. These limits must not be described as completed
features or as a gap-free accounting sequence.

## Deployment order — only after explicit release instruction

The actual topology is `deploy/Caddyfile`: ordinary `/api/*` goes to Python 5002; WhatsApp routes
go to Node 5001; static frontend is `/srv/vistaar`. Python `crm-api` and `crm-worker` use Compose;
the previously deployed Node process is the `vistaar` systemd service.

1. Review the entire dirty tree, choose scoped commits, exclude `frontend/vite.config.ts` and
   test artifacts/secrets, then publish the approved revision. Record its SHA and previous SHA.
2. Before changing the server, back up `/srv/vistaar`, deployed Node `backend/dist`, Compose
   files/override, both environment files, and `/etc/caddy/Caddyfile` into a private archive.
   Take a consistent, authenticated Mongo backup using the server's existing backup workflow;
   include counters, invoices, payments, links and recurring templates. Preserve encryption keys
   privately. Record existing API/worker image IDs and retain/tag them for rollback.
3. Pull the exact approved revision. Build Node, frontend with `VITE_API_BASE_URL=/api/v1`, and
   `crm-api`/`crm-worker` images before replacing running services. Install the changed Python
   dependencies through image build; do not rely on the host virtualenv.
4. Compose commands use `--env-file .env --env-file backend/.env`. Recreate only `crm-api` and
   `crm-worker`; retain Mongo/Redis volumes. Restart `vistaar` for the Node gateway changes.
   Verify financial index creation succeeds; resolve conflicting legacy data deliberately rather
   than dropping indexes to make startup pass. Use one dedicated worker; keep API background
   runners disabled. Retain existing scheduling settings deliberately.
5. Publish frontend assets before atomically replacing `/srv/vistaar/index.html`. Retain old
   hashed assets for cached clients. No Caddy change is needed for billing routes. Keep
   `/internal/*` excluded from public ingress. Confirm the gateway service key matches Python
   and Node; `CRM_API_URL` defaults to `http://127.0.0.1:5002`.
6. Check service readiness, authenticated tenant/permission behavior, PDF storage mount
   (`./var/media:/app/var/media` on API/worker), browser/APK API origin and the acceptance cases
   above. Rebuild the APK after the web/backend release if requested. No APK was built here.

### Verifying the financial indexes actually exist after deploy

Step 4's "verify financial index creation succeeds" is the single most important post-deploy
check, and it is cheap. `ensure_billing_indexes` is called without a `try` in `app/main.py`, so
the API refuses to start if any index fails — but confirm the indexes are *present*, not merely
that the process came up, because a pre-existing deployment may have started before that guard
was added:

```
db.invoices.getIndexes()   // expect organizationId_1_invoiceNumber_1 (unique, partial on $type string)
                           // and organizationId_1_recurringTemplateId_1_recurringPeriod_1 (unique)
db.payments.getIndexes()   // expect unique partial indexes on providerPaymentId, providerLinkId
                           // and idempotencyKey
```

If the recurring index is missing on a database that already holds generated invoices, creating
it can fail on existing duplicates. Resolve those deliberately — decide which invoice is real —
rather than dropping the index to make startup pass. Without it the only thing standing between
a retried sweep and a double-billed client is the lease, which is exactly the fail-open lock
this design was built to avoid.

### Reproducing the local verification stack

Both tools refuse anything but an explicit `mongodb://127.0.0.1:PORT` and never read
`MONGODB_URI`, so neither can be pointed at a real tenant by accident.

```
docker run -d --name vistaar-mongo-check -p 127.0.0.1:27117:27117 mongo:8 --port 27117 --bind_ip_all
cd crm-api && ./venv/Scripts/python.exe -m tools.check_billing_mongo --uri mongodb://127.0.0.1:27117
```

For the UI, a replica set is required (`crm-api` expects `replicaSet=rs0`):

```
docker run -d --name vistaar-mongo-rs -p 127.0.0.1:27118:27118 mongo:8 --replSet rs0 --port 27118 --bind_ip_all
docker exec vistaar-mongo-rs mongosh --port 27118 --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27118"}]})'
cd crm-api && ./venv/Scripts/python.exe -m tools.seed_billing_demo --uri mongodb://127.0.0.1:27118
```

Then run `crm-api` against it and point Vite's proxy at it with an environment variable, so
`frontend/vite.config.ts` is never edited:

```
cd crm-api && MONGODB_URI="mongodb://127.0.0.1:27118/vistaar_billing_demo?replicaSet=rs0" JWT_ACCESS_SECRET=local-only ./venv/Scripts/python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 5099
cd frontend && VITE_API_PROXY_TARGET="http://127.0.0.1:5099" npx vite --port 5174
```

Sign in at `http://localhost:5174` as `admin@demo.test` or `manager@demo.test` (read-only),
password `DemoPassword123!`. Razorpay is deliberately left unconnected: proving a connection
means calling Razorpay. Remove both containers when finished.

## Rollback

Stop new billing activity and the dedicated worker if financial writes are suspect. Restore the
previous frontend index/assets and Node dist, restart `vistaar`, and recreate API/worker using
the retained previous images. Keep the current financial database and audit records unless an
explicitly reviewed restore plan calls for replacement: restoring an older database can erase
payments received after its snapshot. Reconcile provider events/ledger before resuming jobs.
Do not delete new collections, reset invoice counters, drop safety indexes, rotate encryption
keys or use `docker compose down -v` as a rollback shortcut. Preserve failed-release logs and
the exact code/image IDs for diagnosis.


## User decision ? historical migration excluded

The user explicitly decided not to migrate the old payment project's historical data.
Phase 8 is intentionally skipped. Do not build/run an importer or copy old clients, invoices,
payments, templates or logs. Preserve the source project as-is. Earlier migration assessments
remain historical context only. Continue with the new CRM billing features and release steps;
GitHub publishing must follow the user's clarified instruction.
