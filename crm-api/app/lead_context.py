"""
The lead's own form answers, for grounding an AI draft — but only when the admin who
connected the source turned that on.

PORTED FROM backend/src/modules/lead-sources/lead-context.service.ts.

The gate is per lead source and defaults to off. Widening what leaves the estate for the AI
provider is an explicit choice, not a side effect of importing leads, and free-text answers
can contain whatever the lead decided to type. Name, email, phone and the inbox URL are never
included even when the toggle is on.
"""

from __future__ import annotations

from typing import Any, NamedTuple
from bson import ObjectId

from app.lead_sources_repository import (
    find_lead_source_by_id,
    find_lead_submissions_for_conversation,
)


class LeadContextField(NamedTuple):
    label: str
    value: str


class LeadFormContext(NamedTuple):
    form_name: str | None
    fields: list[LeadContextField]


async def get_lead_form_context(
    organization_id: ObjectId | str,
    conversation_id: ObjectId | str,
) -> LeadFormContext | None:
    """
    Fetches custom fields for grounding AI, strictly gated on source.aiContextEnabled.
    Excludes PII (name, phone, email, inboxUrl) unconditionally.
    """
    submissions = await find_lead_submissions_for_conversation(
        organization_id=organization_id,
        conversation_id=conversation_id,
        limit=1,
    )
    if not submissions:
        return None

    latest = submissions[0]
    payload = latest.payload
    if not payload:
        return None

    ls_id = latest.submission.get("leadSourceId")
    lead_source = await find_lead_source_by_id(ls_id, organization_id)
    if not lead_source or not lead_source.get("aiContextEnabled"):
        return None

    custom_fields = payload.get("customFields") or []
    fields: list[LeadContextField] = []

    for item in custom_fields:
        if isinstance(item, dict):
            lbl = str(item.get("label") or "").strip()
            val = str(item.get("value") or "").strip()
        elif hasattr(item, "label") and hasattr(item, "value"):
            lbl = str(item.label or "").strip()
            val = str(item.value or "").strip()
        else:
            continue

        if lbl and val:
            fields.append(LeadContextField(label=lbl, value=val))

    if not fields:
        return None

    form_name = latest.submission.get("formName")
    return LeadFormContext(form_name=form_name, fields=fields)

