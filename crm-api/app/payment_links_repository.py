"""Durable payment-link intents; no provider call starts before the intent is stored."""
from typing import Any
from app import db

LINKS = "payment_links"

async def ensure_razorpay_indexes(database=None):
    database = database if database is not None else db.get_database()
    await database.organizations.create_index("razorpay.webhookToken", unique=True,
        partialFilterExpression={"razorpay.webhookToken": {"$type": "string"}})
    await database[LINKS].create_index([("organizationId", 1), ("invoiceId", 1), ("idempotencyKey", 1)], unique=True)
    await database[LINKS].create_index([("organizationId", 1), ("referenceId", 1)], unique=True)
    await database[LINKS].create_index([("organizationId", 1), ("providerLinkId", 1)], unique=True,
        partialFilterExpression={"providerLinkId": {"$type": "string"}})
    # Different HTTP request keys must not open competing links for the same balance.
    await database[LINKS].create_index([("organizationId", 1), ("activeInvoiceId", 1)], unique=True,
        partialFilterExpression={"activeInvoiceId": {"$exists": True}})
    await database[LINKS].create_index([("state", 1), ("nextCheckAt", 1)])
    await database[LINKS].create_index([("organizationId", 1), ("providerOrderId", 1)])

def link_dto(row: dict[str, Any]) -> dict[str, Any]:
    from app.serialization import serialize_date
    return {
        "id": str(row["_id"]), "invoiceId": str(row["invoiceId"]),
        "amountPaise": row["amountPaise"], "currency": "INR", "state": row["state"],
        "url": row.get("url"), "providerLinkId": row.get("providerLinkId"),
        "isLive": row["isLive"], "lastError": row.get("lastError"),
        "createdAt": serialize_date(row.get("createdAt")),
    }
