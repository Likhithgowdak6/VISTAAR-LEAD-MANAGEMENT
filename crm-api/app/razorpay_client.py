"""
The only module that knows the shape of Razorpay's API.

NO `razorpay` SDK, DELIBERATELY. vistaar-payment-bot used it; this does not, for three reasons:

  - The suite forbids real connections (`tests/conftest.py`), and an SDK that builds its own
    HTTP stack is a way around a guard that exists because `../backend/.env` points at a real
    database on the production host. An injectable `httpx.AsyncClient` is inspectable.
  - `meta_graph_client.py` beside it is already a hand-written client on injected httpx. Two
    conventions for "call an external API" is one more than this service needs.
  - The only SDK feature used was `utility.verify_webhook_signature`, which is an HMAC - six
    lines of stdlib, and the same six already written twice here for Meta.

Every failure leaves as a `RazorpayError` carrying whether it is worth retrying, mirroring the
WhatsApp Cloud client's taxonomy: the caller's question is always "do I try again or tell
somebody", and answering it with an HTTP status leaves that decision at every call site.
"""

from __future__ import annotations

import base64
import logging
import re
from datetime import datetime, timezone
from typing import Any

import httpx

logger = logging.getLogger(__name__)

RAZORPAY_BASE_URL = "https://api.razorpay.com/v1"

DEFAULT_TIMEOUT_MS = 20_000


class RazorpayError(Exception):
    """
    A Razorpay call that did not work.

    `retryable` is the field callers read. A 5xx or a dropped connection is worth another
    attempt; a rejected key or a malformed request is not, and retrying it only delays telling
    somebody that their connection is broken.
    """

    def __init__(
        self,
        message: str,
        *,
        code: str = "RAZORPAY_ERROR",
        retryable: bool = False,
        http_status: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.http_status = http_status


def _auth_header(key_id: str, key_secret: str) -> str:
    """
    HTTP Basic, which is what Razorpay uses.

    Built here rather than handed to httpx's `auth=` so the header can be asserted in tests
    without a live client, and so the secret appears in exactly one place.
    """
    raw = f"{key_id}:{key_secret}".encode()

    return "Basic " + base64.b64encode(raw).decode()


def _classify(status: int, body: Any) -> RazorpayError:
    """
    Razorpay's errors, reduced to the two reactions a caller has.

    Its envelope is `{"error": {"code", "description", "reason"}}`. The description is written
    for a developer and can quote back request content, so it is never surfaced - the messages
    here are written for whoever is reading the screen.
    """
    error = (body or {}).get("error") if isinstance(body, dict) else None
    reason = (error or {}).get("reason") or ""

    if status in (401, 403):
        return RazorpayError(
            "Razorpay refused these credentials. Check the key id and secret, and that the key "
            "is active.",
            code="RAZORPAY_UNAUTHORIZED",
            retryable=False,
            http_status=status,
        )

    if status == 429:
        return RazorpayError(
            "Razorpay is rate limiting this account. It will be retried.",
            code="RAZORPAY_RATE_LIMITED",
            retryable=True,
            http_status=status,
        )

    if status >= 500:
        return RazorpayError(
            "Razorpay is temporarily unavailable. It will be retried.",
            code="RAZORPAY_UNAVAILABLE",
            retryable=True,
            http_status=status,
        )

    if status == 400:
        return RazorpayError(
            "Razorpay rejected the request. The amount or the customer details may be invalid.",
            code="RAZORPAY_BAD_REQUEST",
            retryable=False,
            http_status=status,
        )

    return RazorpayError(
        f"Razorpay returned an unexpected response (HTTP {status}).",
        code="RAZORPAY_UNEXPECTED",
        # Unknown is treated as NOT retryable. Repeating a call whose effect is unknown risks
        # creating a second payment link for one invoice.
        retryable=False,
        http_status=status,
    )


async def _request(
    *,
    method: str,
    path: str,
    key_id: str,
    key_secret: str,
    json_body: dict[str, Any] | None = None,
    params: dict[str, Any] | None = None,
    client: httpx.AsyncClient | None = None,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
) -> dict[str, Any]:
    url = f"{RAZORPAY_BASE_URL}/{path.lstrip('/')}"
    timeout = timeout_ms / 1000.0

    headers = {
        "Authorization": _auth_header(key_id, key_secret),
        "Content-Type": "application/json",
    }

    async def _send(c: httpx.AsyncClient) -> httpx.Response:
        return await c.request(method, url, json=json_body, params=params, headers=headers, timeout=timeout)

    try:
        if client is not None:
            response = await _send(client)
        else:
            async with httpx.AsyncClient() as owned:
                response = await _send(owned)
    except httpx.HTTPError:
        # A timeout and a dropped connection are indistinguishable here and both are worth
        # another attempt. The exception type is logged, never the message - it can carry the URL.
        raise RazorpayError(
            "Could not reach Razorpay. It will be retried.",
            code="RAZORPAY_NETWORK_ERROR",
            retryable=True,
        ) from None

    try:
        body = response.json()
    except Exception:
        body = None

    if response.status_code >= 400:
        raise _classify(response.status_code, body)

    if not isinstance(body, dict):
        raise RazorpayError(
            "Razorpay returned a response that could not be read.",
            code="RAZORPAY_UNREADABLE",
            retryable=True,
            http_status=response.status_code,
        )

    return body


async def create_payment_link(
    *,
    key_id: str,
    key_secret: str,
    amount_paise: int,
    description: str,
    reference_id: str,
    notes: dict[str, str] | None = None,
    customer_name: str | None = None,
    customer_contact: str | None = None,
    expire_by: datetime | None = None,
    client: httpx.AsyncClient | None = None,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
) -> dict[str, Any]:
    """
    Creates a payment link.

    `amount_paise` IS ALREADY EXACT and is passed straight through. The original computed it as
    `int(rupees * 100)`, which truncates - `int(1.15 * 100)` is 114, so a 1.15 link was created
    for 1.14. Nothing here multiplies or rounds; the invoice stores paise and this sends paise.

    `notes` is how a webhook finds its way back to an invoice. Razorpay echoes it on both the
    link and the payment, so `payment.captured` - which carries no link id - can still be
    resolved.

    `reference_id` is Razorpay's own idempotency-ish handle: creating a second link with a
    reference already used returns an error rather than a duplicate link.
    """
    payload: dict[str, Any] = {
        "amount": int(amount_paise),
        "currency": "INR",
        # False: a part payment against a link would arrive as an amount that does not settle
        # the invoice, and partial collection is handled by issuing a link for the part.
        "accept_partial": False,
        "description": description[:2048],
        "reference_id": reference_id,
        "notes": notes or {},
        # Razorpay would otherwise send its own SMS and email, over which the business has no
        # control and which arrive alongside this CRM's WhatsApp reminder.
        "notify": {"sms": False, "email": False},
        "reminder_enable": False,
    }

    customer: dict[str, str] = {}

    if customer_name:
        customer["name"] = customer_name[:100]

    if customer_contact:
        customer["contact"] = customer_contact

    if customer:
        payload["customer"] = customer

    if expire_by is not None:
        # Razorpay wants whole seconds since the epoch, and refuses anything less than ~15
        # minutes out.
        payload["expire_by"] = int(expire_by.replace(tzinfo=expire_by.tzinfo or timezone.utc).timestamp())

    return await _request(
        method="POST",
        path="payment_links",
        key_id=key_id,
        key_secret=key_secret,
        json_body=payload,
        client=client,
        timeout_ms=timeout_ms,
    )


async def fetch_payment_link(
    *,
    key_id: str,
    key_secret: str,
    link_id: str,
    client: httpx.AsyncClient | None = None,
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
) -> dict[str, Any]:
    """
    One payment link's current state.

    The reconciliation poller's only call: it asks Razorpay what actually happened to links
    whose webhook may never have arrived.
    """
    return await _request(
        method="GET",
        path=f"payment_links/{_entity_id(link_id, 'plink')}",
        key_id=key_id,
        key_secret=key_secret,
        client=client,
        timeout_ms=timeout_ms,
    )


def _entity_id(value: str, prefix: str) -> str:
    if not re.fullmatch(prefix + r"_[A-Za-z0-9]+", value):
        raise RazorpayError("Invalid Razorpay identifier.", code="RAZORPAY_ID_INVALID")
    return value


async def list_payment_links(*, key_id: str, key_secret: str, reference_id: str | None = None,
                             client: httpx.AsyncClient | None = None) -> dict[str, Any]:
    params: dict[str, Any] = {"count": 100 if reference_id else 1}
    if reference_id:
        params["reference_id"] = reference_id
    return await _request(method="GET", path="payment_links", key_id=key_id,
                          key_secret=key_secret, params=params, client=client)


async def fetch_payment(*, key_id: str, key_secret: str, payment_id: str,
                        client: httpx.AsyncClient | None = None) -> dict[str, Any]:
    return await _request(method="GET", path=f"payments/{_entity_id(payment_id, 'pay')}",
                          key_id=key_id, key_secret=key_secret, client=client)


async def cancel_payment_link(*, key_id: str, key_secret: str, link_id: str,
                              client: httpx.AsyncClient | None = None) -> dict[str, Any]:
    return await _request(method="POST", path=f"payment_links/{_entity_id(link_id, 'plink')}/cancel",
                          key_id=key_id, key_secret=key_secret, client=client)
