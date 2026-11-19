"""Internal owner-payment bridge. Public ingress must not expose /internal/*."""
import hmac
from bson import ObjectId
from fastapi import APIRouter, Request
from pydantic import BaseModel, Field
from app.config import settings
from app import db
from app.payments_service import error
from app.payment_followup import get_payment_follow_up_service

router = APIRouter()
class OwnerReplyBody(BaseModel):
    organizationId: str = Field(pattern=r"^[a-fA-F0-9]{24}$")
    text: str = Field(min_length=1, max_length=200)

@router.post("/owner-reply")
async def owner_reply(body: OwnerReplyBody, request: Request):
    key = settings.whatsapp_gateway_service_key or settings.ai_brain_service_key
    if not key:
        raise error(503, "SERVICE_NOT_CONFIGURED", "Internal authentication is not configured.")
    if not hmac.compare_digest(request.headers.get("x-service-key", "").encode(), key.encode()):
        raise error(401, "SERVICE_AUTH_REQUIRED", "Invalid service key.")
    org = ObjectId(body.organizationId)
    if not await db.get_database().organizations.find_one({"_id": org, "status": "active"}):
        raise error(404, "ORGANIZATION_NOT_FOUND", "Workspace not found.")
    handled = await get_payment_follow_up_service().handle_owner_reply(org, body.text)
    return {"data": {"handled": handled}}
