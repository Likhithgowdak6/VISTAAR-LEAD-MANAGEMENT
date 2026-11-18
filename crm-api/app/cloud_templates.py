"""Cloud send validation at the Python CRM boundary; Node owns delivery and credentials."""
import re
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import HTTPException
from app import db


def refuse(code: str, message: str, status: int = 400):
    raise HTTPException(status_code=status, detail={"error": {"code": code, "message": message}})


def supported_components(components: Any) -> bool:
    if not isinstance(components, list) or not components:
        return False
    has_body = False
    for component in components:
        if not isinstance(component, dict):
            return False
        kind = str(component.get("type", "")).upper()
        if kind not in ("BODY", "HEADER", "FOOTER"):
            return False
        if kind == "HEADER" and str(component.get("format", "TEXT")).upper() != "TEXT":
            return False
        text = component.get("text")
        if not isinstance(text, str):
            return False
        if "{{" in re.sub(r"\{\{\s*[1-9]\d*\s*\}\}", "", text):
            return False
        if kind == "BODY":
            has_body = bool(text.strip())
    return has_body


def parameter_count(text: str | None) -> int:
    return max((int(value) for value in re.findall(r"\{\{\s*(\d+)\s*\}\}", text or "")), default=0)


async def validate_send(*, organization_id, account_id, actor, selection, conversation, switching=False):
    account = await db.get_database()["whatsappaccounts"].find_one({"_id": account_id, "organizationId": organization_id})
    access = actor.get("accountAccess") or []
    if actor.get("accountAccessMode") == "selected" and access and str(account_id) not in {str(v) for v in access}:
        refuse("ACCOUNT_ACCESS_DENIED", "You cannot send from this WhatsApp number.", 403)
    cloud = bool(account and account.get("provider") == "cloud")
    if selection is None:
        if cloud:
            inbound = conversation.get("lastInboundAt") if not switching else None
            if isinstance(inbound, datetime) and inbound.tzinfo is None:
                inbound = inbound.replace(tzinfo=timezone.utc)
            if not isinstance(inbound, datetime) or inbound + timedelta(hours=24) <= datetime.now(timezone.utc):
                refuse("WHATSAPP_WINDOW_CLOSED", "The reply window is closed. Send an approved WhatsApp template instead.")
        return None
    if not cloud or account.get("status") != "active":
        refuse("WHATSAPP_ACCOUNT_NOT_SENDABLE", "Select an active Cloud API number to send a template.")
    stored = await db.get_database()["whatsapptemplates"].find_one({
        "organizationId": organization_id, "whatsappAccountId": account_id,
        "name": selection.name, "language": selection.language,
    })
    if not stored or stored.get("status") != "APPROVED":
        refuse("TEMPLATE_NOT_APPROVED", "This template is unavailable or is not approved.")
    if not supported_components(stored.get("components")):
        refuse("TEMPLATE_UNSUPPORTED", "Only approved text templates with numbered placeholders are supported. Media and button templates are unavailable.")
    body_values, header_values = selection.bodyParameters, selection.headerParameters
    if len(body_values) != parameter_count(stored.get("bodyText")) or len(header_values) != parameter_count(stored.get("headerText")):
        refuse("TEMPLATE_PARAMETER_MISMATCH", "Fill every template placeholder with the required values.")
    def render(text, values):
        return re.sub(r"\{\{\s*(\d+)\s*\}\}", lambda match: values[int(match[1])-1], text or "")
    preview = "\n\n".join(filter(None, (render(stored.get("headerText"), header_values), render(stored.get("bodyText"), body_values))))
    return {"payload": selection.model_dump(), "preview": preview}
