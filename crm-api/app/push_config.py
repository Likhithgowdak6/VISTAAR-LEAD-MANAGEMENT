"""
Whether push is configured — the report `/push/status` serves.

A PORT OF `describeConfiguration` from backend/src/modules/push/push-sender.service.ts.

ONLY THE REPORT MOVES IN PHASE 7, NOT THE SENDER. `/push/devices` and `/push/status` are
registration and introspection; nothing on those routes sends a notification. The actual FCM
delivery lives in `push-notify.service.ts`, which is only ever called by the reminder runner —
so it moves in Phase 8, with that runner, and this service does not acquire a second code path
that could send a customer-facing notification while Node still owns the sweep.

NAMES OF MISSING VARIABLES, NEVER VALUES, AND NEVER THE PRIVATE KEY. The endpoint exists so the
dashboard can explain why push is silent; `missing: ["FIREBASE_PRIVATE_KEY"]` does that and
`"the key is <...>"` would be a credential in a response body, a proxy log and an error
tracker.

`enabled` AND `configured` ARE SEPARATE FACTS. Off deliberately, and on-but-misconfigured, are
different problems with different fixes, and collapsing them into one boolean leaves the
operator guessing which they have.
"""

from app.config import settings

FIREBASE_PROJECT_ID = "FIREBASE_PROJECT_ID"
FIREBASE_CLIENT_EMAIL = "FIREBASE_CLIENT_EMAIL"
FIREBASE_PRIVATE_KEY = "FIREBASE_PRIVATE_KEY"


def describe_configuration() -> dict:
    """`describeConfiguration`. The order of `missing` matches Node's, which is check order."""
    missing: list[str] = []

    if not settings.firebase_project_id:
        missing.append(FIREBASE_PROJECT_ID)

    if not settings.firebase_client_email:
        missing.append(FIREBASE_CLIENT_EMAIL)

    if not settings.firebase_private_key:
        missing.append(FIREBASE_PRIVATE_KEY)

    return {
        "enabled": settings.push_enabled is True,
        "configured": len(missing) == 0,
        "missing": missing,
    }
