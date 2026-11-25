"""
Where CRM state changes become Conversions API milestones.

A SEPARATE MODULE SO THE CALL SITES STAY ONE LINE. The repository and the payment service should
not grow an understanding of Meta's funnel; they should say "this stage changed" and "this money
arrived" and be done.

NOTHING HERE EVER RAISES. A stage change must not fail because Meta's queue collection is
unreachable, and a payment must not be refused because a conversion could not be recorded. Every
failure is swallowed and logged; the conversion is lost rather than the payment, which is the
right way round.

THE STAGE MAP IS DELIBERATELY SMALL. Of eight pipeline stages only two are reported, because Meta
models a funnel and not a kanban board: `qualified` is the stage most advertisers optimise toward,
and `won` is the commitment that precedes money. `contacted`, `proposal_sent` and `negotiation`
are activity rather than qualification, and reporting them would train the ad account on busyness.
`lost` and `closed` are not conversions at all.
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

logger = logging.getLogger("crm-api.capi-hooks")

#: CRM pipeline stage -> the milestone reported to Meta. Stages absent from this map report
#: nothing, which is the common case.
STAGE_MILESTONES = {
    "qualified": "lead_qualified",
    "won": "lead_won",
}


async def on_stage_changed(
    conversation: dict[str, Any] | None,
    *,
    stage: str,
    db_override: Any = None,
) -> None:
    """
    Reports a pipeline stage that Meta cares about.

    `subject_id` IS THE CONVERSATION PLUS THE STAGE, so a thread moved to `qualified`, back to
    `contacted`, and forward to `qualified` again reports one qualification rather than two. The
    lead did not qualify twice because somebody corrected a mis-click.
    """
    milestone = STAGE_MILESTONES.get(stage)

    if milestone is None or not conversation:
        return

    try:
        # Imported here, not at module scope: this module is imported by the conversations
        # repository, and the service pulls in the Graph client and httpx.
        from app.capi_service import capi_enabled_for, record_milestone

        # Asked FIRST, so a workspace that has never connected a dataset pays one indexed read
        # rather than also loading a contact nobody is going to report.
        if not await capi_enabled_for(
            organization_id=conversation.get("organizationId"), db_override=db_override
        ):
            return

        contact = await _load_contact(
            organization_id=conversation.get("organizationId"),
            contact_id=conversation.get("contactId"),
            db_override=db_override,
        )

        await record_milestone(
            organization_id=conversation.get("organizationId"),
            event_key=milestone,
            subject_id=f"{conversation.get('_id')}:{stage}",
            occurred_at=conversation.get("updatedAt"),
            contact=contact,
            conversation=conversation,
            db_override=db_override,
        )
    except Exception as exc:  # noqa: BLE001 - a stage change must never fail over this
        logger.warning(
            "Could not record a Conversions API milestone for stage=%s: %s",
            stage,
            type(exc).__name__,
        )


async def on_lead_imported(
    *,
    organization_id: Any,
    conversation: dict[str, Any] | None,
    contact_id: Any,
    external_id: Any,
    occurred_at: datetime | None = None,
    db_override: Any = None,
) -> None:
    """
    Reports a Meta lead arriving — the "raw lead" event Meta asks for.

    THIS IS WHAT MAKES LEAD COVERAGE WORK. Meta measures the share of leads it can match to an
    uploaded event and requires 60%; reporting only qualifications means it sees conversions for
    leads it was never told existed, and the figure stays on the floor.

    `external_id` comes straight from the importer, which already has it. It is only a Meta lead
    id when the lead actually came from Meta - a sheet or CSV import stores a row hash in the same
    field - and `normalize_lead_id` rejects those by shape, so a non-Meta lead reports nothing
    rather than reporting a hash as though it were a lead id.
    """
    if not conversation:
        return

    try:
        from app.capi_service import capi_enabled_for, record_milestone

        if not await capi_enabled_for(
            organization_id=organization_id, db_override=db_override
        ):
            return

        contact = await _load_contact(
            organization_id=organization_id,
            contact_id=contact_id,
            db_override=db_override,
        )

        await record_milestone(
            organization_id=organization_id,
            event_key="lead_received",
            # The conversation, so a resubmission of the same form does not report a second lead.
            subject_id=f"{conversation.get('_id')}:lead_received",
            occurred_at=occurred_at,
            contact=contact,
            conversation=conversation,
            lead_id=external_id,
            db_override=db_override,
        )
    except Exception as exc:  # noqa: BLE001 - a lead must import regardless
        logger.warning(
            "Could not record a Conversions API lead event: %s", type(exc).__name__
        )


async def on_payment_recorded(
    *,
    organization_id: Any,
    payment: dict[str, Any],
    invoice: dict[str, Any],
    db_override: Any = None,
) -> None:
    """
    Reports money that actually arrived.

    DRIVEN BY THE LEDGER, NOT BY AN INVOICE. An invoice is a request for money; reporting one as
    a purchase would tell Meta a conversion happened every time the business asked to be paid,
    and would optimise the ad account toward people who get invoiced rather than people who pay.

    `subject_id` is the PAYMENT row, so a part payment followed by the balance is two purchases -
    which is what they are - while the same payment replayed after a crash is one.
    """
    try:
        from app.capi_service import capi_enabled_for, record_milestone

        if not await capi_enabled_for(
            organization_id=organization_id, db_override=db_override
        ):
            return

        conversation = await _load_conversation(
            organization_id=organization_id,
            conversation_id=invoice.get("conversationId"),
            db_override=db_override,
        )

        contact = await _load_contact(
            organization_id=organization_id,
            contact_id=invoice.get("contactId"),
            db_override=db_override,
        )

        await record_milestone(
            organization_id=organization_id,
            event_key="purchase",
            subject_id=str(payment.get("_id")),
            occurred_at=payment.get("paidAt"),
            contact=contact,
            conversation=conversation,
            value_paise=int(payment.get("amountPaise") or 0),
            db_override=db_override,
        )
    except Exception as exc:  # noqa: BLE001 - a payment must never fail over this
        logger.warning(
            "Could not record a Conversions API purchase: %s", type(exc).__name__
        )


async def _load_contact(
    *, organization_id: Any, contact_id: Any, db_override: Any = None
) -> dict[str, Any] | None:
    """
    The contact's email and phone, for Meta's fallback match keys.

    READ ONLY WHEN A MILESTONE IS ACTUALLY BEING REPORTED - the caller checks `capi_enabled_for`
    before getting here, so a workspace that has not connected a dataset never pays for this.
    """
    if contact_id is None:
        return None

    from app import db

    database = db_override if db_override is not None else db.get_database()

    return await database["contacts"].find_one(
        {"_id": contact_id, "organizationId": organization_id},
        {"email": 1, "phone": 1},
    )


async def _load_conversation(
    *, organization_id: Any, conversation_id: Any, db_override: Any = None
) -> dict[str, Any] | None:
    if conversation_id is None:
        return None

    from app import db

    database = db_override if db_override is not None else db.get_database()

    return await database["conversations"].find_one(
        {"_id": conversation_id, "organizationId": organization_id}, {"_id": 1}
    )
