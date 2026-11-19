# Sales follow-up restart repair

Implemented locally on 19 November 2026. This repairs general sales nurture, separately from
invoice payment reminders. The existing follow-up cadence and enablement settings are retained.

## Behavior

A new customer reply resets `nurtureStep` to zero atomically with `lastInboundAt` and clears the
superseded generic promise. An outgoing message does not reset the step. The silence schedule
waits for our response, then evaluates the existing two-hour/four-hour/local-slot cadence with
its existing limits. A reply or explicit owner resume gives the next sequence its own key.

Node ingestion already had the reset; Python's preview path was missing it. Both runtimes now
guard step/cold-state writes with the reply/resume timestamps read by the sweep. An older sweep
cannot overwrite a newer reply's reset or disable automation based on the expired old cycle.

A draft generated before a reply can finish afterward, so its queue creation timestamp alone
does not identify the stale work. Both delivery paths check the cycle embedded in its nurture
idempotency key, including immediately before the provider call. Stale-cycle work is cancelled
as `superseded_by_inbound`. Its enqueue also cannot stamp the newer conversation as answered.

Mongo's naive UTC dates are normalized before schedule comparisons. The outbound queue now
publishes the existing `OUTBOUND` realtime reason instead of the nonexistent `MESSAGE` key,
which previously raised after saving the message. Proposal-stage eligibility matches the
canonical pipeline stage names.

Opt-outs, service rejection, per-lead follow-up switches, pending promises and manual automation
pauses remain effective. This repair does not enable `NURTURE_ENABLED` globally, reopen cold or
closed leads, contact customers, import historical data, or change the invoice-payment sequence.

## Validation

Regression tests cover reply → AI response → silence → new step 1, distinct cycle keys, protected
manual pauses/opt-outs, stale step/cold writes, delayed enqueue, and replies arriving before or
during outbound delivery. Node's repository tests pin the cycle snapshot used by the database.

An isolated MongoDB 8 check confirmed reset/restart behavior using actual repository and queue
operations: 20 old-cycle writes were rejected, an old cold pause was refused, a delayed draft
could not fake a response to the new inbound, and the fresh sequence queued step 1. Only its
unique test database and dedicated container were removed; no live provider was called.

Logs: `crm-api/nurture-restart-focused.log`, `crm-api/nurture-restart-full.log`,
`backend/nurture-restart-focused.log`, `backend/nurture-restart-full.log`,
`backend/nurture-restart-build.log`, `backend/nurture-restart-lint.log`.

Final results: Python 14,581 passed / 28 skipped; Node 3,525 passed. Node production build,
TypeScript type-check and scoped ESLint passed. The disposable real-MongoDB check passed.

The server's effective configuration was not inspected in this task. Runtime follow-ups still
require the existing nurture/WhatsApp/delivery switches and per-lead eligibility to be enabled.
The user requested publication in six scoped, sequential GitHub pushes. Production deployment
is a separate step; no production configuration was changed during this repair.
