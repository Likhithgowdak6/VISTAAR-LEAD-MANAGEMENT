"""Razorpay tests use httpx MockTransport and Mongo mocks; no external calls or money movement."""
import asyncio
import hashlib
import hmac
import json
from datetime import timedelta

import httpx
import pytest
import pytest_asyncio
from bson import ObjectId
from fastapi import HTTPException
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

from app import db, razorpay_client as api
from app.main import app
from app.payment_links_repository import ensure_razorpay_indexes, LINKS, link_dto
from app.payments_repository import ensure_payment_indexes, sum_payments_for_invoice
from app.razorpay_credentials import build_razorpay_config, read_key_secret, razorpay_dto
from app.razorpay_service import connect, create_link, sync_link, cancel_link
from app.razorpay_webhook import handle_webhook
from app.razorpay_reconciliation import reconcile_links
from app.routers import razorpay as routes
from app.deps import AuthContext

KEY = "rzp_test_Test12345678"
SECRET = "synthetic-key-secret"
WEBHOOK = "synthetic-webhook-secret"

class Provider:
    def __init__(self):
        self.links = {}
        self.payments = {}
        self.calls = []
        self.timeout_after_create = False

    async def request(self, request):
        self.calls.append(request)
        path = request.url.path
        if request.method == "POST" and path == "/v1/payment_links":
            body = json.loads(request.content)
            await asyncio.sleep(0)
            number = str(len(self.links) + 1)
            link = {**body, "id": "plink_" + number, "order_id": "order_" + number,
                "status": "created", "payments": [], "short_url": "https://rzp.io/i/test" + number}
            self.links[link["id"]] = link
            if self.timeout_after_create:
                raise httpx.ReadTimeout("synthetic timeout")
            return httpx.Response(200, json=link)
        if request.method == "GET" and path == "/v1/payment_links":
            reference = request.url.params.get("reference_id")
            return httpx.Response(200, json={"payment_links": [
                link for link in self.links.values() if not reference or link["reference_id"] == reference]})
        if path.startswith("/v1/payment_links/"):
            link_id = path.split("/")[3]
            if link_id not in self.links:
                return httpx.Response(404, json={"error": {}})
            if path.endswith("/cancel"):
                self.links[link_id]["status"] = "cancelled"
            return httpx.Response(200, json=self.links[link_id])
        if path.startswith("/v1/payments/"):
            return httpx.Response(200, json=self.payments[path.split("/")[-1]])
        raise AssertionError("Unexpected provider request")

    def capture(self, link_id):
        link = self.links[link_id]
        payment_id = "pay_" + link_id.split("_")[1]
        payment = {"id": payment_id, "order_id": link["order_id"], "amount": link["amount"],
            "currency": "INR", "status": "captured", "created_at": 1795000000}
        self.payments[payment_id] = payment
        link.update({"status": "paid", "amount_paid": link["amount"],
            "payments": [{"payment_id": payment_id, "status": "captured", "amount": link["amount"]}]})
        return payment

@pytest_asyncio.fixture
async def ctx(monkeypatch):
    database = AsyncMongoMockClient()["razorpay_tests"]
    monkeypatch.setattr(db, "get_database", lambda: database)
    await ensure_payment_indexes(database)
    await ensure_razorpay_indexes(database)
    org, other, invoice, actor = [ObjectId() for _ in range(4)]
    config = build_razorpay_config(key_id=KEY, key_secret=SECRET, webhook_secret=WEBHOOK)
    await database.organizations.insert_one({"_id": org, "status": "active", "razorpay": config})
    await database.organizations.insert_one({"_id": other, "status": "active"})
    await database.invoices.insert_one({"_id": invoice, "organizationId": org, "status": "issued",
        "deletedAt": None, "totalPaise": 10000, "amountPaidPaise": 0, "contactId": ObjectId(),
        "invoiceNumber": "VIS-2026-0001", "remindersSentCount": 0})
    provider = Provider()
    async with httpx.AsyncClient(transport=httpx.MockTransport(provider.request)) as client:
        yield database, org, other, invoice, actor, config, provider, client

async def new_link(ctx, **kwargs):
    database, org, _, invoice, actor, _, _, client = ctx
    return await create_link(organization_id=org, invoice_id=invoice, actor_id=actor,
        idempotency_key="request-12345678", client=client, db_override=database, **kwargs)

def event(row, kind="payment_link.paid"):
    return json.dumps({"event": kind, "payload": {
        "payment_link": {"entity": {"id": row["providerLinkId"], "reference_id": row["referenceId"]}},
        "payment": {"entity": {"order_id": row.get("providerOrderId")}},
    }}).encode()

async def deliver(ctx, raw, secret=WEBHOOK):
    database, _, _, _, _, config, _, client = ctx
    signature = hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    return await handle_webhook(token=config["webhookToken"], raw=raw, signature=signature,
        client=client, db_override=database)

@pytest.mark.asyncio
async def test_credentials_are_encrypted_and_not_returned(ctx):
    database, org, _, _, _, config, _, client = ctx
    assert read_key_secret({"razorpay": config}) == SECRET
    assert SECRET not in json.dumps(config)
    dto = razorpay_dto({"razorpay": config}, webhook_base_url="https://crm.example")
    assert SECRET not in json.dumps(dto) and WEBHOOK not in json.dumps(dto)
    assert dto["webhookUrl"].endswith(config["webhookToken"])
    updated = await connect(organization_id=org, key_id=KEY, key_secret=SECRET,
        webhook_secret="rotated-webhook-secret", client=client, db_override=database)
    assert updated["razorpay"]["webhookToken"] == config["webhookToken"]

@pytest.mark.asyncio
async def test_link_creation_is_exact_and_never_sends_notifications(ctx):
    row = await new_link(ctx, amount_paise=115)
    database, org, _, invoice, _, _, provider, _ = ctx
    payload = json.loads(provider.calls[0].content)
    assert payload["amount"] == 115
    assert payload["currency"] == "INR"
    assert payload["accept_partial"] is False
    assert payload["notify"] == {"sms": False, "email": False}
    assert payload["reminder_enable"] is False
    assert "customer" not in payload
    assert SECRET not in str(provider.calls[0].url)
    assert row["state"] == "created"
    assert (await database.invoices.find_one({"_id": invoice}))["razorpayLinkId"] == row["providerLinkId"]
    assert link_dto(row)["isLive"] is False

@pytest.mark.asyncio
async def test_concurrent_requests_and_replays_create_only_one_link(ctx):
    rows = await asyncio.gather(new_link(ctx), new_link(ctx))
    final = await new_link(ctx)
    assert len(ctx[6].links) == 1
    assert rows[0]["_id"] == rows[1]["_id"] == final["_id"]
    with pytest.raises(HTTPException):
        await new_link(ctx, amount_paise=200)

@pytest.mark.asyncio
async def test_other_request_key_cannot_create_competing_link(ctx):
    row = await new_link(ctx)
    database, org, _, invoice, actor, _, provider, client = ctx
    replay = await create_link(organization_id=org, invoice_id=invoice, actor_id=actor,
        idempotency_key="different-request-key", client=client, db_override=database)
    assert replay["_id"] == row["_id"]
    assert len(provider.links) == 1

@pytest.mark.asyncio
async def test_cross_tenant_invoice_is_not_found(ctx):
    database, _, other, invoice, actor, _, provider, client = ctx
    with pytest.raises(HTTPException) as exc:
        await create_link(organization_id=other, invoice_id=invoice, actor_id=actor,
            idempotency_key="request-12345678", client=client, db_override=database)
    assert exc.value.status_code == 404
    assert provider.calls == []

@pytest.mark.asyncio
@pytest.mark.parametrize("amount", [0, -1, 10001, True])
async def test_invalid_amount_never_reaches_provider(ctx, amount):
    with pytest.raises(HTTPException):
        await new_link(ctx, amount_paise=amount)
    assert ctx[6].calls == []

@pytest.mark.asyncio
async def test_unknown_creation_result_is_recovered_without_second_post(ctx):
    ctx[6].timeout_after_create = True
    with pytest.raises(api.RazorpayError):
        await new_link(ctx)
    row = await ctx[0][LINKS].find_one({})
    assert row["state"] == "unknown"
    outcome = await sync_link(organization_id=ctx[1], link_id=row["_id"],
        client=ctx[7], db_override=ctx[0])
    assert outcome["link"]["state"] == "created"
    assert len(ctx[6].links) == 1
    assert len([r for r in ctx[6].calls if r.method == "POST"]) == 1

@pytest.mark.asyncio
async def test_webhook_duplicate_and_captured_events_record_once(ctx):
    row = await new_link(ctx)
    ctx[6].capture(row["providerLinkId"])
    assert (await deliver(ctx, event(row)))["recorded"] == 1
    assert (await deliver(ctx, event(row)))["recorded"] == 0
    assert (await deliver(ctx, event(row, "payment.captured")))["recorded"] == 0
    assert await ctx[0].payments.count_documents({}) == 1
    invoice = await ctx[0].invoices.find_one({"_id": ctx[3]})
    assert invoice["amountPaidPaise"] == 10000 and invoice["status"] == "paid"

@pytest.mark.asyncio
async def test_partial_invoice_collection_via_separate_full_links(ctx):
    first = await new_link(ctx, amount_paise=4000)
    ctx[6].capture(first["providerLinkId"])
    await deliver(ctx, event(first))
    invoice = await ctx[0].invoices.find_one({"_id": ctx[3]})
    assert invoice["amountPaidPaise"] == 4000 and invoice["status"] == "issued"
    second = await create_link(organization_id=ctx[1], invoice_id=ctx[3], actor_id=ctx[4],
        idempotency_key="second-collection-123", client=ctx[7], db_override=ctx[0])
    assert second["amountPaise"] == 6000
    ctx[6].capture(second["providerLinkId"])
    await deliver(ctx, event(second))
    assert (await ctx[0].invoices.find_one({"_id": ctx[3]}))["amountPaidPaise"] == 10000

@pytest.mark.asyncio
async def test_bad_and_wrong_tenant_signatures_cannot_record_payments(ctx):
    row = await new_link(ctx); ctx[6].capture(row["providerLinkId"])
    count = len(ctx[6].calls)
    for secret in ("wrong-secret", ""):
        with pytest.raises(HTTPException) as exc:
            await deliver(ctx, event(row), secret=secret)
        assert exc.value.status_code == 401
    assert len(ctx[6].calls) == count
    assert await ctx[0].payments.count_documents({}) == 0

@pytest.mark.asyncio
async def test_signature_is_over_raw_bytes_not_reserialized_json(ctx):
    row = await new_link(ctx)
    raw = event(row)
    signature = hmac.new(WEBHOOK.encode(), raw, hashlib.sha256).hexdigest()
    with pytest.raises(HTTPException):
        await handle_webhook(token=ctx[5]["webhookToken"], raw=raw+b" ", signature=signature,
            db_override=ctx[0], client=ctx[7])

@pytest.mark.asyncio
async def test_same_invoice_note_without_local_link_is_not_trusted(ctx):
    raw = json.dumps({"event": "payment.captured", "payload": {"payment": {"entity": {
        "id": "pay_other", "order_id": "order_other", "notes": {"invoiceId": str(ctx[3])}}}}}).encode()
    assert (await deliver(ctx, raw))["outcome"] == "unrelated"
    assert await ctx[0].payments.count_documents({}) == 0

@pytest.mark.asyncio
async def test_provider_payment_must_belong_to_the_link(ctx):
    row = await new_link(ctx)
    payment = ctx[6].capture(row["providerLinkId"])
    payment["order_id"] = "order_different"
    with pytest.raises(api.RazorpayError):
        await deliver(ctx, event(row))
    assert await ctx[0].payments.count_documents({}) == 0

@pytest.mark.asyncio
async def test_ledger_insert_crash_is_recovered_on_webhook_retry(ctx, monkeypatch):
    from app import payments_service
    row = await new_link(ctx); ctx[6].capture(row["providerLinkId"])
    original = payments_service._apply_outcome_to_invoice
    async def fail(**kwargs):
        raise RuntimeError("synthetic database failure after ledger insert")
    monkeypatch.setattr(payments_service, "_apply_outcome_to_invoice", fail)
    with pytest.raises(RuntimeError):
        await deliver(ctx, event(row))
    assert await ctx[0].payments.count_documents({}) == 1
    assert (await ctx[0].invoices.find_one({"_id": ctx[3]}))["amountPaidPaise"] == 0
    monkeypatch.setattr(payments_service, "_apply_outcome_to_invoice", original)
    await deliver(ctx, event(row))
    await deliver(ctx, event(row))
    assert (await ctx[0].invoices.find_one({"_id": ctx[3]}))["amountPaidPaise"] == 10000

@pytest.mark.asyncio
async def test_post_update_crash_retry_never_double_adds(ctx, monkeypatch):
    from app import payments_service
    row = await new_link(ctx); ctx[6].capture(row["providerLinkId"])
    original = payments_service._apply_outcome_to_invoice
    async def fail(**kwargs):
        await original(**kwargs)
        raise RuntimeError("synthetic lost acknowledgement")
    monkeypatch.setattr(payments_service, "_apply_outcome_to_invoice", fail)
    with pytest.raises(RuntimeError):
        await deliver(ctx, event(row))
    monkeypatch.setattr(payments_service, "_apply_outcome_to_invoice", original)
    await deliver(ctx, event(row))
    assert (await ctx[0].invoices.find_one({"_id": ctx[3]}))["amountPaidPaise"] == 10000

@pytest.mark.asyncio
async def test_polling_recovers_a_missed_webhook(ctx):
    row = await new_link(ctx); ctx[6].capture(row["providerLinkId"])
    await ctx[0][LINKS].update_one({"_id": row["_id"]}, {"$set": {"nextCheckAt": db.utc_now()-timedelta(seconds=1)}})
    outcome = await reconcile_links(db_override=ctx[0], client=ctx[7])
    assert outcome == {"checked": 1, "recorded": 1, "errors": 0}
    assert (await ctx[0].invoices.find_one({"_id": ctx[3]}))["status"] == "paid"

@pytest.mark.asyncio
async def test_cancel_does_not_void_actual_payment(ctx):
    row = await new_link(ctx)
    cancelled = await cancel_link(organization_id=ctx[1], link_id=row["_id"], client=ctx[7], db_override=ctx[0])
    assert cancelled["state"] == "cancelled"
    assert await ctx[0].payments.count_documents({}) == 0
    assert (await ctx[0].invoices.find_one({"_id": ctx[3]}))["razorpayLinkUrl"] is None

@pytest.mark.asyncio
async def test_payment_received_after_manual_collection_remains_in_ledger(ctx):
    from app.payments_service import record_payment
    row = await new_link(ctx)
    await record_payment(organization_id=ctx[1], invoice_id=ctx[3], amount_paise=10000,
                         mode="cash", db_override=ctx[0])
    ctx[6].capture(row["providerLinkId"])
    await deliver(ctx, event(row))
    assert (await ctx[0].invoices.find_one({"_id": ctx[3]}))["amountPaidPaise"] == 20000

@pytest.mark.asyncio
async def test_api_permission_gates_and_secret_response(ctx):
    auth = AuthContext(user={"_id": ctx[4]}, organization={"_id": ctx[1]}, session={},
                       permissions=["settings.manage", "invoices.manage", "invoices.read"])
    app.dependency_overrides[routes._require_settings] = lambda: auth
    try:
        with TestClient(app) as client:
            response = client.get("/api/v1/settings/razorpay")
            assert response.status_code == 200
            assert SECRET not in response.text and WEBHOOK not in response.text
            response = client.post("/api/v1/payments/razorpay/webhook/"+ctx[5]["webhookToken"],
                content=b"{}", headers={"x-razorpay-signature": "wrong"})
            assert response.status_code == 401
    finally:
        app.dependency_overrides.clear()

@pytest.mark.asyncio
async def test_unconfigured_webhook_fails_closed(ctx):
    await ctx[0].organizations.update_one({"_id": ctx[1]}, {"$unset": {"razorpay.encryptedWebhookSecret": ""}})
    with pytest.raises(HTTPException) as exc:
        await deliver(ctx, b"{}")
    assert exc.value.status_code == 503

@pytest.mark.asyncio
@pytest.mark.parametrize("status,retryable,code", [(401,False,"RAZORPAY_UNAUTHORIZED"),
    (403,False,"RAZORPAY_UNAUTHORIZED"),(429,True,"RAZORPAY_RATE_LIMITED"),(500,True,"RAZORPAY_UNAVAILABLE")])
async def test_http_errors_are_classified_and_do_not_echo_secrets(status,retryable,code):
    transport = httpx.MockTransport(lambda r: httpx.Response(status, json={"error": {"description": SECRET}}))
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(api.RazorpayError) as exc:
            await api.list_payment_links(key_id=KEY, key_secret=SECRET, client=client)
    assert exc.value.code == code and exc.value.retryable == retryable
    assert SECRET not in str(exc.value)

@pytest.mark.asyncio
async def test_other_tenant_cannot_settle_invoice_even_with_its_own_valid_signature(ctx):
    config = build_razorpay_config(key_id=KEY, key_secret=SECRET, webhook_secret="other-tenant-secret")
    await ctx[0].organizations.update_one({"_id": ctx[2]}, {"$set": {"razorpay": config}})
    row = await new_link(ctx); ctx[6].capture(row["providerLinkId"])
    raw = event(row)
    signature = hmac.new(b"other-tenant-secret", raw, hashlib.sha256).hexdigest()
    count = len(ctx[6].calls)
    result = await handle_webhook(token=config["webhookToken"], raw=raw, signature=signature,
                                 client=ctx[7], db_override=ctx[0])
    assert result["outcome"] == "unrelated"
    assert len(ctx[6].calls) == count
    assert await ctx[0].payments.count_documents({}) == 0

@pytest.mark.asyncio
async def test_rotated_webhook_secret_accepts_old_retries_for_one_day(ctx):
    row = await new_link(ctx); ctx[6].capture(row["providerLinkId"])
    await connect(organization_id=ctx[1], key_id=KEY, key_secret=SECRET,
        webhook_secret="rotated-webhook-secret", client=ctx[7], db_override=ctx[0])
    await connect(organization_id=ctx[1], key_id=KEY, key_secret=SECRET,
        webhook_secret="rotated-webhook-secret", client=ctx[7], db_override=ctx[0])
    assert (await deliver(ctx, event(row)))["recorded"] == 1
    await ctx[0].organizations.update_one({"_id": ctx[1]},
        {"$set": {"razorpay.previousWebhookSecretUntil": db.utc_now()-timedelta(seconds=1)}})
    with pytest.raises(HTTPException) as exc:
        await deliver(ctx, event(row))
    assert exc.value.status_code == 401

@pytest.mark.asyncio
async def test_mode_switch_cannot_poll_old_mode_links(ctx):
    row = await new_link(ctx)
    await ctx[0].organizations.update_one({"_id": ctx[1]}, {"$set": {"razorpay.keyId": "rzp_live_Test12345678"}})
    count = len(ctx[6].calls)
    with pytest.raises(HTTPException) as exc:
        await sync_link(organization_id=ctx[1], link_id=row["_id"], client=ctx[7], db_override=ctx[0])
    assert exc.value.status_code == 409
    assert len(ctx[6].calls) == count

@pytest.mark.asyncio
async def test_polling_is_bounded_and_leases_prevent_overlap(ctx):
    row = await new_link(ctx); ctx[6].capture(row["providerLinkId"])
    await ctx[0][LINKS].update_one({"_id": row["_id"]}, {"$set": {"nextCheckAt": db.utc_now()-timedelta(seconds=1)}})
    results = await asyncio.gather(
        reconcile_links(db_override=ctx[0], client=ctx[7]),
        reconcile_links(db_override=ctx[0], client=ctx[7]))
    assert sum(result["checked"] for result in results) == 1
    assert sum(result["recorded"] for result in results) == 1

@pytest.mark.asyncio
async def test_definite_provider_rejection_releases_active_intent(ctx, monkeypatch):
    async def rejected(**kwargs):
        raise api.RazorpayError("Rejected", code="RAZORPAY_BAD_REQUEST")
    monkeypatch.setattr(api, "create_payment_link", rejected)
    with pytest.raises(api.RazorpayError):
        await new_link(ctx)
    row = await ctx[0][LINKS].find_one({})
    assert row["state"] == "failed" and "activeInvoiceId" not in row

@pytest.mark.asyncio
async def test_unknown_create_is_not_reposted_on_request_replay(ctx):
    ctx[6].timeout_after_create = True
    with pytest.raises(api.RazorpayError):
        await new_link(ctx)
    row = await new_link(ctx)
    assert row["state"] == "unknown"
    assert len(ctx[6].links) == 1

@pytest.mark.asyncio
async def test_stale_created_response_cannot_undo_paid_status(ctx):
    from app.razorpay_service import save_provider_link
    row = await new_link(ctx)
    stale = dict(ctx[6].links[row["providerLinkId"]])
    ctx[6].capture(row["providerLinkId"])
    await deliver(ctx, event(row))
    updated = await save_provider_link(row, stale, ctx[0])
    assert updated["state"] == "paid"
    assert (await ctx[0].invoices.find_one({"_id": ctx[3]}))["razorpayLinkUrl"] is None

@pytest.mark.asyncio
async def test_api_rejects_another_invoice_in_link_url(ctx):
    row = await new_link(ctx)
    auth = AuthContext(user={"_id": ctx[4]}, organization={"_id": ctx[1]}, session={},
                       permissions=["invoices.manage"])
    app.dependency_overrides[routes._require_manage] = lambda: auth
    try:
        with TestClient(app) as client:
            response = client.post(f"/api/v1/invoices/{ObjectId()}/payment-links/{row['_id']}/cancel")
            assert response.status_code == 404
    finally:
        app.dependency_overrides.clear()

def test_settings_and_link_routes_require_authentication():
    with TestClient(app) as client:
        assert client.get("/api/v1/settings/razorpay").status_code == 401
        assert client.post(f"/api/v1/invoices/{ObjectId()}/payment-links",
            json={"idempotencyKey": "request-12345678"}).status_code == 401

@pytest.mark.asyncio
async def test_public_route_limits_unsigned_payload_size(ctx):
    with TestClient(app) as client:
        response = client.post("/api/v1/payments/razorpay/webhook/" + ctx[5]["webhookToken"],
                               content=b"x" * 1_048_577)
        assert response.status_code == 413
    assert await ctx[0].payments.count_documents({}) == 0

@pytest.mark.asyncio
async def test_failed_credentials_are_never_saved(ctx):
    transport = httpx.MockTransport(lambda r: httpx.Response(401, json={"error": {}}))
    previous = (await ctx[0].organizations.find_one({"_id": ctx[1]}))["razorpay"]
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(api.RazorpayError):
            await connect(organization_id=ctx[1], key_id=KEY, key_secret="wrong-secret",
                webhook_secret=WEBHOOK, client=client, db_override=ctx[0])
    assert (await ctx[0].organizations.find_one({"_id": ctx[1]}))["razorpay"] == previous

@pytest.mark.asyncio
async def test_unknown_token_is_rejected_before_processing(ctx):
    with pytest.raises(HTTPException) as exc:
        await handle_webhook(token="not-an-endpoint", raw=b"{}", signature="",
                             client=ctx[7], db_override=ctx[0])
    assert exc.value.status_code == 404

@pytest.mark.asyncio
async def test_invalid_provider_identifier_never_makes_a_request():
    transport = httpx.MockTransport(lambda r: pytest.fail("must not make request"))
    async with httpx.AsyncClient(transport=transport) as client:
        with pytest.raises(api.RazorpayError):
            await api.fetch_payment_link(key_id=KEY, key_secret=SECRET, link_id="../payments", client=client)
