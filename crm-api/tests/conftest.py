"""
Test fixtures.

NO REAL MONGO, NO REAL REDIS. These tests run in CI and on a laptop, and a suite that needs a
live replica set to run is a suite that stops being run. The probes are stubbed per-test so each
dependency state - up, down, wrong cluster - is stated in the test that cares about it.
"""

import base64
import os
import pytest
import mongomock.collection

from app.config import settings

# ---------------------------------------------------------------------------
# mongomock bugfix for $max / $min on null fields
# In MongoDB, BSON comparison treats null < Date/Number/String. mongomock's
# default implementation does `max(doc.get(k, val), val)`, which raises
# `TypeError: '>' not supported between instances of ... and 'NoneType'`
# when `doc[k]` is explicitly `None`.
# ---------------------------------------------------------------------------
def _patched_max_updater(doc, field_name, value):
    if isinstance(doc, dict):
        cur = doc.get(field_name)
        if cur is None:
            doc[field_name] = value
        elif value is None:
            pass
        else:
            doc[field_name] = max(cur, value)

def _patched_min_updater(doc, field_name, value):
    if isinstance(doc, dict):
        cur = doc.get(field_name)
        if cur is None:
            doc[field_name] = None
        elif value is None:
            doc[field_name] = None
        else:
            doc[field_name] = min(cur, value)

mongomock.collection._updaters["$max"] = _patched_max_updater
mongomock.collection._updaters["$min"] = _patched_min_updater

# ---------------------------------------------------------------------------
# mongomock bugfix for $mergeObjects in pipeline updates
# MongoDB 4.4+ supports $mergeObjects in aggregation and update pipelines.
# mongomock raises NotImplementedError for $mergeObjects.
# ---------------------------------------------------------------------------
import mongomock.aggregate
_orig_aggregate_parse = mongomock.aggregate._Parser.parse

def _patched_aggregate_parse(self, expression):
    if isinstance(expression, dict) and "$mergeObjects" in expression:
        args = expression["$mergeObjects"]
        if not isinstance(args, list):
            args = [args]
        merged = {}
        for item in args:
            res = self.parse(item)
            if isinstance(res, dict):
                merged.update(res)
        return merged
    return _orig_aggregate_parse(self, expression)

mongomock.aggregate._Parser.parse = _patched_aggregate_parse


@pytest.fixture(autouse=True)
def _test_settings(tmp_path, monkeypatch):
    """
    A known secret, environment, and isolated temp media dir for every test.

    Set on the shared settings object rather than through env vars because pydantic-settings
    reads the environment once at import. Restored afterwards so one test cannot leak into the
    next - the auth tests deliberately change the secret.
    """
    if "ENCRYPTION_KEY_V1" not in os.environ:
        monkeypatch.setenv("ENCRYPTION_KEY_V1", base64.b64encode(b"k" * 32).decode("ascii"))
    if "ENCRYPTION_KEY_CURRENT_VERSION" not in os.environ:
        monkeypatch.setenv("ENCRYPTION_KEY_CURRENT_VERSION", "1")
    if "CONTACT_LOOKUP_HMAC_KEY" not in os.environ:
        monkeypatch.setenv("CONTACT_LOOKUP_HMAC_KEY", base64.b64encode(b"test-secret-at-least-16-bytes!").decode("ascii"))

    original = (
        settings.jwt_access_secret,
        settings.node_env,
        settings.expected_replica_set,
        getattr(settings, "media_storage_dir", "var/media"),
    )

    settings.jwt_access_secret = "test-secret-at-least-32-characters-long!"
    settings.node_env = "test"
    settings.expected_replica_set = "rs0"
    settings.media_storage_dir = str(tmp_path / "media")

    yield

    (
        settings.jwt_access_secret,
        settings.node_env,
        settings.expected_replica_set,
        settings.media_storage_dir,
    ) = original


def _supports_lookup_pipeline() -> bool:
    """
    Whether the backing database implements `$lookup` with a SUB-PIPELINE.

    MONGOMOCK DOES NOT — neither the `pipeline` form nor the correlated `let` form. Real
    MongoDB has supported it since 3.6 and the Node implementation relies on it; mongomock
    raises NotImplementedError.

    Tests needing it SKIP here rather than being rewritten to suit the mock. Rewriting them
    would mean shipping a different pipeline than Node ships, which is the one thing this port
    must not do — and the pipelines themselves are compared stage-for-stage against Node in
    their own structural tests, which is the stronger check.

    A PROBE rather than a hard skip, so the same tests execute unchanged the moment the suite is
    pointed at a real MongoDB.

    Lives in conftest because two suites need it (analytics routes and the Tasks screen) and two
    copies of a capability probe is two chances for one to drift and silently stop skipping.
    """
    import asyncio

    from mongomock_motor import AsyncMongoMockClient

    async def probe() -> bool:
        mock = AsyncMongoMockClient()["probe"]
        await mock.a.insert_one({"_id": 1, "k": "x"})

        try:
            cursor = mock.a.aggregate(
                [
                    {
                        "$lookup": {
                            "from": "a",
                            "let": {"k": "$k"},
                            "pipeline": [{"$match": {"$expr": {"$eq": ["$k", "$$k"]}}}],
                            "as": "self",
                        }
                    }
                ]
            )
            [row async for row in cursor]

            return True
        except Exception:  # noqa: BLE001
            return False

    return asyncio.run(probe())


SUPPORTS_LOOKUP_PIPELINE = _supports_lookup_pipeline()

needs_lookup_pipeline = pytest.mark.skipif(
    not SUPPORTS_LOOKUP_PIPELINE,
    reason=(
        "mongomock does not implement $lookup with a sub-pipeline. The pipeline is compared to "
        "Node structurally in its own test; this route test runs against a real MongoDB."
    ),
)
