"""
Recurring invoice templates.

Gated on `invoices.manage` for anything that changes a schedule, `invoices.read` for looking.
Setting up a template is billing configuration - it decides what a client is charged every month
without anybody present - so it sits with raising invoices rather than with recording payments.

THERE IS NO "GENERATE NOW" ROUTE, deliberately. Generation belongs to the daily job, which holds
the lease and the period key that make it safe to run twice. A button that generated on demand
would be a second path into the same invariant, and the only reason to want one is impatience.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query

from app.deps import AuthContext, require_permission
from app.invoice_validation import (
    CreateRecurringTemplateBody,
    SetTemplateActiveBody,
    UpdateRecurringTemplateBody,
)
from app.permissions import INVOICES_MANAGE, INVOICES_READ
from app.recurring_invoice_serializer import serialize_recurring_template
from app.recurring_invoices_repository import find_template_by_id, find_templates
from app.recurring_invoices_service import (
    create_template,
    error,
    set_template_active,
    update_template_contents,
)

router = APIRouter()

_require_read = require_permission(INVOICES_READ)
_require_manage = require_permission(INVOICES_MANAGE)


@router.get("")
async def list_recurring(
    active: bool | None = Query(default=None),
    auth: AuthContext = Depends(_require_read),
):
    templates = await find_templates(organization_id=auth.organization_id, active=active)

    return {
        "data": [serialize_recurring_template(t) for t in templates],
        "meta": {"count": len(templates)},
    }


@router.get("/{templateId}")
async def get_recurring(templateId: str, auth: AuthContext = Depends(_require_read)):
    template = await find_template_by_id(
        template_id=templateId, organization_id=auth.organization_id
    )

    if not template:
        raise error(404, "RECURRING_TEMPLATE_NOT_FOUND", "That recurring template does not exist.")

    return {"data": serialize_recurring_template(template)}


@router.post("", status_code=201)
async def create_recurring(
    body: CreateRecurringTemplateBody,
    auth: AuthContext = Depends(_require_manage),
):
    template = await create_template(
        organization_id=auth.organization_id,
        actor_id=auth.user_id,
        payload=body.model_dump(),
    )

    return {"data": serialize_recurring_template(template)}


@router.put("/{templateId}")
async def update_recurring(
    templateId: str,
    body: UpdateRecurringTemplateBody,
    auth: AuthContext = Depends(_require_manage),
):
    """
    Edits what a schedule bills, and when.

    A WHOLE-CONTENTS REPLACE, like editing an invoice: the full line list is submitted, so
    deleting a line is expressible. Edits apply from the next generation; invoices already
    produced keep the rates they were billed at.

    The client is not editable - see `update_template_contents`.
    """
    template = await update_template_contents(
        organization_id=auth.organization_id,
        template_id=templateId,
        payload=body.model_dump(),
    )

    return {"data": serialize_recurring_template(template)}


@router.post("/{templateId}/active")
async def set_active(
    templateId: str,
    body: SetTemplateActiveBody,
    auth: AuthContext = Depends(_require_manage),
):
    """
    Pauses or resumes a schedule.

    Pausing does not move `nextRunAt`, so resuming after the billing day has passed bills the
    period that was missed - which is what somebody pausing for a fortnight almost always meant.
    """
    template = await set_template_active(
        organization_id=auth.organization_id, template_id=templateId, active=body.active
    )

    return {"data": serialize_recurring_template(template)}
