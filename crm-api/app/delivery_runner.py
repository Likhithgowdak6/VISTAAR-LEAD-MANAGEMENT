"""
Delivery runner for WhatsApp outbound messages.

Ported from backend/src/modules/whatsapp/delivery/delivery-runner.ts.

Runs an interval task that drains queued outbound messages for every active WhatsApp account
holding a live socket session.
Gated on:
- WHATSAPP_ENABLED
- WHATSAPP_SEND_TEXT_POC_ENABLED
- WHATSAPP_OUTBOUND_DELIVERY_ENABLED
Polling interval: WHATSAPP_OUTBOUND_POLL_INTERVAL_MS (default 5000ms).
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable

from app.config import settings
from app.outbound_delivery import OutboundDeliveryService, create_outbound_delivery_service
from app.whatsapp_accounts_service import SessionManagerProtocol, get_session_manager

logger = logging.getLogger(__name__)


class DeliveryRunner:
    name: str = "delivery"

    def __init__(
        self,
        session_manager: SessionManagerProtocol | None = None,
        create_delivery_service_fn: Callable[[Any], OutboundDeliveryService] | None = None,
        interval_ms: int | None = None,
        enabled: bool | None = None,
    ) -> None:
        self.session_manager = session_manager or get_session_manager()

        if enabled is not None:
            self.enabled = enabled
        else:
            self.enabled = bool(
                getattr(settings, "whatsapp_enabled", False)
                and getattr(settings, "whatsapp_send_text_poc_enabled", False)
                and getattr(settings, "whatsapp_outbound_delivery_enabled", False)
            )

        self.interval_ms = interval_ms or getattr(settings, "whatsapp_outbound_poll_interval_ms", 5000)

        if create_delivery_service_fn:
            self.create_delivery_service = create_delivery_service_fn
        else:
            self.create_delivery_service = lambda account_id: create_outbound_delivery_service(
                session_service=self.session_manager,  # type: ignore[arg-type]
            )

        self._running = False
        self._task: asyncio.Task[None] | None = None

    async def drain_active_accounts(self) -> None:
        """Drains queued outbound messages for each live active account. Guarded against re-entrancy."""
        if self._running:
            return
        self._running = True

        try:
            states_fn = getattr(self.session_manager, "list_runtime_states", None)
            active_sessions = []
            if callable(states_fn):
                active_sessions = [
                    s for s in states_fn()
                    if s.get("running") and s.get("status") == "active"
                ]

            for state in active_sessions:
                account_id = state.get("accountId")
                org_id = state.get("organizationId")
                if not account_id or not org_id:
                    continue

                service = self.create_delivery_service(account_id)
                await service.drain_queue(
                    organization_id=org_id,
                    whatsapp_account_id=account_id,
                )
        except Exception as exc:
            logger.error("Delivery runner tick failed safely: %s", exc)
        finally:
            self._running = False

    async def _loop(self) -> None:
        while True:
            try:
                await self.drain_active_accounts()
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.error("Error in delivery runner loop: %s", exc)

            await asyncio.sleep(self.interval_ms / 1000.0)

    def start(self) -> bool:
        if not self.enabled or self._task is not None:
            return False
        self._task = asyncio.create_task(self._loop())
        return True

    def stop(self) -> None:
        if self._task:
            self._task.cancel()
            self._task = None


def create_delivery_runner(**kwargs: Any) -> DeliveryRunner:
    return DeliveryRunner(**kwargs)

