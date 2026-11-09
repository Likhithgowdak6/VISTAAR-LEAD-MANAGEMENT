"""
Enquiry class, AI response status, and "does a human need to look at this".

A PORT OF backend/src/modules/analytics/conversation-classification.ts.

THESE NAMES ARE SHARED WITH THE INBOX, AND THAT IS THE REASON THIS IS ITS OWN MODULE. A metric
card on the dashboard is clickable: it hands its filters straight to the conversation list, and
the list hands them back when the owner drills the other way. If `awaiting_ai_reply` meant one
thing here and another there, the number on the card and the length of the list it opens would
disagree — and there would be no way to tell which one was lying.

`aiIntent` IS DELIBERATELY NEVER CONSULTED. It is the classifier's read of the last message it
judged, so it moves as a thread goes on. Letting it decide here would mean a confirmed customer
who replies "ok" could be re-labelled on the strength of that one word. `leadQualificationStatus`
was built to be the stable answer and is the only input.

THE PRECEDENCE ORDER IN `resolve_ai_response_status` IS THE DESIGN, not an implementation
detail. Each rule answers a question that makes the ones below it irrelevant, so a conversation
lands in exactly one bucket and the buckets sum to the total — which is what lets the analytics
cards be added up honestly. Reordering any two silently breaks that sum.
"""

from datetime import datetime, timezone
from typing import Any

# --- enquiry class -----------------------------------------------------------------------
ENQUIRY = "enquiry"
NOT_ENQUIRY = "not_enquiry"
NEEDS_REVIEW = "needs_review"

ENQUIRY_CLASS_VALUES = (ENQUIRY, NOT_ENQUIRY, NEEDS_REVIEW)

# --- AI response status ------------------------------------------------------------------
AI_REPLIED = "ai_replied"
AI_AWAITING = "awaiting_ai_reply"
AI_PAUSED = "ai_paused"
AI_FAILED = "ai_reply_failed"
AI_NOT_NEEDED = "ai_not_needed"
AI_NEEDS_REVIEW = "needs_review"

AI_RESPONSE_STATUS_VALUES = (
    AI_REPLIED,
    AI_AWAITING,
    AI_PAUSED,
    AI_FAILED,
    AI_NOT_NEEDED,
    AI_NEEDS_REVIEW,
)

# --- lead qualification ------------------------------------------------------------------
QUALIFICATION_UNKNOWN = "unknown"
QUALIFICATION_CONFIRMED = "confirmed"
QUALIFICATION_REJECTED = "rejected"

SOURCE_AI_REPLY_SENT = "ai_reply_sent"
SOURCE_CLASSIFIER_NON_LEAD = "classifier_non_lead"
SOURCE_LEGACY_DELIVERED_REPLY = "legacy_delivered_reply"


def _as_utc(value: Any) -> datetime | None:
    """
    Mongo stores no zone, so the driver hands back naive datetimes. Comparing a naive to an
    aware one raises in Python where JavaScript would just compare numbers, so every boundary
    is normalised here rather than at each call site.
    """
    if not isinstance(value, datetime):
        return None

    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _is_after(a: Any, b: Any) -> bool:
    """
    `isAfter`. A missing `a` is never after anything; a missing `b` means any `a` is.

    Both halves matter: the first stops a conversation with no inbound reading as "waiting on
    us", the second makes a first inbound with no reply yet count as unanswered.
    """
    left = _as_utc(a)

    if left is None:
        return False

    right = _as_utc(b)

    return right is None or left > right


def classify_enquiry(conversation: dict[str, Any]) -> str:
    """
    `classifyEnquiry`. Straight off the established qualification, never guessed at.

    `unknown`, missing and anything unrecognised all land in NEEDS_REVIEW — an unanswered
    genuine enquiry and a legacy row both legitimately sit there until a human or a reply
    settles it.
    """
    status = conversation.get("leadQualificationStatus")

    if status == QUALIFICATION_CONFIRMED:
        return ENQUIRY

    if status == QUALIFICATION_REJECTED:
        return NOT_ENQUIRY

    return NEEDS_REVIEW


def resolve_last_ai_reply_at(conversation: dict[str, Any]) -> datetime | None:
    """
    When a successful AI reply last reached this customer, as well as it can be known.

    `lastAiReplyAt` is written at DELIVERY, which is the honest moment — a generated draft or a
    queued row is not a reply.

    Rows predating that field fall back to `leadQualifiedAt`, which is not a guess either: a
    conversation only becomes `confirmed` because a qualifying reply was actually delivered.
    **The fallback is a FLOOR, not the truth** — it records the first such reply, not the most
    recent — so a legacy thread can read as "awaiting" when a later reply also went out. Erring
    that way is deliberate: showing a reply as owed when it was answered costs a glance; the
    opposite costs a customer.
    """
    direct = _as_utc(conversation.get("lastAiReplyAt"))

    if direct:
        return direct

    qualified_by_delivered_reply = conversation.get("leadQualificationSource") in (
        SOURCE_AI_REPLY_SENT,
        SOURCE_LEGACY_DELIVERED_REPLY,
    )

    return _as_utc(conversation.get("leadQualifiedAt")) if qualified_by_delivered_reply else None


def has_unanswered_inbound(conversation: dict[str, Any]) -> bool:
    """
    `hasUnansweredInbound`: an inbound newer than the last answer from EITHER side.

    `lastDeliveredOutboundAt` covers any author, not just the AI — a human answering by hand
    settles the customer's question just as well. Using the AI-only field would show a
    hand-answered thread as still waiting.

    A one-word "ok" after a reply still counts as unanswered, because from here there is no way
    to know it needed nothing. The page says so explicitly rather than guessing.
    """
    ai_reply_at = resolve_last_ai_reply_at(conversation)
    delivered = _as_utc(conversation.get("lastDeliveredOutboundAt"))

    if delivered and ai_reply_at:
        last_answer_at = max(delivered, ai_reply_at)
    else:
        last_answer_at = delivered or ai_reply_at

    return _is_after(conversation.get("lastInboundAt"), last_answer_at)


def resolve_ai_response_status(
    conversation: dict[str, Any], enquiry_class: str | None = None
) -> str:
    """
    The AI response status, in a FIXED order of precedence. See the module docstring.
    """
    if enquiry_class is None:
        enquiry_class = classify_enquiry(conversation)

    # 1. Nothing is owed: a known non-customer, or someone who asked us to stop.
    #    Checked FIRST so a paused non-enquiry reads as "not needed" rather than "paused" - the
    #    pause is true but it is not the reason no reply is coming.
    if enquiry_class == NOT_ENQUIRY or conversation.get("optedOutAt"):
        return AI_NOT_NEEDED

    # 2. Automation is off: paused by a safety rule, or a human has taken over. Showing this as
    #    "awaiting AI" would put it in a queue that nothing drains.
    #    `is False` exactly: a MISSING field is not the same as an explicit false, and legacy
    #    rows without the key must not all read as paused.
    if conversation.get("aiAutomationEnabled") is False:
        return AI_PAUSED

    last_reply_at = resolve_last_ai_reply_at(conversation)

    # 3. The last thing the AI tried was a failure and nothing has succeeded since. Ranked above
    #    "awaiting" because the two call for different actions: one needs the queue to run, the
    #    other needs somebody to look at why it did not.
    if _is_after(conversation.get("lastAiSendFailedAt"), last_reply_at):
        return AI_FAILED

    # 4. Something came in after the last successful reply.
    if _is_after(conversation.get("lastInboundAt"), last_reply_at):
        # Only an ESTABLISHED enquiry is "awaiting an AI reply". For anything unclassified the
        # AI may legitimately never answer, so claiming it is queued would be wrong. It still
        # appears under "needs attention", which is the filter for "a human should look".
        return AI_AWAITING if enquiry_class == ENQUIRY else AI_NEEDS_REVIEW

    # 5. A reply went out and nothing has come in since.
    if last_reply_at:
        return AI_REPLIED

    # 6. Nothing to go on - a legacy row, or a conversation created by hand that has never
    #    exchanged a message.
    return AI_NEEDS_REVIEW


def needs_attention(conversation: dict[str, Any], now: datetime | None = None) -> bool:
    """
    Whether a human should look at this — a different question again from both of the above.

    DELIBERATELY BROADER than "awaiting AI reply": it also catches the threads the AI will never
    pick up — paused ones with the customer waiting, failed sends, unclassified threads with an
    unanswered message — plus follow-ups that have come due. A conversation nobody is coming
    back to is the thing a CRM exists to surface.
    """
    if now is None:
        now = datetime.now(timezone.utc)

    now = _as_utc(now) or datetime.now(timezone.utc)

    enquiry_class = classify_enquiry(conversation)

    if enquiry_class == NOT_ENQUIRY or conversation.get("optedOutAt"):
        return False

    # THE CUSTOMER IS WAITING, counting an answer from EITHER side of the business.
    #
    # This used to be preceded by `status in (AI_AWAITING, AI_FAILED)`, and the AWAITING half
    # was the bug. AWAITING compares the inbound against the AI-ONLY reply time, so a thread a
    # human had already answered still read as needing attention — contradicting the status's
    # own published definition in the inbox ("newer than the last reply SENT") and disagreeing
    # with `needs_attention_filter`, which has always compared against both sides.
    #
    # `has_unanswered_inbound` is the correct test and already compares both. A genuinely
    # unanswered AWAITING thread still matches; one a human answered no longer does.
    if has_unanswered_inbound(conversation):
        return True

    # An unresolved AI send failure, but ONLY while the AI still owns the thread.
    #
    # `AI_FAILED` encodes exactly that: automation on, not opted out, and a failure with nothing
    # successful after it. A PAUSED thread cannot reach FAILED, which is deliberate — if a human
    # took the thread over and the customer is not waiting (checked above), a stale AI send
    # failure is not something anybody needs to act on. It stays discoverable through the
    # inbox's own "AI reply failed" filter for every thread the AI still owns.
    if resolve_ai_response_status(conversation, enquiry_class) == AI_FAILED:
        return True

    next_follow_up = _as_utc(conversation.get("nextFollowUpAt"))

    return bool(next_follow_up and next_follow_up <= now)
