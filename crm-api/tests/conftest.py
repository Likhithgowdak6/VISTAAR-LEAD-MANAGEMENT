"""
Test fixtures.

NO REAL MONGO, NO REAL REDIS. These tests run in CI and on a laptop, and a suite that needs a
live replica set to run is a suite that stops being run. The probes are stubbed per-test so each
dependency state - up, down, wrong cluster - is stated in the test that cares about it.
"""

import pytest

from app.config import settings


@pytest.fixture(autouse=True)
def _test_settings():
    """
    A known secret and environment for every test.

    Set on the shared settings object rather than through env vars because pydantic-settings
    reads the environment once at import. Restored afterwards so one test cannot leak into the
    next - the auth tests deliberately change the secret.
    """
    original = (settings.jwt_access_secret, settings.node_env, settings.expected_replica_set)

    settings.jwt_access_secret = "test-secret-at-least-32-characters-long!"
    settings.node_env = "test"
    settings.expected_replica_set = "rs0"

    yield

    (settings.jwt_access_secret, settings.node_env, settings.expected_replica_set) = original
