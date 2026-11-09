"""
Tests for transient-failure, pinned by fixtures generated from Node.
"""

import json
from pathlib import Path

from app.transient_failure import describe_failure, is_transient_ai_failure

FIXTURES = json.loads(
    (Path(__file__).parent / "fixtures" / "transient_failure.json").read_text(
        encoding="utf-8"
    )
)


def test_transient_failure_fixtures():
    for case in FIXTURES["cases"]:
        inp = case.get("input")
        expected_transient = case["isTransient"]
        expected_described = case["described"]

        assert is_transient_ai_failure(inp) == expected_transient
        assert describe_failure(inp) == expected_described


def test_exception_objects():
    class AbortError(Exception):
        pass

    assert is_transient_ai_failure(AbortError("operation aborted")) is True

    class CustomNetworkError(Exception):
        def __init__(self):
            self.code = "ECONNREFUSED"

    assert is_transient_ai_failure(CustomNetworkError()) is True


def test_never_includes_error_message():
    err = {
        "name": "AbortError",
        "code": 20,
        "message": "failed parsing 'call me on 9876543210'",
    }
    described = describe_failure(err)
    assert "9876543210" not in described
    assert "call me" not in described
    assert described == "AbortError:20"

