"""
Contacts — and the one path by which a customer's phone number leaves this backend.

A PORT OF backend/src/modules/contacts/*.

TWO ROUTES, TWO DIFFERENT PERMISSIONS, and the gap between them is the entire design:

  GET  /contacts/:id                conversations.read   never returns a phone or an email
  POST /contacts/:id/reveal-phone   client_pii.reveal    decrypts and returns the phone, and
                                                         writes an audit row saying who did

`serialize_contact` has NO phone and NO email field at all — not nulled, absent. The encrypted
columns are not even selected by the default query in Node (`includeEncrypted` is opt-in). A
port that added `phone` to the serializer "for convenience" would hand every reader a customer's
number with no audit trail and no permission check, and nothing in the response would look
wrong.

THE AUDIT WRITE HAPPENS BEFORE THE RESPONSE, AND ITS FAILURE FAILS THE REQUEST. An unlogged
reveal is worse than a refused one: the number has left the building and nothing records who
took it. There is no try/except around it for that reason.

THE AUDIT METADATA CARRIES IDS AND A FIELD NAME, NEVER THE NUMBER. `{contactId, leadId,
field: "phone"}`. An audit log containing the secret whose access it records defeats itself.

WHY THERE IS NO TRANSACTION, even though two writes look involved: there is only one write. The
reveal reads the contact, reads the encrypted PII, and writes one audit row. Node does the same
without a transaction.
"""

import re
from typing import Any

from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Request

from app import audit, db, encryption
from app.deps import AuthContext, require_any_permission, require_permission
from app.permissions import (
    CLIENT_PII_REVEAL,
    CONVERSATIONS_READ_ALL,
    CONVERSATIONS_READ_ASSIGNED,
)
from app.request_context import get_request_id
from app.serialization import serialize_date, serialize_id

router = APIRouter()

COLLECTION = "contacts"

OBJECT_ID_PATTERN = re.compile(r"^[a-f\d]{24}$", re.IGNORECASE)

_require_read = require_any_permission(CONVERSATIONS_READ_ASSIGNED, CONVERSATIONS_READ_ALL)
_require_reveal = require_permission(CLIENT_PII_REVEAL)


def _not_found() -> HTTPException:
    return HTTPException(
        status_code=404,
        detail={"error": {"code": "CONTACT_NOT_FOUND", "message": "Contact not found."}},
    )


def _object_id_or_none(value: str | None) -> ObjectId | None:
    if not value or not OBJECT_ID_PATTERN.match(value):
        return None

    return ObjectId(value)


def serialize_contact(doc: dict[str, Any] | None) -> dict[str, Any] | None:
    """
    EXACTLY the fields Node's serializer emits.

    There is no `phone`, no `email`, no `encryptedPhone`, no `providerKey`. Adding any of them
    would leak PII through a route gated only on `conversations.read`, and the response would
    look entirely normal while doing it.
    """
    if not doc:
        return None

    return {
        "id": serialize_id(doc.get("_id")),
        "organizationId": serialize_id(doc.get("organizationId")),
        "leadId": doc.get("leadId"),
        "displayName": doc.get("displayName"),
        "profileName": doc.get("profileName"),
        "source": doc.get("source"),
        "status": doc.get("status"),
        "createdAt": serialize_date(doc.get("createdAt")),
        "updatedAt": serialize_date(doc.get("updatedAt")),
    }


async def _find_contact(contact_id: ObjectId, organization_id: ObjectId) -> dict[str, Any] | None:
    # Scoped in the query, never as a follow-up comparison.
    return await db.get_database()[COLLECTION].find_one(
        {"_id": contact_id, "organizationId": organization_id}
    )


@router.get("/{contact_id}")
async def get_contact(
    contact_id: str,
    auth: AuthContext = Depends(_require_read),
):
    target = _object_id_or_none(contact_id)

    if not target:
        raise _not_found()

    contact = await _find_contact(target, auth.organization_id)

    if not contact:
        raise _not_found()

    return {"data": serialize_contact(contact)}


@router.post("/{contact_id}/reveal-phone")
async def reveal_contact_phone(
    contact_id: str,
    request: Request,
    auth: AuthContext = Depends(_require_reveal),
):
    target = _object_id_or_none(contact_id)

    if not target:
        raise _not_found()

    contact = await _find_contact(target, auth.organization_id)

    if not contact:
        raise _not_found()

    # DECRYPTED BEFORE THE AUDIT WRITE, so a field that cannot be decrypted raises and no row
    # claims a successful reveal that never happened.
    phone = encryption.decrypt_string(
        contact.get("encryptedPhone"), encryption.CONTACT_PHONE
    )

    # Not wrapped: if this fails, the request fails. An unlogged reveal is worse than a refused
    # one.
    await audit.create_audit_log(
        organization_id=auth.organization_id,
        event_type=audit.CLIENT_PII_REVEALED,
        actor_id=auth.user_id,
        session_id=auth.session.get("_id"),
        request_id=get_request_id(request),
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent"),
        metadata={
            # Ids and a field NAME. Never the number.
            "contactId": str(contact["_id"]),
            "leadId": contact.get("leadId"),
            "field": "phone",
        },
        # NO transaction here, matching Node: the reveal performs exactly one write. Passing
        # None explicitly so the absence reads as a decision rather than a forgotten argument.
        session=None,
    )

    return {
        "data": {
            "contactId": str(contact["_id"]),
            "leadId": contact.get("leadId"),
            "phone": phone,
        }
    }
