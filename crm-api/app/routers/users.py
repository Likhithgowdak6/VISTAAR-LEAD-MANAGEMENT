"""
User management.

A PORT OF backend/src/modules/users/* — seven routes, and the module that decides what every
other migrated route is allowed to do. `permissionOverrides` written here is the input to
`resolve_user_permissions` in `app/permissions.py`, so a silent change to this module changes
authorization across the whole CRM.

----------------------------------------------------------------------------------------------
THE THREE GUARDS, which are the point of the module
----------------------------------------------------------------------------------------------
`assertTargetUserCanBeManaged` runs before every write to an existing user, IN THIS ORDER, and
the order is observable:

  1. target missing            -> 404 USER_NOT_FOUND
  2. target is super_admin     -> 403 SUPER_ADMIN_CANNOT_BE_MANAGED
  3. target is the actor       -> 400 USER_CANNOT_MANAGE_SELF

Checking self BEFORE super-admin would let a super admin disable themselves, locking the seed
account out of its own organisation. Checking existence last would leak whether an id belongs
to a super admin.

THE SUPER ADMIN IS SEED-ONLY. It cannot be created, assigned or managed through this API, and
there are three separate error codes for those three attempts rather than one, because the
remedy differs each time.

A USER CANNOT MANAGE THEMSELVES AT ALL through these routes - not even to change their own
name. Self-service lives on `/auth/change-password`, which stays in Node until Phase 6.

----------------------------------------------------------------------------------------------
DISABLE AND RESET-PASSWORD REVOKE SESSIONS, AND THAT IS WHY THERE IS A TRANSACTION
----------------------------------------------------------------------------------------------
Flipping `status` without revoking refresh sessions leaves a disabled employee working until
their access token expires, and nothing in the UI shows it. The pair must be atomic. Same for a
password reset: the old sessions must die with the old password.

`deps.authenticate` already refuses a user whose status is not ACTIVE, so the access token is
dead on its next request either way - but the REFRESH session is what would otherwise mint a
new one.

----------------------------------------------------------------------------------------------
THE PASSWORD MINIMUM IS 12 HERE, NOT 8
----------------------------------------------------------------------------------------------
`PASSWORD_POLICY.MIN_LENGTH` is 8, but `createUserBodySchema` spells `z.string().min(12)` and
zod runs first. So the effective API minimum is 12 and `PASSWORD_TOO_SHORT` is unreachable
through these routes - a 10-character password answers `VALIDATION_FAILED`, not
`PASSWORD_TOO_SHORT`. Both checks are ported in the same order anyway; see app/passwords.py.
"""

import re
from typing import Any, Literal

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator, model_validator

from app import audit, db
from app.config import settings
from app.deps import AuthContext, require_permission
from app.passwords import PasswordPolicyError, hash_password, validate_plain_password
from app.permissions import PERMISSION_VALUES, USERS_MANAGE, USERS_READ
from app.request_context import get_request_id
from app.serialization import serialize_date, serialize_id
from app.transactions import run_in_transaction

router = APIRouter()

COLLECTION = "users"
SESSIONS_COLLECTION = "refreshsessions"

ROLE_SUPER_ADMIN = "super_admin"
ROLE_ADMIN = "admin"
ROLE_MANAGER = "manager"
ROLE_STAFF = "staff"
ROLE_VALUES = (ROLE_SUPER_ADMIN, ROLE_ADMIN, ROLE_MANAGER, ROLE_STAFF)

# `super_admin` is absent on purpose: `assignableRoles` filters it out of the zod enum, so the
# API answers VALIDATION_FAILED for it on create, and the service answers
# SUPER_ADMIN_CANNOT_BE_ASSIGNED_BY_API on update. Two different codes for two different paths.
AssignableRole = Literal["admin", "manager", "staff"]
AnyRole = Literal["super_admin", "admin", "manager", "staff"]
UserStatus = Literal["active", "disabled"]
AccountAccessMode = Literal["all", "selected"]

USER_STATUS_ACTIVE = "active"
USER_STATUS_DISABLED = "disabled"
ACCOUNT_ACCESS_ALL = "all"
ACCOUNT_ACCESS_SELECTED = "selected"

SESSION_ACTIVE = "active"
SESSION_REVOKED = "revoked"

NAME_MIN = 2
NAME_MAX = 120
PASSWORD_ROUTE_MIN = 12
PASSWORD_ROUTE_MAX = 128

OBJECT_ID_PATTERN = re.compile(r"^[a-f\d]{24}$", re.IGNORECASE)

# ZOD'S OWN EMAIL REGEX, not pydantic's `EmailStr`.
#
# `EmailStr` needs `email-validator`, which implements RFC 5322 plus deliverability rules and
# therefore accepts and rejects a DIFFERENT set of addresses than zod does. Swapping one
# validator for another mid-migration would silently change which addresses can be registered -
# an admin who could add `name@localhost` yesterday gets a validation error today, or worse the
# reverse. Copying the regex keeps the accepted set identical and adds no dependency.
EMAIL_PATTERN = re.compile(
    r"^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$",
    re.IGNORECASE,
)

_require_read = require_permission(USERS_READ)
_require_manage = require_permission(USERS_MANAGE)

# code -> (status, message). Ported verbatim from USER_MANAGEMENT_ERROR_MAP.
ERROR_MAP: dict[str, tuple[int, str]] = {
    "USER_NOT_FOUND": (404, "User not found."),
    "USER_EMAIL_ALREADY_EXISTS": (409, "A user with this email already exists."),
    "USER_CANNOT_MANAGE_SELF": (400, "You cannot perform this action on your own user."),
    "SUPER_ADMIN_CANNOT_BE_MANAGED": (
        403,
        "The seed-only super admin cannot be managed by this API.",
    ),
    "SUPER_ADMIN_CANNOT_BE_CREATED_BY_API": (
        403,
        "Super admin users can only be created by the seed command.",
    ),
    "SUPER_ADMIN_CANNOT_BE_ASSIGNED_BY_API": (
        403,
        "Super admin role cannot be assigned by this API.",
    ),
    "PASSWORD_REQUIRED": (400, "Password is required."),
    "PASSWORD_TOO_SHORT": (400, "Password is too short."),
    "PASSWORD_TOO_LONG": (400, "Password is too long."),
    "PASSWORD_HAS_SURROUNDING_WHITESPACE": (
        400,
        "Password must not start or end with whitespace.",
    ),
}


def _error(code: str) -> HTTPException:
    status_code, message = ERROR_MAP[code]

    return HTTPException(
        status_code=status_code, detail={"error": {"code": code, "message": message}}
    )


def _object_id_or_none(value: str | None) -> ObjectId | None:
    if not value or not OBJECT_ID_PATTERN.match(value):
        return None

    return ObjectId(value)


def serialize_user(doc: dict[str, Any] | None) -> dict[str, Any] | None:
    """
    `serializeUser`. **There is no `passwordHash` field and there must never be one.**

    `permissionOverrides` is normalised to `{allow: [], deny: []}` rather than passed through,
    matching Node: a document written before the field existed has no key at all, and a client
    doing `user.permissionOverrides.allow.length` would throw on it.
    """
    if not doc:
        return None

    overrides = doc.get("permissionOverrides")
    overrides = overrides if isinstance(overrides, dict) else {}

    access = doc.get("accountAccess")
    access = access if isinstance(access, list) else []

    return {
        "id": serialize_id(doc.get("_id")),
        "organizationId": serialize_id(doc.get("organizationId")),
        "name": doc.get("name"),
        "email": doc.get("email"),
        "role": doc.get("role"),
        "permissionOverrides": {
            "allow": overrides.get("allow") or [],
            "deny": overrides.get("deny") or [],
        },
        "accountAccessMode": doc.get("accountAccessMode"),
        "accountAccess": [serialize_id(item) for item in access],
        "status": doc.get("status"),
        "mustChangePassword": bool(doc.get("mustChangePassword")),
        "passwordChangedAt": serialize_date(doc.get("passwordChangedAt")),
        "lastLoginAt": serialize_date(doc.get("lastLoginAt")),
        "createdBy": serialize_id(doc.get("createdBy")),
        "updatedBy": serialize_id(doc.get("updatedBy")),
        "createdAt": serialize_date(doc.get("createdAt")),
        "updatedAt": serialize_date(doc.get("updatedAt")),
    }


class PermissionOverrides(BaseModel):
    """
    Unknown permission names are REJECTED here, not ignored.

    `resolve_user_permissions` ignores an unknown entry at read time, which is the right
    behaviour for a stale record. Accepting one at WRITE time is different: it stores a typo
    that will silently never grant anything, and the admin sees it listed in the UI as though
    it works.
    """

    allow: list[str] = Field(default_factory=list)
    deny: list[str] = Field(default_factory=list)

    @field_validator("allow", "deny")
    @classmethod
    def _known(cls, value: list[str]) -> list[str]:
        unknown = [item for item in value if item not in PERMISSION_VALUES]

        if unknown:
            raise ValueError(f"Unknown permissions: {', '.join(sorted(unknown))}")

        return value


class CreateUser(BaseModel):
    name: str = Field(min_length=NAME_MIN, max_length=NAME_MAX)
    email: str
    # NOT trimmed: the policy rejects surrounding whitespace rather than silently removing it,
    # so trimming here would accept a password the user cannot then type.
    password: str = Field(min_length=PASSWORD_ROUTE_MIN, max_length=PASSWORD_ROUTE_MAX)
    role: AssignableRole = ROLE_STAFF
    permissionOverrides: PermissionOverrides = Field(default_factory=PermissionOverrides)
    accountAccessMode: AccountAccessMode
    accountAccess: list[str] = Field(default_factory=list)
    mustChangePassword: bool = True

    @field_validator("name", mode="before")
    @classmethod
    def _trim(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value

    @field_validator("email", mode="before")
    @classmethod
    def _email(cls, value: Any) -> Any:
        # zod is `.trim().toLowerCase().email()` - trimmed and lowercased BEFORE validation, so
        # "  Ananya@Example.COM  " is a valid address and is stored lowercased.
        if not isinstance(value, str):
            return value

        normalised = value.strip().lower()

        if not EMAIL_PATTERN.match(normalised):
            raise ValueError("Invalid email")

        return normalised

    @field_validator("accountAccess")
    @classmethod
    def _ids(cls, value: list[str]) -> list[str]:
        if any(not OBJECT_ID_PATTERN.match(item) for item in value):
            raise ValueError("accountAccess entries must be object ids")

        return value


class UpdateUser(BaseModel):
    name: str | None = Field(default=None, min_length=NAME_MIN, max_length=NAME_MAX)
    role: AssignableRole | None = None
    permissionOverrides: PermissionOverrides | None = None
    accountAccessMode: AccountAccessMode | None = None
    accountAccess: list[str] | None = None
    status: UserStatus | None = None
    mustChangePassword: bool | None = None

    @field_validator("name", mode="before")
    @classmethod
    def _trim(cls, value: Any) -> Any:
        return value.strip() if isinstance(value, str) else value

    @field_validator("accountAccess")
    @classmethod
    def _ids(cls, value: list[str] | None) -> list[str] | None:
        if value and any(not OBJECT_ID_PATTERN.match(item) for item in value):
            raise ValueError("accountAccess entries must be object ids")

        return value

    @model_validator(mode="after")
    def _at_least_one(self):
        # zod's `.refine(body => Object.keys(body).length > 0)`. An empty PATCH answering 200
        # with an unchanged record hides a client bug.
        if not self.model_fields_set:
            raise ValueError("At least one field is required.")

        return self


class ResetPassword(BaseModel):
    password: str = Field(min_length=PASSWORD_ROUTE_MIN, max_length=PASSWORD_ROUTE_MAX)
    mustChangePassword: bool = True


async def _find_user(user_id: ObjectId, organization_id: ObjectId) -> dict[str, Any] | None:
    return await db.get_database()[COLLECTION].find_one(
        {"_id": user_id, "organizationId": organization_id}
    )


def _assert_manageable(actor: AuthContext, target: dict[str, Any] | None) -> dict[str, Any]:
    """
    `assertTargetUserCanBeManaged`. THE ORDER IS THE BEHAVIOUR — see the module docstring.
    """
    if not target:
        raise _error("USER_NOT_FOUND")

    if target.get("role") == ROLE_SUPER_ADMIN:
        raise _error("SUPER_ADMIN_CANNOT_BE_MANAGED")

    if str(target["_id"]) == str(actor.user_id):
        raise _error("USER_CANNOT_MANAGE_SELF")

    return target


async def _audit(
    *,
    auth: AuthContext,
    request: Request,
    event_type: str,
    target_user_id: ObjectId,
    reason_code: str,
    session: Any,
    metadata: dict[str, Any] | None = None,
) -> None:
    await audit.create_audit_log(
        organization_id=auth.organization_id,
        event_type=event_type,
        actor_id=auth.user_id,
        target_user_id=target_user_id,
        reason_code=reason_code,
        request_id=get_request_id(request),
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
        # `source` first, then the caller's keys — matching Node's spread order.
        metadata={"source": "user-management", **(metadata or {})},
        # In the SAME transaction as the write it describes.
        session=session,
    )


async def _revoke_sessions(user_id: ObjectId, reason: str, session: Any) -> None:
    """
    `revokeActiveRefreshSessionsForUser`.

    Scoped by `userId` ALONE, not by organization — exactly as Node does. A user belongs to one
    organisation, and a session that somehow carries a different one is precisely the session
    that most needs revoking.
    """
    await db.get_database()[SESSIONS_COLLECTION].update_many(
        {"userId": user_id, "status": SESSION_ACTIVE},
        {
            "$set": {
                "status": SESSION_REVOKED,
                "revokedAt": db.utc_now(),
                "revokeReason": reason,
            }
        },
        session=session,
    )


@router.get("")
async def list_users(
    role: AnyRole | None = Query(default=None),
    status: UserStatus | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    skip: int = Query(default=0, ge=0),
    auth: AuthContext = Depends(_require_read),
):
    query: dict[str, Any] = {"organizationId": auth.organization_id}

    if role:
        query["role"] = role

    if status:
        query["status"] = status

    cursor = (
        db.get_database()[COLLECTION].find(query).sort("createdAt", -1).skip(skip).limit(limit)
    )
    users = [serialize_user(doc) async for doc in cursor]

    return {"data": users, "meta": {"limit": limit, "skip": skip, "count": len(users)}}


@router.get("/{user_id}")
async def get_user(user_id: str, auth: AuthContext = Depends(_require_read)):
    target = _object_id_or_none(user_id)

    if not target:
        raise _error("USER_NOT_FOUND")

    user = await _find_user(target, auth.organization_id)

    if not user:
        raise _error("USER_NOT_FOUND")

    return {"data": serialize_user(user)}


@router.post("", status_code=201)
async def create_user(
    payload: CreateUser,
    request: Request,
    auth: AuthContext = Depends(_require_manage),
):
    # Unreachable through the schema (super_admin is not in the assignable enum), but ported
    # because the service checks it and a future caller may not go through the schema.
    if payload.role == ROLE_SUPER_ADMIN:
        raise _error("SUPER_ADMIN_CANNOT_BE_CREATED_BY_API")

    reason = validate_plain_password(payload.password)

    if reason:
        raise _error(reason)

    email = payload.email.strip().lower()

    existing = await db.get_database()[COLLECTION].find_one(
        {"organizationId": auth.organization_id, "email": email}
    )

    if existing:
        raise _error("USER_EMAIL_ALREADY_EXISTS")

    try:
        password_hash = hash_password(payload.password, settings.bcrypt_rounds)
    except PasswordPolicyError as error:
        raise _error(error.reason_code) from None

    now = db.utc_now()

    # `accountAccess` is FORCED EMPTY when the mode is `all`. Keeping a stale list alongside
    # mode=all would quietly become a restriction the moment someone switched the mode back.
    account_access = (
        []
        if payload.accountAccessMode == ACCOUNT_ACCESS_ALL
        else [ObjectId(item) for item in payload.accountAccess]
    )

    document = {
        "organizationId": auth.organization_id,
        "name": payload.name,
        "email": email,
        "passwordHash": password_hash,
        "role": payload.role,
        "permissionOverrides": {
            "allow": payload.permissionOverrides.allow,
            "deny": payload.permissionOverrides.deny,
        },
        "accountAccessMode": payload.accountAccessMode,
        "accountAccess": account_access,
        "status": USER_STATUS_ACTIVE,
        "mustChangePassword": payload.mustChangePassword,
        "passwordChangedAt": None,
        "lastLoginAt": None,
        "createdBy": auth.user_id,
        "updatedBy": auth.user_id,
        "createdAt": now,
        "updatedAt": now,
    }

    async def body(session: Any) -> dict[str, Any]:
        result = await db.get_database()[COLLECTION].insert_one(document, session=session)
        document["_id"] = result.inserted_id

        await _audit(
            auth=auth,
            request=request,
            event_type="USER_CREATED",
            target_user_id=document["_id"],
            reason_code="user_created",
            session=session,
        )

        return document

    created = await run_in_transaction(body)

    return {"data": serialize_user(created)}


@router.patch("/{user_id}")
async def update_user(
    user_id: str,
    payload: UpdateUser,
    request: Request,
    auth: AuthContext = Depends(_require_manage),
):
    target_id = _object_id_or_none(user_id)

    if not target_id:
        raise _error("USER_NOT_FOUND")

    _assert_manageable(auth, await _find_user(target_id, auth.organization_id))

    update: dict[str, Any] = {"updatedBy": auth.user_id, "updatedAt": db.utc_now()}
    supplied = payload.model_dump(exclude_unset=True)

    if payload.role == ROLE_SUPER_ADMIN:
        raise _error("SUPER_ADMIN_CANNOT_BE_ASSIGNED_BY_API")

    for key in ("name", "role", "accountAccessMode", "status", "mustChangePassword"):
        if key in supplied:
            update[key] = supplied[key]

    if "permissionOverrides" in supplied and payload.permissionOverrides is not None:
        update["permissionOverrides"] = {
            "allow": payload.permissionOverrides.allow,
            "deny": payload.permissionOverrides.deny,
        }

    if "accountAccess" in supplied and payload.accountAccess is not None:
        update["accountAccess"] = [ObjectId(item) for item in payload.accountAccess]

    # Same rule as create, and it applies even when only the MODE was sent.
    if supplied.get("accountAccessMode") == ACCOUNT_ACCESS_ALL:
        update["accountAccess"] = []

    async def body(session: Any) -> dict[str, Any] | None:
        updated = await db.get_database()[COLLECTION].find_one_and_update(
            {"_id": target_id, "organizationId": auth.organization_id},
            {"$set": update},
            return_document=True,
            session=session,
        )

        await _audit(
            auth=auth,
            request=request,
            event_type="USER_UPDATED",
            target_user_id=target_id,
            reason_code="user_updated",
            session=session,
            # The field NAMES the caller sent, never their values. A permission change is
            # interesting; recording the new password-change flag's value is noise, and
            # recording values is how an audit log grows a copy of the data it audits.
            metadata={"updatedFields": sorted(supplied.keys())},
        )

        return updated

    return {"data": serialize_user(await run_in_transaction(body))}


async def _set_status(
    *,
    user_id: str,
    request: Request,
    auth: AuthContext,
    status: str,
    event_type: str,
    reason_code: str,
    revoke: bool,
):
    target_id = _object_id_or_none(user_id)

    if not target_id:
        raise _error("USER_NOT_FOUND")

    _assert_manageable(auth, await _find_user(target_id, auth.organization_id))

    async def body(session: Any) -> dict[str, Any] | None:
        updated = await db.get_database()[COLLECTION].find_one_and_update(
            {"_id": target_id, "organizationId": auth.organization_id},
            {"$set": {"status": status, "updatedBy": auth.user_id, "updatedAt": db.utc_now()}},
            return_document=True,
            session=session,
        )

        if revoke:
            # In the SAME transaction. A disabled user whose refresh sessions survive keeps
            # minting access tokens, and nothing in the UI shows it.
            await _revoke_sessions(target_id, reason_code, session)

        await _audit(
            auth=auth,
            request=request,
            event_type=event_type,
            target_user_id=target_id,
            reason_code=reason_code,
            session=session,
        )

        return updated

    return {"data": serialize_user(await run_in_transaction(body))}


@router.patch("/{user_id}/disable")
async def disable_user(
    user_id: str, request: Request, auth: AuthContext = Depends(_require_manage)
):
    return await _set_status(
        user_id=user_id,
        request=request,
        auth=auth,
        status=USER_STATUS_DISABLED,
        event_type="USER_DISABLED",
        reason_code="user_disabled",
        revoke=True,
    )


@router.patch("/{user_id}/enable")
async def enable_user(
    user_id: str, request: Request, auth: AuthContext = Depends(_require_manage)
):
    # NO session revocation on enable — there is nothing to revoke, and re-enabling must not
    # log out sessions created since.
    return await _set_status(
        user_id=user_id,
        request=request,
        auth=auth,
        status=USER_STATUS_ACTIVE,
        event_type="USER_ENABLED",
        reason_code="user_enabled",
        revoke=False,
    )


@router.patch("/{user_id}/reset-password")
async def reset_user_password(
    user_id: str,
    payload: ResetPassword,
    request: Request,
    auth: AuthContext = Depends(_require_manage),
):
    target_id = _object_id_or_none(user_id)

    if not target_id:
        raise _error("USER_NOT_FOUND")

    _assert_manageable(auth, await _find_user(target_id, auth.organization_id))

    reason = validate_plain_password(payload.password)

    if reason:
        raise _error(reason)

    try:
        password_hash = hash_password(payload.password, settings.bcrypt_rounds)
    except PasswordPolicyError as error:
        raise _error(error.reason_code) from None

    async def body(session: Any) -> dict[str, Any] | None:
        updated = await db.get_database()[COLLECTION].find_one_and_update(
            {"_id": target_id, "organizationId": auth.organization_id},
            {
                "$set": {
                    "passwordHash": password_hash,
                    "mustChangePassword": payload.mustChangePassword,
                    "passwordChangedAt": db.utc_now(),
                    "updatedBy": auth.user_id,
                    "updatedAt": db.utc_now(),
                }
            },
            return_document=True,
            session=session,
        )

        # The old sessions must die with the old password.
        await _revoke_sessions(target_id, "password_reset", session)

        await _audit(
            auth=auth,
            request=request,
            event_type="USER_PASSWORD_RESET",
            target_user_id=target_id,
            reason_code="password_reset",
            session=session,
        )

        return updated

    return {"data": serialize_user(await run_in_transaction(body))}
