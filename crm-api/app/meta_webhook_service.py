"""
Leads arriving in seconds instead of on the ten-minute poll.

PORTED FROM backend/src/modules/lead-sources/meta-webhook.service.ts.

A leadgen webhook carries an id and almost nothing else - no answers, no name, no phone. So the
work here is: decide the event is genuine, find which of this organisation's sources it belongs
to, fetch the lead with that source's own Page token, and hand it to the SAME pipeline the
poller uses.

ONE PIPELINE, TWO DOORS. `import_lead` is the only thing that creates a lead, here as in the
poller - so deduplication, the LeadSubmission ledger, the allowlist gate, the auto-greet
scheduling and the owner alert all behave identically whichever door the lead came through.
A webhook-specific creation path would be a second place for all of that to drift.

WHICH MAKES DOUBLE DELIVERY A NON-EVENT. LeadSubmission is unique on
(organizationId, leadSourceId, externalId), and `import_lead` returns 'duplicate' on the
duplicate-key error rather than throwing. So a webhook and a poll that both see the same lead
produce one conversation and one ledger row - which is exactly what Meta's retry behaviour
needs, since it re-delivers anything we do not acknowledge quickly.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, NamedTuple
from bson import ObjectId

from app.config import settings
from app.lead_pipeline import LeadPipeline, create_lead_pipeline
from app.lead_sources_common import decrypt_meta_access_token
from app.lead_sources_repository import (
    count_lead_source_import as default_count_lead_source_import,
    find_lead_source_for_meta_form as default_find_lead_source_for_meta_form,
)
from app.meta_graph_client import (
    fetch_meta_lead_by_id as default_fetch_meta_lead_by_id,
)
from app.meta_lead_mapper import map_meta_graph_lead

logger = logging.getLogger(__name__)


class MetaLeadgenEvent(NamedTuple):
    """One changes[] entry off a page webhook, once we have decided we care about it."""
    leadgen_id: str
    page_id: str
    form_id: str | None
    created_time: int | None


def extract_leadgen_events(body: Any) -> list[MetaLeadgenEvent]:
    """
    Pulls the leadgen events out of a webhook body, ignoring everything else.

    Meta posts one envelope for many kinds of Page change; `field: 'leadgen'` is the only one this
    app subscribes to, but a Page subscribed by someone else for another reason still delivers
    here. Anything unrecognised is dropped silently rather than logged as an error - it is not one.

    Total, never throws: a malformed envelope must produce an empty list and a 200, because Meta
    retries anything else and a parse bug would become an infinite redelivery loop.
    """
    if not isinstance(body, dict):
        return []

    if body.get("object") != "page" or not isinstance(body.get("entry"), list):
        return []

    events: list[MetaLeadgenEvent] = []

    for raw_entry in body["entry"]:
        if not isinstance(raw_entry, dict):
            continue

        changes = raw_entry.get("changes")
        if not isinstance(changes, list):
            continue

        for raw_change in changes:
            if not isinstance(raw_change, dict):
                continue

            if raw_change.get("field") != "leadgen":
                continue

            val = raw_change.get("value")
            if not isinstance(val, dict):
                continue

            raw_leadgen_id = val.get("leadgen_id")
            leadgen_id = str(raw_leadgen_id).strip() if raw_leadgen_id is not None else ""

            raw_page_id = val.get("page_id")
            page_id = str(raw_page_id).strip() if raw_page_id is not None else ""

            if not leadgen_id or not page_id:
                continue

            raw_form_id = val.get("form_id")
            form_id = str(raw_form_id).strip() if raw_form_id is not None else None
            if form_id == "":
                form_id = None

            raw_time = val.get("created_time")
            try:
                created_time = int(raw_time) if raw_time is not None else None
            except (ValueError, TypeError):
                created_time = None

            events.append(
                MetaLeadgenEvent(
                    leadgen_id=leadgen_id,
                    page_id=page_id,
                    form_id=form_id,
                    created_time=created_time,
                )
            )

    return events


def field_key_overrides_for(lead_source: dict[str, Any]) -> dict[str, str | None]:
    """The overrides a source's stored mappings amount to, in the shape parse_form_fields wants."""
    overrides: dict[str, str | None] = {}
    for mapping in lead_source.get("fieldMappings") or []:
        if not isinstance(mapping, dict):
            continue
        meta_key = str(mapping.get("metaKey") or "").strip()
        if not meta_key:
            continue
        fact_key = mapping.get("factKey")
        if isinstance(fact_key, str) and fact_key.strip():
            overrides[meta_key] = fact_key.strip()
        else:
            overrides[meta_key] = None
    return overrides


class MetaWebhookService:
    """
    Processes real-time inbound Meta Leadgen webhooks.
    """

    def __init__(
        self,
        *,
        timeout_ms: int | None = None,
        fn_find_lead_source: Callable[..., Any] = default_find_lead_source_for_meta_form,
        fn_fetch_lead: Callable[..., Any] = default_fetch_meta_lead_by_id,
        fn_decrypt_token: Callable[..., Any] = decrypt_meta_access_token,
        lead_pipeline: LeadPipeline | None = None,
        fn_count_lead_source_import: Callable[..., Any] = default_count_lead_source_import,
    ):
        self.timeout_ms = timeout_ms or int(getattr(settings, "meta_graph_timeout_ms", 15_000))
        self._find_lead_source = fn_find_lead_source
        self._fetch_lead = fn_fetch_lead
        self._decrypt_token = fn_decrypt_token
        self._lead_pipeline = lead_pipeline or create_lead_pipeline()
        self._count_lead_source_import = fn_count_lead_source_import

    async def handle_leadgen_event(self, event: MetaLeadgenEvent) -> str:
        """
        One leadgen event, end to end.
        Never throws. Returns 'imported', 'duplicate', 'skipped', 'no_source', 'no_token', or 'failed'.
        """
        try:
            lead_source = await self._find_lead_source(
                page_id=event.page_id,
                form_id=event.form_id,
            )

            if not lead_source:
                logger.info(
                    "Meta webhook ignored: no lead source configured for page %s and form %s.",
                    event.page_id,
                    event.form_id,
                )
                return "no_source"

            access_token = self._decrypt_token(lead_source.get("encryptedMetaAccessToken"))
            if not access_token:
                logger.error(
                    "Meta webhook could not run: leadSource %s has no usable access token.",
                    str(lead_source.get("_id")),
                )
                return "no_token"

            graph_lead = await self._fetch_lead(
                event.leadgen_id,
                access_token,
                timeout_ms=self.timeout_ms,
            )

            meta_config = lead_source.get("meta") or {}
            form_name = meta_config.get("formName")

            lead = map_meta_graph_lead(
                lead=graph_lead,
                column_mapping=lead_source.get("columnMapping"),
                form_name=form_name,
                field_key_overrides=field_key_overrides_for(lead_source),
            )

            outcome = await self._lead_pipeline.import_lead(lead_source, lead)

            if outcome == "imported":
                try:
                    await self._count_lead_source_import(lead_source["_id"])
                except Exception as cnt_err:
                    logger.error(
                        "Meta webhook imported lead but could not update count for leadSource %s: %s",
                        str(lead_source.get("_id")),
                        str(cnt_err),
                    )

            return outcome
        except Exception as exc:
            logger.error(
                "Meta webhook failed to process lead safely for page %s: %s; poller will retry.",
                event.page_id,
                str(exc),
            )
            return "failed"

    async def handle_webhook_body(self, body: Any) -> dict[str, Any]:
        """
        Sequentially processes all events in a single delivery envelope.
        """
        events = extract_leadgen_events(body)
        outcomes: list[str] = []

        for event in events:
            outcomes.append(await self.handle_leadgen_event(event))

        return {"received": len(events), "outcomes": outcomes}


def create_meta_webhook_service(**kwargs: Any) -> MetaWebhookService:
    return MetaWebhookService(**kwargs)

