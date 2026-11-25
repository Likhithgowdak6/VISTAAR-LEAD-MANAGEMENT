"""
Sending a manual Instagram reply from the composer.

WHY THIS CALLS NODE. The Instagram Page token, its encryption purpose and the Send API client all
live in the Node service beside the rest of the Meta integration. Teaching this service to decrypt
a credential Node owns would mean two services holding one secret, which is how a key rotation
becomes an outage. So the composer asks Node to spend it, over the same internal bridge and the
same service key that owner notifications already use.

WHAT IS ENFORCED HERE AND WHAT IS ENFORCED THERE. Permissions and conversation visibility are
decided here, because this is where they live. Meta's messaging window is checked in BOTH places,
deliberately: here so the composer can refuse before anybody types a reply they cannot send, and
in Node because that endpoint is reachable by anything holding the service key - a window enforced
only by its caller is not enforced.

THE MESSAGE ROW IS WRITTEN BY THE CALLER, not here, and the send result updates it. A failed send
therefore shows in the thread as a failed message rather than vanishing, which is the whole point
of recording before sending.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx

from app.config import settings

logger = logging.getLogger("crm-api.instagram-send")

#: Meta's window for a human replying, with the HUMAN_AGENT tag. Seven days rather than the bare
#: twenty-four hours, because a person answering a customer is exactly what that tag is for.
INSTAGRAM_HUMAN_AGENT_WINDOW = timedelta(days=7)

#: Instagram refuses a text message longer than this. Bytes, not characters.
INSTAGRAM_TEXT_MAX_BYTES = 1000

DEFAULT_TIMEOUT_SECONDS = 15


class InstagramSendUnavailable(Exception):
    """The send could not be attempted or was refused. Carries a code the composer can act on."""

    def __init__(self, message: str, *, code: str, retryable: bool = False):
        super().__init__(message)
        self.code = code
        self.retryable = retryable


def window_is_open(last_inbound_at: Any, *, now: datetime | None = None) -> bool:
    """
    Whether Meta will still accept a human reply on this thread.

    An absent `lastInboundAt` means the customer has never written, and Instagram has no template
    mechanism to open a conversation - so there is nothing to reply to and the answer is no.
    """
    if not last_inbound_at:
        return False

    moment = now or datetime.now(timezone.utc)

    if isinstance(last_inbound_at, str):
        try:
            last_inbound_at = datetime.fromisoformat(last_inbound_at.replace("Z", "+00:00"))
        except ValueError:
            # An unreadable timestamp is not evidence the window is open. Refusing costs one
            # rejected send; assuming open costs a message the agent believed had gone.
            return False

    if not isinstance(last_inbound_at, datetime):
        return False

    if last_inbound_at.tzinfo is None:
        # Mongo hands back naive UTC.
        last_inbound_at = last_inbound_at.replace(tzinfo=timezone.utc)

    return moment - last_inbound_at < INSTAGRAM_HUMAN_AGENT_WINDOW


def text_is_too_long(text: str) -> bool:
    return len(text.encode("utf-8")) > INSTAGRAM_TEXT_MAX_BYTES


async def send_instagram_reply(
    *,
    organization_id: Any,
    instagram_account_id: Any,
    recipient_id: str,
    text: str,
    last_inbound_at: Any,
    client: httpx.AsyncClient | None = None,
) -> str | None:
    """
    Sends one manual reply and returns Meta's message id.

    Raises `InstagramSendUnavailable` with a code the composer surfaces verbatim - the difference
    between "try again" and "reconnect the account" is the difference between a user waiting and a
    user fixing something.
    """
    key = (
        getattr(settings, "whatsapp_gateway_service_key", "")
        or getattr(settings, "ai_brain_service_key", "")
    )

    if not key:
        raise InstagramSendUnavailable(
            "The Instagram bridge is not configured on this deployment.",
            code="INSTAGRAM_GATEWAY_NOT_CONFIGURED",
        )

    if text_is_too_long(text):
        raise InstagramSendUnavailable(
            f"Instagram refuses a message over {INSTAGRAM_TEXT_MAX_BYTES} characters.",
            code="INSTAGRAM_TEXT_TOO_LONG",
        )

    if not window_is_open(last_inbound_at):
        raise InstagramSendUnavailable(
            "Instagram will not accept a reply more than 7 days after the customer last wrote. "
            "Ask them to message you again.",
            code="INSTAGRAM_WINDOW_CLOSED",
        )

    url = settings.whatsapp_gateway_url.rstrip("/") + "/internal/v1/instagram/send"

    payload = {
        "organizationId": str(organization_id),
        "instagramAccountId": str(instagram_account_id),
        "recipientId": recipient_id,
        "text": text,
        "lastInboundAt": (
            last_inbound_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
            if isinstance(last_inbound_at, datetime)
            else last_inbound_at
        ),
    }

    async def _post(http: httpx.AsyncClient) -> httpx.Response:
        return await http.post(
            url,
            headers={"X-Service-Key": key},
            json=payload,
            timeout=DEFAULT_TIMEOUT_SECONDS,
        )

    try:
        if client is not None:
            response = await _post(client)
        else:
            async with httpx.AsyncClient() as owned:
                response = await _post(owned)
    except httpx.HTTPError as exc:
        # A timeout and a dropped connection are indistinguishable, and either may have been
        # delivered. Retryable is the honest answer; the caller marks the message failed and a
        # person can see it and decide.
        raise InstagramSendUnavailable(
            "The Instagram bridge could not be reached.",
            code="INSTAGRAM_GATEWAY_UNREACHABLE",
            retryable=True,
        ) from exc

    if response.status_code >= 400:
        try:
            error = (response.json() or {}).get("error") or {}
        except ValueError:
            error = {}

        raise InstagramSendUnavailable(
            error.get("message") or "Instagram refused the message.",
            code=error.get("code") or "INSTAGRAM_SEND_FAILED",
            retryable=response.status_code >= 500,
        )

    try:
        return ((response.json() or {}).get("data") or {}).get("providerMessageId")
    except ValueError:
        # A 200 with an unreadable body means it probably went. Returning None loses the provider
        # id, not the message.
        return None
