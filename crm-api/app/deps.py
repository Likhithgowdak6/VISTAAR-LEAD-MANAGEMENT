"""
The authenticated request, as FastAPI dependencies.

A PORT OF backend/src/middleware/auth.middleware.ts, and the piece every protected route in
every later phase depends on. Phase 0 proved Python could verify a Node-signed token; that is
only the first of six things `authenticateRequest` does, and the other five are what actually
decide whether a request is allowed.

THE FULL CHAIN, in Node's order, because each step can reject and the ORDER of rejection is
part of the observable behaviour:

  1. bearer token present            -> 401 AUTH_TOKEN_MISSING
  2. token verifies                  -> 401 AUTH_TOKEN_INVALID
  3. organization exists and ACTIVE  -> 401 ORGANIZATION_NOT_ACTIVE
  4. user exists and ACTIVE          -> 401 USER_NOT_ACTIVE
  5. session matches user AND org    -> 401 SESSION_NOT_ACTIVE
  6. session is active, or is ROTATED with a live sibling in its family
  7. permissions resolved from the user record

THE ROTATED-SESSION CASE IS NOT AN EDGE CASE. Refresh tokens rotate in normal use, so a user
whose session rotated between issuing an access token and using it holds a token pointing at a
superseded row. Node walks to the active sibling by `familyId`; without that, every ordinary
refresh would log the user out the moment they touched a Python route - which would look like
Python breaking authentication rather than like a missing lookup.

ORG AND USER ARE CHECKED BEFORE THE SESSION, deliberately. A suspended organisation should be
told its organisation is inactive, not handed a session error that sends the owner looking in
the wrong place.

PYTHON NEVER ISSUES A TOKEN. Node remains the only signer until the auth ROUTES migrate; this
file verifies. One signer means one place the rules live.
"""

from typing import Any

from bson import ObjectId
from fastapi import Depends, HTTPException, Request

from app import db
from app.auth import InvalidAccessToken, verify_access_token
from app.permissions import resolve_user_permissions

# Matching the Node constants. Any other value means not usable.
ORGANIZATION_ACTIVE = "active"
USER_ACTIVE = "active"
SESSION_ACTIVE = "active"
SESSION_ROTATED = "rotated"


class AuthContext:
    """What Node puts on `req.auth`, carried the same way."""

    __slots__ = ("user", "organization", "session", "permissions")

    def __init__(
        self,
        user: dict[str, Any],
        organization: dict[str, Any],
        session: dict[str, Any],
        permissions: list[str],
    ) -> None:
        self.user = user
        self.organization = organization
        self.session = session
        self.permissions = permissions

    @property
    def user_id(self) -> ObjectId:
        return self.user["_id"]

    @property
    def organization_id(self) -> ObjectId:
        return self.organization["_id"]

    def has_permission(self, permission: str) -> bool:
        return permission in self.permissions

    def require_permission(self, permission: str) -> None:
        if not self.has_permission(permission):
            raise HTTPException(
                status_code=403,
                detail={
                    "error": {
                        "code": "FORBIDDEN",
                        "message": "You do not have permission to perform this action.",
                        "details": None,
                    }
                },
            )


# EVERY 401 FROM THIS CHAIN CARRIES THE SAME MESSAGE, and that is Node's behaviour, not a
# simplification. `authenticateRequest` wraps its whole body in a try/catch: the specific errors
# it throws are caught and re-emitted with `code: getErrorCode(error)` preserved but the message
# replaced by this one. So the CODE is specific and the MESSAGE never is.
#
# Found by the response-comparison harness, not by the tests - `test_deps.py` asserted on
# `error.code` and never looked at `error.message`, so six wrong messages passed 24 tests.
AUTHENTICATION_FAILED_MESSAGE = "Authentication failed."


def _unauthorized(code: str) -> HTTPException:
    """
    Node's error envelope, reproduced.

    The body shape is part of the API: the React client reads `error.code` to decide whether to
    attempt a refresh, so a FastAPI default `{"detail": ...}` would silently break that.
    """
    return HTTPException(
        status_code=401,
        detail={"error": {"code": code, "message": AUTHENTICATION_FAILED_MESSAGE}},
    )


def _bearer_token(request: Request) -> str | None:
    """
    CASE-SENSITIVE on purpose. Node's `getBearerToken` tests `startsWith('Bearer ')`, so a
    client sending `bearer abc` is treated as having sent no token at all.

    Accepting the lowercase form here would be the friendlier choice and the wrong one: the same
    request would succeed on a Python-served route and 401 on a Node-served one, and with the
    API split across two services for several more phases that is a difference someone would
    eventually have to debug from the outside.
    """
    header = request.headers.get("authorization") or ""
    prefix = "Bearer "

    if not header.startswith(prefix):
        return None

    token = header[len(prefix) :].strip()

    return token or None


async def _object_id(value: Any) -> ObjectId | None:
    try:
        return ObjectId(str(value))
    except Exception:  # noqa: BLE001 - a malformed id is simply not found
        return None


async def authenticate(request: Request) -> AuthContext:
    """The dependency protected routes declare. Raises 401 exactly where Node does."""
    token = _bearer_token(request)

    if not token:
        raise _unauthorized("AUTH_TOKEN_MISSING")

    try:
        claims = verify_access_token(token)
    except InvalidAccessToken:
        raise _unauthorized("AUTH_TOKEN_INVALID") from None

    database = db.get_database()

    user_id = await _object_id(claims.user_id)
    organization_id = await _object_id(claims.organization_id)
    session_id = await _object_id(claims.session_id)

    if not user_id or not organization_id or not session_id:
        # A well-signed token whose claims are not ids is not one of ours.
        raise _unauthorized("AUTH_TOKEN_INVALID")

    organization = await database.organizations.find_one({"_id": organization_id})

    if not organization or organization.get("status") != ORGANIZATION_ACTIVE:
        raise _unauthorized("ORGANIZATION_NOT_ACTIVE")

    user = await database.users.find_one({"_id": user_id})

    if not user or user.get("status") != USER_ACTIVE:
        raise _unauthorized("USER_NOT_ACTIVE")

    session = await database.refreshsessions.find_one({"_id": session_id})

    # The session must belong to BOTH. Either alone would let a token survive a user moving
    # organisation, which is exactly the boundary this is here to hold.
    if (
        not session
        or str(session.get("userId")) != str(user["_id"])
        or str(session.get("organizationId")) != str(organization["_id"])
    ):
        raise _unauthorized("SESSION_NOT_ACTIVE")

    active_session = session

    if session.get("status") == SESSION_ROTATED:
        # Ordinary refresh rotation, not an attack. Walk to the live sibling.
        active_session = await database.refreshsessions.find_one(
            {
                "familyId": session.get("familyId"),
                "userId": user["_id"],
                "organizationId": organization["_id"],
                "status": SESSION_ACTIVE,
            }
        )
    elif session.get("status") != SESSION_ACTIVE:
        active_session = None

    if not active_session:
        raise _unauthorized("SESSION_NOT_ACTIVE")

    return AuthContext(
        user=user,
        organization=organization,
        session=active_session,
        permissions=resolve_user_permissions(user),
    )


async def require_password_changed(
    auth: AuthContext = Depends(authenticate),
) -> AuthContext:
    """
    A temporary password must be replaced before anything else is reachable.

    403, not 401: the caller IS authenticated, and answering 401 would send the client into a
    refresh loop it can never satisfy.
    """
    if auth.user.get("mustChangePassword"):
        raise HTTPException(
            status_code=403,
            detail={
                "error": {
                    "code": "PASSWORD_CHANGE_REQUIRED",
                    "message": "You must change your password before using the application.",
                }
            },
        )

    return auth


def _denied(details: dict[str, Any]) -> HTTPException:
    """
    Node's 403, INCLUDING `details`.

    The details payload is not decoration. `requirePermissions` sends
    `{requiredPermissions: [...]}` and `requireAnyPermission` sends
    `{requiredAnyPermissions: [...]}`, and the two are distinguishable - which is the only way a
    caller can tell "you need all of these" from "you need one of these". Omitting them would be
    a quiet reduction in what the API says, and the response-comparison harness treats a key
    present in Node and absent in Python as a difference, correctly.
    """
    return HTTPException(
        status_code=403,
        detail={
            "error": {
                "code": "PERMISSION_DENIED",
                "message": "You do not have permission to perform this action.",
                "details": details,
            }
        },
    )


def require_permission(*permissions: str):
    """
    Builds a dependency demanding EVERY listed permission.

    Stacked ON TOP of `require_password_changed` rather than beside it, so the three checks
    always run in Node's order: authenticated, then password current, then permitted.
    """

    async def dependency(auth: AuthContext = Depends(require_password_changed)) -> AuthContext:
        if not all(permission in auth.permissions for permission in permissions):
            raise _denied({"requiredPermissions": list(permissions)})

        return auth

    return dependency


def require_any_permission(*permissions: str):
    """
    Builds a dependency demanding AT LEAST ONE of the listed permissions.

    A separate gate, not a convenience over the one above. `requireConversationsRead` accepts
    either `conversations.read_assigned` or `conversations.read_all`, because a staff member who
    can only see their own leads can still read a conversation - collapsing this into "all of"
    would lock every staff user out of the inbox.
    """

    async def dependency(auth: AuthContext = Depends(require_password_changed)) -> AuthContext:
        if not any(permission in auth.permissions for permission in permissions):
            raise _denied({"requiredAnyPermissions": list(permissions)})

        return auth

    return dependency
