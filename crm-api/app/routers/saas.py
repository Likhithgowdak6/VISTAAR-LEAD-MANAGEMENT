"""Self-service beta workspaces. Plan changes are deliberately not exposed to tenants."""
import hashlib
import hmac
import secrets
from typing import Any
from bson import ObjectId
from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, ConfigDict, Field, field_validator
from pymongo.errors import DuplicateKeyError
from app import cache, db
from app.config import settings
from app.deps import AuthContext, authenticate, require_permission
from app.permissions import SETTINGS_MANAGE
from app.passwords import hash_password, validate_plain_password
from app.saas import BETA_LIMITS, atomic, ensure_indexes, error, identity_record
from app.serialization import serialize_date
from app.routers.auth import LoginBody, _auth_payload, _create_session, _request_context
from app.auth_cookies import build_refresh_cookie

public_router = APIRouter()
workspace_router = APIRouter()


class Registration(LoginBody):
    model_config = ConfigDict(extra="forbid")
    organizationSlug: str | None = None
    organizationName: str = Field(min_length=2, max_length=120)
    name: str = Field(min_length=2, max_length=120)
    password: str = Field(min_length=12, max_length=72)
    inviteCode: str = Field(default="", max_length=200)

    @field_validator("organizationSlug", mode="before")
    @classmethod
    def require_workspace_address(cls, value):
        if value is None:
            return None
        if not isinstance(value, str) or not value.strip():
            raise ValueError("A workspace address is required.")
        return value

    @field_validator("organizationName", "name", mode="before")
    @classmethod
    def trim(cls, value: Any):
        return value.strip() if isinstance(value, str) else value

    @field_validator("email")
    @classmethod
    def reserved_email(cls, value: str):
        if value == "ai-assistant@internal.local":
            raise ValueError("This email address is reserved.")
        return value

    @field_validator("password")
    @classmethod
    def password_policy(cls, value: str):
        if validate_plain_password(value) or len(value.encode("utf-8")) > 72:
            raise ValueError("Use 12-72 bytes without surrounding spaces.")
        return value


@public_router.get("/signup-options")
async def signup_options():
    return {"data": {"enabled": settings.saas_signup_enabled,
                     "inviteRequired": bool(settings.saas_signup_invite_code),
                     "googleClientId": settings.google_auth_client_id}}


async def signup_limit(request: Request) -> None:
    address = request.client.host if request.client else "unknown"
    key = "saas:signup:" + hashlib.sha256(address.encode()).hexdigest()
    try:
        # Atomic expiry: a worker dying between INCR and EXPIRE cannot leave a permanent lock.
        hits = await cache.get_client().eval(
            "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],3600) end; return n", 1, key)
    except Exception:
        raise error(503, "SIGNUP_UNAVAILABLE", "Workspace creation is temporarily unavailable.") from None
    if int(hits) > 5:
        raise error(429, "SIGNUP_RATE_LIMITED", "Too many workspace creation attempts. Try again later.")


@public_router.post("/register", status_code=201)
async def register(body: Registration, request: Request, response: Response):
    return await provision_workspace(body, request, response)


async def provision_workspace(body: Registration, request: Request, response: Response, google_subject: str | None = None):
    if not settings.saas_signup_enabled:
        raise error(403, "SIGNUP_DISABLED", "New workspace registration is currently closed.")
    await signup_limit(request)
    if settings.saas_signup_invite_code and not hmac.compare_digest(
        body.inviteCode.encode(), settings.saas_signup_invite_code.encode()
    ):
        raise error(403, "INVITE_REQUIRED", "Enter a valid workspace invitation code.")
    await ensure_indexes()
    database = db.get_database()
    now = db.utc_now()
    org_id, user_id = ObjectId(), ObjectId()
    organization = {"_id": org_id, "name": body.organizationName,
                    "slug": body.organizationSlug or "workspace-" + secrets.token_hex(8), "status": "active", "ownerWhatsappNumber": None,
                    "saasManaged": True, "saasPlan": "beta", "saasLimits": dict(BETA_LIMITS),
                    "saasRevision": 0, "ownerUserId": user_id,
                    "businessProfile": {}, "createdAt": now, "updatedAt": now}
    user = {"_id": user_id, "organizationId": org_id, "name": body.name, "email": body.email,
            "passwordHash": hash_password(body.password, settings.bcrypt_rounds),
            "role": "super_admin", "permissionOverrides": {"allow": [], "deny": []},
            "accountAccessMode": "all", "accountAccess": [], "status": "active",
            "mustChangePassword": False, "passwordChangedAt": now, "lastLoginAt": now,
            "createdBy": None, "updatedBy": None, "createdAt": now, "updatedAt": now}
    if google_subject:
        user["googleSubject"] = google_subject
    context = _request_context(request)

    async def provision(session):
        await database.organizations.insert_one(dict(organization), session=session)
        await database.users.insert_one(dict(user), session=session)
        await database.aiknowledges.insert_one(identity_record(org_id, user_id, body.organizationName), session=session)
        result = await _create_session(organization=organization, user=user, context=context, session=session)
        await database.auditlogs.insert_one({"organizationId": org_id, "actorId": user_id,
            "eventType": "WORKSPACE_CREATED", "outcome": "success", "createdAt": now,
            "metadata": {"plan": "beta"}}, session=session)
        return result
    try:
        result = await atomic(provision)
    except DuplicateKeyError:
        raise error(409, "WORKSPACE_SLUG_TAKEN", "This workspace address is already in use.") from None
    response.set_cookie(**build_refresh_cookie(result["refreshToken"]))
    return {"data": _auth_payload(access_token=result["accessToken"], user=user,
                                  organization=organization, session=result["session"])}


class WorkspaceProfile(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=2, max_length=120)
    industry: str = Field(default="", max_length=100)
    timezone: str = Field(default="Asia/Kolkata", max_length=100)

    @field_validator("name", "industry", mode="before")
    @classmethod
    def trim(cls, value):
        return value.strip() if isinstance(value, str) else value

    @field_validator("timezone")
    @classmethod
    def valid_timezone(cls, value):
        from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError("Choose a valid IANA timezone.") from None
        return value


@workspace_router.get("")
async def workspace(auth: AuthContext = Depends(authenticate)):
    database = db.get_database()
    oid = ObjectId(str(auth.organization_id))
    org = await database.organizations.find_one({"_id": oid})
    if not org:
        raise error(404, "WORKSPACE_NOT_FOUND", "Workspace not found.")
    usage = {"users": await database.users.count_documents({"organizationId": oid, "status": "active", "email": {"$ne": "ai-assistant@internal.local"}}),
             "whatsappAccounts": await database.whatsappaccounts.count_documents({"organizationId": oid, "status": {"$ne": "removed"}})}
    profile = org.get("businessProfile") or {}
    connected = await database.whatsappaccounts.count_documents({"organizationId": oid, "status": "active"})
    knowledge = await database.aiknowledges.count_documents({"organizationId": oid, "status": "active", "_id": {"$ne": oid}})
    return {"data": {"id": str(oid), "name": org["name"], "slug": org["slug"],
            "plan": org.get("saasPlan", "legacy"), "billingStatus": "not_configured",
            "limits": org.get("saasLimits") if org.get("saasManaged") else None,
            "usage": usage, "profile": profile, "createdAt": serialize_date(org.get("createdAt")),
            "onboarding": {"businessProfile": bool(profile.get("industry")),
                           "whatsappConnected": connected > 0, "knowledgeAdded": knowledge > 0}}}


@workspace_router.patch("")
async def update_workspace(body: WorkspaceProfile, auth: AuthContext = Depends(require_permission(SETTINGS_MANAGE))):
    database = db.get_database()
    oid = ObjectId(str(auth.organization_id))
    async def save(session):
        result = await database.organizations.update_one(
            {"_id": oid}, {"$set": {"name": body.name, "businessProfile": {
                "industry": body.industry, "timezone": body.timezone}, "updatedAt": db.utc_now()}}, session=session)
        if not result.matched_count:
            raise error(404, "WORKSPACE_NOT_FOUND", "Workspace not found.")
        record = identity_record(oid, auth.user_id, body.name, body.industry)
        mutable = {key: value for key, value in record.items() if key not in ("_id", "createdAt", "createdBy")}
        await database.aiknowledges.update_one({"_id": oid, "organizationId": oid},
            {"$set": mutable, "$setOnInsert": {"createdAt": record["createdAt"], "createdBy": auth.user_id}},
            upsert=True, session=session)
    await atomic(save)
    return await workspace(auth)
