"""
Workspace settings for Meta's Conversions API.

GATED ON `settings.manage`, like the Razorpay panel beside it: connecting a dataset decides where
a business's conversion data is reported, which is an owner's decision rather than a salesperson's.

THREE ROUTES AND NO FOURTH. Connect, enable, and read the status. There is deliberately no
"send a test event" button that posts arbitrary data - Meta's own Test Events tab is the documented
way to prove an integration, and it is driven by the `testEventCode` on the connection, so
the real milestones flow through the real code path while nothing touches live reporting. A
synthetic event sent from a button would prove that the button works.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field, SecretStr

from app import db
from app.capi_credentials import (
    build_connection,
    normalize_test_event_code,
    serialize_connection,
)
from app.capi_service import delivery_status
from app.deps import AuthContext, require_permission
from app.domain.capi_events import EVENT_KEYS, EVENT_NAMES, validate_selection
from app.payments_service import error
from app.permissions import SETTINGS_MANAGE

settings_router = APIRouter()

_require_settings = require_permission(SETTINGS_MANAGE)


class ConnectCapiBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    datasetId: str
    #: `SecretStr` so an accidental log line or repr prints `**********` rather than the token.
    accessToken: SecretStr
    testEventCode: str | None = None
    selectedEvents: list[str] = Field(default_factory=list)


class CapiToggleBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    enabled: bool


class CapiSelectionBody(BaseModel):
    model_config = ConfigDict(extra="forbid")

    selectedEvents: list[str]
    testEventCode: str | None = None


@settings_router.get("/capi")
async def get_capi(auth: AuthContext = Depends(_require_settings)):
    """
    The connection as the dashboard may see it.

    THE ACCESS TOKEN IS NOT IN HERE and there is no route that returns it, so there is nothing
    for a component to accidentally render - the same rule as the Razorpay panel.
    """
    organization = await db.get_database()["organizations"].find_one(
        {"_id": auth.organization_id}, {"capi": 1}
    )

    return {
        "data": {
            **serialize_connection(organization),
            # The milestones this installation can report, so the form is built from the
            # server's vocabulary rather than a copy of it that drifts.
            "availableEvents": [
                {"key": key, "metaEventName": EVENT_NAMES[key]} for key in EVENT_KEYS
            ],
        }
    }


@settings_router.put("/capi")
async def connect_capi(
    body: ConnectCapiBody,
    auth: AuthContext = Depends(_require_settings),
):
    """
    Stores a dataset and token. Does NOT start sending anything.

    Enabling is a separate call on purpose: pasting a credential is finishing a setup, and
    starting to report real conversions into somebody's ad account is a different decision.
    """
    try:
        connection = build_connection(
            dataset_id=body.datasetId,
            access_token=body.accessToken.get_secret_value(),
            test_event_code=body.testEventCode,
            selected_events=body.selectedEvents,
            now=db.utc_now(),
        )
    except ValueError as exc:
        raise error(400, "CAPI_CONFIG_INVALID", str(exc)) from None

    # `enabled` is preserved rather than reset: re-pasting a rotated token on a live connection
    # should not silently stop delivery, and should not silently start it either.
    existing = await db.get_database()["organizations"].find_one(
        {"_id": auth.organization_id}, {"capi.enabled": 1}
    )
    connection["enabled"] = bool(((existing or {}).get("capi") or {}).get("enabled"))
    connection["needsAttention"] = False

    await db.get_database()["organizations"].update_one(
        {"_id": auth.organization_id}, {"$set": {"capi": connection}}
    )

    organization = await db.get_database()["organizations"].find_one(
        {"_id": auth.organization_id}, {"capi": 1}
    )

    return {"data": serialize_connection(organization)}


@settings_router.post("/capi/enabled")
async def set_capi_enabled(
    body: CapiToggleBody,
    auth: AuthContext = Depends(_require_settings),
):
    """
    Starts or stops delivery.

    Refuses to enable an unconfigured connection rather than accepting a setting that cannot do
    anything - a toggle that reads "on" while nothing is sent is worse than a refusal.
    """
    organization = await db.get_database()["organizations"].find_one(
        {"_id": auth.organization_id}, {"capi": 1}
    )

    capi = (organization or {}).get("capi") or {}

    if body.enabled and not (capi.get("datasetId") and capi.get("encryptedAccessToken")):
        raise error(
            409,
            "CAPI_NOT_CONFIGURED",
            "Connect a Meta dataset before switching delivery on.",
        )

    await db.get_database()["organizations"].update_one(
        {"_id": auth.organization_id}, {"$set": {"capi.enabled": bool(body.enabled)}}
    )

    refreshed = await db.get_database()["organizations"].find_one(
        {"_id": auth.organization_id}, {"capi": 1}
    )

    return {"data": serialize_connection(refreshed)}


@settings_router.post("/capi/events")
async def set_capi_events(
    body: CapiSelectionBody,
    auth: AuthContext = Depends(_require_settings),
):
    """Changes which milestones are reported, and whether they go to Test Events."""
    try:
        selected = validate_selection(body.selectedEvents)
        test_code = normalize_test_event_code(body.testEventCode)
    except ValueError as exc:
        raise error(400, "CAPI_CONFIG_INVALID", str(exc)) from None

    updated = await db.get_database()["organizations"].find_one_and_update(
        {"_id": auth.organization_id, "capi.datasetId": {"$type": "string"}},
        {"$set": {"capi.selectedEvents": selected, "capi.testEventCode": test_code}},
        projection={"capi": 1},
        return_document=True,
    )

    if not updated:
        raise error(409, "CAPI_NOT_CONFIGURED", "Connect a Meta dataset first.")

    return {"data": serialize_connection(updated)}


@settings_router.get("/capi/status")
async def get_capi_status(auth: AuthContext = Depends(_require_settings)):
    """
    Delivery status: counts by state and the most recent failures.

    THE FAILURES ARE THE POINT. A conversion that never reached Meta is a number missing from an
    advertiser's reporting, and the only place anybody would notice is here.
    """
    status = await delivery_status(organization_id=auth.organization_id)

    return {
        "data": {
            "counts": status["counts"],
            "maxAttempts": status["maxAttempts"],
            "recentFailures": [
                {
                    "eventKey": row.get("eventKey"),
                    "state": row.get("state"),
                    "attempts": row.get("attempts"),
                    "lastError": row.get("lastError"),
                    "lastErrorAt": row.get("lastErrorAt"),
                }
                for row in status["recentFailures"]
            ],
        }
    }
