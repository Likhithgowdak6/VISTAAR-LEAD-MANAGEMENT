"""
"Remind me at 5 PM to call Rahul", typed into the owner's own WhatsApp self-chat.

A PORT OF backend/src/modules/followups/owner-reminder-command.service.ts.

SECURITY FIRST, because this is the one feature where getting it wrong hands a stranger a
writable path into the owner's account. This service is reachable from exactly one place:
the router's `inboundMessage.isSelfChat === true` branch, which sits INSIDE a `fromMe: true`
check and compares the sender against the linked account's own JID. A customer messaging a
lead conversation is neither, so they cannot reach this code at all - and crucially, nothing
here reads the owner's identity out of the message. The organisation comes from the account
the message arrived on, and the user comes from `get_owner_actor_for_organization`. There is no
input a sender could craft to become somebody else.

WHY THE PARSING IS DETERMINISTIC. Owner commands are formulaic - "remind me <when> to <what>"
- and the hard part was never understanding them, it was resolving "tomorrow at 10" into an
instant without inventing one. That lives in reminder_time.py and is the validation layer: a
due date reaches the database only if `resolve_reminder_time` pinned it AND `is_usable_due_date`
accepts it. The lead-commitment path is where a model is genuinely needed, because
"I'm travelling today, ping me after" is not formulaic.

ORDERING: this runs BEFORE the approval-reply handler, behind a strict prefilter that cannot
match an approval code like "A7 1" or "1". Anything it does not claim falls straight through
to the existing handler, so no existing owner workflow changes.
"""

from datetime import datetime, timezone
import logging
import re
from typing import Any, Callable

from pymongo.errors import DuplicateKeyError

from app.config import settings
from app.followup_tasks import (
    FOLLOWUP_STATUSES,
    FOLLOWUP_TYPES,
    REMINDER_SOURCES,
    create_follow_up_task as default_create_follow_up_task,
    find_pending_tasks_by_user as default_find_pending_tasks_by_user,
    reschedule_reminder as default_reschedule_reminder,
    update_task_status as default_update_task_status,
)
from app.next_follow_up import sync_quietly
from app.owner_actor import get_owner_actor_for_organization as default_get_owner_actor
from app.reminder_message import format_reminder_time
from app.reminder_time import (
    DEFAULT_REMINDER_TIMEZONE,
    is_usable_due_date,
    resolve_reminder_time,
)

_logger = logging.getLogger("crm-api.owner-reminder-command")

NOT_HANDLED = {"handled": False}

LOOKS_LIKE_PATTERN = re.compile(
    r"\b(remind me|reminder|reminders|set an alarm|set alarm|wake me)\b"
)
CREATE_MARKERS = re.compile(
    r"\b(remind me|set an alarm|set alarm|wake me)\b"
)
LIST_MARKERS = re.compile(
    r"\b(what reminders|my reminders|list reminders|show reminders|reminders do i have|reminders today)\b"
)
CANCEL_MARKERS = re.compile(
    r"\b(cancel|delete|remove|drop)\b.*\breminder\b|\breminder\b.*\b(cancel|delete|remove)\b"
)
RESCHEDULE_MARKERS = re.compile(
    r"\b(move|reschedule|change|shift|push)\b.*\breminder\b|\breminder\b.*\b(to|till|until)\b"
)

TO_MATCH_PATTERN = re.compile(r"\b(?:to|that i|that|about|for)\s+(.{2,180})$", re.IGNORECASE)
TRAILING_TIME_PATTERN = re.compile(r"\b(?:at|on|by)?\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*$", re.IGNORECASE)
TRAILING_DAY_PATTERN = re.compile(r"\b(today|tomorrow|tonight)\s*$", re.IGNORECASE)

STRIP_CMD = re.compile(r"\b(please\s+)?(remind me|set an alarm|set alarm|wake me)\b", re.IGNORECASE)
STRIP_REL = re.compile(r"\b(in \d{1,4} (?:minutes?|mins?|hours?|hrs?|days?))\b", re.IGNORECASE)
STRIP_DAYS = re.compile(r"\b(today|tomorrow|day after tomorrow|tonight|next \w+)\b", re.IGNORECASE)
STRIP_PREP_TIME = re.compile(r"\b(at|on|by|for)\s+\d{1,2}(?::\d{2})?\s*(am|pm)?\b", re.IGNORECASE)
STRIP_BARE_TIME = re.compile(r"\b\d{1,2}(?::\d{2})?\s*(am|pm)\b", re.IGNORECASE)
HAS_ALPHA = re.compile(r"[a-z]", re.IGNORECASE)


def normalize(text: Any) -> str:
    s = str(text or "")
    s = s.lower()
    s = re.sub(r"\s+", " ", s)
    return s.strip()


def looks_like_reminder_command(text: str) -> bool:
    """
    Does this look like a reminder command at all?

    STRICT ON PURPOSE. The owner's self-chat is also the approval channel ("A7 1"), the payment
    channel ("VX12 collected") and a free-text question channel. A loose matcher here would
    swallow those and break workflows people already rely on, so this demands an explicit
    reminder verb.
    """
    return bool(LOOKS_LIKE_PATTERN.search(text))


def extract_title(original: str) -> str | None:
    """
    Pulls the task out of "remind me at 5 pm to call rahul".

    Takes what follows "to"/"that"/"about" when present, because that is where people put the
    task, and falls back to stripping the command words. Returns None rather than a guess when
    nothing is left - the caller then stores "Personal reminder", which the brief asks for
    explicitly: a clear time with no description is still worth creating.
    """
    text = str(original or "").strip()

    to_match = TO_MATCH_PATTERN.search(text)
    if to_match:
        candidate = to_match.group(1)
        candidate = TRAILING_TIME_PATTERN.sub("", candidate)
        candidate = TRAILING_DAY_PATTERN.sub("", candidate)
        candidate = candidate.strip()

        if len(candidate) >= 2 and not candidate[0].isdigit():
            return candidate[:200]

    stripped = STRIP_CMD.sub(" ", text)
    stripped = STRIP_REL.sub(" ", stripped)
    stripped = STRIP_DAYS.sub(" ", stripped)
    stripped = STRIP_PREP_TIME.sub(" ", stripped)
    stripped = STRIP_BARE_TIME.sub(" ", stripped)
    stripped = re.sub(r"\s+", " ", stripped).strip()

    return stripped[:200] if len(stripped) >= 2 and HAS_ALPHA.search(stripped) else None


def _describe(task: dict[str, Any]) -> str:
    """Describe task for user messages: 'Call Rahul — 5:00 PM today'"""
    title = task.get("title") or task.get("note") or "Reminder"
    due_at = task.get("dueAt") or task.get("due_at")
    tz = task.get("timezone") or task.get("timezone_name") or DEFAULT_REMINDER_TIMEZONE
    return f"{title} — {format_reminder_time(due_at, tz)}"


def find_referenced_task(tasks: list[dict[str, Any]], text: str) -> dict[str, Any] | None:
    """
    Finds the reminder a phrase like 'my reminder to call Rahul' refers to.

    Word-overlap, not fuzzy matching: the owner typed the title themselves minutes ago, so a
    shared significant word is a strong signal. Returns None on a tie or no match, and the
    caller then asks rather than acting on the wrong one - cancelling the wrong reminder is a
    silent failure the owner only discovers when the right one never fires.
    """
    excluded = {"reminder", "cancel", "remind", "move"}
    words = {
        w for w in normalize(text).split(" ")
        if len(w) > 3 and w not in excluded
    }

    if not words:
        return None

    scored: list[tuple[int, dict[str, Any]]] = []
    for task in tasks:
        haystack = normalize(f"{task.get('title') or ''} {task.get('note') or ''}")
        score = sum(1 for w in words if w in haystack)
        if score > 0:
            scored.append((score, task))

    if not scored:
        return None

    scored.sort(key=lambda x: x[0], reverse=True)

    # A tie means two reminders match equally well; acting on either is a coin flip.
    if len(scored) > 1 and scored[0][0] == scored[1][0]:
        return None

    return scored[0][1]


async def default_notify_owner(*, organization_id: Any = None, account_id: Any = None, text: str = "") -> dict[str, Any]:
    """Default notification placeholder when WhatsApp session manager is not directly invoked."""
    return {"providerMessageId": None}


class OwnerReminderCommandService:
    """Deterministic parser and handler for owner self-chat reminder commands."""

    def __init__(
        self,
        *,
        get_owner_actor: Callable[..., Any] = default_get_owner_actor,
        create_follow_up_task: Callable[..., Any] = default_create_follow_up_task,
        find_pending_tasks_by_user: Callable[..., Any] = default_find_pending_tasks_by_user,
        reschedule_reminder: Callable[..., Any] = default_reschedule_reminder,
        update_task_status: Callable[..., Any] = default_update_task_status,
        notify_owner: Callable[..., Any] = default_notify_owner,
        now: Callable[[], datetime] | None = None,
        logger: Any = None,
        timezone_name: str | None = None,
    ):
        self._get_owner_actor = get_owner_actor
        self._create_follow_up_task = create_follow_up_task
        self._find_pending_tasks_by_user = find_pending_tasks_by_user
        self._reschedule_reminder = reschedule_reminder
        self._update_task_status = update_task_status
        self._notify_owner = notify_owner
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._logger = logger or _logger
        self._timezone = timezone_name or getattr(settings, "whatsapp_business_timezone", None) or DEFAULT_REMINDER_TIMEZONE

    def looks_like_reminder_command(self, text: str) -> bool:
        return looks_like_reminder_command(text)

    async def _list_reminders(
        self,
        organization_id: Any,
        owner_id: Any,
        respond: Callable[[str], Any],
    ) -> dict[str, Any]:
        tasks = await self._find_pending_tasks_by_user(
            organization_id=organization_id,
            assigned_to=owner_id,
            limit=10,
        )

        if not tasks:
            return await respond("You have no reminders set.")

        lines = ["⏰ *Your reminders*"] + [f"• {_describe(task)}" for task in tasks]
        return await respond("\n".join(lines))

    async def handle_owner_reminder_command(
        self,
        *,
        organization_id: Any = None,
        whatsapp_account_id: Any = None,
        text: str | None = None,
        message_id: str | None = None,
    ) -> dict[str, Any]:
        async def respond(reply: str) -> dict[str, Any]:
            try:
                await self._notify_owner(
                    organization_id=organization_id,
                    account_id=whatsapp_account_id,
                    text=reply,
                )
            except Exception as err:
                code = getattr(err, "code", None)
                name = type(err).__name__
                if hasattr(self._logger, "error"):
                    self._logger.error(
                        "Reminder acknowledgement could not be delivered; the reminder itself still stands.",
                        extra={"code": code, "name": name},
                    )
            return {"handled": True, "reply": reply}

        raw = str(text or "")
        normalized = normalize(raw)

        if not organization_id or normalized == "" or not looks_like_reminder_command(normalized):
            return NOT_HANDLED

        try:
            owner = await self._get_owner_actor(organization_id=organization_id)
            actor = owner.get("actor") if isinstance(owner, dict) else getattr(owner, "actor", None)
            owner_id = actor.get("_id") if isinstance(actor, dict) else getattr(actor, "_id", None)

            if not owner_id:
                if hasattr(self._logger, "error"):
                    self._logger.error(
                        "No owner actor for reminder command.",
                        extra={"organizationId": str(organization_id)},
                    )
                return NOT_HANDLED

            if LIST_MARKERS.search(normalized):
                return await self._list_reminders(organization_id, owner_id, respond)

            if CANCEL_MARKERS.search(normalized):
                tasks = await self._find_pending_tasks_by_user(
                    organization_id=organization_id,
                    assigned_to=owner_id,
                    limit=25,
                )
                target = find_referenced_task(tasks or [], normalized)

                if not target:
                    return await respond("Which reminder? Tell me what it's for and I'll cancel it.")

                target_id = target.get("_id")
                await self._update_task_status(
                    task_id=target_id,
                    organization_id=organization_id,
                    status=FOLLOWUP_STATUSES["CANCELLED"],
                )

                await sync_quietly(
                    organization_id=organization_id,
                    conversation_id=target.get("conversationId"),
                )

                return await respond(f"Cancelled: {_describe(target)}")

            if RESCHEDULE_MARKERS.search(normalized) and not CREATE_MARKERS.search(normalized):
                when = resolve_reminder_time(raw, now=self._now(), timezone_name=self._timezone)

                if when.kind != "resolved":
                    question = "What time should I move it to?" if when.kind == "none" else when.question
                    return await respond(question or "")

                tasks = await self._find_pending_tasks_by_user(
                    organization_id=organization_id,
                    assigned_to=owner_id,
                    limit=25,
                )
                target = find_referenced_task(tasks or [], normalized)

                if not target:
                    return await respond("Which reminder should I move?")

                target_id = target.get("_id")
                await self._reschedule_reminder(
                    task_id=target_id,
                    organization_id=organization_id,
                    due_at=when.due_at,
                    timezone_name=when.timezone,
                )

                title = target.get("title") or target.get("note") or "your reminder"
                formatted_time = format_reminder_time(when.due_at, when.timezone)
                return await respond(f"Moved to {formatted_time}: {title}")

            if not CREATE_MARKERS.search(normalized):
                return NOT_HANDLED

            when = resolve_reminder_time(raw, now=self._now(), timezone_name=self._timezone)

            if when.kind in ("ambiguous", "recurring"):
                return await respond(when.question or "")

            if when.kind == "none":
                return await respond("When should I remind you?")

            if not is_usable_due_date(when.due_at, self._now()):
                return await respond("That time has already passed - when should I remind you?")

            title = extract_title(raw) or "Personal reminder"
            idempotency_key = f"owner-cmd:{message_id}" if message_id else None

            task = await self._create_follow_up_task(
                organization_id=organization_id,
                whatsapp_account_id=whatsapp_account_id,
                conversation_id=None,
                assigned_to=owner_id,
                created_by=owner_id,
                type=FOLLOWUP_TYPES["CUSTOM"],
                title=title,
                due_at=when.due_at,
                timezone_name=when.timezone,
                source=REMINDER_SOURCES["OWNER_COMMAND"],
                source_message_id=message_id,
                idempotency_key=idempotency_key,
            )

            due_at = (
                task.get("dueAt")
                or task.get("due_at")
                if isinstance(task, dict)
                else getattr(task, "dueAt", getattr(task, "due_at", when.due_at))
            ) or when.due_at
            tz = (
                task.get("timezone")
                or task.get("timezone_name")
                if isinstance(task, dict)
                else getattr(task, "timezone", getattr(task, "timezone_name", when.timezone))
            ) or when.timezone
            task_title = (
                task.get("title")
                if isinstance(task, dict)
                else getattr(task, "title", title)
            ) or title

            formatted_time = format_reminder_time(due_at, tz)
            return await respond(f"Done! I'll remind you at {formatted_time} — {task_title}")

        except Exception as err:
            code = getattr(err, "code", None)
            # Duplicate key error means idempotency guard caught replayed message
            if isinstance(err, DuplicateKeyError) or code == 11000:
                return {"handled": True}

            name = type(err).__name__
            if hasattr(self._logger, "error"):
                self._logger.error(
                    "Owner reminder command failed; falling through to the other owner handlers.",
                    extra={"code": code, "name": name},
                )

            return NOT_HANDLED


def create_owner_reminder_command_service(**kwargs: Any) -> OwnerReminderCommandService:
    return OwnerReminderCommandService(**kwargs)


_default_command_service: OwnerReminderCommandService | None = None


def get_owner_reminder_command_service() -> OwnerReminderCommandService:
    global _default_command_service
    if _default_command_service is None:
        _default_command_service = create_owner_reminder_command_service()
    return _default_command_service


async def handle_owner_reminder_command(**kwargs: Any) -> Any:
    return await get_owner_reminder_command_service().handle_owner_reminder_command(**kwargs)

