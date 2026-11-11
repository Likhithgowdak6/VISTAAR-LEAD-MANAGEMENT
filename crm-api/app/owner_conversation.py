"""
The owner's own thread with the assistant.

Every message the AI sends the studio owner — reminders, digests, call escalations, calendar
alerts — and every reply the owner types back, recorded in the SAME `conversations` and
`messages` collections a customer thread uses, so the Inbox can render it with no new UI.

----------------------------------------------------------------------------------------------
WHY THIS DID NOT EXIST ALREADY
----------------------------------------------------------------------------------------------
Both directions deliberately short-circuit the normal pipeline:

  - `owner_notify.notify_owner()` sends straight down the socket. No conversation, no message.
  - `inbound_router` spots the owner (own number, or `isSelfChat`) and hands off to
    `handle_owner_self_chat_reply`, then RETURNS — it never reaches `ingest()`.

That was correct when owner messages were fire-and-forget alerts. It stops being correct the
moment you want to read the exchange back, which is what this module adds.

----------------------------------------------------------------------------------------------
THE DANGEROUS PART IS NOT WRITING THE ROWS. IT IS EVERYTHING THAT READS THEM
----------------------------------------------------------------------------------------------
`analytics_pipelines.build_conversation_match` is `{organizationId, deletedAt: None}` and
nothing else. Every analytics card, stage breakdown and response-time figure counts every
conversation in the organisation. An owner thread landing in that collection would be counted
as a lead — one that never converts, replies instantly, and drags every average with it.

So this conversation carries `kind: "owner_assistant"`, and the analytics match excludes it.
`kind` is ADDITIVE: no existing conversation has the field, so `{"kind": {"$ne": ...}}` leaves
every customer thread matching exactly as before.

**`aiIntent: non_lead` IS NOT ENOUGH ON ITS OWN**, which is the trap worth naming. It reads like
the right field — the owner is genuinely not a sales lead — but only `find_nurturable_conversations`
consults it. Analytics never does. A future reader reaching for `non_lead` instead of `kind`
would silently reintroduce the miscount.

----------------------------------------------------------------------------------------------
THE AI MUST NEVER TRY TO SELL TO THE OWNER
----------------------------------------------------------------------------------------------
The created conversation is pinned with automation off, nurture off, intent `non_lead` and no
`autoGreetDueAt`. Each one independently keeps a different sweep away:

  - `aiAutomationEnabled: False` and `nurtureEnabled: False` -> the nurture sweep skips it
  - `aiIntent: "non_lead"`                                   -> the nurture sweep skips it again
  - `autoGreetDueAt` absent                                  -> the auto-greet sweep skips it

Belt and braces on purpose. The failure being prevented is the assistant chasing the owner with
"just following up on your wedding enquiry!", which is the kind of thing that gets noticed by
the person who pays for the software.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from bson import ObjectId

from app import db
from app.contacts_repository import find_or_create_contact_by_provider_key
from app.conversations_repository import upsert_conversation_for_contact

logger = logging.getLogger("crm-api.owner-conversation")

CONVERSATIONS = "conversations"
MESSAGES = "messages"

#: The discriminator every reader uses to tell this thread from a customer's.
OWNER_ASSISTANT_KIND = "owner_assistant"

#: Shown in the Inbox list and the thread header.
OWNER_ASSISTANT_DISPLAY_NAME = "Owner Assistant"

#: `senderType` on messages the assistant sends. Distinct from `user` (a human teammate typing)
#: so the Inbox can label the bubble without guessing from `authoredBy` alone.
SENDER_TYPE_ASSISTANT = "assistant"


def owner_provider_contact_key(owner_number: Any) -> str | None:
    """
    The contact key for the owner's handset.

    Built from the digits of the configured owner number, exactly as `owner_jid_from_config`
    does, so the contact this creates is the same one an inbound message from that number
    resolves to. Diverging here would give the owner two contacts and two threads — one written
    by the outbound path, one by the inbound — which is the specific duplicate this module
    exists to avoid.
    """
    if not owner_number:
        return None

    digits = re.sub(r"\D", "", str(owner_number))

    return digits or None


async def ensure_owner_conversation(
    *,
    organization_id: Any,
    whatsapp_account_id: Any,
    owner_number: Any,
) -> dict[str, Any] | None:
    """
    Finds or creates the owner's assistant thread. Safe to call on every message.

    ATOMIC, NOT READ-THEN-WRITE. `find_or_create_contact_by_provider_key` and
    `upsert_conversation_for_contact` both resolve races in the database — the latter with
    `$setOnInsert` on `(organizationId, whatsappAccountId, contactId)`. Two reminders firing in
    the same second therefore produce one thread, not two. That matters because the daily jobs
    all run at the same minute.

    Returns None when no owner number is configured — the caller carries on without recording,
    rather than failing a delivery that would otherwise have succeeded.
    """
    provider_key = owner_provider_contact_key(owner_number)

    if not provider_key or not organization_id or not whatsapp_account_id:
        return None

    contact_result = await find_or_create_contact_by_provider_key(
        organization_id=organization_id,
        provider_contact_key=provider_key,
        display_name=OWNER_ASSISTANT_DISPLAY_NAME,
        phone=str(owner_number),
        source="owner_assistant",
    )

    contact = contact_result.contact

    return await upsert_conversation_for_contact(
        organization_id,
        whatsapp_account_id,
        contact.get("_id"),
        lead_id=contact.get("leadId"),
        display_name=OWNER_ASSISTANT_DISPLAY_NAME,
        defaults={
            # The discriminator. See the module docstring - analytics excludes on this and
            # nothing else is reliable.
            "kind": OWNER_ASSISTANT_KIND,
            # Four independent brakes on the automation sweeps.
            "aiAutomationEnabled": False,
            "aiAutomationPausedReason": "Owner assistant thread - the AI never qualifies this.",
            "nurtureEnabled": False,
            "aiIntent": "non_lead",
            # Not a sales lead, so it has no meaningful position in the pipeline. `stage` is
            # required by the schema; `lost` would be a lie and `new` invites a human to work
            # it, so it is parked in `closed` where the inbox's default filters leave it alone.
            "status": "closed",
        },
    )


async def record_owner_message(
    *,
    organization_id: Any,
    whatsapp_account_id: Any,
    owner_number: Any,
    direction: str,
    body: str | None,
    provider_message_id: str | None = None,
    status: str = "sent",
    sent_at: Any = None,
    sender_type: str = SENDER_TYPE_ASSISTANT,
) -> dict[str, Any] | None:
    """
    Writes one message into the owner's thread, in either direction.

    ------------------------------------------------------------------------------------------
    DEDUPED ON `providerMessageId`, WHICH IS WHAT WHATSAPP ACTUALLY GUARANTEES
    ------------------------------------------------------------------------------------------
    Baileys re-delivers: a reconnect replays recent events, and the same inbound message can
    arrive two or three times. `idempotencyKey` is the right guard for OUTBOUND sends the CRM
    initiates, because the CRM mints the key — but an inbound event has no such key, only the
    provider's own id. So the uniqueness check is on `(organizationId, providerMessageId)`,
    which both directions have.

    A message with NO provider id is written unconditionally. That is deliberate: a failed send
    has no id, and two failed sends are two real events the owner should see.

    Never raises. A failure to record must not fail the delivery it is recording — the owner
    getting their reminder matters more than the CRM having a copy of it.
    """
    try:
        conversation = await ensure_owner_conversation(
            organization_id=organization_id,
            whatsapp_account_id=whatsapp_account_id,
            owner_number=owner_number,
        )

        if not conversation:
            return None

        database = db.get_database()
        now = sent_at or db.utc_now()

        if provider_message_id:
            existing = await database[MESSAGES].find_one(
                {
                    "organizationId": conversation.get("organizationId"),
                    "providerMessageId": provider_message_id,
                }
            )

            if existing:
                return existing

        document: dict[str, Any] = {
            "organizationId": conversation.get("organizationId"),
            "whatsappAccountId": conversation.get("whatsappAccountId"),
            "conversationId": conversation.get("_id"),
            "contactId": conversation.get("contactId"),
            "direction": direction,
            "senderType": sender_type,
            "senderId": None,
            "body": body or None,
            "type": "text",
            "status": status,
            "providerMessageId": provider_message_id,
            # `ai`, so the Inbox renders these with the assistant styling customer-facing AI
            # replies already use, rather than as a teammate's typing.
            "authoredBy": "ai" if direction == "outbound" else "contact",
            "sentAt": now,
            "attempts": 0,
            "createdAt": now,
            "updatedAt": now,
        }

        result = await database[MESSAGES].insert_one(document)
        document["_id"] = result.inserted_id

        preview = (body or "").strip()[:160]

        await database[CONVERSATIONS].update_one(
            {"_id": conversation.get("_id")},
            {
                "$set": {
                    "lastMessageAt": now,
                    "lastMessagePreview": preview,
                    "updatedAt": now,
                    **(
                        {"lastInboundAt": now}
                        if direction == "inbound"
                        else {"lastOutboundAt": now}
                    ),
                }
            },
        )

        return document
    except Exception as exc:  # noqa: BLE001 - recording must never break delivery
        logger.error(
            "Could not record owner assistant message safely: %s", type(exc).__name__
        )

        return None
