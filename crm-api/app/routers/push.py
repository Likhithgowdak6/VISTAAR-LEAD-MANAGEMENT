"""
Device registration, from a signed-in app.

A PORT OF backend/src/modules/push/push.{routes,controller,validation}.ts.

AUTHENTICATED, AND NO PERMISSION BEYOND THAT. Registering your own handset is not a privileged
act — every role that can sign in has reminders assigned to them and should be able to receive
one. The scoping that matters is to the SESSION, and it happens here rather than in a
permission gate.

THE OWNER OF A DEVICE IS THE SESSION, NEVER THE BODY. Both handlers take `organizationId` and
`userId` from the verified token and ignore anything the client sends about identity — the
schema does not even have those fields. Without that, any signed-in user could register their
own handset against another organisation and start receiving its reminders.

NOTHING ON THESE ROUTES SENDS A NOTIFICATION. The FCM delivery path moves in Phase 8 with the
reminder runner that calls it, so this service cannot emit a customer-facing push while Node
still owns the sweep.
"""

from typing import Any, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field, field_validator

from app import db
from app.deps import AuthContext, require_password_changed
from app.push_config import describe_configuration

router = APIRouter()

COLLECTION = "pushdevices"

PLATFORM_ANDROID = "android"
Platform = Literal["android", "ios", "web"]

TOKEN_MIN = 10
TOKEN_MAX = 4096


class RegisterDevice(BaseModel):
    """
    NEITHER `userId` NOR `organizationId` IS ACCEPTED, and that is the security property of this
    endpoint rather than an omission.
    """

    token: str = Field(min_length=TOKEN_MIN, max_length=TOKEN_MAX)
    platform: Platform = PLATFORM_ANDROID

    @field_validator("token", mode="before")
    @classmethod
    def _trim(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


class RemoveDevice(BaseModel):
    token: str = Field(min_length=TOKEN_MIN, max_length=TOKEN_MAX)

    @field_validator("token", mode="before")
    @classmethod
    def _trim(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value


@router.post("/devices", status_code=201)
async def register_device(
    payload: RegisterDevice,
    auth: AuthContext = Depends(require_password_changed),
):
    """
    Upserted ON THE TOKEN ALONE, not on (token, user).

    A handset that is handed to a colleague re-registers with the same FCM token under a new
    user, and the row must MOVE rather than duplicate — otherwise the previous owner keeps
    receiving the new owner's reminders on a phone they no longer have.

    `disabledAt` is cleared on every registration: a token FCM previously rejected is alive
    again the moment the app proves it by registering.
    """
    now = db.utc_now()

    device = await db.get_database()[COLLECTION].find_one_and_update(
        {"token": payload.token},
        {
            "$set": {
                "organizationId": auth.organization_id,
                "userId": auth.user_id,
                "platform": payload.platform,
                "lastSeenAt": now,
                "disabledAt": None,
                "disabledReason": None,
            },
            # Only on insert, so re-registering an existing handset does not reset its history.
            "$setOnInsert": {"createdAt": now},
        },
        upsert=True,
        return_document=True,
    )

    # THE TOKEN IS NOT ECHOED BACK. It is a credential for addressing this handset; a response
    # that repeats it puts it in logs, proxies and error trackers for no benefit — the client
    # already has it.
    return {
        "registered": True,
        "platform": (device or {}).get("platform") or payload.platform,
    }


@router.delete("/devices")
async def remove_device(
    payload: RemoveDevice,
    auth: AuthContext = Depends(require_password_changed),
):
    """
    Scoped to the caller's own organisation AND user, so knowing somebody else's token is not
    enough to silence their phone.

    DELIBERATELY 200 WHETHER OR NOT A ROW MATCHED. "This token is not registered for you" and
    "it was, and now is not" are the same state from the caller's point of view, and
    distinguishing them would turn this into an oracle for whether a token exists.
    """
    result = await db.get_database()[COLLECTION].delete_one(
        {
            "organizationId": auth.organization_id,
            "userId": auth.user_id,
            "token": payload.token,
        }
    )

    return {"removed": (result.deleted_count or 0) > 0}


@router.get("/status")
async def push_status(auth: AuthContext = Depends(require_password_changed)):
    """
    Whether push is configured, for the dashboard to explain itself with.

    Behind authentication because the shape of a deployment's configuration is not public, and
    names of missing variables only — never values, never the private key.
    """
    return describe_configuration()
