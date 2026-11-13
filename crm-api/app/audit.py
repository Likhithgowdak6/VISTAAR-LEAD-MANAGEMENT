"""
The audit log.

A PORT OF backend/src/modules/audit/audit.repository.ts, written now because Phase 4's
`POST /contacts/:id/reveal-phone` is its first Python consumer. This module has no routes of its
own and never did — it is a library, and the migration rule for libraries is that they move
WITH the first module that needs them, not before. Porting it standalone would have meant two
implementations of the same writer running for months with no route to verify either against.

AN AUDIT WRITE IS NOT OPTIONAL AND NOT BEST-EFFORT. The one event wired up here records that a
human looked at a customer's phone number. If the write fails the reveal must fail too: an
unlogged reveal is worse than a refused one, because the number has left the building and
nothing says who took it. So this raises, and the caller does not catch it.

`createdAt` ONLY — the Mongoose schema is `timestamps: {createdAt: true, updatedAt: false}`.
An audit row is never updated, and writing an `updatedAt` would suggest it could be.

NO `updatedAt`, NO SOFT DELETE, NO UPDATE FUNCTION HERE AT ALL. The Node repository exposes
`findAuditLogById` and list helpers; only the writer is ported, because only the writer has a
Python consumer today. Read paths land with the module that needs them.
"""

import re
from typing import Any

from bson import ObjectId

from app import db
from app.redaction import SensitiveKeyError, assert_no_sensitive_keys

#: The exact pattern `backend/src/modules/audit/audit.model.ts` validates metadata against.
#:
#: REPRODUCED HERE BECAUSE PYTHON BYPASSES IT. That validator is a Mongoose schema rule, and
#: this module writes through Motor — so Node enforces it and Python, until now, did not. The
#: asymmetry meant the guarantee "an audit row never contains the secret it records access to"
#: held for one service and was a convention in the other.
#:
#: Note `body` and `requestBody`, which `redaction.SENSITIVE_KEY_PARTS` does not cover: a
#: metadata key called `body` is exactly how a whole WhatsApp message would end up duplicated
#: into the audit log.
_NODE_BLOCKED_METADATA_KEY = re.compile(
    r"password|passwordHash|accessToken|refreshToken|tokenHash|cookie|authorization|secret"
    r"|requestBody|body",
    re.IGNORECASE,
)


def _assert_metadata_is_safe(metadata: dict[str, Any] | None) -> None:
    """
    Both rules, because they block different things and neither is a superset.

    Node's audit pattern catches `body` and `requestBody`; `redaction.py` catches phone numbers,
    email addresses, JIDs, ciphertext and auth state. An audit row must satisfy both — the first
    so Python cannot write a row Mongoose would reject, the second because this collection is
    read by people investigating an incident and should not itself be a source of PII.
    """
    if not metadata:
        return

    def walk(value: Any, path: list[str]) -> None:
        if isinstance(value, dict):
            for key, nested in value.items():
                if _NODE_BLOCKED_METADATA_KEY.search(str(key)):
                    raise SensitiveKeyError(
                        "Audit metadata contains a blocked sensitive key: "
                        f"{'.'.join([*path, str(key)])}"
                    )

                walk(nested, [*path, str(key)])
        elif isinstance(value, (list, tuple)):
            for index, item in enumerate(value):
                walk(item, [*path, str(index)])

    walk(metadata, [])

    # The broader PII rule on top.
    assert_no_sensitive_keys(metadata, label="Audit metadata")

# Collection: Mongoose model 'AuditLog' -> lowercase plural. No `collection:` override.
COLLECTION = "auditlogs"

AUDIT_OUTCOME_SUCCESS = "success"
AUDIT_OUTCOME_FAILURE = "failure"

# From constants/audit-events.ts. Only the events Python raises today.
CLIENT_PII_REVEALED = "CLIENT_PII_REVEALED"

# The assistant. Written only here — the feature lives in this service — but declared in the
# Node constant file too, because its Mongoose schema enum-validates `eventType` and that file
# is the single source of truth for what the column may contain.
ASSISTANT_QUESTION_ASKED = "ASSISTANT_QUESTION_ASKED"
ASSISTANT_THREAD_VIEWED = "ASSISTANT_THREAD_VIEWED"
ASSISTANT_THREAD_DELETED = "ASSISTANT_THREAD_DELETED"
ASSISTANT_RATE_LIMITED = "ASSISTANT_RATE_LIMITED"


async def create_audit_log(
    *,
    organization_id: ObjectId,
    event_type: str,
    actor_id: ObjectId | None = None,
    target_user_id: ObjectId | None = None,
    session_id: ObjectId | None = None,
    outcome: str = AUDIT_OUTCOME_SUCCESS,
    reason_code: str | None = None,
    request_id: str | None = None,
    ip_address: str | None = None,
    user_agent: str | None = None,
    metadata: dict[str, Any] | None = None,
    session: Any = None,
) -> dict[str, Any]:
    """
    One audit row, with Node's defaults written explicitly.

    `session` IS PART OF THE CONTRACT, not an optional extra. Node's `createUserAuditLog` passes
    the transaction session straight through, so a user update and its audit row commit or roll
    back together. Omitting it leaves an audit row asserting a change that was rolled back -
    which is worse than no row at all, because the log is the thing people trust when they are
    trying to work out what happened.

    Callers with no transaction pass None, and that is correct for them: the contacts
    reveal-phone path has no transaction in Node either.

    `metadata` defaults to `{}` rather than None, matching the Mongoose default — a reader
    doing `row.metadata.contactId` should find an object, not have to guard for null first.

    THE METADATA MUST NOT CARRY THE REVEALED VALUE. Node's schema has a validator that rejects
    blocked sensitive keys, and the contacts service passes ids and a field NAME, never the
    phone itself. An audit log that contains the secret it is recording access to defeats its
    own purpose.
    """
    # BEFORE the write, and it raises rather than redacting. A silently-redacted audit row
    # looks complete while being wrong about what was recorded; a refused write is a bug the
    # caller has to fix. Node's schema validator behaves the same way.
    _assert_metadata_is_safe(metadata)

    document = {
        "organizationId": organization_id,
        "eventType": event_type,
        "actorId": actor_id,
        "targetUserId": target_user_id,
        "sessionId": session_id,
        "outcome": outcome,
        "reasonCode": reason_code,
        "requestId": request_id,
        "ipAddress": ip_address,
        "userAgent": user_agent,
        "metadata": metadata if metadata is not None else {},
        # createdAt only. See the module docstring.
        "createdAt": db.utc_now(),
    }

    result = await db.get_database()[COLLECTION].insert_one(document, session=session)
    document["_id"] = result.inserted_id

    return document
