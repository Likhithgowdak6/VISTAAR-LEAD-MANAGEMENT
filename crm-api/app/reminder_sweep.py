"""
Fires reminders when they come due.

A PORT OF backend/src/modules/followups/reminder-sweep.service.ts.

The CRM has had a task model with a `dueAt` since long before this file: what it never had
was anything that READ it. A follow-up could be created, listed and completed, and the hour
it was due for would pass in silence. This is that missing half.

WHY A DATABASE SWEEP AND NOT A TIMER. `setTimeout` would be simpler and is wrong for the one
thing reminders have to survive: a deploy. Every redeploy of this backend would silently
forget every pending timer, and the owner would never know which reminders were lost. The
due time lives in Mongo, the sweep asks for it on an interval, and a restart costs at most
one interval of lateness.

DELIVERY IS TWO INDEPENDENT CHANNELS. WhatsApp is sent from here. The Android alarm is NOT —
the handset armed that itself when it last synced, and it will ring whether or not this
process is even running. The two are recorded separately and neither failure contaminates
the other, which is why `record_reminder_delivery` takes a channel.

CATCH-UP POLICY, stated rather than implied: an overdue reminder is still sent, however late,
and the message says the time it was FOR. The alternative — dropping anything older than some
window — loses the one reminder an owner most wants after their server was down overnight.
The only thing that stops a reminder being re-sent is `lastNotificationAt`.
"""

from datetime import datetime, timezone
import logging
from typing import Any, Callable, NamedTuple

from bson import ObjectId

from app import db
from app.config import settings
from app.followup_tasks import (
    FOLLOWUP_STATUSES,
    REMINDER_CHANNELS,
    REMINDER_DELIVERY_STATUSES,
    REMINDER_MAX_DELIVERY_ATTEMPTS,
    claim_due_reminder as default_claim_due_reminder,
    finish_reminder_delivery as default_finish_reminder_delivery,
    record_reminder_delivery as default_record_reminder_delivery,
    release_reminder_claim as default_release_reminder_claim,
)
from app.reminder_lead_context import load_reminder_lead_context as default_load_reminder_lead_context
from app.reminder_message import build_reminder_message

_logger = logging.getLogger("crm-api.reminder-sweep")

ACCOUNTS_COLLECTION = "whatsappaccounts"


def _to_object_id(val: Any) -> ObjectId | None:
    if isinstance(val, ObjectId):
        return val
    if isinstance(val, str) and len(val) == 24:
        try:
            return ObjectId(val)
        except Exception:
            return None
    return None


async def default_find_accounts_by_organization(
    *,
    organization_id: Any,
    status: str = "active",
    limit: int = 1,
) -> list[dict[str, Any]]:
    oid = _to_object_id(organization_id)
    if not oid:
        return []
    cursor = (
        db.get_database()[ACCOUNTS_COLLECTION]
        .find({"organizationId": oid, "status": status})
        .sort("createdAt", -1)
        .limit(limit)
    )
    return await cursor.to_list(length=limit)


async def default_notify_owner(
    *,
    organization_id: Any = None,
    account_id: Any = None,
    text: str = "",
) -> dict[str, Any]:
    """
    Default sink for notifying the owner on WhatsApp.
    Returns null providerMessageId until live Baileys provider socket integration is wired in Phase 11.
    """
    return {"providerMessageId": None}


async def default_notify_reminder_due_push(task: dict[str, Any]) -> dict[str, int]:
    """
    Pushes the owner's handsets. Must never throw and must never report a WhatsApp outcome —
    see push/push-notify.service.ts.
    """
    return {"sent": 0, "failed": 0, "disabled": 0}


class ReminderSweepResult(NamedTuple):
    claimed: int
    whatsappSent: int
    whatsappFailed: int
    whatsappRetrying: int
    pushSent: int
    pushFailed: int

    @property
    def whatsapp_sent(self) -> int:
        return self.whatsappSent

    @property
    def whatsapp_failed(self) -> int:
        return self.whatsappFailed

    @property
    def whatsapp_retrying(self) -> int:
        return self.whatsappRetrying

    @property
    def push_sent(self) -> int:
        return self.pushSent

    @property
    def push_failed(self) -> int:
        return self.pushFailed


class ReminderSweepService:
    """One database sweep pass for firing due reminders."""

    def __init__(
        self,
        *,
        config: Any = None,
        claim_due_reminder: Callable[..., Any] = default_claim_due_reminder,
        release_reminder_claim: Callable[..., Any] = default_release_reminder_claim,
        record_reminder_delivery: Callable[..., Any] = default_record_reminder_delivery,
        finish_reminder_delivery: Callable[..., Any] = default_finish_reminder_delivery,
        find_accounts_by_organization: Callable[..., Any] = default_find_accounts_by_organization,
        load_reminder_lead_context: Callable[..., Any] = default_load_reminder_lead_context,
        notify_owner: Callable[..., Any] = default_notify_owner,
        notify_reminder_due_push: Callable[..., Any] = default_notify_reminder_due_push,
        now: Callable[[], datetime] | None = None,
        logger: Any = None,
    ) -> None:
        self.config = config or settings
        self.claim_due_reminder = claim_due_reminder
        self.release_reminder_claim = release_reminder_claim
        self.record_reminder_delivery = record_reminder_delivery
        self.finish_reminder_delivery = finish_reminder_delivery
        self.find_accounts_by_organization = find_accounts_by_organization
        self.load_reminder_lead_context = load_reminder_lead_context
        self.notify_owner = notify_owner
        self.notify_reminder_due_push = notify_reminder_due_push
        self.now = now or (lambda: datetime.now(timezone.utc))
        self.logger = logger or _logger

    def _create_account_resolver(self) -> Callable[[Any], Any]:
        """
        Builds a per-sweep resolver for "which WhatsApp number carries this reminder".

        A lead follow-up was born from a conversation and names its own account. A PERSONAL reminder
        has no conversation, so it stores `whatsappAccountId: null` — and that null used to be passed
        straight through to `sessionManager.sendTextMessage`, where the account id IS the key into
        the map of live sockets. No id means no key, which means no session: every personal reminder
        failed with WHATSAPP_SESSION_NOT_RUNNING no matter how healthy the connection actually was.
        The error even said "No running session for this account" about an account nobody had named.

        Scoped to the reminder's own organization, never a global lookup — one tenant's reminder must
        not go out over another tenant's number. Where an organization has several active numbers any
        of them reaches the same owner, so the most recently created one wins and the choice is
        deterministic. Memoised for the duration of one sweep: a backlog is usually one organization.
        """
        cache: dict[str, Any] = {}

        async def resolve_account_id(organization_id: Any) -> Any:
            key = str(organization_id)
            if key in cache:
                return cache[key]

            resolved = None
            try:
                accounts = await self.find_accounts_by_organization(
                    organization_id=organization_id,
                    status="active",
                    limit=1,
                )
                if accounts and len(accounts) > 0:
                    resolved = accounts[0].get("_id")
            except Exception as error:
                err_code = getattr(error, "code", None)
                if hasattr(self.logger, "error"):
                    self.logger.error(
                        "Reminder account lookup failed safely: %s",
                        err_code or type(error).__name__,
                    )

            cache[key] = resolved
            return resolved

        return resolve_account_id

    async def _deliver_whatsapp(
        self,
        task: dict[str, Any],
        resolve_account_id: Callable[[Any], Any],
    ) -> str:
        """
        Delivers one reminder on WhatsApp.

        Returns a TERMINAL/RETRY verdict rather than a boolean, and that distinction is the whole
        retry mechanism: 'retry' means this attempt failed but the budget is not spent, so the
        caller must leave the reminder un-stamped for the next sweep to pick up. Returning a plain
        false here is what previously retired a reminder after one failed attempt.

        Never throws. A reminder that cannot be delivered must not take the sweep down with it,
        because the next reminder in the queue probably can be.
        """
        wa_delivery = task.get("whatsappDelivery") or {}
        attempts = wa_delivery.get("attempts", 0)

        # Out of retries. Recorded as failed and left alone — visible in the task list and in the
        # API, rather than retried forever against whatever is actually broken.
        if attempts >= REMINDER_MAX_DELIVERY_ATTEMPTS:
            last_err = wa_delivery.get("error") or "unknown"
            err_msg = f"gave up after {attempts} attempts - last error: {last_err}"[:500]
            await self.record_reminder_delivery(
                task_id=task["_id"],
                channel=REMINDER_CHANNELS["WHATSAPP"],
                status=REMINDER_DELIVERY_STATUSES["FAILED"],
                error=err_msg,
                now=self.now(),
            )
            return "failed"

        # A lead follow-up names its own account; a personal reminder has to borrow the
        # organization's. Resolved before the send because the account id is what selects the live
        # socket — without one there is nothing to send through.
        account_id = task.get("whatsappAccountId") or await resolve_account_id(
            task.get("organizationId")
        )

        if not account_id:
            # The organization has no active number at all. Nothing is transiently broken, so this is
            # not worth an attempt from the budget; the reminder closes out and the handset still rings.
            await self.record_reminder_delivery(
                task_id=task["_id"],
                channel=REMINDER_CHANNELS["WHATSAPP"],
                status=REMINDER_DELIVERY_STATUSES["SKIPPED"],
                error="no active WhatsApp account for this organization",
                now=self.now(),
            )
            return "skipped"

        try:
            lead = await self.load_reminder_lead_context(task, logger=self.logger)
            message_text = build_reminder_message(
                task,
                now=self.now(),
                lead=lead,
                config=self.config,
            )

            result = await self.notify_owner(
                organization_id=task.get("organizationId"),
                account_id=account_id,
                text=message_text,
            )

            # notify_owner resolves with a null id when there is no session or no owner number. That
            # is not an error to retry against — nothing is misconfigured at this end — so it is
            # SKIPPED, and the device alarm remains the owner's path to hearing about this.
            provider_id = (
                result.get("providerMessageId") if isinstance(result, dict) else None
            )
            if not provider_id:
                await self.record_reminder_delivery(
                    task_id=task["_id"],
                    channel=REMINDER_CHANNELS["WHATSAPP"],
                    status=REMINDER_DELIVERY_STATUSES["SKIPPED"],
                    error="no WhatsApp session or owner number configured",
                    now=self.now(),
                )
                return "skipped"

            await self.record_reminder_delivery(
                task_id=task["_id"],
                channel=REMINDER_CHANNELS["WHATSAPP"],
                status=REMINDER_DELIVERY_STATUSES["SENT"],
                now=self.now(),
            )
            return "sent"

        except Exception as error:
            err_msg = str(
                getattr(error, "message", None)
                or getattr(error, "code", None)
                or error
                or "send failed"
            )[:500]

            # PENDING, not FAILED: the attempt counter went up, and the next sweep tries again until
            # REMINDER_MAX_DELIVERY_ATTEMPTS is reached. This is the retry.
            await self.record_reminder_delivery(
                task_id=task["_id"],
                channel=REMINDER_CHANNELS["WHATSAPP"],
                status=REMINDER_DELIVERY_STATUSES["PENDING"],
                error=err_msg,
                now=self.now(),
            )

            if hasattr(self.logger, "error"):
                self.logger.error(
                    "Reminder WhatsApp delivery failed; it will be retried: %s",
                    type(error).__name__,
                )

            return "retry"

    async def sweep_once(self, *, limit: int = 25) -> ReminderSweepResult:
        """
        One pass. Claims and delivers up to `limit` reminders, oldest-due first.

        Bounded per tick on purpose: a backlog after an outage drains over several sweeps instead
        of firing two hundred WhatsApp messages in one burst, which is how an unofficial WhatsApp
        connection gets itself banned.
        """
        claimed = 0
        whatsapp_sent = 0
        whatsapp_failed = 0
        whatsapp_retrying = 0
        push_sent = 0
        push_failed = 0

        # Belt-and-braces against re-handling one reminder inside a single sweep. The claim/lease
        # should already prevent it; this makes it impossible even if a future change to the
        # release paths reopens that door.
        handled: set[str] = set()
        resolve_account_id = self._create_account_resolver()

        for _ in range(limit):
            task = await self.claim_due_reminder(now=self.now())
            if not task:
                break

            task_id_str = str(task.get("_id"))
            if task_id_str in handled:
                await self.release_reminder_claim(task_id=task["_id"])
                break

            handled.add(task_id_str)
            claimed += 1

            # Cancelled or completed between being claimed and being read. Nothing to send; drop the
            # claim and move on. The device learns the same thing from its next sync.
            if task.get("status") != FOLLOWUP_STATUSES["PENDING"]:
                await self.release_reminder_claim(task_id=task["_id"])
                continue

            # Already announced. Belt-and-braces against a lease that expired under a slow send —
            # without it, the reclaim path is a duplicate-message generator.
            if task.get("lastNotificationAt"):
                await self.release_reminder_claim(task_id=task["_id"])
                continue

            # THE SECOND CHANNEL, AND IT RUNS WHATEVER WHATSAPP DOES.
            #
            # Deliberately before the branch below: the `retry` path `continue`s, so a push placed
            # after it would never fire on exactly the occasion the owner most needs it — WhatsApp
            # down and the reminder going nowhere. `notifyReminderDueQuietly` never throws and
            # returns nothing the sweep reads, so a Firebase outage cannot change a WhatsApp
            # outcome. Its own `pushNotifiedAt` stamp is what stops a WhatsApp retry re-buzzing the
            # handset. See push/push-notify.service.ts.
            push_res = await self.notify_reminder_due_push(task)
            push_sent += push_res.get("sent", 0)
            push_failed += push_res.get("failed", 0)

            outcome = await self._deliver_whatsapp(task, resolve_account_id)

            if outcome == "sent":
                whatsapp_sent += 1
            else:
                whatsapp_failed += 1

            # RETRY IS THE ONLY NON-TERMINAL OUTCOME. Stamping `lastNotificationAt` is what tells
            # every later sweep this reminder is done with, so doing it on a retryable failure
            # retires the reminder after a single attempt and REMINDER_MAX_DELIVERY_ATTEMPTS can
            # never be reached. Hand the claim back instead and let the next sweep try again.
            if outcome == "retry":
                whatsapp_retrying += 1

                # THE CLAIM IS DELIBERATELY NOT RELEASED. Releasing it here made the reminder
                # immediately eligible again, so this same loop re-claimed it and spent the entire
                # attempt budget in one tick — three "retries" 27 milliseconds apart, against a
                # WhatsApp socket that was equally down for all of them.
                #
                # Leaving the claim in place makes the LEASE the backoff: nobody can touch this
                # reminder until it expires, which is a couple of sweeps away. That is what "retried
                # on the next sweep" was always supposed to mean.
                continue

            # Terminal — sent, deliberately skipped, or out of attempts. Closed out either way: a
            # permanent WhatsApp failure must not hold the reminder open, because the owner's
            # handset may well have rung regardless and an un-closed reminder would be re-announced
            # on every sweep forever.
            await self.finish_reminder_delivery(task_id=task["_id"], now=self.now())

        result = ReminderSweepResult(
            claimed=claimed,
            whatsappSent=whatsapp_sent,
            whatsappFailed=whatsapp_failed,
            whatsappRetrying=whatsapp_retrying,
            pushSent=push_sent,
            pushFailed=push_failed,
        )

        if claimed > 0 and hasattr(self.logger, "info"):
            self.logger.info("REMINDER_SWEEP: %s", result._asdict())

        return result


def create_reminder_sweep_service(**kwargs: Any) -> ReminderSweepService:
    return ReminderSweepService(**kwargs)

