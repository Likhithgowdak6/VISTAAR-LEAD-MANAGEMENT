"""
Multi-document transactions.

A PORT OF `runInTransaction` from backend/src/config/database.ts. The deployment runs mongod
with `--replSet rs0`, which is the whole reason the 39 transaction sites in Node work, and
`app/db.py`'s readiness probe already asserts the topology rather than trusting the URI.

WHY THIS EXISTS AT ALL. Users is the first migrated module whose writes come in pairs:
disabling a user both flips `status` AND revokes every active refresh session. Half of that
pair is a security hole — a disabled employee whose sessions survive keeps working until their
access token expires, and nothing in the UI shows it.

----------------------------------------------------------------------------------------------
THE TESTING PROBLEM, AND THE DECISION
----------------------------------------------------------------------------------------------
`mongomock-motor` does not implement sessions or transactions. The suite runs against it
because that is what makes the tenancy tests real — a mocked repository would let every
`organizationId` filter pass.

Three options were considered:

  1. Require a real replica set for the test suite. Correct, and it makes the suite depend on
     infrastructure that must be running before anyone can check out the repo and run tests.
     The Node suite has no such requirement; adding one to the Python side would be the first
     time this migration made the project harder to work on.
  2. Skip transactions in Python. Not an option - it is the behaviour being ported.
  3. **Degrade gracefully, and assert the SESSION THREADING instead of the atomicity.** The
     helper starts a real transaction when the driver supports one and runs the body with
     `session=None` when it does not. Tests then assert that every write inside the body was
     handed the session, which is the thing a port actually gets wrong. Nobody forgets to call
     `start_transaction`; people forget to pass `session=` to the third write.

Option 3 is implemented. The limitation is explicit: **the test suite does not prove atomicity,
it proves participation.** Atomicity is a property of the replica set, verified in production by
the readiness probe reporting `replicaSet.ok: true`.
"""

from contextlib import asynccontextmanager
from typing import Any, AsyncIterator, Awaitable, Callable, TypeVar

from app import db

T = TypeVar("T")


class _NoTransaction:
    """
    What callers get when the driver cannot start a session.

    Deliberately NOT a null object that silently swallows `session=`: it IS None, so a write
    that passes it through behaves exactly as an un-sessioned write. The point is that the code
    path is identical in both cases, so tests exercise the same lines production runs.
    """


@asynccontextmanager
async def transaction() -> AsyncIterator[Any]:
    """
    Yields a session to pass to every write in the body, or None when unsupported.

    On a real replica set this opens a session, begins a transaction, commits on success and
    aborts on any exception. The abort is what makes a half-finished pair impossible.
    """
    import inspect

    # THE CLIENT COMES FROM THE DATABASE, not from `db.get_client()`.
    #
    # Those are the same object in production, but `get_client()` constructs one from
    # `MONGODB_URI`, and the test suite replaces `get_database` while leaving the URI empty -
    # so calling it raised `ConfigurationError("Empty host")` from inside a request. Reaching
    # through the database object means there is exactly one place the connection is decided,
    # and whatever is driving the queries is also what drives the session.
    try:
        client = db.get_database().client
        session_cm = client.start_session()
        if inspect.isawaitable(session_cm):
            session_cm = await session_cm
    except Exception:  # noqa: BLE001 - every driver raises its own type here
        # No session support. See the module docstring: the body still runs, and the tests that
        # matter assert the session was threaded through rather than that it rolled back.
        yield None
        return

    try:
        if hasattr(session_cm, "__aenter__"):
            async with session_cm as session:
                if hasattr(session, "start_transaction"):
                    txn = session.start_transaction()
                    if hasattr(txn, "__aenter__"):
                        async with txn:
                            yield session
                    else:
                        yield session
                else:
                    yield session
        elif hasattr(session_cm, "__enter__"):
            with session_cm as session:
                if hasattr(session, "start_transaction"):
                    txn = session.start_transaction()
                    if hasattr(txn, "__enter__"):
                        with txn:
                            yield session
                    else:
                        yield session
                else:
                    yield session
        else:
            yield session_cm
    except (AttributeError, NotImplementedError):
        # A driver with `start_session` but no usable `start_transaction`.
        yield None


async def run_in_transaction(body: Callable[[Any], Awaitable[T]]) -> T:
    """
    `runInTransaction(async (session) => ...)`, with the same shape.

    The callable receives the session and MUST pass it to every write it performs. A write that
    omits it silently escapes the transaction and will not be rolled back - which is invisible
    until the day the second write fails.
    """
    async with transaction() as session:
        return await body(session)
