"""
Keeping `Conversation.nextFollowUpAt` honest.

A PORT OF backend/src/modules/followups/next-follow-up.service.ts.

WHAT THE FIELD MEANS: the earliest due time among a conversation's ACTIONABLE reminders — its
pending ones. Completed and cancelled reminders are not work, so they do not count. An OVERDUE
reminder very much is still work, so a due time in the past is a perfectly good value here;
"overdue" is a reading of this field, not a reason to clear it. A conversation with no pending
reminders left goes back to null.

----------------------------------------------------------------------------------------------
WHY IT IS RECOMPUTED RATHER THAN ADJUSTED
----------------------------------------------------------------------------------------------
Every call re-derives the answer from the task collection instead of nudging the stored value.
That costs one indexed query — the `{organizationId, conversationId, status, dueAt}` index
answers it by reading a single entry — and buys three things an incremental update cannot:

  - **IT IS IDEMPOTENT.** Running it twice is the same as running it once, so a retry is free.
  - **IT CANNOT DRIFT.** An incremental "is this sooner than what is stored?" is wrong the moment
    two reminders change close together, or a write is lost. This reads the truth each time,
    which also means it SELF-HEALS: the next mutation on that conversation repairs whatever the
    last one got wrong.
  - **IT NEEDS NO LOCK.** Two concurrent recomputes race to write the same derived value.

----------------------------------------------------------------------------------------------
DELIVERY DOES NOT DEPEND ON THIS
----------------------------------------------------------------------------------------------
The reminder runner claims due tasks straight from the task collection; nothing about ringing a
reminder reads `nextFollowUpAt`. So a failed sync degrades an INBOX HINT, never a delivery —
which is why `sync_quietly` logs and continues rather than failing a reminder that was already
saved successfully.

PERSONAL REMINDERS NEVER REACH HERE. A reminder with no `conversationId` has no conversation
field to maintain, and the guard returns before touching anything.
"""

import logging
from datetime import datetime
from typing import Any

from app import db
from app.followup_tasks import FOLLOWUP_STATUSES, find_earliest_pending_due_at

logger = logging.getLogger(__name__)

CONVERSATIONS = "conversations"


async def set_conversation_next_follow_up_at(
    *, organization_id: Any, conversation_id: Any, next_follow_up_at: datetime | None = None
) -> None:
    """`setConversationNextFollowUpAt`."""
    await db.get_database()[CONVERSATIONS].update_one(
        {"_id": conversation_id, "organizationId": organization_id},
        {"$set": {"nextFollowUpAt": next_follow_up_at}},
    )


async def sync_next_follow_up_at(
    *, organization_id: Any, conversation_id: Any
) -> datetime | None:
    """
    Recomputes and stores the conversation's next actionable due time.

    Returns what it wrote, or None when there is nothing pending.
    """
    # A personal reminder, or a caller that does not know its organisation. Either way there is
    # no conversation field to maintain, and guessing one is the bug this exists to avoid.
    if not conversation_id or not organization_id:
        return None

    next_follow_up_at = await find_earliest_pending_due_at(
        organization_id=organization_id,
        conversation_id=conversation_id,
        status=FOLLOWUP_STATUSES["PENDING"],
    )

    await set_conversation_next_follow_up_at(
        organization_id=organization_id,
        conversation_id=conversation_id,
        next_follow_up_at=next_follow_up_at,
    )

    return next_follow_up_at


async def sync_quietly(*, organization_id: Any, conversation_id: Any) -> None:
    """
    The form every reminder mutation uses: sync, and never let a failure here turn a reminder
    that WAS saved into an error the caller has to handle.

    Silent only in the sense that it does not raise — the failure is logged with the ids and NO
    CUSTOMER DATA, and the stale value is temporary by construction: the next create,
    reschedule, complete or cancel on that conversation recomputes it.
    """
    try:
        await sync_next_follow_up_at(
            organization_id=organization_id, conversation_id=conversation_id
        )
    except Exception as error:  # noqa: BLE001 - a hint refresh must never fail a saved reminder
        logger.error(
            "Could not refresh nextFollowUpAt for a conversation.",
            extra={
                "errorType": type(error).__name__,
                "conversationId": str(conversation_id or ""),
            },
        )
