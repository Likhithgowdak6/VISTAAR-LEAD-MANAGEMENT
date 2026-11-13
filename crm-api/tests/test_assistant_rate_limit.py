"""
Throttling the assistant.

----------------------------------------------------------------------------------------------
THE TEST THAT MATTERS MOST IS THE BYPASS ONE
----------------------------------------------------------------------------------------------
A limit keyed on anything a user controls is not a limit. The UI has a "New conversation"
button; if the counter were scoped to a thread, one click would reset the budget and the whole
feature would be decoration. `TestItCannotBeBypassed` asserts the keys carry only the session's
user and organisation ids — not a thread id, not anything from the request body.

The second thing worth defending is that **all three counters increment even when one has
already tripped**. Returning early on the first breach would let somebody sitting on their
per-minute limit make unlimited attempts that never count toward the hour, so a client
retrying every second would be throttled forever while the hourly budget stayed untouched and
the organisation counter never saw the traffic at all.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from bson import ObjectId
from fastapi.testclient import TestClient

from app import assistant_rate_limit
from app.assistant_rate_limit import (
    HOUR_SECONDS,
    MINUTE_SECONDS,
    assistant_rate_limit_keys,
    check_assistant_rate_limit,
    rate_limit_message,
)
from app.config import settings
from app.deps import AuthContext
from app.main import app
from app.permissions import CONVERSATIONS_READ_ALL, CONVERSATIONS_READ_ASSIGNED
from app.routers import assistant as assistant_router

ORG = ObjectId()
OTHER_ORG = ObjectId()
USER = ObjectId()
OTHER_USER = ObjectId()
THREAD_ID = str(ObjectId())


class FakeRedis:
    """An in-memory stand-in with the two operations the limiter uses."""

    def __init__(self) -> None:
        self.counts: dict[str, int] = {}
        self.expiries: dict[str, int] = {}

    async def incr(self, key: str) -> int:
        self.counts[key] = self.counts.get(key, 0) + 1
        return self.counts[key]

    async def expire(self, key: str, seconds: int) -> None:
        # Recorded rather than ignored: a limiter that re-sets the TTL on every hit never lets
        # the window close, and the only way to see that is to count the calls.
        self.expiries[key] = self.expiries.get(key, 0) + 1


@pytest.fixture
def redis(monkeypatch):
    fake = FakeRedis()
    monkeypatch.setattr(assistant_rate_limit.cache, "get_client", lambda: fake)
    monkeypatch.setattr(settings, "redis_url", "redis://localhost:6379/0")

    return fake


@pytest.fixture
def limits(monkeypatch):
    monkeypatch.setattr(settings, "assistant_rate_limit_per_minute", 3)
    monkeypatch.setattr(settings, "assistant_rate_limit_per_hour", 5)
    monkeypatch.setattr(settings, "assistant_org_rate_limit_per_hour", 7)


async def ask_once(user_id=USER, organization_id=ORG):
    return await check_assistant_rate_limit(
        user_id=user_id, organization_id=organization_id
    )


class TestItCannotBeBypassed:
    def test_NO_KEY_CONTAINS_A_THREAD_ID(self):
        """
        The bypass this whole module would fail to prevent if it got this wrong.

        "New conversation" is one click. A thread-scoped counter would reset on every click and
        the limit would be unenforceable by design, while still looking present in the code.
        """
        keys = assistant_rate_limit_keys(USER, ORG)

        for key in keys:
            assert THREAD_ID not in key
            assert "thread" not in key.lower()

    def test_the_keys_are_derived_from_user_and_organisation_only(self):
        minute, user_hour, org_hour = assistant_rate_limit_keys(USER, ORG)

        assert str(USER) in minute and str(USER) in user_hour
        assert str(ORG) in org_hour

    @pytest.mark.asyncio
    async def test_OPENING_A_NEW_THREAD_DOES_NOT_RESET_THE_COUNT(self, redis, limits):
        # Exercised through the limiter itself rather than by inspecting keys, so a future
        # change that threads a thread id through would fail here too.
        for _ in range(5):
            await ask_once()

        assert (await ask_once()).limited is True

    @pytest.mark.asyncio
    async def test_a_different_user_has_their_own_budget(self, redis, monkeypatch):
        # Per-user limit of 5, but the ORGANISATION limit raised out of the way: otherwise one
        # user exhausting their own budget also exhausts the shared one, and this would pass or
        # fail for the wrong reason.
        monkeypatch.setattr(settings, "assistant_rate_limit_per_minute", 100)
        monkeypatch.setattr(settings, "assistant_rate_limit_per_hour", 5)
        monkeypatch.setattr(settings, "assistant_org_rate_limit_per_hour", 10_000)

        for _ in range(5):
            await ask_once(user_id=USER)

        assert (await ask_once(user_id=USER)).limited is True
        assert (await ask_once(user_id=OTHER_USER)).limited is False

    @pytest.mark.asyncio
    async def test_a_different_organisation_has_its_own_budget(self, redis, limits):
        for index in range(8):
            await ask_once(user_id=ObjectId(), organization_id=ORG)

        assert (await ask_once(user_id=ObjectId(), organization_id=ORG)).scope == "organisation"
        assert (
            await ask_once(user_id=ObjectId(), organization_id=OTHER_ORG)
        ).limited is False


class TestTheThreeCounters:
    @pytest.mark.asyncio
    async def test_the_per_minute_burst_limit_trips_first(self, redis, limits):
        # 3 per minute, 5 per hour: the fourth question in a minute is a burst, not a quota
        # problem, and the message should say so.
        for _ in range(3):
            assert (await ask_once()).limited is False

        decision = await ask_once()

        assert decision.limited is True
        assert decision.scope == "minute"
        assert decision.retry_after_seconds == MINUTE_SECONDS

    @pytest.mark.asyncio
    async def test_THE_HOURLY_LIMIT_TRIPS_EVEN_WHEN_SPREAD_OUT(self, redis, limits):
        """
        The per-minute counter expiring must not refill the hour.

        Simulated by clearing only the minute key — which is exactly what its 60-second TTL
        does — so this is a user asking politely, one question at a time, all afternoon.
        """
        minute_key, _, _ = assistant_rate_limit_keys(USER, ORG)

        for _ in range(5):
            redis.counts.pop(minute_key, None)
            assert (await ask_once()).limited is False

        redis.counts.pop(minute_key, None)
        decision = await ask_once()

        assert decision.limited is True
        assert decision.scope == "hour"
        assert decision.retry_after_seconds == HOUR_SECONDS

    @pytest.mark.asyncio
    async def test_THE_ORGANISATION_LIMIT_CATCHES_WHAT_PER_USER_MISSES(self, redis, limits):
        # Seven different users, each on their first question and nowhere near a personal
        # limit. Only the organisation counter sees the aggregate.
        minute_key_for = lambda uid: assistant_rate_limit_keys(uid, ORG)[0]

        for _ in range(7):
            assert (await ask_once(user_id=ObjectId())).limited is False

        decision = await ask_once(user_id=ObjectId())

        assert decision.limited is True
        assert decision.scope == "organisation"

    @pytest.mark.asyncio
    async def test_ALL_THREE_INCREMENT_EVEN_WHEN_ONE_HAS_TRIPPED(self, redis, limits):
        """
        Returning early on the first breach would make the hourly and organisation budgets
        unreachable for anyone stuck behind the per-minute limit — so a retry loop would be
        throttled forever while never exhausting the hour, and the organisation counter would
        never see the traffic.
        """
        minute_key, user_hour_key, org_hour_key = assistant_rate_limit_keys(USER, ORG)

        for _ in range(6):
            await ask_once()

        assert redis.counts[minute_key] == 6
        assert redis.counts[user_hour_key] == 6
        assert redis.counts[org_hour_key] == 6

    @pytest.mark.asyncio
    async def test_being_exactly_at_the_limit_is_allowed(self, redis, limits):
        # `count > limit`, not `>=`. A limit of 3 must permit the third question.
        for _ in range(3):
            assert (await ask_once()).limited is False


class TestTheWindow:
    @pytest.mark.asyncio
    async def test_THE_TTL_IS_SET_ONCE_NOT_ON_EVERY_HIT(self, redis, limits):
        """
        Re-setting the TTL on each attempt turns a fixed window into one that never expires
        while somebody keeps trying — the counter stays above the limit indefinitely and the
        user is locked out permanently. `login_rate_limit.py` documents the same trap.
        """
        minute_key, user_hour_key, org_hour_key = assistant_rate_limit_keys(USER, ORG)

        for _ in range(5):
            await ask_once()

        assert redis.expiries[minute_key] == 1
        assert redis.expiries[user_hour_key] == 1
        assert redis.expiries[org_hour_key] == 1


class TestFailureModes:
    @pytest.mark.asyncio
    async def test_REDIS_BEING_DOWN_FAILS_CLOSED(self, monkeypatch):
        """
        DELIBERATELY UNLIKE the login and draft limiters, which both fail open.

        What sits behind this one is up to six paid Anthropic calls. Failing open does not
        degrade a feature, it removes the only ceiling on spend at exactly the moment nobody
        is watching. An hour without the assistant costs nobody anything.
        """
        class Broken:
            async def incr(self, key):
                raise ConnectionError("redis unreachable")

            async def expire(self, key, seconds):
                raise ConnectionError("redis unreachable")

        monkeypatch.setattr(settings, "redis_url", "redis://localhost:6379/0")
        monkeypatch.setattr(assistant_rate_limit.cache, "get_client", lambda: Broken())

        decision = await ask_once()

        assert decision.unavailable is True
        assert decision.allowed is False

    @pytest.mark.asyncio
    async def test_A_TIMEOUT_ALSO_FAILS_CLOSED(self, monkeypatch):
        # A hung Redis is the more common outage than a refused one, and it arrives as a
        # different exception type.
        import asyncio

        class Hanging:
            async def incr(self, key):
                raise asyncio.TimeoutError()

            async def expire(self, key, seconds):
                raise asyncio.TimeoutError()

        monkeypatch.setattr(settings, "redis_url", "redis://localhost:6379/0")
        monkeypatch.setattr(assistant_rate_limit.cache, "get_client", lambda: Hanging())

        assert (await ask_once()).unavailable is True

    @pytest.mark.asyncio
    async def test_an_arbitrary_redis_operation_error_fails_closed(self, monkeypatch):
        class Odd:
            async def incr(self, key):
                raise RuntimeError("MISCONF Redis is configured to save RDB snapshots")

            async def expire(self, key, seconds):
                raise RuntimeError("nope")

        monkeypatch.setattr(settings, "redis_url", "redis://localhost:6379/0")
        monkeypatch.setattr(assistant_rate_limit.cache, "get_client", lambda: Odd())

        assert (await ask_once()).unavailable is True

    @pytest.mark.asyncio
    async def test_AN_OUTAGE_IS_NEVER_REPORTED_AS_A_RATE_LIMIT(self, monkeypatch):
        # The caller exceeded nothing. Setting `limited` here would tell somebody they hit a
        # quota they never touched, and send them away for an hour instead of seconds.
        class Broken:
            async def incr(self, key):
                raise ConnectionError("down")

            async def expire(self, key, seconds):
                raise ConnectionError("down")

        monkeypatch.setattr(settings, "redis_url", "redis://localhost:6379/0")
        monkeypatch.setattr(assistant_rate_limit.cache, "get_client", lambda: Broken())

        decision = await ask_once()

        assert decision.limited is False
        assert decision.scope is None

    @pytest.mark.asyncio
    async def test_RECOVERY_NEEDS_NO_RESTART(self, monkeypatch, limits):
        """
        `cache.get_client` caches a redis-py client whose pool reconnects on its own, so the
        first call after Redis returns succeeds. Simulated by flipping the fake from raising
        to working, with no re-import and no new client.
        """
        state = {"down": True}
        counts: dict = {}

        class Flaky:
            async def incr(self, key):
                if state["down"]:
                    raise ConnectionError("redis unreachable")

                counts[key] = counts.get(key, 0) + 1
                return counts[key]

            async def expire(self, key, seconds):
                if state["down"]:
                    raise ConnectionError("redis unreachable")

        monkeypatch.setattr(settings, "redis_url", "redis://localhost:6379/0")
        monkeypatch.setattr(assistant_rate_limit.cache, "get_client", lambda: Flaky())

        assert (await ask_once()).unavailable is True

        state["down"] = False

        recovered = await ask_once()

        assert recovered.unavailable is False
        assert recovered.allowed is True

    @pytest.mark.asyncio
    async def test_THE_LOG_LINE_CARRIES_NO_CONNECTION_STRING(self, monkeypatch, caplog):
        # A Redis URL can carry credentials, and this is the line most likely to be pasted
        # into a ticket. Only the exception TYPE is logged.
        class Leaky:
            async def incr(self, key):
                raise ConnectionError("failed connecting to redis://user:hunter2@10.0.0.4:6379")

            async def expire(self, key, seconds):
                raise ConnectionError("same")

        monkeypatch.setattr(settings, "redis_url", "redis://localhost:6379/0")
        monkeypatch.setattr(assistant_rate_limit.cache, "get_client", lambda: Leaky())

        with caplog.at_level("ERROR"):
            await ask_once()

        assert "hunter2" not in caplog.text
        assert "10.0.0.4" not in caplog.text
        assert "ConnectionError" in caplog.text

    @pytest.mark.asyncio
    async def test_A_BUG_IN_THIS_MODULE_IS_NOT_HIDDEN_AS_DEGRADED(self, monkeypatch):
        """
        A `TypeError` here is our bug, not an unavailable dependency. Swallowing it would
        report "the limiter is coping" while the limiter was in fact broken — and the spend
        ceiling would be silently gone.
        """
        class Buggy:
            async def incr(self, key):
                raise TypeError("key is not a string")

            async def expire(self, key, seconds):
                raise TypeError("nope")

        monkeypatch.setattr(settings, "redis_url", "redis://localhost:6379/0")
        monkeypatch.setattr(assistant_rate_limit.cache, "get_client", lambda: Buggy())

        with pytest.raises(TypeError):
            await ask_once()

    @pytest.mark.asyncio
    async def test_NO_REDIS_CONFIGURED_IS_ALSO_UNAVAILABLE(self, monkeypatch):
        # `check_ai_draft_rate_limit` treats this as "no limiter, carry on" - correct for a
        # single model call, wrong for six. A deployment that can spend money on Anthropic
        # but cannot reach a counter should not be spending it.
        monkeypatch.setattr(settings, "redis_url", "")

        decision = await ask_once()

        assert decision.unavailable is True
        assert decision.allowed is False


class TestTheMessage:
    @pytest.mark.parametrize("scope", ["minute", "hour", "organisation"])
    def test_every_scope_has_its_own_wording(self, scope):
        assert rate_limit_message(scope).strip()

    def test_THE_ORGANISATION_MESSAGE_NAMES_NOBODY(self):
        # Telling whoever hits the limit which colleague spent the budget would report one
        # person's activity to another, through an error message.
        message = rate_limit_message("organisation")

        assert "organisation" in message.lower()
        assert "user" not in message.lower()

    def test_an_unknown_scope_still_says_something_useful(self):
        assert rate_limit_message(None).strip()


# ----------------------------------------------------------------------------------------------
# Through the route
# ----------------------------------------------------------------------------------------------


def _auth(permissions, user_id=str(USER), org_id=str(ORG)):
    user = {
        "id": ObjectId(user_id), "_id": ObjectId(user_id),
        "organizationId": ObjectId(org_id), "role": "admin", "email": "a@b.test",
    }
    org = {"id": ObjectId(org_id), "_id": ObjectId(org_id), "name": "S", "status": "active"}

    class MockAuth(AuthContext):
        def __init__(self):
            super().__init__(
                user=user, organization=org, session={}, permissions=frozenset(permissions)
            )

    return MockAuth()


@pytest.fixture(autouse=True)
def clean_overrides():
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()


@pytest.fixture
def client():
    app.dependency_overrides[assistant_router._require_assistant] = lambda: _auth(
        [CONVERSATIONS_READ_ALL, CONVERSATIONS_READ_ASSIGNED]
    )

    return TestClient(app)


class TestThroughTheRoute:
    def test_A_LIMITED_QUESTION_IS_429_AND_NEVER_REACHES_THE_MODEL(self, client):
        """
        The limit has to be checked before the expensive part, not after. A 429 returned once
        the model has already run is an accounting exercise.
        """
        with patch.object(
            assistant_router, "check_assistant_rate_limit", new_callable=AsyncMock
        ) as check, patch.object(
            assistant_router, "run_assistant", new_callable=AsyncMock
        ) as run, patch.object(
            assistant_router.assistant_threads, "create_thread", new_callable=AsyncMock
        ) as create:
            check.return_value = assistant_rate_limit.RateLimitDecision(
                True, "minute", 60, unavailable=False
            )

            response = client.post("/api/v1/assistant/ask", json={"question": "hi"})

        assert response.status_code == 429
        run.assert_not_called()
        create.assert_not_called()

    def test_the_429_carries_a_retry_after_header(self, client):
        # So a client can back off correctly rather than guessing.
        with patch.object(
            assistant_router, "check_assistant_rate_limit", new_callable=AsyncMock
        ) as check:
            check.return_value = assistant_rate_limit.RateLimitDecision(
                True, "hour", 3600, unavailable=False
            )

            response = client.post("/api/v1/assistant/ask", json={"question": "hi"})

        assert response.headers["retry-after"] == "3600"

    def test_THE_ERROR_BODY_IS_READABLE_BY_A_PERSON(self, client):
        # This string is rendered in the UI. A bare code would leave the user guessing.
        with patch.object(
            assistant_router, "check_assistant_rate_limit", new_callable=AsyncMock
        ) as check:
            check.return_value = assistant_rate_limit.RateLimitDecision(
                True, "minute", 60, unavailable=False
            )

            response = client.post("/api/v1/assistant/ask", json={"question": "hi"})

        error = response.json()["error"]

        assert error["code"] == "ASSISTANT_RATE_LIMITED"
        assert "wait" in error["message"].lower()
        assert error["details"]["retryAfterSeconds"] == 60

    def test_the_limiter_is_given_the_session_identity_not_the_body(self, client):
        # The same guarantee as the tool context: a body naming another user must not change
        # whose budget is spent.
        with patch.object(
            assistant_router, "check_assistant_rate_limit", new_callable=AsyncMock
        ) as check, patch.object(
            assistant_router, "run_assistant", new_callable=AsyncMock
        ) as run, patch.object(
            assistant_router, "retrieve_background", new_callable=AsyncMock
        ), patch.object(
            assistant_router.assistant_threads, "create_thread", new_callable=AsyncMock
        ) as create, patch.object(
            assistant_router.assistant_threads, "save_turn", new_callable=AsyncMock
        ):
            check.return_value = assistant_rate_limit.RateLimitDecision(
                False, None, 0, unavailable=False
            )
            create.return_value = {
                "_id": ObjectId(), "organizationId": ORG, "userId": USER,
                "title": "t", "messages": [],
            }
            run.return_value = {
                "answer": "ok", "steps": [], "stoppedEarly": False,
                "stepCount": 0, "messages": [],
            }

            client.post(
                "/api/v1/assistant/ask",
                json={"question": "hi", "userId": str(OTHER_USER)},
            )

        assert str(check.call_args.kwargs["user_id"]) == str(USER)
        assert str(check.call_args.kwargs["organization_id"]) == str(ORG)

    def test_the_limits_are_advertised_to_the_frontend(self, client):
        response = client.get("/api/v1/assistant/tools")
        limits = response.json()["data"]["limits"]

        assert limits["perMinute"] == settings.assistant_rate_limit_per_minute
        assert limits["perHour"] == settings.assistant_rate_limit_per_hour


class TestTheDefaults:
    def test_THE_ASSISTANT_BUDGET_IS_TIGHTER_THAN_THE_DRAFT_BUDGET(self):
        """
        One draft is one model call; one assistant question is up to `MAX_STEPS`. Matching the
        draft's 60 an hour would have allowed six times the model calls under a number that
        looked like the same budget.
        """
        from app.assistant_agent import MAX_STEPS

        # Strictly fewer REQUESTS than the draft feature allows, because each one buys up to
        # MAX_STEPS model calls rather than one. Note `ai_draft_rate_limit_per_hour` resolves
        # to 30 in this environment, not the code default of 60 — `backend/.env` overrides it,
        # which is why this compares against the resolved setting rather than a literal.
        assert settings.assistant_rate_limit_per_hour < settings.ai_draft_rate_limit_per_hour

        # The worst case is still a multiple of the draft budget and that is a deliberate,
        # documented judgement call - strict model-call parity would mean 5 questions an hour.
        # What this pins is that the multiple stays bounded and visible rather than drifting.
        worst_case = settings.assistant_rate_limit_per_hour * MAX_STEPS

        assert worst_case <= settings.ai_draft_rate_limit_per_hour * 4

    def test_the_minute_limit_is_well_below_the_hourly_one(self):
        # Otherwise the burst counter never fires and the hour can be spent in seconds.
        assert settings.assistant_rate_limit_per_minute < settings.assistant_rate_limit_per_hour

    def test_the_organisation_limit_leaves_room_for_several_people(self):
        # An org limit below one user's hourly budget would make the per-user limit unreachable
        # and lock out a single legitimate heavy user.
        assert (
            settings.assistant_org_rate_limit_per_hour
            > settings.assistant_rate_limit_per_hour
        )


class TestTheStatusCodesAreNotConflated:
    """
    429 is the user's problem and clears when their window rolls over.
    503 is ours and clears when Redis comes back.

    Reporting an outage as 429 would tell somebody they had exceeded a limit they never
    touched, and the honest retry advice differs: an hour versus seconds.
    """

    def _decision(self, **kwargs):
        return assistant_rate_limit.RateLimitDecision(**kwargs)

    def test_AN_OUTAGE_IS_503_NOT_429(self, client):
        with patch.object(
            assistant_router, "check_assistant_rate_limit", new_callable=AsyncMock
        ) as check, patch.object(
            assistant_router, "run_assistant", new_callable=AsyncMock
        ) as run, patch.object(
            assistant_router.assistant_threads, "create_thread", new_callable=AsyncMock
        ) as create:
            check.return_value = self._decision(
                limited=False, scope=None, retry_after_seconds=15, unavailable=True
            )

            response = client.post("/api/v1/assistant/ask", json={"question": "hi"})

        assert response.status_code == 503
        assert response.json()["error"]["code"] == "ASSISTANT_UNAVAILABLE"
        run.assert_not_called()
        create.assert_not_called()

    def test_A_GENUINE_LIMIT_IS_STILL_429(self, client):
        # The distinction has to hold in both directions, or one of them is just a rename.
        with patch.object(
            assistant_router, "check_assistant_rate_limit", new_callable=AsyncMock
        ) as check:
            check.return_value = self._decision(
                limited=True, scope="hour", retry_after_seconds=3600, unavailable=False
            )

            response = client.post("/api/v1/assistant/ask", json={"question": "hi"})

        assert response.status_code == 429
        assert response.json()["error"]["code"] == "ASSISTANT_RATE_LIMITED"

    def test_the_503_advises_a_short_retry_not_an_hour(self, client):
        with patch.object(
            assistant_router, "check_assistant_rate_limit", new_callable=AsyncMock
        ) as check:
            check.return_value = self._decision(
                limited=False, scope=None, retry_after_seconds=15, unavailable=True
            )

            response = client.post("/api/v1/assistant/ask", json={"question": "hi"})

        assert response.headers["retry-after"] == "15"
        assert int(response.headers["retry-after"]) < 60

    def test_THE_503_BODY_LEAKS_NO_INFRASTRUCTURE(self, client):
        """
        This string is rendered in the browser and visible in the network tab. "Redis", a
        hostname, a port or an exception name are all things the reader cannot act on and
        should not be handed.
        """
        with patch.object(
            assistant_router, "check_assistant_rate_limit", new_callable=AsyncMock
        ) as check:
            check.return_value = self._decision(
                limited=False, scope=None, retry_after_seconds=15, unavailable=True
            )

            response = client.post("/api/v1/assistant/ask", json={"question": "hi"})

        body = response.text.lower()

        for leaked in ("redis", "connection", "traceback", "6379", "localhost", "exception"):
            assert leaked not in body, f"{leaked!r} leaked into the 503 body"

    def test_the_503_tells_the_user_the_rest_of_the_crm_is_fine(self, client):
        # Otherwise a failing assistant reads as a failing CRM, and somebody stops trusting
        # the numbers on every other screen.
        with patch.object(
            assistant_router, "check_assistant_rate_limit", new_callable=AsyncMock
        ) as check:
            check.return_value = self._decision(
                limited=False, scope=None, retry_after_seconds=15, unavailable=True
            )

            response = client.post("/api/v1/assistant/ask", json={"question": "hi"})

        assert "working normally" in response.json()["error"]["message"]

    def test_OTHER_CRM_ROUTES_ARE_UNAFFECTED_BY_A_LIMITER_OUTAGE(self, client):
        # The limiter guards `/assistant/ask` alone. A Redis outage must not take the rest of
        # the API with it.
        with patch.object(
            assistant_router, "check_assistant_rate_limit", new_callable=AsyncMock
        ) as check:
            check.return_value = self._decision(
                limited=False, scope=None, retry_after_seconds=15, unavailable=True
            )

            tools = client.get("/api/v1/assistant/tools")

        assert tools.status_code == 200
