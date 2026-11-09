"""
Who the reminder is about, so the owner can act on it without opening anything.

A PORT OF backend/src/modules/followups/reminder-lead-context.ts.

THE PROBLEM THIS SOLVES. A reminder used to arrive saying "Check if they messaged you back" —
true, and useless an hour later, because it never said WHO. The owner had to open the CRM,
find the thread, and remember what the person wanted before they could do anything. Three
facts fix that, and all three already exist in the database: the lead's name, their number,
and one line about what they are after.

NO NEW LLM CALL. The requirement is read from what has already been written about this
thread, in descending order of how much a human trusted it (see `describe_requirement`). A
model call per notification would add cost and latency to a path whose whole job is to be
punctual, and would invent a requirement on a thread that does not have one yet.

FAILURE IS NOT FATAL. Every lookup here is best-effort: if the conversation or the contact
cannot be read, the reminder still goes out with whatever was found. A reminder that fires
late or thin beats one that does not fire because a join failed.

PHONE NUMBERS ARE ENCRYPTED AT REST and are read through `find_contact_pii_for_internal_use`,
the same accessor the outbound sender uses. The number is put into a message addressed to the
OWNER and is never logged — see the sweep, which logs counts only.
"""

import logging
import re
from typing import Any, Callable, NamedTuple

from bson import ObjectId

from app import db, encryption

_logger = logging.getLogger("crm-api.reminder-lead-context")

# Long enough to be useful on a phone screen, short enough not to be swiped away.
REQUIREMENT_MAX_LENGTH = 180

CONVERSATIONS = "conversations"
CONTACTS = "contacts"


class ReminderLeadContext(NamedTuple):
    """Everything the notification needs about the lead behind one reminder."""

    displayName: str | None = None
    phone: str | None = None
    requirement: str | None = None

    @property
    def display_name(self) -> str | None:
        return self.displayName


EMPTY = ReminderLeadContext(None, None, None)


def truncate(value: str, max_len: int) -> str:
    """Collapses whitespace and trims to `max_len`, ending on a word where it can."""
    clean = re.sub(r"\s+", " ", value).strip()

    if len(clean) <= max_len:
        return clean

    cut = clean[: max_len - 1]
    last_space = cut.rfind(" ")

    end_part = cut[:last_space] if last_space > max_len * 0.6 else cut
    return f"{end_part.rstrip()}…"


def format_phone(phone: Any) -> str | None:
    """
    `+919876543210` from whatever shape the number is stored in.

    Returns None rather than a half-formatted string for anything that is not a plausible
    number — the owner taps this to call someone, and a mangled one wastes that tap.
    """
    if not isinstance(phone, str):
        return None

    digits = re.sub(r"\D", "", phone)

    # Shorter than a national number anywhere; almost certainly junk or a partial record.
    if len(digits) < 8 or len(digits) > 15:
        return None

    return f"+{digits}"


def _humanise(value: str) -> str:
    """Reads better in a sentence than the raw playbook key."""
    return re.sub(r"[_-]+", " ", value).strip()


def describe_requirement(conversation: dict[str, Any] | None) -> str | None:
    """
    One line describing what this lead wants, from what is already known about them.

    ORDERED BY HOW MUCH A HUMAN TRUSTED IT, which is the only defensible ordering when several
    sources disagree:

      1. the CRM note someone typed by hand — a person decided this was worth writing down;
      2. the AI's catch-up headline, which is literally defined as "who this is and what they
         want" and was generated when somebody asked for it;
      3. the structured facts — the event, when, where. This is what an imported lead-ad
         submission carries, and it is the common case for a form lead nobody has chatted to.

    `lastMessagePreview` IS NOT A FOURTH SOURCE, and it is worth saying why it looks like one.
    That field holds the last message in EITHER direction — outbound-message.service.ts writes it
    on every send — and it carries no flag saying which. Using it would print our own AI's last
    line back at the owner under the heading "Requirement", attributing our words to the customer:

        📌 Requirement: Yes, we do wedding shoots — which date is it?

    Reading the latest INBOUND message instead would be accurate but costs a third query per
    reminder to quote one raw line — often "ok" — and for a lead follow-up the customer's own
    words are already on the Reason line directly beneath. So this stops at the facts.

    Returns None when none of those exist. The caller renders "Requirement not yet clear" rather
    than this file guessing — a reminder that invents what someone wants is worse than one that
    admits it does not know.
    """
    if not conversation:
        return None

    note = (conversation.get("summary") or "").strip()
    if note != "":
        return truncate(note, REQUIREMENT_MAX_LENGTH)

    ai_summary = conversation.get("aiSummary")
    headline = ""
    if isinstance(ai_summary, dict):
        headline = (ai_summary.get("headline") or "").strip()

    if headline != "":
        return truncate(headline, REQUIREMENT_MAX_LENGTH)

    facts = conversation.get("aiFacts")
    facts_dict: dict[str, Any] = facts if isinstance(facts, dict) else {}

    def read_fact(*keys: str) -> str | None:
        for key in keys:
            val = facts_dict.get(key)
            if isinstance(val, str) and val.strip() != "":
                return val.strip()
        return None

    category = (conversation.get("aiCategory") or "").strip()
    service = read_fact("event_type", "service", "photo_or_video")
    when = read_fact("event_date", "shoot_date", "date")
    where = read_fact("city", "venue", "location")

    head: str | None = None
    if service:
        head = service
    elif category != "" and category != "unknown":
        head = _humanise(category)

    detail_parts = [p for p in (when, where) if p]
    detail = ", ".join(detail_parts) if detail_parts else None

    if head and detail:
        return truncate(f"{_humanise(head)} — {detail}", REQUIREMENT_MAX_LENGTH)

    if head:
        return truncate(_humanise(head), REQUIREMENT_MAX_LENGTH)

    return truncate(detail, REQUIREMENT_MAX_LENGTH) if detail else None


def _to_object_id(value: Any) -> ObjectId | None:
    if isinstance(value, ObjectId):
        return value
    if isinstance(value, str) and len(value) == 24:
        try:
            return ObjectId(value)
        except Exception:
            return None
    return None


async def _default_find_conversation(
    *, conversation_id: Any, organization_id: Any
) -> dict[str, Any] | None:
    cid = _to_object_id(conversation_id)
    oid = _to_object_id(organization_id)
    if not cid or not oid:
        return None
    return await db.get_database()[CONVERSATIONS].find_one(
        {"_id": cid, "organizationId": oid}
    )


async def _default_find_contact_pii(
    *, contact_id: Any, organization_id: Any
) -> dict[str, Any] | None:
    cid = _to_object_id(contact_id)
    oid = _to_object_id(organization_id)
    if not cid or not oid:
        return None
    contact = await db.get_database()[CONTACTS].find_one(
        {"_id": cid, "organizationId": oid}
    )
    if not contact:
        return None

    phone = None
    encrypted_phone = contact.get("encryptedPhone")
    if encrypted_phone:
        try:
            phone = encryption.decrypt_string(encrypted_phone, encryption.CONTACT_PHONE)
        except Exception:
            phone = None
    else:
        phone = contact.get("phone")

    return {"phone": phone}


async def load_reminder_lead_context(
    task: dict[str, Any],
    *,
    find_conversation_by_id: Callable[..., Any] | None = None,
    find_contact_pii: Callable[..., Any] | None = None,
    logger: Any = None,
) -> ReminderLeadContext:
    """
    Everything the notification needs about the lead behind one reminder.

    SCOPED TO THE TASK'S OWN ORGANIZATION on both reads, and keyed on the conversation id the
    reminder was created with — never on a name. Looking a customer up by name is how one
    owner's reminder ends up carrying another customer's phone number, and two leads called
    "Rahul" is not a hypothetical.

    Returns empty context for a personal reminder, which has no conversation and must not be
    given invented lead details.
    """
    conversation_id = task.get("conversationId")
    if not conversation_id:
        return EMPTY

    organization_id = task.get("organizationId")
    log = logger or _logger

    find_conv = find_conversation_by_id or _default_find_conversation
    find_pii = find_contact_pii or _default_find_contact_pii

    try:
        conversation = await find_conv(
            conversation_id=conversation_id,
            organization_id=organization_id,
        )

        if not conversation:
            return EMPTY

        display_name = (conversation.get("displayName") or "").strip() or None
        requirement = describe_requirement(conversation)

        phone: str | None = None
        contact_id = conversation.get("contactId")

        if contact_id:
            try:
                pii = await find_pii(
                    contact_id=contact_id,
                    organization_id=organization_id,
                )
                if pii and isinstance(pii, dict):
                    phone = format_phone(pii.get("phone"))
            except Exception as error:
                err_code = getattr(error, "code", None)
                if hasattr(log, "error"):
                    log.error(
                        "Reminder lead phone lookup failed safely; the reminder will go without a number: %s",
                        err_code or type(error).__name__,
                    )

        return ReminderLeadContext(
            displayName=display_name,
            phone=phone,
            requirement=requirement,
        )
    except Exception as error:
        err_code = getattr(error, "code", None)
        if hasattr(log, "error"):
            log.error(
                "Reminder lead context lookup failed safely; sending the reminder without it: %s",
                err_code or type(error).__name__,
            )
        return EMPTY

