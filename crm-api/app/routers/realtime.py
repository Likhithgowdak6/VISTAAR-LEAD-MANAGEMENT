"""
The realtime SSE stream.

A PORT OF backend/src/modules/realtime/realtime.routes.ts.

ONE REDIS SUBSCRIPTION PER CONNECTED CLIENT, not one shared subscriber with an in-process
registry. Node keeps a single subscriber and a `Set` of response objects because Express hands
it a raw socket to write to; FastAPI's `StreamingResponse` is pull-based, so each connection
owns an async generator and the natural shape is a subscription per stream.

That is more Redis connections than Node uses — bounded by the number of open dashboards, which
is a handful. The alternative, a shared subscriber fanning into per-client queues, is a second
piece of concurrency to get right for no benefit at this scale, and the failure mode of getting
it wrong is a client that silently stops receiving.

THE HEARTBEAT IS NOT DECORATIVE. Caddy, and every proxy between it and the browser, will close
an idle connection. A comment frame every 25 seconds keeps it open; without it the stream dies
after a minute or so and the inbox stops updating with nothing in any log.

`X-Accel-Buffering: no` AND `Cache-Control: no-transform` are both required. A proxy that
buffers the response delivers the whole stream at once when it ends, which for a stream that
never ends means never.
"""

import asyncio
import contextlib
import logging
from typing import AsyncIterator

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse

from app import cache
from app.deps import AuthContext, require_password_changed
from app.permissions import CONVERSATIONS_READ_ALL
from app.realtime import (
    REALTIME_CHANNEL,
    RealtimeClient,
    format_sse_event,
    parse_channel_message,
    should_deliver_to_client,
)

router = APIRouter()

HEARTBEAT_INTERVAL_SECONDS = 25

_logger = logging.getLogger("crm-api.realtime")


async def _stream(request: Request, client: RealtimeClient) -> AsyncIterator[str]:
    """
    Yields SSE frames until the client disconnects.

    The `: connected` preamble is sent immediately so the browser's `EventSource` fires `open`
    rather than sitting in `CONNECTING` until the first real event — which on a quiet account
    could be hours, and looks exactly like a broken connection.
    """
    yield ": connected\n\n"

    pubsub = None

    try:
        pubsub = cache.get_client().pubsub()
        await pubsub.subscribe(REALTIME_CHANNEL)

        while True:
            if await request.is_disconnected():
                break

            message = await pubsub.get_message(
                ignore_subscribe_messages=True, timeout=HEARTBEAT_INTERVAL_SECONDS
            )

            if message is None:
                # No event within the window. The heartbeat is what keeps the proxy from
                # closing an idle connection.
                yield ": ping\n\n"
                continue

            event = parse_channel_message(message.get("data"))

            # A malformed payload from another publisher must not end this client's stream.
            if event and should_deliver_to_client(event, client):
                yield format_sse_event(event)
    except asyncio.CancelledError:
        # Ordinary disconnect. Re-raised so the server can finish tearing the request down.
        raise
    except Exception as error:  # noqa: BLE001
        # One client's stream failing must not be reported as a server error to that client -
        # the response has already begun - nor take anything else down.
        _logger.warning("Realtime stream ended: %s", type(error).__name__)
    finally:
        if pubsub is not None:
            with contextlib.suppress(Exception):
                await pubsub.unsubscribe(REALTIME_CHANNEL)
                await pubsub.aclose()


@router.get("/stream")
async def stream(request: Request, auth: AuthContext = Depends(require_password_changed)):
    """
    The event stream.

    THE CLIENT'S PERMISSIONS ARE CAPTURED AT CONNECT TIME, exactly as Node does it. A user whose
    access is narrowed while holding an open stream keeps the wider view until they reconnect —
    which is bounded by the proxy's idle timeout and a page refresh, and is the same behaviour
    the access token already has.
    """
    client = RealtimeClient(
        user_id=str(auth.user_id),
        organization_id=str(auth.organization_id),
        can_read_all=CONVERSATIONS_READ_ALL in auth.permissions,
        queue=None,
    )

    return StreamingResponse(
        _stream(request, client),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            # Without this a buffering proxy delivers the whole stream when it ends, which for
            # a stream that never ends means never.
            "X-Accel-Buffering": "no",
        },
    )
