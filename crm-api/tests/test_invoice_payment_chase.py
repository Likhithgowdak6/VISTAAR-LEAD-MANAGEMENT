import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from bson import ObjectId
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

from app import db
from app.invoice_payment_chase import InvoicePaymentChase, delivery_reason, ensure_payment_chase_indexes
from app.payment_followup import PaymentFollowUpService
from app.payments_repository import ensure_payment_indexes
from app.main import app
from app.config import settings

@pytest_asyncio.fixture
async def ctx(monkeypatch):
    database = AsyncMongoMockClient()["payment_chase_tests"]
    monkeypatch.setattr(db, "get_database", lambda: database)
    await ensure_payment_indexes(database)
    await ensure_payment_chase_indexes(database)
    await database.messages.create_index([("organizationId",1),("idempotencyKey",1)], unique=True)
    org, cid, contact, account, invoice = [ObjectId() for _ in range(5)]
    now = [datetime(2026,11,20,12,tzinfo=timezone.utc)]
    conv = {"_id":cid, "organizationId":org, "contactId":contact, "whatsappAccountId":account,
        "stage":"won", "eventDate":now[0]-timedelta(days=2), "displayName":"Riya",
        "aiAutomationEnabled":True, "paymentPromptSentAt":now[0]-timedelta(hours=1),
        "paymentPromptCode":"B4"}
    await database.organizations.insert_one({"_id":org, "status":"active"})
    await database.conversations.insert_one(conv)
    await database.invoices.insert_one({"_id":invoice, "organizationId":org, "conversationId":cid,
        "contactId":contact, "status":"issued", "totalPaise":10000, "amountPaidPaise":0,
        "invoiceNumber":"VIS-2026-001", "deletedAt":None, "remindersSentCount":0})
    await database.payment_links.insert_one({"organizationId":org, "invoiceId":invoice,
        "state":"created", "amountPaise":10000, "providerLinkId":"plink_current", "url":"https://rzp.io/i/synthetic"})
    notify, handoff = AsyncMock(), AsyncMock()
    async def enqueue(**kw):
        old = await database.messages.find_one({"organizationId":org,"idempotencyKey":kw["idempotency_key"]})
        if old:
            return old
        doc = {"organizationId":org, "conversationId":cid, "contactId":contact,
            "whatsappAccountId":account, "authoredBy":"ai", "status":"queued", "body":kw["body"],
            "createdAt":now[0], "sentAt":now[0], "idempotencyKey":kw["idempotency_key"],
            "paymentContext":kw["payment_context"]}
        doc["_id"] = (await database.messages.insert_one(doc)).inserted_id
        return doc
    service = InvoicePaymentChase(database=database, now=lambda:now[0],
        notify=notify, enqueue=enqueue, handoff=handoff)
    return database, org, cid, invoice, conv, now, service, notify, handoff

async def pending(ctx):
    invoice = await ctx[0].invoices.find_one({"_id":ctx[3]})
    return await ctx[0].messages.find_one({"idempotencyKey":invoice["paymentChase"].get("pendingKey")})

async def approve(ctx):
    conv = await ctx[0].conversations.find_one({"_id":ctx[2]})
    return await ctx[6].approve(conv, "B4")

async def mark_sent(ctx):
    msg = await pending(ctx)
    await ctx[0].messages.update_one({"_id":msg["_id"]},{"$set":{"status":"sent","sentAt":ctx[5][0]}})
    await ctx[6].process(ctx[3],ctx[1])

@pytest.mark.asyncio
async def test_no_approval_means_no_reminders_even_when_invoice_is_overdue(ctx):
    await ctx[0].invoices.update_one({"_id":ctx[3]}, {"$set":{"dueDate":ctx[5][0]-timedelta(days=100)}})
    await ctx[6].run_for_organization(ctx[1])
    assert await ctx[0].messages.count_documents({}) == 0

@pytest.mark.asyncio
async def test_owner_pending_queues_invoice_amount_and_exact_balance_link(ctx):
    assert await approve(ctx)
    msg = await pending(ctx)
    assert "₹100.00" in msg["body"] and "VIS-2026-001" in msg["body"]
    assert "https://rzp.io/i/synthetic" in msg["body"]
    assert msg["authoredBy"] == "ai"
    assert (await ctx[0].invoices.find_one({"_id":ctx[3]}))["remindersSentCount"] == 0
    conv = await ctx[0].conversations.find_one({"_id":ctx[2]})
    assert await delivery_reason(msg, conv, ctx[5][0], database=ctx[0]) is None

@pytest.mark.asyncio
async def test_parallel_owner_answers_do_not_queue_twice(ctx):
    await asyncio.gather(approve(ctx),approve(ctx))
    assert await ctx[0].messages.count_documents({}) == 1

@pytest.mark.asyncio
@pytest.mark.parametrize("changes",[
    {"stage":"contacted"}, {"eventDate":datetime(2027,1,1,tzinfo=timezone.utc)},
    {"optedOutAt":datetime(2026,11,20,tzinfo=timezone.utc)},
    {"aiAutomationEnabled":False}, {"paymentSettledAt":datetime(2026,11,20,tzinfo=timezone.utc)},
])
async def test_gates_block_owner_approval(ctx, changes):
    await ctx[0].conversations.update_one({"_id":ctx[2]},{"$set":changes})
    await approve(ctx)
    assert await ctx[0].messages.count_documents({}) == 0

@pytest.mark.asyncio
async def test_missing_or_ambiguous_invoice_never_guesses_a_debt(ctx):
    await ctx[0].invoices.insert_one({"organizationId":ctx[1],"conversationId":ctx[2],
        "contactId":ctx[4]["contactId"],"status":"issued","deletedAt":None,"totalPaise":5000})
    assert await approve(ctx)
    assert await ctx[0].messages.count_documents({}) == 0
    assert "multiple unpaid" in ctx[7].call_args.kwargs["text"]

@pytest.mark.asyncio
async def test_invoice_is_not_matched_by_contact_alone_or_other_tenant(ctx):
    await ctx[0].invoices.update_one({"_id":ctx[3]},{"$set":{"conversationId":ObjectId()}})
    assert await approve(ctx) is False
    assert await ctx[0].messages.count_documents({}) == 0

@pytest.mark.asyncio
async def test_only_successful_delivery_advances_the_three_step_ladder(ctx):
    await approve(ctx)
    for step,gap in [(1,3),(2,4),(3,0)]:
        await ctx[6].process(ctx[3],ctx[1])
        assert await ctx[0].messages.count_documents({}) == step
        await mark_sent(ctx)
        invoice = await ctx[0].invoices.find_one({"_id":ctx[3]})
        assert invoice["remindersSentCount"] == step
        if gap:
            ctx[5][0] += timedelta(days=gap)-timedelta(seconds=1)
            await ctx[6].process(ctx[3],ctx[1])
            assert await ctx[0].messages.count_documents({}) == step
            ctx[5][0] += timedelta(seconds=1)
            await ctx[6].process(ctx[3],ctx[1])
    assert invoice["paymentChase"]["state"] == "handed_off"
    ctx[8].assert_awaited_once()
    ctx[5][0] += timedelta(days=30)
    await ctx[6].run_for_organization(ctx[1])
    assert await ctx[0].messages.count_documents({}) == 3

@pytest.mark.asyncio
async def test_partial_payment_cancels_stale_amount_and_omits_old_larger_link(ctx):
    await approve(ctx)
    msg = await pending(ctx)
    await ctx[0].payments.insert_one({"organizationId":ctx[1],"invoiceId":ctx[3],
        "amountPaise":4000,"voidedAt":None})
    conv = await ctx[0].conversations.find_one({"_id":ctx[2]})
    assert await delivery_reason(msg,conv,ctx[5][0],database=ctx[0]) == "payment_balance_changed"
    await ctx[0].messages.update_one({"_id":msg["_id"]},{"$set":{
        "status":"failed_permanent","lastDeliveryError":"payment_balance_changed"}})
    await ctx[6].process(ctx[3],ctx[1])
    revised = await pending(ctx)
    assert revised["_id"] != msg["_id"]
    assert "₹60.00" in revised["body"] and "https://rzp.io" not in revised["body"]
    assert revised["paymentContext"]["amountDuePaise"] == 6000

@pytest.mark.asyncio
async def test_ledger_payment_stops_a_queued_message_before_invoice_cache_updates(ctx):
    await approve(ctx); msg = await pending(ctx)
    await ctx[0].payments.insert_one({"organizationId":ctx[1],"invoiceId":ctx[3],
        "amountPaise":10000,"voidedAt":None})
    conv = await ctx[0].conversations.find_one({"_id":ctx[2]})
    assert await delivery_reason(msg,conv,ctx[5][0],database=ctx[0]) == "payment_balance_changed"
    await ctx[6].process(ctx[3],ctx[1])
    assert (await ctx[0].invoices.find_one({"_id":ctx[3]}))["paymentChase"]["state"] == "stopped"

@pytest.mark.asyncio
@pytest.mark.parametrize("changes", [
    {"paymentSettledAt":datetime(2026,11,21,tzinfo=timezone.utc)},
    {"optedOutAt":datetime(2026,11,21,tzinfo=timezone.utc)},
    {"aiAutomationEnabled":False},
    {"ownerLastTypedAt":datetime(2026,11,21,tzinfo=timezone.utc)},
])
async def test_revocation_after_queue_blocks_delivery(ctx,changes):
    await approve(ctx); msg=await pending(ctx)
    await ctx[0].conversations.update_one({"_id":ctx[2]},{"$set":changes})
    conv=await ctx[0].conversations.find_one({"_id":ctx[2]})
    assert await delivery_reason(msg,conv,ctx[5][0],database=ctx[0])
    await ctx[6].process(ctx[3],ctx[1])
    assert (await ctx[0].invoices.find_one({"_id":ctx[3]}))["paymentChase"]["state"] == "stopped"

@pytest.mark.asyncio
async def test_human_reply_after_approval_stops_the_sequence(ctx):
    await approve(ctx); msg=await pending(ctx)
    await ctx[0].messages.insert_one({"organizationId":ctx[1],"conversationId":ctx[2],
        "authoredBy":"human","createdAt":ctx[5][0]+timedelta(minutes=1)})
    conv=await ctx[0].conversations.find_one({"_id":ctx[2]})
    assert await delivery_reason(msg,conv,ctx[5][0],database=ctx[0]) == "payment_owner_takeover"

@pytest.mark.asyncio
async def test_confirmed_payment_promise_postpones_then_follows_up_when_missed(ctx):
    await approve(ctx); msg=await pending(ctx)
    due=ctx[5][0]+timedelta(days=2)
    await ctx[0].conversations.update_one({"_id":ctx[2]},{"$set":{"lastLeadCommitment":{
        "direction":"await_lead","quote":"I will pay on Sunday","dueAt":due,"key":"lead-commit:new"}}})
    conv=await ctx[0].conversations.find_one({"_id":ctx[2]})
    assert await delivery_reason(msg,conv,ctx[5][0],database=ctx[0]) == "payment_promise_changed"
    await ctx[0].messages.update_one({"_id":msg["_id"]},{"$set":{
        "status":"failed_permanent","lastDeliveryError":"payment_promise_changed"}})
    await ctx[6].process(ctx[3],ctx[1])
    invoice=await ctx[0].invoices.find_one({"_id":ctx[3]})
    assert invoice["promiseDate"].replace(tzinfo=timezone.utc) == due
    assert await ctx[0].messages.count_documents({}) == 1
    ctx[5][0]=due+timedelta(hours=23)
    await ctx[6].process(ctx[3],ctx[1])
    assert await ctx[0].messages.count_documents({}) == 1
    ctx[5][0]=due+timedelta(days=1)
    await ctx[6].process(ctx[3],ctx[1])
    assert await ctx[0].messages.count_documents({}) == 2

@pytest.mark.asyncio
async def test_non_payment_commitment_does_not_postpone_collections(ctx):
    await approve(ctx)
    due=ctx[5][0]+timedelta(days=10)
    await ctx[0].conversations.update_one({"_id":ctx[2]},{"$set":{"lastLeadCommitment":{
        "direction":"await_lead","quote":"I will send the photo album","dueAt":due,"key":"unrelated"}}})
    await ctx[6].process(ctx[3],ctx[1])
    assert "promiseDate" not in (await ctx[0].invoices.find_one({"_id":ctx[3]}))

@pytest.mark.asyncio
async def test_failed_cloud_window_hands_off_instead_of_retrying_or_substituting_template(ctx):
    await approve(ctx); msg=await pending(ctx)
    await ctx[0].messages.update_one({"_id":msg["_id"]},{"$set":{
        "status":"failed_permanent","lastDeliveryError":"window_closed"}})
    await ctx[6].process(ctx[3],ctx[1])
    assert await ctx[0].messages.count_documents({}) == 1
    assert (await ctx[0].invoices.find_one({"_id":ctx[3]}))["paymentChase"]["state"] == "handed_off"

@pytest.mark.asyncio
async def test_restarts_recover_approval_and_queue_insert_gaps(ctx):
    await approve(ctx)
    invoice=await ctx[0].invoices.find_one({"_id":ctx[3]})
    await ctx[0].invoices.update_one({"_id":ctx[3]},{"$unset":{"paymentChase":""}})
    await ctx[6].run_for_organization(ctx[1])
    assert await ctx[0].messages.count_documents({}) == 1
    invoice=await ctx[0].invoices.find_one({"_id":ctx[3]})
    assert invoice["paymentChase"]["generation"]
    await ctx[6].process(ctx[3],ctx[1])
    assert await ctx[0].messages.count_documents({}) == 1

@pytest.mark.asyncio
async def test_owner_collected_stops_chase_without_inventing_ledger_money(ctx):
    await approve(ctx)
    service=PaymentFollowUpService(notify_fn=ctx[7],create_activity_fn=AsyncMock())
    assert await service.handle_owner_reply(ctx[1],"B4 collected")
    await ctx[6].process(ctx[3],ctx[1])
    assert await ctx[0].payments.count_documents({}) == 0
    assert (await ctx[0].invoices.find_one({"_id":ctx[3]}))["paymentChase"]["state"] == "stopped"

@pytest.mark.asyncio
async def test_legacy_booking_without_invoice_keeps_one_reminder(ctx):
    await ctx[0].invoices.delete_one({"_id":ctx[3]})
    send=AsyncMock()
    service=PaymentFollowUpService(notify_fn=ctx[7],send_to_client_fn=send,create_activity_fn=AsyncMock())
    assert await service.handle_owner_reply(ctx[1],"B4 pending")
    assert await service.handle_owner_reply(ctx[1],"B4 pending")
    send.assert_awaited_once()

@pytest.mark.asyncio
async def test_internal_gateway_requires_service_key_before_tenant_access(ctx,monkeypatch):
    from app.routers import payment_gateway
    monkeypatch.setattr(settings,"whatsapp_gateway_service_key","synthetic-service-key")
    fake=AsyncMock()
    fake.handle_owner_reply.return_value=True
    monkeypatch.setattr(payment_gateway,"get_payment_follow_up_service",lambda:fake)
    payload={"organizationId":str(ctx[1]),"text":"B4 pending"}
    with TestClient(app) as client:
        assert client.post("/internal/v1/payments/owner-reply",json=payload).status_code == 401
        response=client.post("/internal/v1/payments/owner-reply",json=payload,
            headers={"X-Service-Key":"synthetic-service-key"})
        assert response.status_code == 200, response.text
    fake.handle_owner_reply.assert_awaited_once()

@pytest.mark.asyncio
async def test_ambiguous_owner_code_does_not_choose_arbitrary_booking(ctx):
    await ctx[0].conversations.insert_one({**ctx[4], "_id":ObjectId()})
    send=AsyncMock()
    service=PaymentFollowUpService(notify_fn=ctx[7],send_to_client_fn=send)
    assert await service.handle_owner_reply(ctx[1],"B4 pending")
    send.assert_not_awaited()
    assert await ctx[0].messages.count_documents({}) == 0
    assert "more than one booking" in ctx[7].call_args.kwargs["text"]

@pytest.mark.asyncio
async def test_non_payment_transfer_promise_does_not_postpone_collection(ctx):
    await approve(ctx)
    await ctx[0].conversations.update_one({"_id":ctx[2]},{"$set":{"lastLeadCommitment":{
        "direction":"await_lead","quote":"I will transfer the photos tomorrow",
        "dueAt":ctx[5][0]+timedelta(days=5),"key":"photo-transfer"}}})
    await ctx[6].process(ctx[3],ctx[1])
    assert "promiseDate" not in (await ctx[0].invoices.find_one({"_id":ctx[3]}))

@pytest.mark.asyncio
async def test_late_commitment_extraction_recovers_a_superseded_message(ctx):
    await approve(ctx); msg=await pending(ctx)
    await ctx[0].messages.update_one({"_id":msg["_id"]},{"$set":{
        "status":"failed_permanent","lastDeliveryError":"superseded_by_inbound"}})
    await ctx[0].conversations.update_one({"_id":ctx[2]},{"$set":{"lastInboundAt":ctx[5][0]}})
    await ctx[6].process(ctx[3],ctx[1])
    assert (await ctx[0].invoices.find_one({"_id":ctx[3]}))["paymentChase"]["state"] == "active"
    await ctx[0].conversations.update_one({"_id":ctx[2]},{"$set":{"lastLeadCommitment":{
        "direction":"await_lead","quote":"I will pay next week","key":"extracted-after-delivery",
        "dueAt":ctx[5][0]+timedelta(days=7)}}})
    await ctx[6].process(ctx[3],ctx[1])
    assert await ctx[0].messages.count_documents({}) == 1
    assert (await ctx[0].invoices.find_one({"_id":ctx[3]}))["promiseDate"]

@pytest.mark.asyncio
async def test_invoice_api_exposes_promise_and_sequence_status_without_leases(ctx):
    from app.invoice_serializer import serialize_invoice
    await approve(ctx)
    invoice=await ctx[0].invoices.find_one({"_id":ctx[3]})
    data=serialize_invoice(invoice)
    assert data["paymentFollowUp"]["state"] == "active"
    assert data["paymentFollowUp"]["remindersSent"] == 0
    assert "leaseToken" not in str(data) and "generation" not in str(data)
