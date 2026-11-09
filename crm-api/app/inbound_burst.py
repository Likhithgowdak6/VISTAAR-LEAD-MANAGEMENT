"""
Inbound message burst collector.

Ported from backend/src/modules/whatsapp/ingestion/inbound-burst.ts.

Groups a customer's rapid-fire messages into ONE logical turn:
- "Hi" / "I need a photographer" / "For my wedding" / "December 15"
- Instead of triggering four individual replies, the first message opens a short debounce window.
- Each new message resets the window until the customer stops typing.
- When the window expires, messages are joined with single spaces and flushed to downstream AI/automation.
- Sequential serialization per conversation prevents concurrent replies.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable, Sequence

logger = logging.getLogger(__name__)


def join_burst_texts(texts: Sequence[str]) -> str:
    """Joins burst fragments with a single space, discarding empty entries."""
    cleaned = [t.strip() for t in texts if t and str(t).strip()]
    return " ".join(cleaned)


class InboundBurstTurn:
    def __init__(self, text: str, message_count: int, last_message_id: str) -> None:
        self.text = text
        self.message_count = message_count
        self.last_message_id = last_message_id

    def to_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "messageCount": self.message_count,
            "lastMessageId": self.last_message_id,
        }


class _PendingBurst:
    def __init__(
        self,
        texts: list[str],
        last_message_id: str,
        flush: Callable[[InboundBurstTurn], Awaitable[None]],
    ) -> None:
        self.texts = texts
        self.last_message_id = last_message_id
        self.flush = flush
        self.timer_handle: asyncio.TimerHandle | None = None


class InboundBurstCollector:
    def __init__(self, debounce_ms: int = 3000) -> None:
        self.debounce_ms = debounce_ms
        self._pending: dict[str, _PendingBurst] = {}
        self._running_tasks: dict[str, asyncio.Task[None]] = {}

    def is_pending(self, conversation_id: Any) -> bool:
        return str(conversation_id) in self._pending

    def collect(
        self,
        conversation_id: Any,
        message_id: Any,
        text: str,
        flush: Callable[[InboundBurstTurn], Awaitable[None]],
    ) -> None:
        """Adds a message to the open window for the conversation. Returns immediately."""
        key = str(conversation_id)
        existing = self._pending.get(key)

        if existing:
            existing.texts.append(text)
            existing.last_message_id = str(message_id)
            existing.flush = flush

            if existing.timer_handle:
                existing.timer_handle.cancel()

            loop = asyncio.get_event_loop()
            existing.timer_handle = loop.call_later(self.debounce_ms / 1000.0, self._fire, key)
            return

        burst = _PendingBurst(
            texts=[text],
            last_message_id=str(message_id),
            flush=flush,
        )
        self._pending[key] = burst

        if self.debounce_ms <= 0:
            self._fire(key)
            return

        loop = asyncio.get_event_loop()
        burst.timer_handle = loop.call_later(self.debounce_ms / 1000.0, self._fire, key)

    def _fire(self, key: str) -> None:
        burst = self._pending.pop(key, None)
        if not burst:
            return

        turn = InboundBurstTurn(
            text=join_burst_texts(burst.texts),
            message_count=len(burst.texts),
            last_message_id=burst.last_message_id,
        )

        async def _run_flush(prev_task: asyncio.Task[None] | None) -> None:
            if prev_task:
                try:
                    await prev_task
                except Exception:
                    pass
            try:
                await burst.flush(turn)
            except Exception as exc:
                logger.error("Inbound burst flush failed safely: %s", exc)
            finally:
                if self._running_tasks.get(key) is current_task:
                    self._running_tasks.pop(key, None)

        prev = self._running_tasks.get(key)
        current_task = asyncio.create_task(_run_flush(prev))
        self._running_tasks[key] = current_task

    async def flush_all(self) -> None:
        """Flushes all pending windows immediately. Used in tests and graceful shutdown."""
        keys = list(self._pending.keys())
        for key in keys:
            burst = self._pending.get(key)
            if burst and burst.timer_handle:
                burst.timer_handle.cancel()
            self._fire(key)

        tasks = list(self._running_tasks.values())
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)


def create_inbound_burst_collector(debounce_ms: int = 3000) -> InboundBurstCollector:
    return InboundBurstCollector(debounce_ms=debounce_ms)

