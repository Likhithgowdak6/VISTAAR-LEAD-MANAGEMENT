"""
Echo guard service for WhatsApp outbound delivery.

Ported from backend/src/modules/whatsapp/automation/echo-guard.service.ts.

Provides a short-TTL "did we just send this" Redis cache:
- Prevents the inbound router from mistaking our own just-sent message reflected back
  by WhatsApp from being treated as an owner typing into the chat.
- Fails safe in both directions:
  - remember() never throws (Redis outages must not break sends).
  - is_own_message() returns True on error or missing arguments ("assume it's ours, stay quiet").
"""

from __future__ import annotations

import logging
from typing import Any

from app import cache

logger = logging.getLogger(__name__)

DEFAULT_TTL_SECONDS = 3600


def _echo_key(account_id: Any, provider_message_id: str) -> str:
    return f"wam:echo:{str(account_id)}:{provider_message_id.strip()}"


class EchoGuardService:
    def __init__(self, redis_client: Any = None, ttl_seconds: int = DEFAULT_TTL_SECONDS) -> None:
        self._redis = redis_client
        self._ttl_seconds = ttl_seconds

    def _get_redis(self) -> Any:
        return self._redis or cache.get_client()

    async def remember(self, account_id: Any, provider_message_id: str | None) -> None:
        """Stores sent message ID in Redis with TTL. Never throws."""
        if not account_id or not provider_message_id:
            return

        try:
            client = self._get_redis()
            key = _echo_key(account_id, provider_message_id)
            await client.set(key, "1", ex=self._ttl_seconds)
        except Exception as exc:
            logger.error("Echo-guard remember failed safely: %s", exc)

    async def is_own_message(self, account_id: Any, provider_message_id: str | None) -> bool:
        """Checks if provider message ID was recently sent by us. Defaults to True on failure."""
        if not account_id or not provider_message_id:
            return True

        try:
            client = self._get_redis()
            key = _echo_key(account_id, provider_message_id)
            count = await client.exists(key)
            return bool(count and count >= 1)
        except Exception as exc:
            logger.error("Echo-guard is_own_message failed safely: %s", exc)
            return True


_global_echo_guard = EchoGuardService()


def get_echo_guard_service() -> EchoGuardService:
    return _global_echo_guard


def set_echo_guard_service(service: EchoGuardService) -> None:
    global _global_echo_guard
    _global_echo_guard = service

