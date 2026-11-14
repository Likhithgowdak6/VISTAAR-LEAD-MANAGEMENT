"""
Sends messages directly to the studio owner on WhatsApp.

PORTED FROM backend/src/modules/whatsapp/automation/owner-notify.service.ts.

Direct and immediate send to the owner's WhatsApp number (or account self-chat).
Bypasses quiet hours and marketing throttles, but respects test allowlist.
"""

from __future__ import annotations

import logging
import re
import httpx
from typing import Any, Callable

from app import db
from app.allowlist import create_number_allowlist
from app.config import settings
from app.owner_conversation import record_owner_message

logger = logging.getLogger("crm-api.owner-notify")


def owner_jid_from_config(raw_number: Any) -> str | None:
    """Extracts digits from number and formats as @s.whatsapp.net JID."""
    if not raw_number:
        return None
    digits = re.sub(r"\D", "", str(raw_number))
    return f"{digits}@s.whatsapp.net" if digits else None


class OwnerNotifyService:
    """Delivers owner notifications to the owner's WhatsApp handset or self-chat."""

    def __init__(
        self,
        *,
        send_fn: Callable[..., Any] | None = None,
        get_owner_number_fn: Callable[..., Any] | None = None,
    ) -> None:
        self._send_fn = send_fn
        self._get_owner_number_fn = get_owner_number_fn

    async def get_owner_number(self, organization_id: Any) -> str:
        if self._get_owner_number_fn:
            return await self._get_owner_number_fn(organization_id=organization_id)
        if not organization_id:
            return getattr(settings, "whatsapp_owner_number", "")

        database = db.get_database()
        org = await database["organizations"].find_one({"_id": organization_id}, {"settings.ownerNumber": 1, "ownerWhatsappNumber": 1, "saasManaged": 1})
        if org and org.get("ownerWhatsappNumber"):
            return org["ownerWhatsappNumber"]
        if org and org.get("saasManaged"):
            return ""
        if org and isinstance(org.get("settings"), dict) and org["settings"].get("ownerNumber"):
            return org["settings"]["ownerNumber"]

        return getattr(settings, "whatsapp_owner_number", "")

    async def notify_owner(
        self,
        *,
        account_id: Any,
        organization_id: Any = None,
        text: str = "",
    ) -> dict[str, Any]:
        """Delivers text notification to owner JID."""
        owner_num = await self.get_owner_number(organization_id)
        owner_jid = owner_jid_from_config(owner_num)

        allowlist = create_number_allowlist(getattr(settings, "whatsapp_test_allowed_numbers", ""))
        if owner_jid and not allowlist.permits(owner_jid, owner_num):
            logger.info("Owner alert blocked by test allowlist: %s", owner_jid)
            return {"providerMessageId": None, "blocked": "not_on_test_allowlist"}

        sender = self._send_fn
        if sender is None and settings.node_env != "test":
            sender = self._gateway_send
        if sender:
            # THE SEND IS UNCHANGED AND STILL COMES FIRST.
            #
            # The tempting refactor is to push this through `enqueue_outbound_message` so the
            # delivery runner handles it and persistence comes free. It would also add the
            # runner's poll interval and, for `authoredBy: ai`, a 3-15 second human-like
            # jitter - to a path whose whole point is bypassing quiet hours and throttles
            # because owner call escalation is time-critical. So the direct send stays, and
            # the recording happens beside it.
            sent_at = db.utc_now()
            status = "sent"
            mid = None

            try:
                res = await (self._gateway_send(account_id=account_id, organization_id=organization_id, text=text)
                             if self._send_fn is None else sender(account_id=account_id, to=owner_jid, text=text))
                if isinstance(res, dict) and res.get("blocked"):
                    return res
                mid = (
                    res.get("providerMessageId")
                    if isinstance(res, dict)
                    else getattr(res, "providerMessageId", None)
                )
            except Exception:
                # Recorded as failed, then re-raised: the caller's own error handling is
                # unchanged, but the owner's thread shows the attempt rather than a silent gap.
                status = "failed"
                await self._record(
                    account_id=account_id,
                    organization_id=organization_id,
                    owner_number=owner_num,
                    text=text,
                    provider_message_id=None,
                    status=status,
                    sent_at=sent_at,
                )
                raise

            await self._record(
                account_id=account_id,
                organization_id=organization_id,
                owner_number=owner_num,
                text=text,
                provider_message_id=mid,
                status=status,
                sent_at=sent_at,
            )

            return {"providerMessageId": mid}

        # Only explicit test environments simulate delivery without an injected sender.
        logger.debug("Simulated owner notification to %s: %s", owner_jid, text[:100])
        return {"providerMessageId": "owner_notify_simulated"}

    async def _gateway_send(self, *, account_id: Any, organization_id: Any, text: str) -> dict[str, Any]:
        key = settings.whatsapp_gateway_service_key or settings.ai_brain_service_key
        if not key or not organization_id or not account_id:
            raise RuntimeError("Owner notification gateway is not configured.")
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.post(
                settings.whatsapp_gateway_url.rstrip("/") + "/internal/v1/whatsapp/owner-notify",
                headers={"X-Service-Key": key},
                json={"organizationId": str(organization_id), "accountId": str(account_id), "text": text})
            response.raise_for_status()
            return response.json()["data"]

    async def _record(
        self,
        *,
        account_id: Any,
        organization_id: Any,
        owner_number: Any,
        text: str,
        provider_message_id: str | None,
        status: str,
        sent_at: Any,
    ) -> None:
        """Mirrors the sent message into the owner's Inbox thread. Never raises."""
        await record_owner_message(
            organization_id=organization_id,
            whatsapp_account_id=account_id,
            owner_number=owner_number,
            direction="outbound",
            body=text,
            provider_message_id=provider_message_id,
            status=status,
            sent_at=sent_at,
        )


def create_owner_notify_service(**kwargs: Any) -> OwnerNotifyService:
    return OwnerNotifyService(**kwargs)


_default_owner_notify_service: OwnerNotifyService | None = None


def get_owner_notify_service(**kwargs: Any) -> OwnerNotifyService:
    global _default_owner_notify_service
    if _default_owner_notify_service is None or kwargs:
        _default_owner_notify_service = OwnerNotifyService(**kwargs)
    return _default_owner_notify_service


