"""
Is this failure worth trying again, or is trying again just a slower way to fail?

A PORT OF backend/src/modules/followups/transient-failure.ts.

THE DISTINCTION IS THE WHOLE POINT OF RETRYING AT ALL. A classifier that timed out would
probably answer if asked in a minute, and the commitment it never saw is a reminder the owner
never got. A classifier that answered "no commitment here" has already done its job, and
asking again costs an LLM call to be told the same thing. Retrying the second kind is how a
recovery mechanism turns into a bill.

SO THE DEFAULT IS NO. Anything this file does not positively recognise as a network or
availability problem is terminal. A permissive default here is worse than a missed reminder:
it would re-run extraction against malformed input, a revoked service key or a 400 forever,
until the attempt budget runs out, every time.
"""

from typing import Any

# Node and undici put the useful part in `code`; `cause` holds it for a wrapped fetch error.
TRANSIENT_CODES: tuple[str, ...] = (
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "EPIPE",
    "EAI_AGAIN",
    "ENOTFOUND",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_SOCKET",
)

# `AbortError` is the one that matters most here, and it is why this file exists.
# ai-brain.client.ts gives `/v1/commitment` an 8-second budget and aborts the fetch when it
# runs out, which rejects with a DOMException named AbortError (code 20).
TRANSIENT_NAMES: tuple[str, ...] = (
    "AbortError",
    "TimeoutError",
    "FetchError",
    "ConnectTimeout",
    "ReadTimeout",
    "TimeoutException",
    "ConnectError",
)


def is_transient_ai_failure(error: Any) -> bool:
    """Returns True if the failure is transient (network / timeout / 5xx / 429) and worth retrying."""
    if error is None:
        return False

    name: str | None = None
    code: Any = None
    status_code: Any = None
    message: str | None = None
    cause: Any = None

    if isinstance(error, dict):
        name = error.get("name")
        code = error.get("code")
        status_code = error.get("statusCode") if "statusCode" in error else error.get("status_code")
        message = error.get("message")
        cause = error.get("cause")
    elif isinstance(error, Exception):
        name = type(error).__name__
        code = getattr(error, "code", getattr(error, "errno", None))
        status_code = getattr(error, "status_code", getattr(error, "statusCode", None))
        message = str(error)
        cause = getattr(error, "__cause__", getattr(error, "cause", None))
    else:
        return False

    if isinstance(name, str) and name in TRANSIENT_NAMES:
        return True

    # Check codes on error and cause
    cause_code = None
    cause_name = None
    if isinstance(cause, dict):
        cause_code = cause.get("code")
        cause_name = cause.get("name")
    elif isinstance(cause, Exception):
        cause_code = getattr(cause, "code", getattr(cause, "errno", None))
        cause_name = type(cause).__name__

    codes = [code, cause_code, cause_name]
    for c in codes:
        if isinstance(c, str) and c in TRANSIENT_CODES:
            return True

    # The service answered, badly. 5xx and 429 are "ask again"; every 4xx is "you asked wrong",
    # and asking the same wrong thing again will fail identically.
    if isinstance(status_code, int):
        return status_code == 429 or status_code >= 500

    # undici's generic wrapper for a connection that never got off the ground.
    if message == "fetch failed":
        return True

    return False


def describe_failure(error: Any) -> str:
    """
    A short, PII-free description of a failure, safe to persist and log.

    Deliberately NOT `error.message`. A provider message can echo the request — which for this
    path is a customer's own words — and anything written here lands in a database row and a log
    line that both outlive the request.
    """
    if error is None:
        return "unknown"

    name: Any = None
    code: Any = None
    status_code: Any = None

    if isinstance(error, dict):
        name = error.get("name")
        code = error.get("code")
        status_code = error.get("statusCode") if "statusCode" in error else error.get("status_code")
    elif isinstance(error, Exception):
        name = getattr(error, "name", type(error).__name__)
        code = getattr(error, "code", getattr(error, "errno", None))
        status_code = getattr(error, "status_code", getattr(error, "statusCode", None))
    else:
        return "unknown"

    parts = [
        str(p)
        for p in (name, code, status_code)
        if (isinstance(p, str) and p.strip()) or isinstance(p, (int, float))
    ]

    return ":".join(parts)[:120] if parts else "unknown"

