"""
Turning a chosen Meta Page and form into a working lead source.

PORTED FROM backend/src/modules/lead-sources/meta-activation.service.ts.

The step the wizard's "Activate" button runs, and the only place the OAuth connection, the
existing LeadSource creation and Meta's webhook subscription meet:

  connection -> page token -> create source (PAUSED) -> subscribe page -> ACTIVE

CREATED PAUSED, ACTIVATED ONLY ON A CONFIRMED SUBSCRIPTION. The alternative - create it active
and subscribe afterwards - produces the worst failure available here: a source that reads as
healthy in the dashboard while quietly depending on the ten-minute poll, with nothing saying
the webhook never attached. Paused-with-an-error is visibly unfinished, and retrying is just
pressing the button again.

THE POLLER IS NOT REPLACED BY ANY OF THIS. A subscribed Page delivers leads in seconds; the
poll catches whatever a missed delivery, a lapsed subscription or a brief outage loses. Both
doors call the same import_lead, so a lead arriving through both produces one conversation.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Callable
from bson import ObjectId
from fastapi import HTTPException

from app.config import settings
from app.lead_sources_common import (
    LEAD_SOURCE_KINDS,
    LEAD_SOURCE_STATUSES,
    META_CONNECTION_STATUSES,
    decrypt_meta_access_token,
    serialize_lead_source,
)
from app.lead_sources_repository import (
    create_lead_source as default_create_lead_source,
    find_meta_connection_with_secrets as default_find_meta_connection_with_secrets,
    mark_meta_connection_status as default_mark_meta_connection_status,
    record_meta_webhook_subscription as default_record_meta_webhook_subscription,
)
from app.meta_graph_client import (
    META_LEADGEN_FIELD,
    MetaPageWithToken,
    fetch_page_subscribed_apps as default_fetch_page_subscribed_apps,
    list_meta_lead_forms as default_list_meta_lead_forms,
    list_meta_pages_with_tokens as default_list_meta_pages_with_tokens,
    subscribe_page_to_leadgen as default_subscribe_page_to_leadgen,
    unsubscribe_page_from_leadgen as default_unsubscribe_page_from_leadgen,
)

logger = logging.getLogger(__name__)

BEGINNING_OF_TIME = datetime(1970, 1, 1, 0, 0, 0, tzinfo=timezone.utc)
DUPLICATE_KEY_ERROR = 11000


def _to_object_id(val: Any) -> ObjectId | None:
    if isinstance(val, ObjectId):
        return val
    if isinstance(val, str) and ObjectId.is_valid(val):
        return ObjectId(val)
    return None


class MetaActivationService:
    """
    Activates a Meta Lead Ads lead source:
    validates page/form ownership, stores encrypted tokens, and subscribes to webhooks.
    """

    def __init__(
        self,
        *,
        timeout_ms: int | None = None,
        fn_find_connection_secrets: Callable[..., Any] = default_find_meta_connection_with_secrets,
        fn_mark_connection_status: Callable[..., Any] = default_mark_meta_connection_status,
        fn_decrypt_token: Callable[..., Any] = decrypt_meta_access_token,
        fn_list_pages: Callable[..., Any] = default_list_meta_pages_with_tokens,
        fn_list_forms: Callable[..., Any] = default_list_meta_lead_forms,
        fn_subscribe_page: Callable[..., Any] = default_subscribe_page_to_leadgen,
        fn_unsubscribe_page: Callable[..., Any] = default_unsubscribe_page_from_leadgen,
        fn_fetch_subscribed_apps: Callable[..., Any] = default_fetch_page_subscribed_apps,
        fn_create_lead_source: Callable[..., Any] = default_create_lead_source,
        fn_record_subscription: Callable[..., Any] = default_record_meta_webhook_subscription,
    ):
        self.timeout_ms = timeout_ms or int(getattr(settings, "meta_graph_timeout_ms", 15_000))
        self._find_connection_secrets = fn_find_connection_secrets
        self._mark_connection_status = fn_mark_connection_status
        self._decrypt_token = fn_decrypt_token
        self._list_pages = fn_list_pages
        self._list_forms = fn_list_forms
        self._subscribe_page_fn = fn_subscribe_page
        self._unsubscribe_page_fn = fn_unsubscribe_page
        self._fetch_subscribed_apps = fn_fetch_subscribed_apps
        self._create_lead_source = fn_create_lead_source
        self._record_subscription = fn_record_subscription

    async def require_user_token(self, organization_id: ObjectId | str) -> tuple[str, ObjectId | None]:
        """
        The organisation's user token, or a 409 the wizard can turn into a Reconnect button.
        Returns (access_token, connection_id).
        """
        connection = await self._find_connection_secrets(organization_id)
        if not connection or connection.get("status") == META_CONNECTION_STATUSES.DISCONNECTED:
            raise HTTPException(
                status_code=409,
                detail={"code": "META_NOT_CONNECTED", "message": "Connect Facebook first."},
            )

        token = self._decrypt_token(connection.get("encryptedUserAccessToken"))
        if not token:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "META_NEEDS_RECONNECT",
                    "message": "The Facebook connection needs attention. Reconnect to continue.",
                },
            )

        conn_id = connection.get("_id")
        return token, conn_id

    async def require_page(
        self,
        organization_id: ObjectId | str,
        page_id: str,
    ) -> dict[str, Any]:
        """
        The chosen Page, with its own token - and the ownership check in one step.
        """
        user_token, conn_id = await self.require_user_token(organization_id)

        try:
            pages = await self._list_pages(user_token, timeout_ms=self.timeout_ms)
        except Exception as exc:
            msg = str(exc)
            await self._mark_connection_status(
                organization_id,
                META_CONNECTION_STATUSES.NEEDS_ATTENTION,
                msg or "Facebook rejected the connection.",
            )
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "META_NEEDS_RECONNECT",
                    "message": "Facebook rejected the connection. Reconnect and try again.",
                },
            ) from exc

        page = next((p for p in pages if (p.id if hasattr(p, "id") else p.get("id")) == page_id), None)
        if not page:
            raise HTTPException(
                status_code=403,
                detail={
                    "code": "META_PAGE_NOT_ACCESSIBLE",
                    "message": "That page is not one this Facebook account manages.",
                },
            )

        page_dict = {
            "id": page.id if hasattr(page, "id") else page["id"],
            "name": page.name if hasattr(page, "name") else page.get("name"),
            "accessToken": page.access_token if hasattr(page, "access_token") else page["accessToken"],
            "connectionId": conn_id,
        }
        return page_dict

    async def _create_without_clashing(
        self,
        params: dict[str, Any],
        form_label: str,
    ) -> dict[str, Any]:
        try:
            return await self._create_lead_source(**params)
        except Exception as exc:
            code = getattr(exc, "code", None)
            from pymongo.errors import DuplicateKeyError
            if code == DUPLICATE_KEY_ERROR or isinstance(exc, DuplicateKeyError):
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "META_FORM_ALREADY_CONNECTED",
                        "message": f'"{form_label}" is already connected to a lead source. Choose a different form, or edit the existing one.',
                    },
                ) from exc
            raise

    async def _subscribe_page(
        self,
        page: dict[str, Any],
    ) -> tuple[bool, str | None]:
        try:
            subscribed = await self._subscribe_page_fn(
                page["id"],
                page["accessToken"],
                timeout_ms=self.timeout_ms,
            )
            if subscribed:
                return True, None
            return False, "Facebook did not confirm the webhook subscription."
        except Exception as exc:
            return False, str(exc) or "Facebook refused the webhook subscription."

    async def activate_meta_lead_source(
        self,
        *,
        organization_id: ObjectId | str,
        actor_id: ObjectId | str | None = None,
        name: str,
        page_id: str,
        form_id: str,
        form_name: str | None = None,
        whatsapp_account_id: ObjectId | str,
        default_country_code: str,
        ai_context_enabled: bool = False,
        auto_greet_enabled: bool = False,
        import_existing: bool = False,
        field_mappings: list[Any] | None = None,
        default_stage: str | None = None,
        default_tag_ids: list[Any] | None = None,
        default_assignee_id: ObjectId | str | None = None,
        subscribe_webhook: bool = True,
    ) -> dict[str, Any]:
        """
        Create the source, subscribe the Page, activate.
        """
        page = await self.require_page(organization_id, page_id)

        forms = await self._list_forms(
            page["id"],
            page["accessToken"],
            timeout_ms=self.timeout_ms,
        )

        form = next(
            (f for f in forms if (f.id if hasattr(f, "id") else f.get("id")) == form_id),
            None,
        )
        if not form:
            raise HTTPException(
                status_code=404,
                detail={
                    "code": "META_FORM_NOT_FOUND",
                    "message": "That lead form is not on the selected page.",
                },
            )

        f_id = form.id if hasattr(form, "id") else form["id"]
        f_name = form.name if hasattr(form, "name") else form.get("name")
        resolved_form_name = form_name or f_name

        lead_source_params = {
            "organization_id": organization_id,
            "name": name,
            "kind": LEAD_SOURCE_KINDS.META_LEAD_ADS,
            "meta": {
                "pageId": page["id"],
                "pageName": page["name"],
                "formId": f_id,
                "formName": resolved_form_name,
                "accessToken": page["accessToken"],
            },
            "meta_connection_id": page.get("connectionId"),
            "whatsapp_account_id": whatsapp_account_id,
            "default_country_code": default_country_code,
            "ai_context_enabled": ai_context_enabled,
            "auto_greet_enabled": auto_greet_enabled,
            "import_from_time": BEGINNING_OF_TIME if import_existing else datetime.now(timezone.utc),
            "created_by": actor_id,
            "field_mappings": field_mappings or [],
            "default_stage": default_stage,
            "default_tag_ids": default_tag_ids or [],
            "default_assignee_id": default_assignee_id,
            "status": LEAD_SOURCE_STATUSES.PAUSED,
        }

        lead_source = await self._create_without_clashing(lead_source_params, resolved_form_name or form_id)

        if not lead_source:
            raise HTTPException(
                status_code=500,
                detail={"code": "LEAD_SOURCE_NOT_CREATED", "message": "The lead source could not be created."},
            )

        if not subscribe_webhook:
            activated = await self._record_subscription(
                lead_source_id=lead_source["_id"],
                organization_id=organization_id,
                subscribed=False,
                error=None,
            )
            return {
                "leadSource": serialize_lead_source(activated or lead_source),
                "webhookSubscribed": False,
                "webhookError": None,
            }

        subscribed, error = await self._subscribe_page(page)

        updated = await self._record_subscription(
            lead_source_id=lead_source["_id"],
            organization_id=organization_id,
            subscribed=subscribed,
            error=error,
        )

        if not subscribed:
            logger.error(
                "Meta webhook subscription failed for leadSource %s (pageId=%s); kept paused for retry.",
                str(lead_source.get("_id")),
                page["id"],
            )

        return {
            "leadSource": serialize_lead_source(updated or lead_source),
            "webhookSubscribed": subscribed,
            "webhookError": error,
        }

    async def retry_webhook_subscription(
        self,
        *,
        organization_id: ObjectId | str,
        lead_source: dict[str, Any],
    ) -> dict[str, Any]:
        """Retry for a source whose subscription failed, without rebuilding its configuration."""
        meta = lead_source.get("meta") or {}
        page_id = meta.get("pageId")
        if not page_id:
            raise HTTPException(
                status_code=400,
                detail={"code": "META_PAGE_MISSING", "message": "That lead source has no Facebook page to subscribe."},
            )

        page = await self.require_page(organization_id, page_id)
        subscribed, error = await self._subscribe_page(page)

        updated = await self._record_subscription(
            lead_source_id=lead_source["_id"],
            organization_id=organization_id,
            subscribed=subscribed,
            error=error,
        )

        return {
            "leadSource": serialize_lead_source(updated) if updated else None,
            "webhookSubscribed": subscribed,
            "webhookError": error,
        }

    async def unsubscribe_page_for_source(
        self,
        *,
        organization_id: ObjectId | str,
        page_id: str | None,
    ) -> bool:
        """Best-effort unsubscribe when a source is removed. Never throws."""
        if not page_id:
            return False

        try:
            page = await self.require_page(organization_id, page_id)
            return await self._unsubscribe_page_fn(
                page["id"],
                page["accessToken"],
                timeout_ms=self.timeout_ms,
            )
        except Exception:
            logger.info("Could not unsubscribe page %s from Meta webhooks; events will be ignored.", page_id)
            return False

    async def diagnose_meta_lead_source(
        self,
        *,
        organization_id: ObjectId | str,
        page_id: str | None,
        form_id: str | None,
    ) -> dict[str, Any]:
        """Independent diagnostics for connection, page access, form access, and webhook."""
        checks: list[dict[str, Any]] = []

        def add(key: str, ok: bool, detail: str):
            checks.append({"key": key, "ok": ok, "detail": detail})

        try:
            page = await self.require_page(organization_id, str(page_id or ""))
            add("connection", True, "Facebook account connected.")
            add("page_access", True, f"Page access verified: {page.get('name') or page.get('id')}.")
        except Exception as exc:
            msg = str(getattr(exc, "detail", str(exc)))
            add("connection", False, msg or "Facebook access failed.")
            add("page_access", False, "Not checked - the connection failed first.")
            add("form_access", False, "Not checked.")
            add("webhook", False, "Not checked.")
            return {"ok": False, "checks": checks}

        try:
            forms = await self._list_forms(
                page["id"],
                page["accessToken"],
                timeout_ms=self.timeout_ms,
            )
            form = next(
                (f for f in forms if (f.id if hasattr(f, "id") else f.get("id")) == form_id),
                forms[0] if (not form_id and forms) else None,
            )
            if form:
                f_name = form.name if hasattr(form, "name") else form.get("name")
                f_id = form.id if hasattr(form, "id") else form.get("id")
                add("form_access", True, f"Lead form found: {f_name or f_id}.")
            else:
                add("form_access", False, "That lead form was not found on this page.")
        except Exception as form_err:
            add("form_access", False, str(form_err) or "Could not read the page lead forms.")

        try:
            apps = await self._fetch_subscribed_apps(
                page["id"],
                page["accessToken"],
                timeout_ms=self.timeout_ms,
            )
            subscribed = any(
                META_LEADGEN_FIELD in (app.subscribed_fields if hasattr(app, "subscribed_fields") else app.get("subscribedFields", []))
                for app in apps
            )
            if subscribed:
                add("webhook", True, "Page is subscribed to leadgen webhooks.")
            else:
                add("webhook", False, "Page is not subscribed - leads will still arrive on the ten-minute poll.")
        except Exception as app_err:
            add("webhook", False, str(app_err) or "Could not read the page subscriptions.")

        return {
            "ok": all(c["ok"] for c in checks),
            "checks": checks,
        }


def create_meta_activation_service(**kwargs: Any) -> MetaActivationService:
    return MetaActivationService(**kwargs)
