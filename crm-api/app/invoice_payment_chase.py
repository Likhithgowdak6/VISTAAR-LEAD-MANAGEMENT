"""Invoice-aware payment chase, driven only by the existing owner's 'pending' approval."""
import hashlib
import logging
import re
import secrets
from datetime import datetime, timedelta, timezone

from bson import ObjectId
from pymongo.errors import DuplicateKeyError

from app import db
from app.owner_actor import get_owner_actor_for_organization
from app.followup_tasks import create_follow_up_task
from app.outbound_messages import enqueue_outbound_message
from app.ai_brain_system_user import get_or_create_ai_system_user
from app.payments_repository import sum_payments_for_invoice
from app.owner_notify import create_owner_notify_service

logger = logging.getLogger(__name__)
COLLECTION = "invoices"
SENT = ("sent", "delivered", "read")
FAILED = ("failed_permanent", "failed")
GAPS = (3, 4)
PAYMENT_WORDS = re.compile(r"\b(pay|payment|balance|settle|settlement|upi)\b|\bbank\s+transfer\b", re.I)

def utc(value):
    return value.replace(tzinfo=value.tzinfo or timezone.utc) if isinstance(value, datetime) else None

def payment_promise(conversation):
    commitment = conversation.get("lastLeadCommitment") or {}
    if (commitment.get("direction") == "await_lead" and isinstance(commitment.get("key"), str)
            and commitment.get("key") and utc(commitment.get("dueAt"))
            and PAYMENT_WORDS.search(str(commitment.get("quote") or ""))):
        return commitment
    return None

def build_invoice_chase_message(name, invoice, balance, step, url=None):
    amount = f"₹{balance // 100:,}.{balance % 100:02d}"
    number = invoice.get("invoiceNumber") or "your invoice"
    opening = ("Just a gentle reminder", "Following up on the outstanding payment",
               "A final payment reminder from our team")[min(step, 2)]
    text = f"Hi {name}, {opening.lower()}: {amount} remains due on invoice {number}."
    if url:
        text += f" You can pay here: {url}"
    return text + " Please let us know if you need any clarification."

async def ensure_payment_chase_indexes(database=None):
    database = database if database is not None else db.get_database()
    await database.invoices.create_index([("organizationId", 1), ("paymentChase.state", 1), ("paymentChase.nextAt", 1)])
    await database.conversations.create_index([("organizationId", 1), ("paymentInvoiceApproval.invoiceId", 1)])

async def balance_due(database, invoice):
    paid = await sum_payments_for_invoice(organization_id=invoice["organizationId"],
        invoice_id=invoice["_id"], db_override=database)
    return int(invoice.get("totalPaise") or 0) - paid

def booking_stop_reason(conversation, approved_at, now):
    if not conversation or conversation.get("isDeleted") or conversation.get("stage") != "won":
        return "booking_not_won"
    if not utc(conversation.get("eventDate")) or utc(conversation["eventDate"]) > now - timedelta(days=1):
        return "service_not_finished"
    if conversation.get("paymentSettledAt"):
        return "owner_settled"
    if conversation.get("optedOutAt") or conversation.get("salesRejectedAt"):
        return "recipient_stopped"
    if conversation.get("aiAutomationEnabled") is not True:
        return "automation_paused"
    if utc(conversation.get("ownerLastTypedAt")) and utc(conversation["ownerLastTypedAt"]) >= approved_at:
        return "owner_takeover"
    return None

async def delivery_reason(message, conversation, now, *, database=None):
    context = message.get("paymentContext")
    if not context:
        return None
    database = database if database is not None else db.get_database()
    try:
        org, invoice_id = ObjectId(str(message["organizationId"])), ObjectId(str(context["invoiceId"]))
    except Exception:
        return "payment_context_invalid"
    invoice = await database.invoices.find_one({"_id": invoice_id, "organizationId": org, "deletedAt": None})
    chase = (invoice or {}).get("paymentChase") or {}
    if (not invoice or invoice.get("status") not in ("issued", "sent")
            or str(invoice.get("conversationId")) != str(message.get("conversationId"))
            or str(invoice.get("contactId")) != str(message.get("contactId"))
            or chase.get("generation") != context.get("generation") or chase.get("state") != "active"):
        return "payment_chase_stopped"
    reason = booking_stop_reason(conversation, utc(chase.get("approvedAt")), now)
    if reason:
        return "payment_" + reason
    approval = conversation.get("paymentInvoiceApproval") or {}
    if approval.get("generation") != chase["generation"]:
        return "payment_approval_revoked"
    promise = payment_promise(conversation)
    if promise and promise.get("key") != context.get("commitmentKey"):
        return "payment_promise_changed"
    if utc(invoice.get("remindersPausedUntil")) and utc(invoice["remindersPausedUntil"]) > now:
        return "payment_reminders_paused"
    if utc(chase.get("notBefore")) and utc(chase["notBefore"]) > now:
        return "payment_promise_pending"
    manual = await database.messages.find_one({"organizationId": org, "conversationId": message["conversationId"],
        "authoredBy": "human", "createdAt": {"$gte": chase["approvedAt"]}})
    if manual:
        return "payment_owner_takeover"
    if await balance_due(database, invoice) != context.get("amountDuePaise"):
        return "payment_balance_changed"
    if context.get("providerLinkId"):
        link = await database.payment_links.find_one({"organizationId": org,
            "invoiceId": invoice["_id"], "providerLinkId": context["providerLinkId"], "state": "created"})
        if not link:
            return "payment_link_unavailable"
    return None

class InvoicePaymentChase:
    def __init__(self, *, database=None, now=None, notify=None, enqueue=None, handoff=None):
        self.database = database
        self.now = now or db.utc_now
        self.notify = notify
        self.enqueue = enqueue
        self.handoff = handoff

    @property
    def store(self):
        return self.database if self.database is not None else db.get_database()

    async def tell_owner(self, organization_id, text):
        if self.notify:
            return await self.notify(organization_id=organization_id, text=text)
        return await create_owner_notify_service().notify_owner(organization_id=organization_id, text=text)

    async def approve(self, conversation, code):
        """Return False only when this booking has no linked invoice (legacy one-shot path)."""
        database = self.store
        org, cid = conversation["organizationId"], conversation["_id"]
        invoices = await database.invoices.find({"organizationId": org, "conversationId": cid,
            "contactId": conversation.get("contactId"), "deletedAt": None,
            "status": {"$in": ["issued", "sent", "paid"]}}).limit(100).to_list(length=100)
        if not invoices:
            return False
        unpaid = [i for i in invoices if i["status"] != "paid" and await balance_due(database, i) > 0]
        if len(unpaid) != 1:
            await self.tell_owner(org, "No reminder sent: this booking has no outstanding balance." if not unpaid
                else "No reminder sent: multiple unpaid invoices are linked to this booking. Please review them manually.")
            return True
        invoice = unpaid[0]
        reason = booking_stop_reason(conversation, self.now(), self.now())
        if reason:
            await self.tell_owner(org, "No payment reminder sent: this booking is settled, paused, opted out, or not yet ready for collection.")
            return True
        approval = conversation.get("paymentInvoiceApproval")
        if approval and str(approval.get("invoiceId")) != str(invoice["_id"]):
            await self.tell_owner(org, "No new reminders started: this booking already has approval for another invoice. Please review it manually.")
            return True
        if invoice.get("paymentChase") and invoice["paymentChase"].get("state") != "active":
            await self.tell_owner(org, "This invoice's automatic follow-up has already stopped. Please review it manually.")
            return True
        if not approval:
            stamp = self.now()
            seed = f"{org}:{cid}:{code}:{conversation.get('paymentPromptSentAt')}"
            approval = {"invoiceId": invoice["_id"], "generation": hashlib.sha256(seed.encode()).hexdigest(),
                        "approvedAt": stamp}
            claimed = await database.conversations.find_one_and_update({
                "_id": cid, "organizationId": org, "paymentPromptCode": code, "paymentSettledAt": None,
                "paymentChaseSentAt": None, "stage": "won", "isDeleted": {"$ne": True}},
                {"$set": {"paymentInvoiceApproval": approval, "paymentChaseSentAt": stamp}}, return_document=True)
            if not claimed:
                await self.tell_owner(org, "This booking already has a payment reminder or is no longer awaiting approval.")
                return True
            conversation = claimed
        await self.restore_approval(conversation)
        await self.process(invoice["_id"], org)
        await self.tell_owner(org, "Payment follow-up approved: up to three reminders, with fresh balance checks before each send. Payment, opt-out or manual takeover stops the sequence.")
        return True

    async def restore_approval(self, conversation):
        approval = conversation.get("paymentInvoiceApproval")
        if not approval:
            return
        await self.store.invoices.update_one({
            "_id": approval["invoiceId"], "organizationId": conversation["organizationId"],
            "conversationId": conversation["_id"], "contactId": conversation.get("contactId"),
            "paymentChase": None, "deletedAt": None, "status": {"$in": ["issued", "sent"]}},
            {"$set": {"paymentChase": {"generation": approval["generation"], "approvedAt": approval["approvedAt"],
                "state": "active", "step": 0, "nextAt": approval["approvedAt"]}}})

    async def hand_to_owner(self, invoice, conversation, reason):
        chase = invoice["paymentChase"]
        org = invoice["organizationId"]
        key = f"payment-handoff:{invoice['_id']}:{chase['generation']}"
        explanation = {"reminder_limit_reached": "three reminders were sent",
            "window_closed": "WhatsApp requires an approved template"}.get(reason, "the reminder could not be delivered")
        if self.handoff:
            await self.handoff(invoice=invoice, conversation=conversation, reason=reason, key=key)
        else:
            actor = (await get_owner_actor_for_organization(organization_id=org))["actor"]
            existing = await self.store.followuptasks.find_one({"organizationId": org, "idempotencyKey": key})
            if not existing:
                try:
                    await create_follow_up_task(organization_id=org, assigned_to=actor["_id"], created_by=actor["_id"],
                        conversation_id=conversation["_id"], whatsapp_account_id=conversation.get("whatsappAccountId"),
                        type="custom", title="Review outstanding invoice payment",
                        note=f"Invoice {invoice.get('invoiceNumber')}: {explanation}.", due_at=self.now(),
                        idempotency_key=key)
                except DuplicateKeyError:
                    pass
        if not chase.get("handoffNotifiedAt"):
            await self.tell_owner(org, f"Payment follow-up needs your attention for invoice {invoice.get('invoiceNumber')}: {explanation}. Automatic reminders have stopped.")
            await self.store.invoices.update_one({"_id": invoice["_id"], "organizationId": org},
                {"$set": {"paymentChase.handoffNotifiedAt": self.now()}})
        await self.store.invoices.update_one({"_id": invoice["_id"], "organizationId": org,
            "paymentChase.generation": chase["generation"]},
            {"$set": {"paymentChase.state": "handed_off", "paymentChase.stopReason": reason}})

    async def process(self, invoice_id, org):
        database, moment, token = self.store, self.now(), secrets.token_hex(16)
        invoice = await database.invoices.find_one_and_update({
            "_id": invoice_id, "organizationId": org, "paymentChase.state": "active",
            "$or": [{"paymentChase.leaseUntil": None}, {"paymentChase.leaseUntil": {"$lte": moment}}]},
            {"$set": {"paymentChase.leaseUntil": moment+timedelta(minutes=5),
                      "paymentChase.leaseToken": token}}, return_document=True)
        if not invoice:
            return
        try:
            await self._process(invoice, moment)
        finally:
            await database.invoices.update_one({"_id": invoice_id, "organizationId": org,
                "paymentChase.leaseToken": token},
                {"$unset": {"paymentChase.leaseUntil": "", "paymentChase.leaseToken": ""}})

    async def _process(self, invoice, now):
        database, org, chase = self.store, invoice["organizationId"], invoice["paymentChase"]
        conversation = await database.conversations.find_one({"_id": invoice["conversationId"], "organizationId": org})
        reason = booking_stop_reason(conversation, utc(chase["approvedAt"]), now)
        if invoice.get("deletedAt") or invoice.get("status") not in ("issued", "sent") or await balance_due(database, invoice) <= 0:
            reason = "invoice_settled_or_closed"
        if not reason and not (conversation.get("paymentInvoiceApproval") or {}).get("generation") == chase["generation"]:
            reason = "approval_revoked"
        if not reason:
            manual = await database.messages.find_one({"organizationId": org, "conversationId": conversation["_id"],
                "authoredBy": "human", "createdAt": {"$gte": chase["approvedAt"]}})
            if manual:
                reason = "owner_takeover"
        if reason:
            await database.invoices.update_one({"_id": invoice["_id"], "organizationId": org},
                {"$set": {"paymentChase.state": "stopped", "paymentChase.stopReason": reason}})
            return
        promise = payment_promise(conversation)
        if promise and promise.get("key") != chase.get("commitmentKey"):
            until = utc(promise["dueAt"]) + timedelta(days=1)
            changes = {"promiseDate": promise["dueAt"], "paymentChase.notBefore": until,
                       "paymentChase.commitmentKey": promise["key"]}
            await database.invoices.update_one({"_id": invoice["_id"], "organizationId": org}, {"$set": changes})
            chase["notBefore"], chase["commitmentKey"] = until, promise["key"]
        pending_key = chase.get("pendingKey")
        if pending_key:
            message = await database.messages.find_one({"organizationId": org, "idempotencyKey": pending_key})
            if not message:
                # A queue insert may have failed; retry the same step and key.
                chase.pop("pendingKey", None)
            elif message.get("status") in SENT:
                step = int(chase.get("step", 0)) + 1
                sent_at = utc(message.get("deliveredAt") or message.get("sentAt")) or now
                next_at = sent_at + timedelta(days=GAPS[min(step-1,1)])
                await database.invoices.update_one({"_id": invoice["_id"], "organizationId": org,
                    "paymentChase.pendingKey": pending_key},
                    {"$set": {"paymentChase.step": step, "paymentChase.nextAt": next_at,
                              "lastReminderAt": sent_at}, "$inc": {"remindersSentCount": 1},
                     "$unset": {"paymentChase.pendingKey": ""}})
                chase.update({"step": step, "nextAt": next_at})
                chase.pop("pendingKey", None)
                if step >= 3:
                    await self.hand_to_owner(invoice, conversation, "reminder_limit_reached")
                    return
            elif message.get("status") in FAILED:
                delivery_error = message.get("lastDeliveryError")
                if delivery_error == "superseded_by_inbound" and not promise:
                    inbound = utc(conversation.get("lastInboundAt"))
                    if inbound and now-inbound < timedelta(minutes=5):
                        return  # Give existing commitment extraction/retries time to finish.
                if delivery_error in ("payment_balance_changed", "payment_promise_changed",
                                                    "payment_promise_pending", "payment_reminders_paused"):
                    await database.invoices.update_one({"_id": invoice["_id"], "organizationId": org},
                        {"$unset": {"paymentChase.pendingKey": ""}})
                    chase.pop("pendingKey", None)
                elif delivery_error == "superseded_by_inbound" and promise:
                    await database.invoices.update_one({"_id": invoice["_id"], "organizationId": org},
                        {"$unset": {"paymentChase.pendingKey": ""}})
                    chase.pop("pendingKey", None)
                else:
                    await self.hand_to_owner(invoice, conversation, str(message.get("lastDeliveryError") or "delivery_failed"))
                    return
            else:
                return
        if int(chase.get("step",0)) >= 3:
            await self.hand_to_owner(invoice, conversation, "reminder_limit_reached")
            return
        due = max(utc(chase["nextAt"]), utc(chase.get("notBefore")) or utc(chase["nextAt"]),
                  utc(invoice.get("remindersPausedUntil")) or utc(chase["nextAt"]))
        if due > now:
            return
        balance = await balance_due(database, invoice)
        link = await database.payment_links.find_one({"organizationId": org, "invoiceId": invoice["_id"],
            "state": "created", "amountPaise": balance})
        # No stale/smaller link: a partial payment may make the old link exceed the balance.
        revision = hashlib.sha256(f"{balance}:{chase.get('commitmentKey','')}:{(link or {}).get('providerLinkId','')}:{invoice.get('remindersPausedUntil')}:{chase.get('notBefore')}".encode()).hexdigest()[:16]
        key = f"invoice-payment:{invoice['_id']}:{chase['generation']}:{chase['step']}:{revision}"
        context = {"invoiceId": invoice["_id"], "generation": chase["generation"],
                   "amountDuePaise": balance, "commitmentKey": chase.get("commitmentKey"),
                   "providerLinkId": (link or {}).get("providerLinkId")}
        body = build_invoice_chase_message(conversation.get("displayName") or "there",
            invoice, balance, chase["step"], (link or {}).get("url"))
        if self.enqueue:
            await self.enqueue(conversation=conversation, organization_id=org, body=body,
                               idempotency_key=key, payment_context=context)
        else:
            actor = await get_or_create_ai_system_user(organization_id=org)
            await enqueue_outbound_message(organization_id=org, conversation=conversation, actor=actor,
                body=body, idempotency_key=key, authored_by="ai", payment_context=context)
        await database.invoices.update_one({"_id": invoice["_id"], "organizationId": org,
            "paymentChase.generation": chase["generation"]},
            {"$set": {"paymentChase.pendingKey": key}})

    async def run_for_organization(self, organization_id):
        database = self.store
        # Recover an owner approval interrupted before its invoice state was initialized.
        conversations = await database.conversations.find({"organizationId": organization_id,
            "paymentInvoiceApproval.invoiceId": {"$exists": True}, "paymentSettledAt": None}).limit(200).to_list(length=200)
        for conversation in conversations:
            await self.restore_approval(conversation)
        invoices = await database.invoices.find({"organizationId": organization_id,
            "paymentChase.state": "active"}).sort("paymentChase.nextAt",1).limit(200).to_list(length=200)
        for invoice in invoices:
            try:
                await self.process(invoice["_id"], organization_id)
            except Exception as exc:
                logger.warning("Invoice payment chase failed (%s)", type(exc).__name__)
