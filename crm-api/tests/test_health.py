"""
The health endpoint, and whether it is indistinguishable from Node's.

THE THING BEING PROTECTED IS NOT THE ENDPOINT. Caddy will route `/api/v1/health*` to Python and
everything else to Node, and the React app calls the same URL it always has. If the two services
answer differently - a renamed field, a different status code, a missing key - the frontend
breaks in a way that looks like a backend outage, and the migration's first visible act is a
regression.

So these assert the EXACT shape the Node backend returns, copied from
backend/src/modules/health/health.service.ts. The second assertion in each test is the one that
matters: not "it responded" but "it responded with precisely this".
"""

import pytest
from fastapi.testclient import TestClient

from app import cache, db
from app.main import app

client = TestClient(app)


@pytest.fixture
def _mongo_up(monkeypatch):
    async def status():
        return {"ready": True, "state": "connected", "replicaSet": {"ok": True, "expected": "rs0", "actual": "rs0"}}

    monkeypatch.setattr(db, "get_status", status)


@pytest.fixture
def _redis_up(monkeypatch):
    async def status():
        return {"ready": True, "state": "ready"}

    monkeypatch.setattr(cache, "get_status", status)


class TestLiveness:
    def test_returns_exactly_what_node_returns(self):
        # Field for field, from health.service.ts's getLivenessSnapshot.
        response = client.get("/api/v1/health")

        assert response.status_code == 200
        assert response.json() == {
            "data": {"status": "ok", "service": "wam-backend"},
            "meta": {"environment": "test"},
        }

    def test_SERVICE_NAME_IS_NOT_RENAMED(self):
        # "wam-backend", not "crm-api". This is the same API with a different implementation
        # behind part of it; a client able to tell them apart is a client that breaks on the
        # next phase.
        assert client.get("/api/v1/health").json()["data"]["service"] == "wam-backend"

    def test_does_not_touch_dependencies(self, monkeypatch):
        # Liveness answers "should this container be restarted". Restarting the API because
        # Redis is down would take down the half that still works.
        async def explode():
            raise AssertionError("liveness must not probe dependencies")

        monkeypatch.setattr(db, "get_status", explode)
        monkeypatch.setattr(cache, "get_status", explode)

        assert client.get("/api/v1/health").status_code == 200


class TestReadiness:
    def test_200_and_the_full_node_shape_when_everything_is_up(self, _mongo_up, _redis_up):
        response = client.get("/api/v1/health/readiness")
        body = response.json()

        assert response.status_code == 200
        assert body["data"]["status"] == "ready"
        assert body["data"]["service"] == "wam-backend"
        assert body["data"]["dependencies"]["mongodb"]["ready"] is True
        assert body["data"]["dependencies"]["redis"]["ready"] is True
        assert body["meta"]["environment"] == "test"

    def test_503_WHEN_MONGO_IS_DOWN(self, _redis_up, monkeypatch):
        # A readiness probe returning 200 while a dependency is down cannot be used to gate
        # anything, which is the only reason to have one.
        async def down():
            return {"ready": False, "state": "disconnected", "error": "ServerSelectionTimeoutError"}

        monkeypatch.setattr(db, "get_status", down)

        response = client.get("/api/v1/health/readiness")

        assert response.status_code == 503
        assert response.json()["data"]["status"] == "not_ready"

    def test_503_when_redis_is_down(self, _mongo_up, monkeypatch):
        async def down():
            return {"ready": False, "state": "closed", "error": "ConnectionError"}

        monkeypatch.setattr(cache, "get_status", down)

        assert client.get("/api/v1/health/readiness").status_code == 503

    def test_NEVER_LEAKS_A_CONNECTION_STRING(self, _redis_up, monkeypatch):
        # A driver exception can carry the full URI, credentials included, and this response is
        # public. The probes report the exception TYPE only - this asserts that holds.
        async def down():
            return {"ready": False, "state": "disconnected", "error": "ServerSelectionTimeoutError"}

        monkeypatch.setattr(db, "get_status", down)

        body = client.get("/api/v1/health/readiness").text

        assert "mongodb://" not in body
        assert "@" not in body


class TestReplicaSetTopology:
    """
    The check that exists because a naive one would have passed.

    The deployment runs mongod with `--replSet rs0` and the Node backend opens transactions
    against it at 39 call sites. A connection string missing `replicaSet=rs0` still connects and
    still pings - reads do not need a replica set - so a ping-only probe reports healthy. It
    fails the first time a migrated module opens a transaction, which is months away on the
    roadmap and in a module far harder to debug than this one.
    """

    def test_NOT_READY_WHEN_CONNECTED_TO_A_STANDALONE(self, _redis_up, monkeypatch):
        # Connected, readable, and wrong. `setName` is absent on a standalone mongod.
        async def standalone():
            return {
                "ready": False,
                "state": "connected",
                "replicaSet": {"ok": False, "expected": "rs0", "actual": None},
            }

        monkeypatch.setattr(db, "get_status", standalone)

        response = client.get("/api/v1/health/readiness")

        assert response.status_code == 503
        assert response.json()["data"]["dependencies"]["mongodb"]["replicaSet"]["ok"] is False

    def test_NOT_READY_WHEN_POINTED_AT_THE_WRONG_CLUSTER(self, _redis_up, monkeypatch):
        # A replica set, just not ours - a staging URI in a production container.
        async def other():
            return {
                "ready": False,
                "state": "connected",
                "replicaSet": {"ok": False, "expected": "rs0", "actual": "rs-staging"},
            }

        monkeypatch.setattr(db, "get_status", other)

        assert client.get("/api/v1/health/readiness").status_code == 503

    def test_reports_which_set_it_found(self, _redis_up, monkeypatch):
        # "Connected to rs-staging, expected rs0" is a diagnosis. "Not ready" is a riddle.
        async def other():
            return {
                "ready": False,
                "state": "connected",
                "replicaSet": {"ok": False, "expected": "rs0", "actual": "rs-staging"},
            }

        monkeypatch.setattr(db, "get_status", other)

        rs = client.get("/api/v1/health/readiness").json()["data"]["dependencies"]["mongodb"]["replicaSet"]

        assert rs["expected"] == "rs0"
        assert rs["actual"] == "rs-staging"


class TestTopologyDetection:
    """
    The probe itself, not the endpoint's handling of it.

    WHY THIS CLASS EXISTS: the tests above stub `db.get_status` wholesale, so they prove the
    readiness endpoint reports a bad topology correctly - and prove nothing about whether the
    probe ever NOTICES one. A mutation that replaced the comparison with `if False:` passed all
    of them. These call the real function against a stubbed driver, so the detection is covered.
    """

    @staticmethod
    def _client_reporting(hello: dict):
        class _Admin:
            async def command(self, _name):
                return hello

        class _Client:
            admin = _Admin()

        return _Client()

    @pytest.mark.asyncio
    async def test_DETECTS_A_STANDALONE_MONGOD(self, monkeypatch):
        # `setName` is absent when mongod is not a replica set member. Reads work, transactions
        # do not - which is why a ping-only probe would call this healthy.
        monkeypatch.setattr(db, "get_client", lambda: self._client_reporting({"ok": 1}))

        status = await db.get_status()

        assert status["ready"] is False
        assert status["replicaSet"]["ok"] is False
        assert status["replicaSet"]["actual"] is None

    @pytest.mark.asyncio
    async def test_DETECTS_THE_WRONG_REPLICA_SET(self, monkeypatch):
        monkeypatch.setattr(
            db, "get_client", lambda: self._client_reporting({"ok": 1, "setName": "rs-staging"})
        )

        status = await db.get_status()

        assert status["ready"] is False
        assert status["replicaSet"]["actual"] == "rs-staging"

    @pytest.mark.asyncio
    async def test_accepts_the_expected_replica_set(self, monkeypatch):
        monkeypatch.setattr(
            db, "get_client", lambda: self._client_reporting({"ok": 1, "setName": "rs0"})
        )

        status = await db.get_status()

        assert status["ready"] is True
        assert status["replicaSet"]["ok"] is True

    @pytest.mark.asyncio
    async def test_REPORTS_THE_EXCEPTION_TYPE_NOT_ITS_TEXT(self, monkeypatch):
        # A driver error can carry the full connection string, credentials included, and this
        # value is rendered into a public response.
        class _Boom:
            class admin:  # noqa: N801
                @staticmethod
                async def command(_name):
                    raise RuntimeError("mongodb://user:password@host/db failed")

        monkeypatch.setattr(db, "get_client", lambda: _Boom())

        status = await db.get_status()

        assert status["ready"] is False
        assert status["error"] == "RuntimeError"
        assert "password" not in str(status)


class TestRoutePaths:
    """
    The service's paths must equal the PUBLIC paths.

    Caddy's `handle` forwards the matched prefix unchanged - it does not strip it. So
    /api/v1/health arrives here spelled /api/v1/health, and a bare /health route would 404 the
    instant Caddy started routing to this service. That failure would appear in production, at
    cutover, as a FastAPI 404 that looks nothing like a routing misconfiguration.
    """

    def test_SERVES_THE_PUBLIC_PATH(self):
        assert client.get("/api/v1/health").status_code == 200

    def test_DOES_NOT_SERVE_THE_BARE_PATH(self):
        # The inverted assertion. If someone "simplifies" these routes back to /health, Caddy
        # keeps matching and this service starts 404ing every health check.
        assert client.get("/health").status_code == 404
