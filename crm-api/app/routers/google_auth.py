"""Google Identity Services: verified ID tokens, browser-bound nonce, and tenant selection."""
import hashlib
import json
import secrets
import hmac
import httpx
import jwt
from bson import ObjectId
from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, Field, ConfigDict
from app import cache, db
from app.config import settings
from app.auth_cookies import build_refresh_cookie, refresh_cookie_secure
from app.routers.auth import _create_session, _auth_payload, _request_context
from app.routers.saas import Registration, provision_workspace
from app.saas import atomic, error
from app.login_rate_limit import check_login_rate_limit

router = APIRouter()
COOKIE = "wam_google_nonce"


def nonce_key(nonce):
    return "auth:google:" + hashlib.sha256(nonce.encode()).hexdigest()


@router.get("/nonce")
async def nonce(response: Response, request: Request):
    if not settings.google_auth_client_id:
        raise error(503, "GOOGLE_NOT_CONFIGURED", "Google sign-in is not configured.")
    address = request.client.host if request.client else "unknown"
    rate_key = "auth:google:nonce-limit:" + hashlib.sha256(address.encode()).hexdigest()
    count = await cache.get_client().eval(
        "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n", 1, rate_key)
    if int(count) > 30:
        raise error(429, "GOOGLE_LOGIN_RATE_LIMITED", "Too many Google sign-in attempts. Try again shortly.")
    value = secrets.token_urlsafe(32)
    await cache.get_client().set(nonce_key(value), "1", ex=600)
    response.set_cookie(COOKIE, value, httponly=True, secure=refresh_cookie_secure(),
                        samesite="lax", path="/api/v1/auth", max_age=600)
    response.headers["Cache-Control"] = "no-store"
    return {"data": {"nonce": value}}


class GoogleLogin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    credential: str = Field(min_length=1, max_length=12000)
    organizationId: str | None = None
    inviteCode: str = Field(default="", max_length=200)


async def verify_identity(credential: str, nonce_value: str):
    try:
        header = jwt.get_unverified_header(credential)
        if header.get("alg") != "RS256":
            raise ValueError()
        async with httpx.AsyncClient(timeout=10) as client:
            result = await client.get("https://www.googleapis.com/oauth2/v3/certs")
            result.raise_for_status()
            keys = result.json()["keys"]
        key = next(item for item in keys if item["kid"] == header.get("kid"))
        claims = jwt.decode(credential, jwt.PyJWK.from_dict(key).key, algorithms=["RS256"],
            audience=settings.google_auth_client_id,
            options={"require": ["exp", "iat", "iss", "sub", "email", "nonce"]})
        email = claims["email"].lower()
        authoritative = email.endswith("@gmail.com") or (
            isinstance(claims.get("hd"), str) and email.endswith("@" + claims["hd"].lower()))
        if (claims["iss"] not in ("accounts.google.com", "https://accounts.google.com")
            or claims.get("email_verified") is not True or not authoritative
            or not hmac.compare_digest(str(claims["nonce"]), nonce_value)):
            raise ValueError()
        return claims
    except Exception:
        raise error(401, "GOOGLE_IDENTITY_INVALID", "Google identity could not be verified. Use a Gmail or Google Workspace account.") from None


@router.post("")
async def google_login(body: GoogleLogin, request: Request, response: Response):
    if not settings.google_auth_client_id:
        raise error(503, "GOOGLE_NOT_CONFIGURED", "Google sign-in is not configured.")
    value = request.cookies.get(COOKIE, "")
    if not value or not await cache.get_client().get(nonce_key(value)):
        raise error(401, "GOOGLE_LOGIN_EXPIRED", "Google sign-in expired. Please try again.")
    claims = await verify_identity(body.credential, value)
    database = db.get_database()
    email, subject = claims["email"].lower(), claims["sub"]
    limit = await check_login_rate_limit(email=email, ip_address=request.client.host if request.client else None)
    if limit["limited"]:
        raise error(429, "AUTH_LOGIN_RATE_LIMITED", "Too many sign-in attempts. Try again later.")
    users = await database.users.find({"email": email, "status": "active"}).limit(50).to_list(50)
    choices = []
    for user in users:
        if user.get("googleSubject") not in (None, subject):
            continue
        org = await database.organizations.find_one({"_id": user["organizationId"], "status": "active"})
        if org:
            choices.append((user, org))
    if body.organizationId:
        choices = [(u, o) for u, o in choices if str(o["_id"]) == body.organizationId]
        if not choices:
            raise error(403, "WORKSPACE_ACCESS_DENIED", "This Google account cannot access that workspace.")
    if len(choices) > 1:
        return {"data": {"selectionRequired": True, "workspaces": [
            {"id": str(org["_id"]), "name": org["name"]} for _, org in choices]}}
    # Atomically consume the browser-bound challenge only when ready to issue a session.
    if not await cache.get_client().getdel(nonce_key(value)):
        raise error(401, "GOOGLE_LOGIN_EXPIRED", "Google sign-in expired. Please try again.")
    response.delete_cookie(COOKIE, path="/api/v1/auth")
    if not choices:
        # Existing disabled accounts are never replaced by a newly provisioned identity.
        if await database.users.find_one({"email": email}):
            raise error(403, "ACCOUNT_NOT_AVAILABLE", "Contact your workspace owner to restore access.")
        name = str(claims.get("name") or "Gmail user").strip()[:100] or "Gmail user"
        return await provision_workspace(Registration(organizationName=(name + " workspace")[:120],
            name=name if len(name) > 1 else "Gmail user", email=email,
            password=secrets.token_urlsafe(32), inviteCode=body.inviteCode), request, response, google_subject=subject)
    user, organization = choices[0]
    async def create(session):
        # Re-check status inside the transaction, including concurrent suspension.
        fresh_user = await database.users.find_one({"_id": user["_id"], "status": "active"}, session=session)
        fresh_org = await database.organizations.find_one({"_id": organization["_id"], "status": "active"}, session=session)
        if not fresh_user or not fresh_org or fresh_user.get("googleSubject") not in (None, subject):
            raise error(403, "ACCOUNT_NOT_AVAILABLE", "This account is not available.")
        await database.users.update_one({"_id": user["_id"], "organizationId": organization["_id"]},
            {"$set": {"googleSubject": subject, "lastLoginAt": db.utc_now()}}, session=session)
        result = await _create_session(organization=fresh_org, user=fresh_user,
                                      context=_request_context(request), session=session)
        return result, fresh_user, fresh_org
    result, user, organization = await atomic(create)
    response.set_cookie(**build_refresh_cookie(result["refreshToken"]))
    response.headers["Cache-Control"] = "no-store"
    return {"data": _auth_payload(access_token=result["accessToken"], user=user,
                                  organization=organization, session=result["session"])}
