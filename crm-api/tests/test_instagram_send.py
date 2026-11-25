"""
Manual Instagram replies from the composer: the window, the limits, and the bridge.

WHAT GOES WRONG HERE IS A MESSAGE AN AGENT BELIEVES THEY SENT. The composer is synchronous, so
every refusal has to reach the person typing — and the difference between "try again in a moment"
and "reconnect the account in Settings" is the difference between waiting and fixing.

The bridge to Node is mocked throughout. Nothing here touches Meta or a running Node process.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import httpx
import pytest

from app.instagram_send import (
    INSTAGRAM_TEXT_MAX_BYTES,
    InstagramSendUnavailable,
    send_instagram_reply,
    text_is_too_long,
    window_is_open,
)

NOW = datetime(2026, 11, 25, 12, 0, tzinfo=timezone.utc)
ORG = "6b0551093af63f65c046820e"
ACCOUNT = "6b0551093af63f65c046820f"


def _hours_ago(hours: float) -> datetime:
    return NOW - timedelta(hours=hours)


class TestMessagingWindow:
    def test_open_just_after_the_customer_wrote(self):
        assert window_is_open(_hours_ago(1), now=NOW)

    def test_open_six_days_later_because_a_human_is_replying(self):
        """
        Seven days, not twenty-four hours.

        The HUMAN_AGENT tag is exactly for a person answering a customer, and this path is only
        ever a person — the automation never comes through here.
        """
        assert window_is_open(_hours_ago(24 * 6), now=NOW)

    def test_closed_after_seven_days(self):
        assert not window_is_open(_hours_ago(24 * 8), now=NOW)

    def test_closed_when_the_customer_has_never_written(self):
        # Instagram has no template to open a conversation with. Never-contacted means never.
        assert not window_is_open(None, now=NOW)

    def test_reads_a_naive_timestamp_as_utc(self):
        # Mongo hands back naive datetimes; reading one as local time would shift the window.
        assert window_is_open(_hours_ago(1).replace(tzinfo=None), now=NOW)

    def test_accepts_an_iso_string(self):
        assert window_is_open(_hours_ago(1).isoformat().replace("+00:00", "Z"), now=NOW)

    @pytest.mark.parametrize("value", ["not-a-date", "", 12345, {}])
    def test_an_unreadable_timestamp_is_treated_as_closed(self, value):
        # Refusing costs one rejected send; assuming open costs a message the agent believed went.
        assert not window_is_open(value, now=NOW)


class TestTextLimit:
    def test_accepts_a_message_at_the_limit(self):
        assert not text_is_too_long("a" * INSTAGRAM_TEXT_MAX_BYTES)

    def test_refuses_one_character_over(self):
        assert text_is_too_long("a" * (INSTAGRAM_TEXT_MAX_BYTES + 1))

    def test_measures_bytes_not_characters(self):
        # An emoji is four bytes. Counting characters would let through what Meta refuses.
        assert text_is_too_long("😀" * 251)
        assert not text_is_too_long("😀" * 250)


class _Bridge:
    """Stands in for the Node gateway. Records what was posted."""

    def __init__(self, *, status: int = 200, payload=None, raises: Exception | None = None):
        self.calls: list[dict] = []
        self.status = status
        self.payload = payload if payload is not None else {"data": {"providerMessageId": "mid.1"}}
        self.raises = raises

    async def handler(self, request: httpx.Request) -> httpx.Response:
        import json

        self.calls.append(
            {
                "url": str(request.url),
                "headers": dict(request.headers),
                "body": json.loads(request.content.decode()),
            }
        )

        if self.raises is not None:
            raise self.raises

        return httpx.Response(self.status, json=self.payload)

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handler))


async def _send(bridge: _Bridge, **over):
    args = dict(
        organization_id=ORG,
        instagram_account_id=ACCOUNT,
        recipient_id="IGSID-CUSTOMER",
        text="We do, what date are you looking at?",
        last_inbound_at=NOW,
        client=bridge.client(),
    )
    args.update(over)

    return await send_instagram_reply(**args)


class TestSending:
    @pytest.mark.asyncio
    async def test_returns_metas_message_id(self, monkeypatch):
        monkeypatch.setattr("app.instagram_send.settings.whatsapp_gateway_service_key", "k", raising=False)

        bridge = _Bridge()

        assert await _send(bridge) == "mid.1"

    @pytest.mark.asyncio
    async def test_authenticates_with_the_service_key(self, monkeypatch):
        # The same key and header the owner-notify bridge already uses.
        monkeypatch.setattr("app.instagram_send.settings.whatsapp_gateway_service_key", "a-key", raising=False)

        bridge = _Bridge()
        await _send(bridge)

        assert bridge.calls[0]["headers"]["x-service-key"] == "a-key"

    @pytest.mark.asyncio
    async def test_posts_to_the_internal_path(self, monkeypatch):
        monkeypatch.setattr("app.instagram_send.settings.whatsapp_gateway_service_key", "k", raising=False)

        bridge = _Bridge()
        await _send(bridge)

        # /internal/* must stay off public ingress; asserting the path keeps that reviewable.
        assert bridge.calls[0]["url"].endswith("/internal/v1/instagram/send")

    @pytest.mark.asyncio
    async def test_passes_the_window_through_so_node_can_check_it_too(self, monkeypatch):
        """
        Checked in BOTH services deliberately.

        Here so the composer refuses before anybody types; in Node because that endpoint is
        reachable by anything holding the service key, and a window enforced only by its caller
        is not enforced.
        """
        monkeypatch.setattr("app.instagram_send.settings.whatsapp_gateway_service_key", "k", raising=False)

        bridge = _Bridge()
        await _send(bridge)

        assert bridge.calls[0]["body"]["lastInboundAt"].startswith("2026-11-25")

    @pytest.mark.asyncio
    async def test_refuses_before_calling_when_the_window_has_closed(self, monkeypatch):
        monkeypatch.setattr("app.instagram_send.settings.whatsapp_gateway_service_key", "k", raising=False)

        bridge = _Bridge()

        with pytest.raises(InstagramSendUnavailable) as caught:
            await _send(bridge, last_inbound_at=_hours_ago(24 * 9))

        assert caught.value.code == "INSTAGRAM_WINDOW_CLOSED"
        # Not even attempted — a refusal Meta would make is cheaper to make here.
        assert bridge.calls == []

    @pytest.mark.asyncio
    async def test_refuses_an_over_long_message_before_calling(self, monkeypatch):
        monkeypatch.setattr("app.instagram_send.settings.whatsapp_gateway_service_key", "k", raising=False)

        bridge = _Bridge()

        with pytest.raises(InstagramSendUnavailable) as caught:
            await _send(bridge, text="a" * 1001)

        assert caught.value.code == "INSTAGRAM_TEXT_TOO_LONG"
        assert bridge.calls == []

    @pytest.mark.asyncio
    async def test_refuses_when_the_bridge_is_not_configured(self, monkeypatch):
        # A deployment that never set the service key should say so, not fail obscurely.
        monkeypatch.setattr("app.instagram_send.settings.whatsapp_gateway_service_key", "", raising=False)
        monkeypatch.setattr("app.instagram_send.settings.ai_brain_service_key", "", raising=False)

        with pytest.raises(InstagramSendUnavailable) as caught:
            await _send(_Bridge())

        assert caught.value.code == "INSTAGRAM_GATEWAY_NOT_CONFIGURED"


class TestFailures:
    @pytest.mark.asyncio
    async def test_surfaces_metas_code_so_the_agent_knows_what_to_do(self, monkeypatch):
        monkeypatch.setattr("app.instagram_send.settings.whatsapp_gateway_service_key", "k", raising=False)

        bridge = _Bridge(
            status=409,
            payload={
                "error": {
                    "code": "INSTAGRAM_TOKEN_EXPIRED",
                    "message": "Instagram access has expired or was revoked.",
                }
            },
        )

        with pytest.raises(InstagramSendUnavailable) as caught:
            await _send(bridge)

        # "Reconnect the account" rather than "try again" — a different action entirely.
        assert caught.value.code == "INSTAGRAM_TOKEN_EXPIRED"
        assert caught.value.retryable is False
        assert "expired or was revoked" in str(caught.value)

    @pytest.mark.asyncio
    async def test_marks_a_5xx_retryable(self, monkeypatch):
        monkeypatch.setattr("app.instagram_send.settings.whatsapp_gateway_service_key", "k", raising=False)

        bridge = _Bridge(status=503, payload={"error": {"code": "INSTAGRAM_RATE_LIMITED"}})

        with pytest.raises(InstagramSendUnavailable) as caught:
            await _send(bridge)

        assert caught.value.retryable is True

    @pytest.mark.asyncio
    async def test_an_unreachable_bridge_is_retryable_and_honest(self, monkeypatch):
        """
        A timeout may still have been delivered.

        Retryable is the honest classification; the caller marks the message failed so a person
        can see it and decide, rather than the system silently sending twice.
        """
        monkeypatch.setattr("app.instagram_send.settings.whatsapp_gateway_service_key", "k", raising=False)

        bridge = _Bridge(raises=httpx.ConnectError("refused"))

        with pytest.raises(InstagramSendUnavailable) as caught:
            await _send(bridge)

        assert caught.value.code == "INSTAGRAM_GATEWAY_UNREACHABLE"
        assert caught.value.retryable is True

    @pytest.mark.asyncio
    async def test_a_200_with_an_unreadable_body_loses_the_id_not_the_message(self, monkeypatch):
        monkeypatch.setattr("app.instagram_send.settings.whatsapp_gateway_service_key", "k", raising=False)

        bridge = _Bridge(payload={})

        assert await _send(bridge) is None
