"""
Redis, as this service sees it.

READ-ONLY, like `app/db.py`: the only command issued is `ping`. Redis holds live sessions, rate
limiter state and the realtime hub's fan-out, all of which the Node backend is actively using.

The status shape matches Node's `RedisStatus` - `{ready, state}` with state in
`ready | open | closed` - so the health response is identical whichever service answers it.
"""

import redis.asyncio as aioredis

from app.config import settings

_client: aioredis.Redis | None = None


def get_client() -> aioredis.Redis:
    global _client

    if _client is None:
        _client = aioredis.from_url(
            settings.redis_url,
            # Matches the Mongo probe's budget. A health endpoint that hangs is worse than one
            # that reports a dependency down.
            socket_connect_timeout=3,
            socket_timeout=3,
        )

    return _client


async def get_status() -> dict[str, object]:
    try:
        await get_client().ping()
    except Exception as error:  # noqa: BLE001 - a health probe must never raise
        # `closed` rather than a Python-specific word: this field is part of an API the React
        # app already reads, and its vocabulary belongs to the API, not to the implementation.
        return {"ready": False, "state": "closed", "error": type(error).__name__}

    return {"ready": True, "state": "ready"}


async def close() -> None:
    global _client

    if _client is not None:
        await _client.aclose()
        _client = None
