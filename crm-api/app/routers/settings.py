"""
Per-organization settings. Today that is one value: the owner's own WhatsApp number.

A PORT OF backend/src/modules/organizations/organization-settings.*.

READ IS GATED THE SAME AS WRITE, and that is not an oversight to tidy up. There is no
`settings.read` permission in the table at all - `organization-settings.routes.ts` puts
`requireSettingsManage` on the GET as well, because the owner's personal phone is organisation
configuration rather than something the whole team needs to see. Adding a softer read gate here
would widen access to the owner's phone number.

THE VALIDATION IS A TRANSFORM, NOT A CHECK. zod's `ownerWhatsappNumberSchema` accepts what a
person actually types - '+91 81830 03081', '081830 03081' - strips to digits, and stores digits
only. An empty string or null CLEARS the setting, which hands control back to the
WHATSAPP_OWNER_NUMBER environment default and then to the agent's own self-chat. Anything else
carrying too few or too many digits is rejected rather than silently clearing, because silently
clearing would redirect every owner notification with no error to notice.

----------------------------------------------------------------------------------------------
THE ONE DELIBERATE BEHAVIOUR CHANGE, AND WHY IT IS THE RIGHT CALL
----------------------------------------------------------------------------------------------
Node caches the resolved owner number per organization for 10 seconds, because
`getOwnerNumber` sits on two hot paths - `notifyOwner` and `routeInboundMessage`, i.e. every
owner-facing send and every inbound WhatsApp message. A database read per message would be
waste. Node's `setOwnerNumber` drops that organization's cache entry immediately, so an admin
saving from the dashboard sees the change on the very next message.

Python cannot reach into Node's in-process Map. Once this route moves, a save here updates the
database and Node's cached value expires on its own within the TTL.

**Maximum staleness becomes 10 seconds instead of zero.**

Considered and rejected: publishing a Redis invalidation that Node subscribes to. That means
ADDING code to the service this migration exists to shrink, and it introduces a new failure mode
- a missed or dropped message leaves the stale value in place indefinitely, which is strictly
worse than a TTL that always expires. The 10-second TTL already defines the staleness contract
the rest of the system lives with; the eager clear is an optimisation on top of it, not a
correctness requirement.

This resolves itself in Phase 11: when the WhatsApp business logic moves to Python, the cache
and its consumers land in the same process and eager invalidation comes back for free.
"""

import re
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator

from app import db
from app.deps import AuthContext, require_permission
from app.permissions import SETTINGS_MANAGE

router = APIRouter()

# `OWNER_NUMBER_MIN_DIGITS` is 8 because that is also `MIN_SUFFIX_MATCH_DIGITS` in
# whatsapp/automation/allowlist.ts - a shorter number cannot be suffix-matched safely. 15 is the
# E.164 maximum.
OWNER_NUMBER_MIN_DIGITS = 8
OWNER_NUMBER_MAX_DIGITS = 15
OWNER_NUMBER_MAX_LENGTH = 40

_require_settings_manage = require_permission(SETTINGS_MANAGE)


def normalize_owner_whatsapp_number(value: Any) -> str | None:
    """
    `normalizeOwnerWhatsappNumber`, character for character: digits only, or None when empty.

    Applied on READ as well as on write. Documents written before this field was normalised, or
    by any other path, still render as digits to the dashboard.
    """
    digits = re.sub(r"\D", "", "" if value is None else str(value))

    return digits or None


class UpdateSettings(BaseModel):
    """
    `updateOrganizationSettingsBodySchema`.

    The field is `str | None` and BOTH are meaningful: null and "" clear the setting, a digit
    string sets it. A missing key is a validation error, not a no-op - zod has no `.optional()`
    here, so Node rejects `{}`.
    """

    ownerWhatsappNumber: str | None

    @field_validator("ownerWhatsappNumber")
    @classmethod
    def _plausible(cls, value: str | None) -> str | None:
        if value is None:
            return None

        if len(value) > OWNER_NUMBER_MAX_LENGTH:
            raise ValueError("Enter at most 40 characters.")

        raw = value.strip()
        digits = re.sub(r"\D", "", value)

        # An explicitly empty value clears the setting and is allowed through. A value that
        # LOOKS like a number but carries too few digits is rejected, because accepting it would
        # silently clear the setting and redirect every owner notification with no error.
        if raw != "" and len(digits) < OWNER_NUMBER_MIN_DIGITS:
            raise ValueError(
                f"Enter at least {OWNER_NUMBER_MIN_DIGITS} digits, or leave it empty to clear it."
            )

        if len(digits) > OWNER_NUMBER_MAX_DIGITS:
            raise ValueError(f"Enter at most {OWNER_NUMBER_MAX_DIGITS} digits.")

        return value


def _settings_dto(organization: dict[str, Any] | None) -> dict[str, Any]:
    """
    The dashboard's view: one key, nothing else from the organization document.

    Narrow on purpose. The organization row also carries `status` and `slug`, and this endpoint
    is not where those are read or changed.
    """
    return {
        "ownerWhatsappNumber": normalize_owner_whatsapp_number(
            (organization or {}).get("ownerWhatsappNumber")
        )
    }


@router.get("")
async def get_settings(auth: AuthContext = Depends(_require_settings_manage)):
    # Scoped by the authenticated organization's own id, which `deps.authenticate` already
    # loaded and verified as ACTIVE. There is no id in the path to tamper with.
    organization = await db.get_database().organizations.find_one({"_id": auth.organization_id})

    return {"data": _settings_dto(organization)}


@router.patch("")
async def update_settings(
    payload: UpdateSettings,
    auth: AuthContext = Depends(_require_settings_manage),
):
    updated = await db.get_database().organizations.find_one_and_update(
        {"_id": auth.organization_id},
        {
            "$set": {
                "ownerWhatsappNumber": normalize_owner_whatsapp_number(
                    payload.ownerWhatsappNumber
                ),
                "updatedAt": db.utc_now(),
            }
        },
        # The response carries the stored value, so returning the pre-update document would show
        # the admin the number they just replaced.
        return_document=True,
    )

    if not updated:
        raise HTTPException(
            status_code=404,
            detail={
                "error": {
                    "code": "ORGANIZATION_NOT_FOUND",
                    "message": "Organization not found.",
                }
            },
        )

    return {"data": _settings_dto(updated)}
