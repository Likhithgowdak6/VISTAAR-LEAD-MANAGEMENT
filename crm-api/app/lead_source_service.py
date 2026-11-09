"""
Business logic service for lead source management: creation, update, listing, deletion,
and immediate synchronization.

A DIRECT PORT OF backend/src/modules/lead-sources/lead-source.service.ts.

Every lead source configuration change (adding a Google Sheet, connecting a Meta Lead Ads form,
updating mapping, or running an immediate sync) is executed through this service.

Two kinds of lead sources are supported:
  1. `google_sheet` - polls link-shared Google Sheets export CSV.
  2. `meta_lead_ads` - fetches form leads from Meta Graph API, driven either by webhook
     push or periodic polling fallback.

THE TWO KINDS ARE KEPT DISTINCT IN CREATION:
They share almost no required fields except a name and destination WhatsApp account.
Folding them into a single function would produce a union masquerading as a signature.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
from bson import ObjectId
from pymongo.errors import DuplicateKeyError

from app import db
from app.config import settings
from app.google_sheet_client import parse_google_sheet_url
from app.lead_import_service import create_lead_import_service
from app.lead_sources_common import (
    LEAD_SOURCE_KINDS,
    LEAD_SOURCE_STATUSES,
    LeadSourceError,
    serialize_lead_source,
)
from app.lead_sources_repository import (
    create_lead_source,
    delete_lead_source,
    find_lead_source_by_id,
    find_lead_source_by_id_with_secrets,
    find_lead_sources_by_organization,
    update_lead_source,
)
from app.meta_graph_client import (
    list_meta_lead_forms as default_list_meta_lead_forms,
    test_meta_connection as default_test_meta_connection,
)

BEGINNING_OF_TIME = datetime(1970, 1, 1, tzinfo=timezone.utc)


def is_duplicate_key_error(error: Any) -> bool:
    """Checks whether an exception represents a MongoDB duplicate key collision (code 11000)."""
    if isinstance(error, DuplicateKeyError):
        return True
    if hasattr(error, "code") and getattr(error, "code") == 11000:
        return True
    if isinstance(error, dict) and error.get("code") == 11000:
        return True
    return False


async def assert_account_usable(organization_id: Any, whatsapp_account_id: Any) -> None:
    """
    Ensures the target WhatsApp account exists and is not removed.
    A removed account would leave every imported lead stranded on a number that can never send.
    """
    account_oid = ObjectId(str(whatsapp_account_id)) if ObjectId.is_valid(str(whatsapp_account_id)) else str(whatsapp_account_id)
    org_oid = ObjectId(str(organization_id)) if ObjectId.is_valid(str(organization_id)) else str(organization_id)

    account = await db.get_database()["whatsappaccounts"].find_one({
        "_id": account_oid,
        "organizationId": org_oid,
    })

    if not account or account.get("status") == "removed":
        raise ValueError("LEAD_SOURCE_ACCOUNT_NOT_FOUND")


def assert_meta_lead_ads_enabled() -> None:
    """Ensures META_LEAD_ADS_ENABLED is switched on before performing Meta-specific actions."""
    if not getattr(settings, "meta_lead_ads_enabled", False):
        raise ValueError("META_LEAD_ADS_DISABLED")


async def assert_no_overlapping_meta_source(
    organization_id: Any,
    page_id: str,
    form_id: str | None,
) -> None:
    """
    A page-wide source and a single-form source on the same page would both import that form's leads,
    each against its own ledger. The unique index catches an exact repeat; this catches the overlap,
    which a partial index cannot express.
    """
    existing = await find_lead_sources_by_organization(organization_id=organization_id, limit=200)

    for lead_source in existing:
        if lead_source.get("kind") != LEAD_SOURCE_KINDS.META_LEAD_ADS:
            continue

        meta = lead_source.get("meta") or {}
        if meta.get("pageId") != page_id:
            continue

        existing_form_id = meta.get("formId") or None

        # Either side covering the whole page swallows the other.
        if existing_form_id is None or form_id is None or existing_form_id == form_id:
            raise ValueError("LEAD_SOURCE_ALREADY_EXISTS")


async def list_lead_sources_for_organization(
    organization_id: Any,
    status: str | None = None,
    limit: int = 100,
    skip: int = 0,
) -> list[dict[str, Any] | None]:
    """Lists lead sources for an organisation without exposing encrypted secrets."""
    sources = await find_lead_sources_by_organization(
        organization_id=organization_id,
        status=status,
        limit=limit,
        skip=skip,
    )
    return [serialize_lead_source(s) for s in sources]


async def create_lead_source_for_actor(
    organization_id: Any,
    actor: Any,
    name: str,
    sheet_url: str,
    whatsapp_account_id: Any,
    default_country_code: str = "91",
    ai_context_enabled: bool = False,
    auto_greet_enabled: bool = False,
    column_mapping: dict[str, Any] | None = None,
    import_existing: bool = False,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """Creates a Google Sheet lead source after URL validation and account check."""
    sheet_ref = parse_google_sheet_url(sheet_url)
    if not sheet_ref:
        raise ValueError("LEAD_SOURCE_INVALID_SHEET_URL")

    await assert_account_usable(organization_id=organization_id, whatsapp_account_id=whatsapp_account_id)

    current_ts = now or datetime.now(timezone.utc)
    import_from = BEGINNING_OF_TIME if import_existing else current_ts

    actor_id = actor.get("_id") if isinstance(actor, dict) else getattr(actor, "id", None) or getattr(actor, "_id", None)

    try:
        lead_source = await create_lead_source(
            organization_id=organization_id,
            name=name,
            kind=LEAD_SOURCE_KINDS.GOOGLE_SHEET,
            sheet_url=sheet_url,
            sheet_id=sheet_ref.sheet_id,
            gid=sheet_ref.gid,
            whatsapp_account_id=whatsapp_account_id,
            default_country_code=default_country_code,
            ai_context_enabled=ai_context_enabled,
            auto_greet_enabled=auto_greet_enabled,
            column_mapping=column_mapping,
            import_from_time=import_from,
            created_by=actor_id,
        )
        return serialize_lead_source(lead_source)
    except Exception as error:
        if is_duplicate_key_error(error):
            raise ValueError("LEAD_SOURCE_ALREADY_EXISTS") from error
        raise


async def create_meta_lead_source_for_actor(
    organization_id: Any,
    actor: Any,
    name: str,
    access_token: str,
    page_id: str,
    page_name: str | None = None,
    form_id: str | None = None,
    form_name: str | None = None,
    whatsapp_account_id: Any = None,
    default_country_code: str = "91",
    ai_context_enabled: bool = False,
    auto_greet_enabled: bool = False,
    column_mapping: dict[str, Any] | None = None,
    import_existing: bool = False,
    now: datetime | None = None,
) -> dict[str, Any] | None:
    """The Meta Lead Ads twin of create_lead_source_for_actor."""
    assert_meta_lead_ads_enabled()
    await assert_account_usable(organization_id=organization_id, whatsapp_account_id=whatsapp_account_id)
    await assert_no_overlapping_meta_source(organization_id=organization_id, page_id=page_id, form_id=form_id)

    current_ts = now or datetime.now(timezone.utc)
    import_from = BEGINNING_OF_TIME if import_existing else current_ts

    actor_id = actor.get("_id") if isinstance(actor, dict) else getattr(actor, "id", None) or getattr(actor, "_id", None)

    meta_dict = {
        "pageId": page_id,
        "pageName": page_name,
        "formId": form_id,
        "formName": form_name,
        "accessToken": access_token,
    }

    try:
        lead_source = await create_lead_source(
            organization_id=organization_id,
            name=name,
            kind=LEAD_SOURCE_KINDS.META_LEAD_ADS,
            meta=meta_dict,
            whatsapp_account_id=whatsapp_account_id,
            default_country_code=default_country_code,
            ai_context_enabled=ai_context_enabled,
            auto_greet_enabled=auto_greet_enabled,
            column_mapping=column_mapping,
            import_from_time=import_from,
            created_by=actor_id,
        )
        return serialize_lead_source(lead_source)
    except Exception as error:
        if is_duplicate_key_error(error):
            raise ValueError("LEAD_SOURCE_ALREADY_EXISTS") from error
        raise


async def test_meta_connection_for_actor(
    access_token: str,
    test_meta_fn: Any = default_test_meta_connection,
) -> Any:
    """Checks a token at paste time before anything is saved. Drops the token immediately."""
    assert_meta_lead_ads_enabled()
    timeout_ms = int(getattr(settings, "meta_graph_timeout_ms", 15_000))
    return await test_meta_fn(access_token=access_token, timeout_ms=timeout_ms)


async def list_meta_forms_for_actor(
    access_token: str,
    page_id: str,
    list_forms_fn: Any = default_list_meta_lead_forms,
) -> Any:
    """Lists lead forms on a Meta Page so an admin picks one rather than typing an ID."""
    assert_meta_lead_ads_enabled()
    timeout_ms = int(getattr(settings, "meta_graph_timeout_ms", 15_000))
    return await list_forms_fn(page_id=page_id, access_token=access_token, timeout_ms=timeout_ms)


async def update_lead_source_for_actor(
    organization_id: Any,
    lead_source_id: Any,
    actor: Any,
    name: str | None = None,
    whatsapp_account_id: Any = None,
    default_country_code: str | None = None,
    ai_context_enabled: bool | None = None,
    auto_greet_enabled: bool | None = None,
    call_scheduling_enabled: bool | None = None,
    status: str | None = None,
    column_mapping: dict[str, Any] | None = None,
    access_token: str | None = None,
    form_id: str | None = None,
    form_name: str | None = None,
) -> dict[str, Any] | None:
    """
    Updates an existing lead source. Enforces that Meta credentials are only set on Meta sources,
    and forces callSchedulingEnabled to false for non-Meta sources.
    """
    lead_source = await find_lead_source_by_id(lead_source_id=lead_source_id, organization_id=organization_id)
    if not lead_source:
        raise ValueError("LEAD_SOURCE_NOT_FOUND")

    is_meta = lead_source.get("kind") == LEAD_SOURCE_KINDS.META_LEAD_ADS

    # Storing a Meta credential against a sheet source would be a token nothing ever spends.
    if not is_meta and (access_token is not None or form_id is not None or form_name is not None):
        raise ValueError("LEAD_SOURCE_NOT_META")

    if whatsapp_account_id is not None:
        await assert_account_usable(organization_id=organization_id, whatsapp_account_id=whatsapp_account_id)

    actor_id = actor.get("_id") if isinstance(actor, dict) else getattr(actor, "id", None) or getattr(actor, "_id", None)

    # SERVER-SIDE KIND CHECK: callSchedulingEnabled is allowed only on Meta sources.
    resolved_call_scheduling: bool | None = None
    if call_scheduling_enabled is not None:
        resolved_call_scheduling = bool(is_meta and call_scheduling_enabled)

    updated = await update_lead_source(
        lead_source_id=lead_source["_id"],
        organization_id=organization_id,
        name=name,
        whatsapp_account_id=whatsapp_account_id,
        default_country_code=default_country_code,
        ai_context_enabled=ai_context_enabled,
        auto_greet_enabled=auto_greet_enabled,
        call_scheduling_enabled=resolved_call_scheduling,
        status=status,
        column_mapping=column_mapping,
        meta_access_token=access_token,
        meta_form_id=form_id,
        meta_form_name=form_name,
        actor_id=actor_id,
    )
    return serialize_lead_source(updated)


async def delete_lead_source_for_actor(organization_id: Any, lead_source_id: Any) -> None:
    """
    Removes the lead source record only. Leads and conversations produced already remain intact.
    """
    deleted = await delete_lead_source(lead_source_id=lead_source_id, organization_id=organization_id)
    if not deleted:
        raise ValueError("LEAD_SOURCE_NOT_FOUND")


async def sync_lead_source_now_for_actor(
    organization_id: Any,
    lead_source_id: Any,
    lead_import_service: Any = None,
) -> dict[str, Any] | None:
    """
    Runs an immediate import tick for one source so an admin gets immediate feedback.
    Loads encrypted secrets so Meta tokens can be used for polling.
    """
    lead_source = await find_lead_source_by_id_with_secrets(
        lead_source_id=lead_source_id,
        organization_id=organization_id,
    )
    if not lead_source:
        raise ValueError("LEAD_SOURCE_NOT_FOUND")

    service = lead_import_service or create_lead_import_service()
    await service.sync_source(lead_source)

    refreshed = await find_lead_source_by_id(
        lead_source_id=lead_source_id,
        organization_id=organization_id,
    )
    return serialize_lead_source(refreshed)

