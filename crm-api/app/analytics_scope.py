"""
Who a caller is allowed to count.

A PORT OF `resolveAnalyticsScope` from backend/src/modules/analytics/analytics.service.ts.

THE BUG THIS PREVENTS. `canReadAll` is module-private inside `conversation.service.ts`, so the
rule has to be restated in analytics — and if it were simply forgotten, a staff user's dashboard
would total the **whole organisation** while their inbox showed only their own threads. That is
not an access-control breach of the conversations themselves; it is a readout of how many there
are, which in aggregate is the same information.

Restated here a third time, in Python. The same forgetting is available, which is why there are
tests asserting the narrowing rather than only the happy path.

AN EXPLICIT `assignedTo=<someone else>` FROM A USER WHO CANNOT READ ALL IS REFUSED, not quietly
rewritten to themselves. Silently answering a different question than the one asked would show
them their own numbers under another person's name — and they would have no way to know.
"""

from typing import Any

from bson import ObjectId
from fastapi import HTTPException

from app.permissions import CLIENT_PII_REVEAL, CONVERSATIONS_READ_ALL


class AnalyticsScope:
    """
    `organization_id` always; `assigned_to` only when the view is narrowed to one person.

    `assigned_to = None` means "the whole organisation" and is reachable ONLY by a caller
    holding `conversations.read_all`.
    """

    __slots__ = ("organization_id", "assigned_to")

    def __init__(self, organization_id: ObjectId, assigned_to: ObjectId | None) -> None:
        self.organization_id = organization_id
        self.assigned_to = assigned_to

    def conversation_filter(self) -> dict[str, Any]:
        """The base filter every analytics query starts from."""
        query: dict[str, Any] = {"organizationId": self.organization_id}

        if self.assigned_to is not None:
            query["assignedTo"] = self.assigned_to

        return query


def can_read_all(permissions: list[str] | tuple[str, ...]) -> bool:
    return CONVERSATIONS_READ_ALL in (permissions or ())


def can_reveal_pii(permissions: list[str] | tuple[str, ...]) -> bool:
    return CLIENT_PII_REVEAL in (permissions or ())


def resolve_analytics_scope(
    *,
    organization_id: ObjectId,
    actor_id: ObjectId,
    permissions: list[str] | tuple[str, ...],
    requested_assigned_to: str | None = None,
) -> AnalyticsScope:
    """`resolveAnalyticsScope`, including the 403."""
    if not can_read_all(permissions):
        if requested_assigned_to and requested_assigned_to != str(actor_id):
            raise HTTPException(
                status_code=403,
                detail={
                    "error": {
                        "code": "ANALYTICS_SCOPE_DENIED",
                        "message": (
                            "You can only see analytics for conversations assigned to you."
                        ),
                    }
                },
            )

        return AnalyticsScope(organization_id=organization_id, assigned_to=actor_id)

    return AnalyticsScope(
        organization_id=organization_id,
        assigned_to=ObjectId(requested_assigned_to) if requested_assigned_to else None,
    )
