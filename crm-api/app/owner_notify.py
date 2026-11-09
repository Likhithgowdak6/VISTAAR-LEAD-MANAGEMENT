"""
Sends messages directly to the studio owner on WhatsApp.

PORTED FROM backend/src/modules/whatsapp/automation/owner-notify.service.ts.

Direct and immediate send to the owner's WhatsApp number (or account self-chat).
Bypasses quiet hours and marketing throttles, but respects test allowlist.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Callable

from app import db
from app.allowlist import create_number_allowlist
from app.config import settings

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
        org = await database["organizations"].find_one({"_id": organization_id}, {"settings.ownerNumber": 1})
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

        if self._send_fn:
            res = await self._send_fn(account_id=account_id, to=owner_jid, text=text)
            mid = res.get("providerMessageId") if isinstance(res, dict) else getattr(res, "providerMessageId", None)
            return {"providerMessageId": mid}

        # Standalone / decoupled simulation
        logger.debug("Simulated owner notification to %s: %s", owner_jid, text[:100])
        return {"providerMessageId": "owner_notify_simulated"}


def create_owner_notify_service(**kwargs: Any) -> OwnerNotifyService:
    return OwnerNotifyService(**kwargs)


_default_owner_notify_service: OwnerNotifyService | None = None


def get_owner_notify_service(**kwargs: Any) -> OwnerNotifyService:
    global _default_owner_notify_service
    if _default_owner_notify_service is None or kwargs:
        _default_owner_notify_service = OwnerNotifyService(**kwargs)
    return _default_owner_notify_service


