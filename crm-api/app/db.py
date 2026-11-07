"""
MongoDB, as this service sees it.

READ-ONLY IN PHASE 0, AND THAT IS ENFORCED BY WHAT IS NOT HERE: there is no insert, no update
and no delete anywhere in this module. The only commands issued are `ping` and `hello`, both of
which are administrative reads. The database this talks to holds live customer conversations and
the Node backend is actively writing to it.

WHY THE TOPOLOGY IS CHECKED AND NOT JUST THE CONNECTION. The deployment runs mongod with
`--replSet rs0`, and the Node backend opens real transactions against it - 39 call sites. A
connection string that omits `replicaSet=rs0` still connects, still pings, and still passes a
naive health check: every read works, because reads do not need a replica set. It fails the
first time a migrated module tries to open a transaction, which on the current roadmap is months
away and in a module far more complex than this one.

So the probe asks the server what it actually is. `hello` returns `setName` only when the node
is a replica set member, and comparing it to the expected name turns a problem that would have
surfaced in Phase 3 into one that surfaces here, in an 89-line module, where the fix is one
environment variable.
"""

from datetime import datetime, timezone
from typing import Any

from motor.motor_asyncio import AsyncIOMotorClient

from app.config import settings

_client: AsyncIOMotorClient | None = None


def get_client() -> AsyncIOMotorClient:
    """The shared client. Motor pools connections internally, so one per process is correct."""
    global _client

    if _client is None:
        _client = AsyncIOMotorClient(
            settings.mongodb_uri,
            # Short, because this is a health probe on a service that must answer quickly. A
            # dependency that takes five seconds to admit it is down is itself a problem.
            serverSelectionTimeoutMS=3000,
        )

    return _client


def utc_now() -> datetime:
    """
    The timestamp written into new documents.

    EXPLICIT BECAUSE MONGOOSE'S `timestamps: true` IS A LIBRARY FEATURE, not a database one.
    Nothing sets createdAt/updatedAt when the driver writes directly, and a document missing
    createdAt sorts last forever in a list ordered by it. Truncated to milliseconds to match
    what BSON stores and what JavaScript's Date carries - six microsecond digits would survive
    in Python and vanish on the next Node read, making the same row look different per reader.
    """
    moment = datetime.now(timezone.utc)

    return moment.replace(microsecond=(moment.microsecond // 1000) * 1000)


def get_database():
    """
    The database named in MONGODB_URI.

    TAKEN FROM THE URI RATHER THAN CONFIGURED SEPARATELY, so Python and Node cannot end up
    pointed at different databases on the same server. Mongoose does the same - the database is
    part of the connection string, not an extra setting - and a second knob here would be a
    second thing to get wrong.
    """
    database = get_client().get_default_database()

    if database is None:
        raise RuntimeError("MONGODB_URI names no database")

    return database


async def get_status() -> dict[str, Any]:
    """
    Whether Mongo is reachable AND is the cluster we expect.

    The shape matches the Node backend's `DatabaseStatus` - `{ready, state}` - because the React
    app reads this response and must not be able to tell which service answered. `replicaSet` is
    additive: a field Node does not send, carrying the topology answer, which no existing client
    reads and which makes the check visible to whoever is running the migration.
    """
    try:
        client = get_client()

        # `hello` is the modern handshake and returns the replica-set name when there is one.
        # It doubles as the liveness ping, so this is one round trip rather than two.
        hello = await client.admin.command("hello")
    except Exception as error:  # noqa: BLE001 - a health probe must never raise
        return {
            "ready": False,
            "state": "disconnected",
            # The exception TYPE, never its text. A driver error can carry the connection
            # string, and this response is public.
            "error": type(error).__name__,
        }

    set_name = hello.get("setName")
    expected = settings.expected_replica_set

    if set_name != expected:
        # Connected, readable, and WRONG - either not a replica set at all (so transactions will
        # fail later) or a different cluster than intended. Reported as not-ready on purpose:
        # "connected to something" is not the thing being asked.
        return {
            "ready": False,
            "state": "connected",
            "replicaSet": {
                "ok": False,
                "expected": expected,
                "actual": set_name,
            },
        }

    return {
        "ready": True,
        "state": "connected",
        "replicaSet": {"ok": True, "expected": expected, "actual": set_name},
    }


async def close() -> None:
    global _client

    if _client is not None:
        _client.close()
        _client = None
