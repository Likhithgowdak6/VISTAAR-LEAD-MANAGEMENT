"""
Lead sources router: configuration and discovery for Google Sheets and Meta Lead Ads.

A DIRECT PORT OF backend/src/modules/lead-sources/lead-source.routes.ts,
lead-source.controller.ts, and the authenticated endpoints of meta-oauth.controller.ts.

MOUNTED AT /api/v1/lead-sources.
Admin-only throughout, requiring `lead_sources.manage`: a sheet link or Facebook ad connection
is core business configuration, and the leads it produces are read through the inbox.

LITERAL META PATHS SIT ABOVE PARAMETERISED `/{lead_source_id}` PATHS:
FastAPI router routes in declaration order. Having `/meta/field-keys` or `/meta/diagnostics`
below `/{lead_source_id}` would cause FastAPI to match the string "meta" as a MongoDB ObjectId
and fail with a validation error.
"""

from __future__ import annotations

import logging
from typing import Any, Literal
from bson import ObjectId
from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel, Field

from app.config import settings
from app.deps import AuthContext, require_permission
from app.lead_field_rules import CONTACT_FACT_KEYS, LEAD_FACT_KEYS, key_for_label
from app.lead_source_service import (
    create_lead_source_for_actor,
    create_meta_lead_source_for_actor,
    delete_lead_source_for_actor,
    list_lead_sources_for_organization,
    list_meta_forms_for_actor,
    sync_lead_source_now_for_actor,
    test_meta_connection_for_actor,
    update_lead_source_for_actor,
)
from app.lead_sources_common import (
    CreateLeadSourceBody,
    CreateMetaOauthLeadSourceBody,
    LEAD_SOURCE_KINDS,
    LEAD_SOURCE_STATUS_VALUES,
    LeadSourceError,
    ListMetaFormsBody,
    META_CONNECTION_STATUSES,
    MetaOauthError,
    TestMetaConnectionBody,
    UpdateLeadSourceBody,
    decrypt_meta_access_token,
    serialize_meta_connection,
)
from app.lead_sources_repository import (
    disconnect_meta_connection,
    find_lead_source_by_id,
    find_meta_connection,
    find_meta_connection_with_secrets,
)
from app.meta_activation_service import create_meta_activation_service
from app.meta_graph_client import (
    fetch_meta_form_questions,
    list_meta_lead_forms,
    list_meta_pages_with_tokens,
)
from app.meta_oauth_service import (
    assert_meta_oauth_configured,
    build_meta_authorize_url,
    meta_oauth_scope_list,
    sign_meta_oauth_state,
)
from app.permissions import LEAD_SOURCES_MANAGE

router = APIRouter()
logger = logging.getLogger("crm-api.lead-sources")

_require_manage = require_permission(LEAD_SOURCES_MANAGE)

LEAD_SOURCE_ERROR_MAP: dict[str, tuple[int, str]] = {
    "LEAD_SOURCE_NOT_FOUND": (404, "Lead source not found."),
    "LEAD_SOURCE_INVALID_SHEET_URL": (400, "That is not a Google Sheets link."),
    "LEAD_SOURCE_ALREADY_EXISTS": (400, "This sheet tab is already connected as a lead source."),
    "LEAD_SOURCE_ACCOUNT_NOT_FOUND": (400, "The selected WhatsApp account does not exist."),
    "LEAD_SOURCE_NOT_META": (400, "Only a Meta Lead Ads source has an access token or a form."),
    "META_LEAD_ADS_DISABLED": (
        400,
        "Meta Lead Ads importing is switched off on this server. Set META_LEAD_ADS_ENABLED=true and restart.",
    ),
}


def map_lead_source_error(error: Exception) -> HTTPException:
    """
    Translates service errors to client-facing HTTP exceptions matching Node's mapLeadSourceError.
    Sheet and Graph failures carry an admin-facing message written by this module and are surfaced
    verbatim as a 502 Bad Gateway.
    """
    if isinstance(error, HTTPException):
        return error

    if isinstance(error, LeadSourceError):
        return HTTPException(
            status_code=502,
            detail={"error": {"code": error.code, "message": str(error)}},
        )

    if isinstance(error, MetaOauthError):
        return HTTPException(
            status_code=503,
            detail={"error": {"code": error.code, "message": str(error)}},
        )

    err_msg = str(error)
    if err_msg in LEAD_SOURCE_ERROR_MAP:
        status_code, client_message = LEAD_SOURCE_ERROR_MAP[err_msg]
        return HTTPException(
            status_code=status_code,
            detail={"error": {"code": err_msg, "message": client_message}},
        )

    return HTTPException(
        status_code=500,
        detail={"error": {"code": "INTERNAL_SERVER_ERROR", "message": "Internal server error."}},
    )


async def require_user_access_token(organization_id: Any) -> str:
    """
    Loads the organisation's user token or raises recognizable 409 conflict.
    Every discovery endpoint needs it, and every one of them fails the same recognisable way
    when authorisation has lapsed.
    """
    connection = await find_meta_connection_with_secrets(organization_id)
    if not connection or connection.get("status") == META_CONNECTION_STATUSES.DISCONNECTED:
        raise HTTPException(
            status_code=409,
            detail={"error": {"code": "META_NOT_CONNECTED", "message": "Connect Facebook first."}},
        )

    token = decrypt_meta_access_token(connection.get("encryptedUserAccessToken"))
    if not token:
        raise HTTPException(
            status_code=409,
            detail={
                "error": {
                    "code": "META_NEEDS_RECONNECT",
                    "message": "The Facebook connection needs attention. Reconnect to continue.",
                }
            },
        )

    return token


# ---- Core Lead Source Endpoints ------------------------------------------------

@router.get("")
async def list_lead_sources(
    status: str | None = Query(None, description="Filter by status (active/paused)"),
    limit: int = Query(100, ge=1, le=200),
    skip: int = Query(0, ge=0),
    auth: AuthContext = Depends(_require_manage),
) -> dict[str, Any]:
    """Lists lead sources for the active organization."""
    if status is not None and status not in LEAD_SOURCE_STATUS_VALUES:
        raise HTTPException(
            status_code=400,
            detail={"error": {"code": "VALIDATION_FAILED", "message": "Invalid status filter."}},
        )

    lead_sources = await list_lead_sources_for_organization(
        organization_id=auth.organization["_id"],
        status=status,
        limit=limit,
        skip=skip,
    )
    return {
        "data": lead_sources,
        "meta": {"limit": limit, "skip": skip, "count": len(lead_sources)},
    }


@router.post("", status_code=201)
async def create_new_lead_source(
    body: CreateLeadSourceBody,
    auth: AuthContext = Depends(_require_manage),
) -> dict[str, Any]:
    """Creates a new Google Sheet or Meta Lead Ads lead source."""
    try:
        if body.kind == LEAD_SOURCE_KINDS.META_LEAD_ADS:
            if not body.accessToken or not body.pageId:
                raise HTTPException(
                    status_code=400,
                    detail={
                        "error": {
                            "code": "VALIDATION_FAILED",
                            "message": "accessToken and pageId are required for Meta Lead Ads.",
                        }
                    },
                )
            lead_source = await create_meta_lead_source_for_actor(
                organization_id=auth.organization["_id"],
                actor=auth.user,
                name=body.name,
                access_token=body.accessToken,
                page_id=body.pageId,
                page_name=body.pageName,
                form_id=body.formId,
                form_name=body.formName,
                whatsapp_account_id=body.whatsappAccountId,
                default_country_code=body.defaultCountryCode,
                ai_context_enabled=body.aiContextEnabled,
                auto_greet_enabled=body.autoGreetEnabled,
                column_mapping=body.columnMapping.model_dump(exclude_unset=True) if body.columnMapping else None,
                import_existing=body.importExisting,
            )
        else:
            if not body.sheetUrl:
                raise HTTPException(
                    status_code=400,
                    detail={
                        "error": {
                            "code": "VALIDATION_FAILED",
                            "message": "sheetUrl is required for Google Sheets.",
                        }
                    },
                )
            lead_source = await create_lead_source_for_actor(
                organization_id=auth.organization["_id"],
                actor=auth.user,
                name=body.name,
                sheet_url=body.sheetUrl,
                whatsapp_account_id=body.whatsappAccountId,
                default_country_code=body.defaultCountryCode,
                ai_context_enabled=body.aiContextEnabled,
                auto_greet_enabled=body.autoGreetEnabled,
                column_mapping=body.columnMapping.model_dump(exclude_unset=True) if body.columnMapping else None,
                import_existing=body.importExisting,
            )

        return {"data": lead_source}
    except Exception as error:
        raise map_lead_source_error(error)


# ---- Meta Manual Paste Connection Probes ---------------------------------------

@router.post("/meta/test-connection")
async def test_meta_connection_route(
    body: TestMetaConnectionBody,
    auth: AuthContext = Depends(_require_manage),
) -> dict[str, Any]:
    """Tests a pasted Page access token without persisting it."""
    try:
        result = await test_meta_connection_for_actor(access_token=body.accessToken)
        return {
            "data": {
                "valid": result.valid,
                "pageId": result.page_id,
                "pageName": result.page_name,
                "scopes": list(result.scopes),
            }
        }
    except Exception as error:
        raise map_lead_source_error(error)


@router.post("/meta/forms")
async def list_meta_forms_route(
    body: ListMetaFormsBody,
    auth: AuthContext = Depends(_require_manage),
) -> dict[str, Any]:
    """Lists lead forms on a page using a pasted access token."""
    try:
        forms = await list_meta_forms_for_actor(
            access_token=body.accessToken,
            page_id=body.pageId,
        )
        data = [
            {"id": f.id, "name": f.name, "status": f.status, "leadsCount": f.leads_count}
            for f in forms
        ]
        return {"data": data, "meta": {"count": len(data)}}
    except Exception as error:
        raise map_lead_source_error(error)


# ---- Facebook Login (OAuth) Wizard Routes --------------------------------------

@router.get("/meta/oauth/start")
async def start_meta_oauth_route(
    auth: AuthContext = Depends(_require_manage),
) -> dict[str, Any]:
    """Returns the Facebook OAuth authorization URL and required scopes."""
    try:
        assert_meta_oauth_configured()
    except Exception as error:
        raise map_lead_source_error(error)

    state = sign_meta_oauth_state(
        organization_id=str(auth.organization["_id"]),
        user_id=str(auth.user["_id"]),
    )
    return {
        "data": {
            "authorizeUrl": build_meta_authorize_url(state=state),
            "scopes": meta_oauth_scope_list().split(","),
        }
    }


@router.get("/meta/connection")
async def get_meta_connection_route(
    auth: AuthContext = Depends(_require_manage),
) -> dict[str, Any]:
    """Renders the current Meta OAuth connection status for the Integrations page."""
    connection = await find_meta_connection(auth.organization["_id"])
    configured = bool(
        getattr(settings, "meta_app_id", "")
        and getattr(settings, "meta_app_secret", "")
        and getattr(settings, "meta_redirect_uri", "")
    )
    return {
        "data": {
            "connection": serialize_meta_connection(connection),
            "configured": configured,
        }
    }


@router.delete("/meta/connection")
async def remove_meta_connection_route(
    auth: AuthContext = Depends(_require_manage),
) -> dict[str, Any]:
    """Destroys the stored Meta user credentials while keeping audit history."""
    connection = await disconnect_meta_connection(auth.organization["_id"])
    return {"data": serialize_meta_connection(connection)}


@router.get("/meta/pages")
async def list_connected_meta_pages_route(
    auth: AuthContext = Depends(_require_manage),
) -> dict[str, Any]:
    """Lists Facebook Pages managed by the connected account. Page tokens are never returned."""
    try:
        token = await require_user_access_token(auth.organization["_id"])
        timeout_ms = int(getattr(settings, "meta_graph_timeout_ms", 15_000))
        pages = await list_meta_pages_with_tokens(access_token=token, timeout_ms=timeout_ms)
        return {
            "data": [
                {"id": page.id, "name": page.name, "pictureUrl": page.picture_url}
                for page in pages
            ]
        }
    except Exception as error:
        raise map_lead_source_error(error)


@router.get("/meta/pages/{page_id}/forms")
async def list_connected_meta_forms_route(
    page_id: str,
    auth: AuthContext = Depends(_require_manage),
) -> dict[str, Any]:
    """Lists lead forms for one connected Page using minted page token."""
    try:
        token = await require_user_access_token(auth.organization["_id"])
        timeout_ms = int(getattr(settings, "meta_graph_timeout_ms", 15_000))
        pages = await list_meta_pages_with_tokens(access_token=token, timeout_ms=timeout_ms)
        page = next((p for p in pages if p.id == page_id), None)

        if not page:
            raise HTTPException(
                status_code=403,
                detail={
                    "error": {
                        "code": "META_PAGE_NOT_ACCESSIBLE",
                        "message": "That page is not one this Facebook account manages.",
                    }
                },
            )

        forms = await list_meta_lead_forms(
            page_id=page.id,
            access_token=page.access_token,
            timeout_ms=timeout_ms,
        )
        return {
            "data": [
                {"id": f.id, "name": f.name, "status": f.status, "leadsCount": f.leads_count}
                for f in forms
            ]
        }
    except Exception as error:
        raise map_lead_source_error(error)


@router.get("/meta/pages/{page_id}/forms/{form_id}/fields")
async def list_connected_meta_form_fields_route(
    page_id: str,
    form_id: str,
    auth: AuthContext = Depends(_require_manage),
) -> dict[str, Any]:
    """Fetches a lead form's questions with suggested CRM fact mappings."""
    try:
        token = await require_user_access_token(auth.organization["_id"])
        timeout_ms = int(getattr(settings, "meta_graph_timeout_ms", 15_000))
        pages = await list_meta_pages_with_tokens(access_token=token, timeout_ms=timeout_ms)
        page = next((p for p in pages if p.id == page_id), None)

        if not page:
            raise HTTPException(
                status_code=403,
                detail={
                    "error": {
                        "code": "META_PAGE_NOT_ACCESSIBLE",
                        "message": "That page is not one this Facebook account manages.",
                    }
                },
            )

        questions = await fetch_meta_form_questions(
            form_id=form_id,
            access_token=page.access_token,
            timeout_ms=timeout_ms,
        )

        data = []
        for q in questions:
            suggested = key_for_label(q.label) or key_for_label(q.key) or None
            data.append({
                "id": q.id,
                "key": q.key,
                "label": q.label,
                "type": q.type,
                "options": list(q.options),
                "suggestedFactKey": suggested,
            })
        return {"data": data}
    except Exception as error:
        raise map_lead_source_error(error)


@router.get("/meta/field-keys")
async def list_meta_field_keys_route(
    auth: AuthContext = Depends(_require_manage),
) -> dict[str, Any]:
    """Returns the candidate CRM fact keys vocabulary offered for field mapping."""
    return {
        "data": [
            {"key": key, "isContact": key in CONTACT_FACT_KEYS}
            for key in LEAD_FACT_KEYS
        ]
    }


@router.post("/meta/sources", status_code=201)
async def create_meta_oauth_lead_source_route(
    body: CreateMetaOauthLeadSourceBody,
    auth: AuthContext = Depends(_require_manage),
) -> dict[str, Any]:
    """
    Creates a lead source from connected Facebook account and subscribes webhook.
    Returns 201 either way; failure to subscribe is noted in webhookSubscribed: false.
    """
    try:
        activation_service = create_meta_activation_service()
        result = await activation_service.activate_meta_lead_source(
            organization_id=auth.organization["_id"],
            actor_id=auth.user["_id"],
            name=body.name,
            page_id=body.pageId,
            form_id=body.formId,
            form_name=body.formName,
            whatsapp_account_id=body.whatsappAccountId,
            default_country_code=body.defaultCountryCode,
            ai_context_enabled=body.aiContextEnabled,
            auto_greet_enabled=body.autoGreetEnabled,
            import_existing=body.importExisting,
            field_mappings=[m.model_dump() for m in body.fieldMappings],
            default_stage=body.defaultStage,
            default_tag_ids=body.defaultTagIds,
            default_assignee_id=body.defaultAssigneeId,
            subscribe_webhook=body.subscribeWebhook,
        )
        return {
            "data": {
                "leadSource": result.lead_source,
                "webhookSubscribed": result.webhook_subscribed,
                "webhookError": result.webhook_error,
            }
        }
    except Exception as error:
        raise map_lead_source_error(error)


@router.post("/meta/sources/{lead_source_id}/subscribe")
async def retry_meta_webhook_subscription_route(
    lead_source_id: str,
    auth: AuthContext = Depends(_require_manage),
) -> dict[str, Any]:
    """Retries a failed webhook subscription for a configured lead source."""
    if not ObjectId.is_valid(lead_source_id):
        raise HTTPException(
            status_code=400,
            detail={"error": {"code": "VALIDATION_FAILED", "message": "Invalid leadSourceId."}},
        )

    lead_source = await find_lead_source_by_id(
        lead_source_id=lead_source_id,
        organization_id=auth.organization["_id"],
    )
    if not lead_source:
        raise HTTPException(
            status_code=404,
            detail={"error": {"code": "LEAD_SOURCE_NOT_FOUND", "message": "Lead source not found."}},
        )

    try:
        activation_service = create_meta_activation_service()
        result = await activation_service.retry_webhook_subscription(
            organization_id=auth.organization["_id"],
            lead_source=lead_source,
        )
        return {
            "data": {
                "subscribed": result.subscribed,
                "error": result.error,
                "leadSource": result.lead_source,
            }
        }
    except Exception as error:
        raise map_lead_source_error(error)


@router.get("/meta/diagnostics")
async def run_meta_diagnostics_route(
    page_id: str = Query(..., alias="pageId"),
    form_id: str | None = Query(None, alias="formId"),
    auth: AuthContext = Depends(_require_manage),
) -> dict[str, Any]:
    """Runs connectivity, permissions, token, and webhook subscription diagnostics."""
    try:
        activation_service = create_meta_activation_service()
        result = await activation_service.diagnose_meta_lead_source(
            organization_id=auth.organization["_id"],
            page_id=page_id,
            form_id=form_id,
        )
        return {
            "data": {
                "ok": result.ok,
                "checks": [
                    {
                        "name": c.name,
                        "status": c.status,
                        "message": c.message,
                        "remediation": c.remediation,
                    }
                    for c in result.checks
                ],
            }
        }
    except Exception as error:
        raise map_lead_source_error(error)


# ---- Individual Lead Source Mutation Endpoints ---------------------------------

@router.patch("/{lead_source_id}")
async def update_lead_source_route(
    lead_source_id: str,
    body: UpdateLeadSourceBody,
    auth: AuthContext = Depends(_require_manage),
) -> dict[str, Any]:
    """Updates a lead source's configuration."""
    if not ObjectId.is_valid(lead_source_id):
        raise HTTPException(
            status_code=400,
            detail={"error": {"code": "VALIDATION_FAILED", "message": "Invalid leadSourceId."}},
        )

    # Validate that at least one field is provided
    body_dump = body.model_dump(exclude_unset=True)
    if not body_dump:
        raise HTTPException(
            status_code=400,
            detail={"error": {"code": "VALIDATION_FAILED", "message": "At least one field must be provided."}},
        )

    try:
        lead_source = await update_lead_source_for_actor(
            organization_id=auth.organization["_id"],
            lead_source_id=lead_source_id,
            actor=auth.user,
            name=body.name,
            whatsapp_account_id=body.whatsappAccountId,
            default_country_code=body.defaultCountryCode,
            ai_context_enabled=body.aiContextEnabled,
            auto_greet_enabled=body.autoGreetEnabled,
            call_scheduling_enabled=body.callSchedulingEnabled,
            status=body.status,
            column_mapping=body.columnMapping.model_dump(exclude_unset=True) if body.columnMapping else None,
            access_token=body.accessToken,
            form_id=body.formId,
            form_name=body.formName,
        )
        return {"data": lead_source}
    except Exception as error:
        raise map_lead_source_error(error)


@router.post("/{lead_source_id}/sync")
async def sync_lead_source_route(
    lead_source_id: str,
    auth: AuthContext = Depends(_require_manage),
) -> dict[str, Any]:
    """Triggers an immediate polling import pass for this lead source."""
    if not ObjectId.is_valid(lead_source_id):
        raise HTTPException(
            status_code=400,
            detail={"error": {"code": "VALIDATION_FAILED", "message": "Invalid leadSourceId."}},
        )

    try:
        lead_source = await sync_lead_source_now_for_actor(
            organization_id=auth.organization["_id"],
            lead_source_id=lead_source_id,
        )
        return {"data": lead_source}
    except Exception as error:
        raise map_lead_source_error(error)


@router.delete("/{lead_source_id}", status_code=204)
async def remove_lead_source_route(
    lead_source_id: str,
    auth: AuthContext = Depends(_require_manage),
) -> Response:
    """Removes a lead source configuration. Retains previously imported leads and conversations."""
    if not ObjectId.is_valid(lead_source_id):
        raise HTTPException(
            status_code=400,
            detail={"error": {"code": "VALIDATION_FAILED", "message": "Invalid leadSourceId."}},
        )

    try:
        await delete_lead_source_for_actor(
            organization_id=auth.organization["_id"],
            lead_source_id=lead_source_id,
        )
        return Response(status_code=204)
    except Exception as error:
        raise map_lead_source_error(error)
