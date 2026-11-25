"""
Turning real CRM milestones into Conversions API events, and delivering them.

WHAT COUNTS AS A MILESTONE, AND WHAT DOES NOT. Every event here is driven by a state that
actually changed in this CRM:

  - `lead_received` when a Meta lead is imported. This is the "raw lead" event Meta asks for, and
    it is what makes Lead Coverage reach the 60% they require - without it, Meta sees qualified
    leads appearing for leads it was never told about.
  - `lead_qualified` / `lead_won` when the conversation stage changes. Not when somebody opens a
    thread, not when the AI replies.
  - `purchase` when MONEY ARRIVES - a row in the payment ledger. Deliberately NOT when an invoice
    is raised or issued. An invoice is a request for money; reporting it as a purchase would tell
    Meta a conversion happened every time the business asked to be paid, and would optimise the
    ad account toward people who are invoiced rather than people who pay.

DISABLED BY DEFAULT AND PER WORKSPACE. `record_milestone` is called from the ordinary CRM paths
and does nothing at all unless that organisation has connected a dataset AND enabled delivery AND
selected the milestone in question. A workspace that has never heard of CAPI pays one indexed
read for the organisation it had already loaded.

NOTHING HERE RAISES INTO A CRM REQUEST. A stage change must not fail because Meta is having a bad
afternoon, so every failure is swallowed into the queue and surfaced on the settings panel
instead.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from app import db
from app.capi_client import post_events
from app.capi_credentials import decrypt_access_token
from app.capi_events_repository import (
    EVENTS,
    MAX_ATTEMPTS,
    build_event_document,
    claim_batch,
    delivery_summary,
    enqueue,
    mark_failed,
    mark_sent,
    mark_state,
    organizations_with_pending,
    recent_failures,
)
from app.domain.capi_events import (
    BATCH_SIZE,
    EVENT_NAMES,
    build_event,
    event_id,
    hash_email,
    hash_phone,
    normalize_lead_id,
    payload_is_matchable,
    within_backfill_window,
)
from app.lead_sources_common import META_GRAPH_FAILURE_KINDS, MetaGraphError

logger = logging.getLogger("crm-api.capi")

#: How long to wait before retrying a transient failure. Grows with attempts so a Meta outage is
#: not hammered, capped so a recovered outage is not waited out for an hour.
RETRY_BACKOFF_SECONDS = (60, 300, 900, 1800, 3600, 3600)


def _retry_delay(attempts: int) -> int:
    index = min(max(0, attempts), len(RETRY_BACKOFF_SECONDS) - 1)

    return RETRY_BACKOFF_SECONDS[index]


async def _capi_config(organization_id: Any, database: Any) -> dict[str, Any] | None:
    """
    The organisation's CAPI settings, or None if this workspace is not sending anything.

    Returns None for every reason that means "do nothing": no dataset, no token, not enabled.
    The caller does not need to tell those apart - they all mean the same thing at the call site.
    """
    organization = await database["organizations"].find_one(
        {"_id": organization_id}, {"capi": 1}
    )

    capi = (organization or {}).get("capi") or {}

    if not capi.get("enabled"):
        return None

    if not capi.get("datasetId") or not capi.get("encryptedAccessToken"):
        return None

    return capi


async def capi_enabled_for(*, organization_id: Any, db_override: Any = None) -> bool:
    """
    Whether this workspace reports anything at all.

    Exists so a caller can skip gathering a contact's details for a workspace that has never
    connected a dataset - which is most of them. One indexed read answers it.
    """
    database = db_override if db_override is not None else db.get_database()

    return await _capi_config(organization_id, database) is not None


async def resolve_lead_id(
    *, organization_id: Any, conversation_id: Any, db_override: Any = None
) -> int | None:
    """
    The Meta lead id behind a conversation, if it came from a Meta form.

    READ FROM `lead_submissions`, which is where the importer already records it as `externalId`.
    Nothing is copied onto the conversation: duplicating an identifier means two places to keep
    in step, and this is read once per milestone, not per message.

    `externalId` is only a Meta lead id when the lead actually came from Meta - for a CSV or a
    sheet without one the importer stores a row hash instead. `normalize_lead_id` rejects those
    by shape, which is why a walk-in lead simply reports no lead id rather than reporting a hash
    as though it were one.
    """
    database = db_override if db_override is not None else db.get_database()

    submission = await database["lead_submissions"].find_one(
        {
            "organizationId": organization_id,
            "conversationId": conversation_id,
        },
        {"externalId": 1},
        sort=[("createdAt", -1)],
    )

    return normalize_lead_id((submission or {}).get("externalId"))


async def record_milestone(
    *,
    organization_id: Any,
    event_key: str,
    subject_id: Any,
    occurred_at: datetime | None = None,
    contact: dict[str, Any] | None = None,
    conversation: dict[str, Any] | None = None,
    lead_id: Any = None,
    value_paise: int | None = None,
    db_override: Any = None,
) -> dict[str, Any]:
    """
    Queues one milestone, if this workspace reports it.

    Returns `{"outcome": ...}` describing what happened, for tests and for the caller's logs:
    `queued`, `duplicate`, `disabled`, `not_selected`, `unmatchable`, or `expired`.

    `subject_id` IS WHAT MAKES THE EVENT ID STABLE. For a stage change it is the conversation; for
    a purchase it is the payment row. Two payments against one invoice are two purchases; the same
    payment replayed is one.
    """
    database = db_override if db_override is not None else db.get_database()

    if event_key not in EVENT_NAMES:
        raise ValueError(f"Not a reportable milestone: {event_key}.")

    capi = await _capi_config(organization_id, database)

    if capi is None:
        return {"outcome": "disabled"}

    if event_key not in set(capi.get("selectedEvents") or []):
        return {"outcome": "not_selected"}

    moment = occurred_at or db.utc_now()

    if not within_backfill_window(moment):
        # Older than Meta's 7-day window, or implausibly in the future. Recorded as expired rather
        # than queued, so the panel shows it was dropped and why instead of silently losing it.
        return {"outcome": "expired"}

    # The Meta lead id is the match key that actually works. The importer already knows it and
    # passes it directly; everything else looks it up from the lead submission behind the thread.
    resolved_lead_id = normalize_lead_id(lead_id)

    if resolved_lead_id is None and (conversation or {}).get("_id") is not None:
        resolved_lead_id = await resolve_lead_id(
            organization_id=organization_id,
            conversation_id=conversation["_id"],
            db_override=database,
        )

    identifier = event_id(
        organization_id=organization_id, event_key=event_key, subject_id=subject_id
    )

    payload = build_event(
        event_key=event_key,
        event_time=moment,
        event_id_value=identifier,
        lead_id=resolved_lead_id,
        # Hashed HERE, at enqueue time, so no plaintext email or phone is ever written to the
        # queue. A dump of `capi_events` is digests, not a customer list.
        hashed_email=hash_email((contact or {}).get("email")),
        hashed_phone=hash_phone((contact or {}).get("phone")),
        value_paise=value_paise,
    )

    if not payload_is_matchable(payload):
        # Meta rejects an event with nothing to match on. Queuing it would spend an attempt to
        # learn that, so it is recorded as unmatchable and counted on the panel - a workspace with
        # many of these has an attribution problem worth seeing.
        return {"outcome": "unmatchable"}

    document = build_event_document(
        organization_id=organization_id,
        event_id=identifier,
        event_key=event_key,
        event_time=moment,
        payload=payload,
        contact_id=(contact or {}).get("_id"),
        conversation_id=(conversation or {}).get("_id"),
        subject_id=subject_id,
        now=moment,
    )

    queued = await enqueue(document, db_override=database)

    if queued is None:
        return {"outcome": "duplicate", "eventId": identifier}

    return {"outcome": "queued", "eventId": identifier}


async def deliver_for_organization(
    *,
    organization_id: Any,
    client: Any = None,
    now: datetime | None = None,
    db_override: Any = None,
) -> dict[str, int]:
    """
    Sends one organisation's queued events, in small batches.

    SMALL BATCHES ON PURPOSE. Meta accepts a thousand per request and fails the WHOLE request on
    one malformed event, so a large batch turns a single bad row into hundreds of lost
    conversions. Fifty keeps the blast radius small enough that a retry is cheap.

    Never raises. A tenant whose token has been revoked must not stop every other tenant's events
    from being delivered.
    """
    database = db_override if db_override is not None else db.get_database()
    moment = now or db.utc_now()

    counts = {"sent": 0, "failed": 0, "expired": 0}

    capi = await _capi_config(organization_id, database)

    if capi is None:
        return counts

    token = decrypt_access_token(capi.get("encryptedAccessToken"))

    if not token:
        return counts

    batch = await claim_batch(
        organization_id=organization_id,
        limit=BATCH_SIZE,
        now=moment,
        db_override=database,
    )

    if not batch:
        return counts

    # Anything that aged out while queued is retired before the request is built, rather than
    # posted and rejected one event at a time.
    fresh: list[dict[str, Any]] = []
    stale: list[Any] = []

    for row in batch:
        if within_backfill_window(row["eventTime"], now=moment):
            fresh.append(row)
        else:
            stale.append(row["_id"])

    if stale:
        counts["expired"] += await mark_state(
            ids=stale,
            state="expired",
            reason="Older than Meta's 7-day backfill window before it could be delivered.",
            now=moment,
            db_override=database,
        )

    if not fresh:
        return counts

    try:
        report = await post_events(
            dataset_id=str(capi["datasetId"]),
            access_token=token,
            events=[row["payload"] for row in fresh],
            test_event_code=capi.get("testEventCode"),
            client=client,
        )
    except MetaGraphError as exc:
        attempts = max((row.get("attempts") or 0) for row in fresh)

        await mark_failed(
            ids=[row["_id"] for row in fresh],
            error=str(exc),
            # A credential that Meta has rejected will be rejected again in a minute. Back it off
            # to the maximum rather than retrying six times in ten minutes against a dead token.
            retry_in_seconds=(
                RETRY_BACKOFF_SECONDS[-1]
                if exc.failure_kind == META_GRAPH_FAILURE_KINDS.NEEDS_ATTENTION
                else _retry_delay(attempts)
            ),
            now=moment,
            db_override=database,
        )

        await _record_connection_error(
            organization_id=organization_id,
            message=str(exc),
            needs_attention=exc.failure_kind == META_GRAPH_FAILURE_KINDS.NEEDS_ATTENTION,
            database=database,
        )

        counts["failed"] += len(fresh)

        logger.warning(
            "Conversions API delivery failed: organization=%s kind=%s code=%s",
            organization_id,
            exc.failure_kind,
            exc.code,
        )

        return counts

    received = report.get("events_received")

    # A partial acceptance is recorded BEFORE the success path clears the error, because the
    # success path below resets `lastError` to None - writing the discrepancy first and then
    # clearing it is how a silent partial loss stays silent.
    partial = isinstance(received, int) and received < len(fresh)

    counts["sent"] += await mark_sent(
        ids=[row["_id"] for row in fresh], now=moment, db_override=database
    )

    delivered: dict[str, Any] = {"capi.lastDeliveredAt": moment}

    if partial:
        # A 200 that accepted fewer events than were sent is a silent partial loss. Meta does not
        # say WHICH it dropped, so the batch is marked sent - they were accepted as far as we can
        # tell - and the discrepancy is left on the panel instead of being cleared away.
        delivered["capi.lastError"] = (
            f"Meta accepted {received} of {len(fresh)} events in a batch. "
            "Check Events Manager diagnostics for rejected rows."
        )
        delivered["capi.lastErrorAt"] = moment
    else:
        delivered["capi.lastError"] = None
        delivered["capi.lastErrorAt"] = None

    await database["organizations"].update_one({"_id": organization_id}, {"$set": delivered})

    return counts


async def _record_connection_error(
    *, organization_id: Any, message: str, needs_attention: bool, database: Any
) -> None:
    """
    Puts Meta's own words on the settings panel.

    `needsAttention` is the difference between "Meta was busy, we will retry" and "your token is
    gone, nothing will work until you paste a new one". Only the second is worth interrupting
    somebody for, and conflating them trains people to ignore both.
    """
    changes: dict[str, Any] = {
        "capi.lastError": str(message)[:500],
        "capi.lastErrorAt": db.utc_now(),
    }

    if needs_attention:
        changes["capi.needsAttention"] = True

    await database["organizations"].update_one({"_id": organization_id}, {"$set": changes})


async def run_due_deliveries(
    *,
    limit: int = 25,
    client: Any = None,
    now: datetime | None = None,
    db_override: Any = None,
) -> dict[str, int]:
    """
    The sweep: every tenant that owes Meta anything, one batch each.

    ONE BATCH PER TENANT PER TICK, not everything they owe. A workspace that has just imported a
    thousand leads does not get to monopolise the runner, and whatever is left is still due on the
    next tick a minute later.
    """
    database = db_override if db_override is not None else db.get_database()
    moment = now or db.utc_now()

    totals = {"organizations": 0, "sent": 0, "failed": 0, "expired": 0}

    organizations = await organizations_with_pending(now=moment, db_override=database)

    for organization_id in organizations[: max(1, limit)]:
        totals["organizations"] += 1

        try:
            counts = await deliver_for_organization(
                organization_id=organization_id,
                client=client,
                now=moment,
                db_override=database,
            )
        except Exception as exc:  # noqa: BLE001 - one tenant must not stop the sweep
            logger.error(
                "Conversions API sweep failed for organization=%s %s",
                organization_id,
                type(exc).__name__,
            )
            continue

        for key in ("sent", "failed", "expired"):
            totals[key] += counts.get(key, 0)

    return totals


async def delivery_status(*, organization_id: Any, db_override: Any = None) -> dict[str, Any]:
    """What the settings panel shows: counts by state and the most recent failures."""
    database = db_override if db_override is not None else db.get_database()

    return {
        "counts": await delivery_summary(
            organization_id=organization_id, db_override=database
        ),
        "recentFailures": await recent_failures(
            organization_id=organization_id, db_override=database
        ),
        "maxAttempts": MAX_ATTEMPTS,
        "collection": EVENTS,
    }
