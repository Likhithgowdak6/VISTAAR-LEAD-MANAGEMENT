"""Workspace provisioning and resource admission shared by the API and Baileys gateway."""
from typing import Any
from bson import ObjectId
from fastapi import HTTPException
from app import db
from app.config import settings
from app.transactions import run_in_transaction

BETA_LIMITS = {"users": 5, "whatsappAccounts": 1}


def error(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"error": {"code": code, "message": message}})


async def ensure_indexes() -> None:
    database = db.get_database()
    # Existing Node installs already have these keys; reuse their definitions without renaming.
    await database.organizations.create_index([("slug", 1)], unique=True)
    await database.users.create_index([("organizationId", 1), ("email", 1)], unique=True)


async def atomic(body):
    # Only the test driver may omit transactions. Provisioning never degrades to partial writes.
    if settings.node_env == "test":
        return await run_in_transaction(body)
    async with await db.get_database().client.start_session() as session:
        return await session.with_transaction(body)


async def admit_resource(organization_id: Any, resource: str, session: Any, exclude_id: Any = None) -> None:
    database = db.get_database()
    oid = ObjectId(str(organization_id))
    org = await database.organizations.find_one({"_id": oid}, session=session)
    if not org or not org.get("saasManaged"):
        return
    if session is None and settings.node_env != "test":
        raise error(503, "WORKSPACE_TRANSACTION_REQUIRED", "Workspace changes require database transactions.")
    # Updating the same document serializes concurrent resource creation, including Node writes.
    await database.organizations.update_one({"_id": oid}, {"$inc": {"saasRevision": 1}}, session=session)
    limits = org.get("saasLimits") or BETA_LIMITS
    limit = limits.get(resource)
    if not isinstance(limit, int) or limit < 1:
        raise error(403, "WORKSPACE_LIMIT_REACHED", "This workspace cannot add more resources.")
    collection = "users" if resource == "users" else "whatsappaccounts"
    query = {"organizationId": oid}
    if resource == "users":
        query.update({"status": "active", "email": {"$ne": "ai-assistant@internal.local"}})
    else:
        query["status"] = {"$ne": "removed"}
    if exclude_id is not None:
        query["_id"] = {"$ne": ObjectId(str(exclude_id))}
    count = await database[collection].count_documents(query, session=session)
    if count >= limit:
        raise error(403, "WORKSPACE_LIMIT_REACHED", f"Workspace limit reached: {limit} {resource}.")


def identity_record(organization_id: Any, owner_id: Any, name: str, industry: str = "") -> dict:
    """A normal company knowledge card so both the Node and Python AI paths see tenant identity."""
    now = db.utc_now()
    return {"_id": organization_id, "organizationId": organization_id, "label": "Business identity",
            "category": "company", "content": f"Business name: {name}\nIndustry: {industry or 'Not configured'}. "
            "Use only services, prices and promises confirmed in this workspace's knowledge base.",
            "status": "active", "createdBy": owner_id, "updatedBy": owner_id,
            "createdAt": now, "updatedAt": now}
