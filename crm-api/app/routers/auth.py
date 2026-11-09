"""
The auth routes — login, refresh, logout, logout-all, me, change-password.

A PORT OF backend/src/modules/auth/*.

THIS IS THE PHASE THAT CHANGES THE TRUST MODEL. Python now ISSUES access tokens, so a session
created here is read by `auth.middleware.ts` on the very next Node-served request. Both
services must agree about the claim set, the refresh-token hash and the cookie attributes, or
a user signs in successfully and is thrown out on their first refresh.

----------------------------------------------------------------------------------------------
REFRESH-TOKEN REUSE IS TREATED AS A BREACH, NOT AS AN ERROR
----------------------------------------------------------------------------------------------
A rotated token presented a second time means either a stolen token or a duplicated client. The
honest response is to assume the former: the ENTIRE FAMILY is revoked, not just that session,
so whoever holds the stolen copy and the legitimate user are both logged out and the user is
forced to sign in again. Revoking only the presented session would leave the thief's newer
token working.

----------------------------------------------------------------------------------------------
EVERY FAILURE PATH ANSWERS THE SAME THING
----------------------------------------------------------------------------------------------
Unknown organisation, unknown user and wrong password all answer **401 INVALID_CREDENTIALS**
with the same message — and all three pay the cost of a bcrypt verification, against a decoy
hash when there is no real one. Skipping the hash for an unknown account returns far faster and
lets an attacker enumerate valid emails by response time while every response says the same
thing.

STATUS CHECKS COME AFTER THE PASSWORD CHECK, deliberately. Telling someone "this organisation
is suspended" before they have proved they belong to it hands out information about accounts
they may not own.
"""

import re
from datetime import datetime, timezone
from typing import Any

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator

from app import audit, db
from app.auth_cookies import build_clear_refresh_cookie, build_refresh_cookie, read_refresh_token
from app.config import settings
from app.deps import AuthContext, authenticate
from app.login_rate_limit import check_login_rate_limit, clear_login_rate_limit
from app.passwords import (
    PasswordPolicyError,
    hash_password,
    validate_plain_password,
    verify_password,
)
from app.permissions import resolve_user_permissions
from app.request_context import get_request_id
from app.routers.users import serialize_user
from app.serialization import serialize_date, serialize_id
from app.tokens import (
    generate_refresh_token,
    hash_refresh_token,
    refresh_token_expires_at,
    sign_access_token,
)
from app.transactions import run_in_transaction

router = APIRouter()

USERS = "users"
ORGANIZATIONS = "organizations"
SESSIONS = "refreshsessions"

DEFAULT_ORGANIZATION_SLUG = "vistaar-media"

SESSION_ACTIVE = "active"
SESSION_ROTATED = "rotated"
SESSION_REVOKED = "revoked"
SESSION_EXPIRED = "expired"

ORGANIZATION_ACTIVE = "active"
USER_ACTIVE = "active"

SLUG_PATTERN = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
EMAIL_PATTERN = re.compile(
    r"^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$",
    re.IGNORECASE,
)

# A hash no submitted password can match, so an unknown account costs the same as a real one.
# Built once per process, exactly as Node memoises it.
_DECOY_PASSWORD = "decoy-password-that-is-never-a-valid-credential"
_decoy_hash: str | None = None


def _decoy() -> str:
    global _decoy_hash

    if _decoy_hash is None:
        _decoy_hash = hash_password(_DECOY_PASSWORD, settings.bcrypt_rounds)

    return _decoy_hash


def verify_password_or_decoy(password: str | None, password_hash: str | None) -> bool:
    """
    `verifyPasswordOrDecoy`.

    Skipping bcrypt for an unknown account would return far faster than a real check, letting an
    attacker tell valid accounts from invalid ones by response time even though both return the
    same error. Hashing against a decoy keeps the two paths equally expensive.
    """
    if not password_hash:
        verify_password(password or _DECOY_PASSWORD, _decoy())

        return False

    return verify_password(password, password_hash)


def _error(status_code: int, code: str, message: str, details: Any = None) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={"error": {"code": code, "message": message, "details": details}},
    )


def _invalid_credentials() -> HTTPException:
    return _error(401, "INVALID_CREDENTIALS", "Invalid email or password.")


def serialize_refresh_session(doc: dict[str, Any] | None) -> dict[str, Any] | None:
    """`serializeRefreshSession`. **`tokenHash` is absent and must stay absent.**"""
    if not doc:
        return None

    return {
        "id": serialize_id(doc.get("_id")),
        "organizationId": serialize_id(doc.get("organizationId")),
        "userId": serialize_id(doc.get("userId")),
        "familyId": serialize_id(doc.get("familyId")),
        "status": doc.get("status"),
        "expiresAt": serialize_date(doc.get("expiresAt")),
        "lastUsedAt": serialize_date(doc.get("lastUsedAt")),
        "rotatedAt": serialize_date(doc.get("rotatedAt")),
        "revokedAt": serialize_date(doc.get("revokedAt")),
        "revokeReason": doc.get("revokeReason"),
        "replacedBySessionId": serialize_id(doc.get("replacedBySessionId")),
        "createdByIp": doc.get("createdByIp"),
        "lastUsedByIp": doc.get("lastUsedByIp"),
        "userAgent": doc.get("userAgent"),
        "reuseDetectedAt": serialize_date(doc.get("reuseDetectedAt")),
        "createdAt": serialize_date(doc.get("createdAt")),
    }


def serialize_organization(doc: dict[str, Any] | None) -> dict[str, Any] | None:
    if not doc:
        return None

    return {
        "id": serialize_id(doc.get("_id")),
        "name": doc.get("name"),
        "slug": doc.get("slug"),
        "status": doc.get("status"),
        "createdAt": serialize_date(doc.get("createdAt")),
        "updatedAt": serialize_date(doc.get("updatedAt")),
    }


def _auth_payload(
    *, access_token: str, user: dict, organization: dict, session: dict
) -> dict[str, Any]:
    return {
        "accessToken": access_token,
        "tokenType": "Bearer",
        "organization": serialize_organization(organization),
        "user": serialize_user(user),
        "permissions": resolve_user_permissions(user),
        "session": serialize_refresh_session(session),
    }


def _request_context(request: Request) -> dict[str, Any]:
    return {
        "requestId": get_request_id(request),
        "ipAddress": request.client.host if request.client else None,
        "userAgent": request.headers.get("user-agent"),
    }


async def _safe_audit(**kwargs: Any) -> None:
    """
    An audit write must never fail a login.

    Node wraps these in `createSafeAuditLog` for the same reason: a logging outage that stopped
    everybody signing in would be a far worse incident than a missing audit row. The user
    management paths deliberately do NOT do this — there, an unlogged change is the problem.
    """
    try:
        await audit.create_audit_log(**kwargs)
    except Exception:  # noqa: BLE001
        pass


async def _create_session(
    *,
    organization: dict,
    user: dict,
    context: dict[str, Any],
    family_id: ObjectId | None = None,
    session: Any = None,
) -> dict[str, Any]:
    """One refresh session plus the access token that points at it."""
    refresh_token = generate_refresh_token()
    now = db.utc_now()

    document = {
        "_id": ObjectId(),
        "organizationId": organization["_id"],
        "userId": user["_id"],
        "familyId": family_id or ObjectId(),
        # ONLY the hash is stored. A database dump yields no usable refresh tokens.
        "tokenHash": hash_refresh_token(refresh_token),
        "status": SESSION_ACTIVE,
        "expiresAt": refresh_token_expires_at(now),
        "lastUsedAt": None,
        "rotatedAt": None,
        "revokedAt": None,
        "revokeReason": None,
        "replacedBySessionId": None,
        "createdByIp": context.get("ipAddress"),
        "lastUsedByIp": context.get("ipAddress"),
        "userAgent": context.get("userAgent"),
        "reuseDetectedAt": None,
        "createdAt": now,
    }

    await db.get_database()[SESSIONS].insert_one(document, session=session)

    access_token = sign_access_token(
        user_id=user["_id"],
        session_id=document["_id"],
        organization_id=organization["_id"],
    )

    return {"refreshToken": refresh_token, "accessToken": access_token, "session": document}


# ---------------------------------------------------------------------------------------------
# Bodies
# ---------------------------------------------------------------------------------------------


class LoginBody(BaseModel):
    organizationSlug: str = DEFAULT_ORGANIZATION_SLUG
    email: str
    password: str = Field(min_length=1)

    @field_validator("organizationSlug", mode="before")
    @classmethod
    def _slug(cls, value: Any) -> Any:
        if value is None:
            return DEFAULT_ORGANIZATION_SLUG

        normalised = str(value).strip().lower()

        if not 2 <= len(normalised) <= 120 or not SLUG_PATTERN.match(normalised):
            raise ValueError("Invalid organization slug")

        return normalised

    @field_validator("email", mode="before")
    @classmethod
    def _email(cls, value: Any) -> Any:
        normalised = str(value or "").strip().lower()

        if not EMAIL_PATTERN.match(normalised):
            raise ValueError("Invalid email")

        return normalised


class ChangePasswordBody(BaseModel):
    currentPassword: str = Field(min_length=1)
    newPassword: str = Field(min_length=1, max_length=128)


# ---------------------------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------------------------


@router.post("/login")
async def login(body: LoginBody, request: Request, response: Response):
    context = _request_context(request)
    database = db.get_database()

    limit = await check_login_rate_limit(
        email=body.email, ip_address=context.get("ipAddress")
    )

    if limit["limited"]:
        raise _error(
            429,
            "AUTH_LOGIN_RATE_LIMITED",
            "Too many login attempts. Please try again later.",
            {"retryAfterSeconds": limit["retryAfterSeconds"]},
        )

    organization = await database[ORGANIZATIONS].find_one({"slug": body.organizationSlug})

    if not organization:
        # Match the cost of a real verification so an unknown slug is not distinguishable by
        # response time.
        verify_password_or_decoy(body.password, None)

        raise _invalid_credentials()

    user = await database[USERS].find_one(
        {"organizationId": organization["_id"], "email": body.email}
    )

    password_matches = verify_password_or_decoy(
        body.password, user.get("passwordHash") if user else None
    )

    if not user or not password_matches:
        await _safe_audit(
            organization_id=organization["_id"],
            event_type="AUTH_LOGIN_FAILED",
            outcome=audit.AUDIT_OUTCOME_FAILURE,
            reason_code="invalid_credentials",
            request_id=context.get("requestId"),
            ip_address=context.get("ipAddress"),
            user_agent=context.get("userAgent"),
            metadata={"source": "auth-login"},
        )

        raise _invalid_credentials()

    # Status checks come AFTER the password check - see the module docstring.
    for condition, code, message, reason in (
        (
            organization.get("status") != ORGANIZATION_ACTIVE,
            "ORGANIZATION_NOT_ACTIVE",
            "Organization is not active.",
            "organization_not_active",
        ),
        (
            user.get("status") != USER_ACTIVE,
            "USER_NOT_ACTIVE",
            "User is not active.",
            "user_not_active",
        ),
    ):
        if condition:
            await _safe_audit(
                organization_id=organization["_id"],
                event_type="AUTH_LOGIN_FAILED",
                target_user_id=user["_id"],
                outcome=audit.AUDIT_OUTCOME_FAILURE,
                reason_code=reason,
                request_id=context.get("requestId"),
                ip_address=context.get("ipAddress"),
                user_agent=context.get("userAgent"),
                metadata={"source": "auth-login"},
            )

            raise _error(403, code, message)

    async def body_fn(transaction: Any) -> dict[str, Any]:
        created = await _create_session(
            organization=organization, user=user, context=context, session=transaction
        )

        updated = await database[USERS].find_one_and_update(
            {"_id": user["_id"], "organizationId": organization["_id"]},
            {"$set": {"lastLoginAt": db.utc_now()}},
            return_document=True,
            session=transaction,
        )

        await _safe_audit(
            organization_id=organization["_id"],
            event_type="AUTH_LOGIN_SUCCEEDED",
            actor_id=user["_id"],
            target_user_id=user["_id"],
            session_id=created["session"]["_id"],
            reason_code="login_success",
            request_id=context.get("requestId"),
            ip_address=context.get("ipAddress"),
            user_agent=context.get("userAgent"),
            metadata={"source": "auth-login"},
            session=transaction,
        )

        return {**created, "user": updated or user}

    result = await run_in_transaction(body_fn)

    await clear_login_rate_limit(email=body.email, ip_address=context.get("ipAddress"))

    response.set_cookie(**build_refresh_cookie(result["refreshToken"]))

    return {
        "data": _auth_payload(
            access_token=result["accessToken"],
            user=result["user"],
            organization=organization,
            session=result["session"],
        )
    }


@router.post("/refresh")
async def refresh(request: Request, response: Response):
    context = _request_context(request)
    database = db.get_database()
    refresh_token = read_refresh_token(request)

    if not refresh_token:
        raise _error(401, "REFRESH_TOKEN_MISSING", "Refresh token is required.")

    existing = await database[SESSIONS].find_one(
        {"tokenHash": hash_refresh_token(refresh_token)}
    )

    if not existing:
        raise _error(401, "REFRESH_SESSION_NOT_FOUND", "Refresh session is not valid.")

    if existing.get("status") != SESSION_ACTIVE:
        if existing.get("status") == SESSION_ROTATED:
            # REUSE OF A ROTATED TOKEN. Either a stolen token or a duplicated client, and the
            # honest response is to assume the former: revoke the whole FAMILY so the thief's
            # newer token dies with the legitimate user's.
            await database[SESSIONS].update_many(
                {"familyId": existing["familyId"], "status": SESSION_ACTIVE},
                {
                    "$set": {
                        "status": SESSION_REVOKED,
                        "revokedAt": db.utc_now(),
                        "revokeReason": "refresh_token_reuse_detected",
                        "reuseDetectedAt": db.utc_now(),
                    }
                },
            )

            await _safe_audit(
                organization_id=existing["organizationId"],
                event_type="AUTH_REFRESH_REUSE_DETECTED",
                target_user_id=existing["userId"],
                session_id=existing["_id"],
                outcome=audit.AUDIT_OUTCOME_FAILURE,
                reason_code="refresh_token_reuse_detected",
                request_id=context.get("requestId"),
                ip_address=context.get("ipAddress"),
                user_agent=context.get("userAgent"),
                metadata={"source": "auth-refresh"},
            )

        raise _error(401, "REFRESH_SESSION_NOT_ACTIVE", "Refresh session is not active.")

    expires_at = existing.get("expiresAt")
    expires_at = (
        expires_at.replace(tzinfo=timezone.utc)
        if expires_at and expires_at.tzinfo is None
        else expires_at
    )

    if expires_at and expires_at <= datetime.now(timezone.utc):
        await database[SESSIONS].update_one(
            {"_id": existing["_id"]}, {"$set": {"status": SESSION_EXPIRED}}
        )

        raise _error(401, "REFRESH_SESSION_EXPIRED", "Refresh session has expired.")

    organization = await database[ORGANIZATIONS].find_one({"_id": existing["organizationId"]})
    user = await database[USERS].find_one({"_id": existing["userId"]})

    async def revoke(reason: str) -> None:
        await database[SESSIONS].update_one(
            {"_id": existing["_id"]},
            {
                "$set": {
                    "status": SESSION_REVOKED,
                    "revokedAt": db.utc_now(),
                    "revokeReason": reason,
                }
            },
        )

    if not organization or organization.get("status") != ORGANIZATION_ACTIVE:
        await revoke("organization_not_active")

        raise _error(401, "ORGANIZATION_NOT_ACTIVE", "Organization is not active.")

    if not user or user.get("status") != USER_ACTIVE:
        await revoke("user_not_active")

        raise _error(401, "USER_NOT_ACTIVE", "User is not active.")

    async def body_fn(transaction: Any) -> dict[str, Any]:
        created = await _create_session(
            organization=organization,
            user=user,
            context=context,
            # THE FAMILY IS CARRIED FORWARD, which is what makes reuse detectable at all: every
            # token descended from one login shares it.
            family_id=existing["familyId"],
            session=transaction,
        )

        await database[SESSIONS].update_one(
            {"_id": existing["_id"]},
            {
                "$set": {
                    "status": SESSION_ROTATED,
                    "rotatedAt": db.utc_now(),
                    "lastUsedAt": db.utc_now(),
                    "lastUsedByIp": context.get("ipAddress"),
                    "replacedBySessionId": created["session"]["_id"],
                }
            },
            session=transaction,
        )

        return created

    result = await run_in_transaction(body_fn)

    response.set_cookie(**build_refresh_cookie(result["refreshToken"]))

    return {
        "data": _auth_payload(
            access_token=result["accessToken"],
            user=user,
            organization=organization,
            session=result["session"],
        )
    }


@router.post("/logout")
async def logout(request: Request, response: Response):
    """
    Always 200, even with no cookie or an unknown token.

    Logging out is not an operation that can usefully fail: telling a caller "that session did
    not exist" leaks whether a token was real, and leaves a client that believes it is still
    signed in.
    """
    refresh_token = read_refresh_token(request)

    if refresh_token:
        await db.get_database()[SESSIONS].update_one(
            {"tokenHash": hash_refresh_token(refresh_token), "status": SESSION_ACTIVE},
            {
                "$set": {
                    "status": SESSION_REVOKED,
                    "revokedAt": db.utc_now(),
                    "revokeReason": "logout",
                }
            },
        )

    response.delete_cookie(
        **{
            key: value
            for key, value in build_clear_refresh_cookie().items()
            if key in {"key", "path", "secure", "httponly", "samesite"}
        }
    )

    return {"data": {"loggedOut": True}}


@router.post("/logout-all")
async def logout_all(
    request: Request, response: Response, auth: AuthContext = Depends(authenticate)
):
    """Every session for this user, including the one making the request."""
    result = await db.get_database()[SESSIONS].update_many(
        {"userId": auth.user_id, "status": SESSION_ACTIVE},
        {
            "$set": {
                "status": SESSION_REVOKED,
                "revokedAt": db.utc_now(),
                "revokeReason": "logout_all",
            }
        },
    )

    response.delete_cookie(
        **{
            key: value
            for key, value in build_clear_refresh_cookie().items()
            if key in {"key", "path", "secure", "httponly", "samesite"}
        }
    )

    return {"data": {"loggedOut": True, "revokedSessions": result.modified_count}}


@router.get("/me")
async def me(auth: AuthContext = Depends(authenticate)):
    """
    Deliberately NOT behind `require_password_changed`: a user who must change their password
    still has to be able to read their own profile in order to be told so.
    """
    return {
        "data": {
            "user": serialize_user(auth.user),
            "organization": serialize_organization(auth.organization),
            "permissions": auth.permissions,
            "session": serialize_refresh_session(auth.session),
        }
    }


@router.post("/change-password")
async def change_password(
    body: ChangePasswordBody,
    request: Request,
    response: Response,
    auth: AuthContext = Depends(authenticate),
):
    """
    NOT behind `require_password_changed` — this is how a forced change is satisfied.

    THE CURRENT SESSION SURVIVES. Every OTHER session is revoked, because a password change is
    how a user responds to a suspected compromise and the point is to evict whoever else is
    signed in. Revoking this one too would log the user out of the act of securing their own
    account.
    """
    context = _request_context(request)
    database = db.get_database()

    if not verify_password(body.currentPassword, auth.user.get("passwordHash")):
        raise _error(401, "INVALID_CURRENT_PASSWORD", "Current password is incorrect.")

    reason = validate_plain_password(body.newPassword)

    if reason:
        raise _error(400, reason, "The new password is not acceptable.")

    # Refusing the same password is the point of the check: a forced change that accepts the
    # current password satisfies nothing.
    if verify_password(body.newPassword, auth.user.get("passwordHash")):
        raise _error(400, "PASSWORD_REUSED", "The new password must be different.")

    try:
        password_hash = hash_password(body.newPassword, settings.bcrypt_rounds)
    except PasswordPolicyError as error:
        raise _error(400, error.reason_code, "The new password is not acceptable.") from None

    async def body_fn(transaction: Any) -> None:
        await database[USERS].update_one(
            {"_id": auth.user_id},
            {
                "$set": {
                    "passwordHash": password_hash,
                    "mustChangePassword": False,
                    "passwordChangedAt": db.utc_now(),
                }
            },
            session=transaction,
        )

        await database[SESSIONS].update_many(
            {
                "userId": auth.user_id,
                "status": SESSION_ACTIVE,
                # The session that authenticated this change stays alive.
                "_id": {"$ne": auth.session.get("_id")},
            },
            {
                "$set": {
                    "status": SESSION_REVOKED,
                    "revokedAt": db.utc_now(),
                    "revokeReason": "password_changed",
                }
            },
            session=transaction,
        )

        await _safe_audit(
            organization_id=auth.organization_id,
            event_type="AUTH_PASSWORD_CHANGED",
            actor_id=auth.user_id,
            target_user_id=auth.user_id,
            session_id=auth.session.get("_id"),
            reason_code="password_changed",
            request_id=context.get("requestId"),
            ip_address=context.get("ipAddress"),
            user_agent=context.get("userAgent"),
            metadata={"source": "auth-change-password"},
            session=transaction,
        )

    await run_in_transaction(body_fn)

    return {"data": {"passwordChanged": True}}
