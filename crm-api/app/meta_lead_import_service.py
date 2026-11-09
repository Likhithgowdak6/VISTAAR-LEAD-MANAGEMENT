"""
The Meta Lead Ads leg of the importer: ask the Graph API for a form's leads instead of reading
the spreadsheet Meta was writing them into.

PORTED FROM backend/src/modules/lead-sources/meta-lead-import.service.ts.

It owns only the two things that are genuinely different from the sheet path — talking to Meta,
and keeping a watermark so each tick asks for what is new — and then hands the leads to
`lead_pipeline.py`, which is the same code the sheet importer runs. Ledger, dedup,
contact and conversation creation, the ADR-005 AI-context boundary, the `importFromTime`
cutoff and the sync bookkeeping are therefore identical by construction, not by agreement.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, NamedTuple
from bson import ObjectId

from app.config import settings
from app.lead_pipeline import LeadBatchResult, LeadPipeline
from app.lead_sources_common import (
    LEAD_SOURCE_KINDS,
    META_GRAPH_FAILURE_KINDS,
    MetaGraphError,
    MetaLeadSourceNotConfiguredError,
    decrypt_meta_access_token,
)
from app.lead_sources_repository import (
    record_meta_backfill_progress as default_record_meta_backfill_progress,
    record_meta_lead_watermark as default_record_meta_lead_watermark,
)
from app.meta_graph_client import (
    fetch_meta_form_leads as default_fetch_meta_form_leads,
    list_meta_lead_forms as default_list_meta_lead_forms,
)
from app.meta_lead_mapper import map_meta_graph_lead as default_map_meta_graph_lead

logger = logging.getLogger(__name__)

WATERMARK_NUDGE_MS = 1000


def resolve_meta_since(lead_source: dict[str, Any]) -> datetime | None:
    """
    The instant this source should ask Meta about. The watermark once one tick has succeeded,
    `importFromTime` before that — which is "now" for a source created without backfill and the
    epoch for one created with it, exactly as for a sheet.
    """
    meta = lead_source.get("meta") or {}
    watermark = meta.get("lastLeadCreatedAt")
    if watermark:
        if watermark.tzinfo is None:
            watermark = watermark.replace(tzinfo=timezone.utc)
        return watermark + timedelta(milliseconds=WATERMARK_NUDGE_MS)

    import_from = lead_source.get("importFromTime")
    if not import_from or import_from.timestamp() <= 0:
        return None

    if import_from.tzinfo is None:
        import_from = import_from.replace(tzinfo=timezone.utc)
    return import_from


class MetaBackfillState(NamedTuple):
    backfilling: bool
    cursor: str | None


def resolve_meta_backfill_state(lead_source: dict[str, Any]) -> MetaBackfillState:
    """
    Whether this source is still reading history, and from where.
    """
    meta = lead_source.get("meta") or {}
    complete = meta.get("backfillComplete")
    has_watermark = meta.get("lastLeadCreatedAt") is not None
    import_from = lead_source.get("importFromTime")
    wants_history = not import_from or import_from.timestamp() <= 0

    if not wants_history or complete is True:
        return MetaBackfillState(backfilling=False, cursor=None)

    # Legacy source: no flag, but it has clearly been running.
    if complete is None and has_watermark:
        return MetaBackfillState(backfilling=False, cursor=None)

    return MetaBackfillState(backfilling=True, cursor=meta.get("backfillCursor"))


def is_meta_lead_source(lead_source: dict[str, Any]) -> bool:
    """True when this source should be handed to the Meta importer rather than the sheet one."""
    return lead_source.get("kind") == LEAD_SOURCE_KINDS.META_LEAD_ADS


def sync_status_for_meta_error(error: Any) -> str:
    """
    How a Graph failure should be recorded against the source. An expired token and a missing
    permission are flagged for a human ('needs_attention'), while a throttle or network blip
    is an ordinary failed sync ('failed').
    """
    if isinstance(error, MetaLeadSourceNotConfiguredError):
        return "needs_attention"

    if isinstance(error, MetaGraphError) and error.failure_kind == META_GRAPH_FAILURE_KINDS.NEEDS_ATTENTION:
        return "needs_attention"

    return "failed"


class MetaLeadImportService:
    """
    Polls the Meta Graph API for new leads or walks historical forms.
    """

    def __init__(
        self,
        *,
        pipeline: LeadPipeline,
        max_leads_per_tick: int | None = None,
        max_pages_per_tick: int | None = None,
        timeout_ms: int | None = None,
        fn_fetch_leads: Callable[..., Any] = default_fetch_meta_form_leads,
        fn_list_forms: Callable[..., Any] = default_list_meta_lead_forms,
        fn_map_lead: Callable[..., Any] = default_map_meta_graph_lead,
        fn_decrypt_token: Callable[..., Any] = decrypt_meta_access_token,
        fn_record_watermark: Callable[..., Any] = default_record_meta_lead_watermark,
        fn_record_backfill: Callable[..., Any] = default_record_meta_backfill_progress,
    ):
        self.pipeline = pipeline
        self.max_leads_per_tick = max_leads_per_tick or int(getattr(settings, "lead_import_max_rows_per_tick", 200))
        self.max_pages_per_tick = max_pages_per_tick or int(getattr(settings, "meta_graph_max_pages_per_tick", 10))
        self.timeout_ms = timeout_ms or int(getattr(settings, "meta_graph_timeout_ms", 15_000))

        self._fetch_leads = fn_fetch_leads
        self._list_forms = fn_list_forms
        self._map_lead = fn_map_lead
        self._decrypt_token = fn_decrypt_token
        self._record_watermark = fn_record_watermark
        self._record_backfill = fn_record_backfill

    async def resolve_form_ids(
        self,
        lead_source: dict[str, Any],
        access_token: str,
    ) -> list[dict[str, Any]]:
        meta = lead_source.get("meta") or {}
        configured_form_id = meta.get("formId")

        if configured_form_id:
            return [{"id": configured_form_id, "name": meta.get("formName")}]

        page_id = meta.get("pageId")
        if not page_id:
            raise MetaLeadSourceNotConfiguredError("This Meta source has neither a form nor a page configured.")

        forms = await self._list_forms(
            page_id,
            access_token,
            timeout_ms=self.timeout_ms,
        )
        return [
            {"id": f.id if hasattr(f, "id") else f["id"], "name": f.name if hasattr(f, "name") else f.get("name")}
            for f in forms
        ]

    async def advance_backfill(
        self,
        lead_source: dict[str, Any],
        result: LeadBatchResult,
        truncated: bool,
        next_after: str | None,
        forms_this_tick: list[dict[str, Any]],
        completed_form_ids: list[str],
        all_form_ids: list[str],
        exhausted: bool,
    ) -> None:
        meta = lead_source.get("meta") or {}
        seen_before = meta.get("backfillNewestSeenAt")
        seen_now = result.newest_submitted_at
        newest_seen_at = (
            seen_now
            if seen_now is not None and (seen_before is None or seen_now > seen_before)
            else seen_before
        )

        if truncated:
            await self._record_backfill(
                lead_source_id=lead_source["_id"],
                cursor=next_after,
                newest_seen_at=newest_seen_at,
                truncated_at=datetime.now(timezone.utc),
            )
            logger.warning(
                "META_BACKFILL: history not fully read for source %s; next poll resumes from cursor.",
                str(lead_source["_id"]),
            )
            return

        done_now = (
            list(completed_form_ids)
            if exhausted
            else list(set(completed_form_ids + [f["id"] for f in forms_this_tick]))
        )
        source_complete = all(fid in done_now for fid in all_form_ids)

        await self._record_backfill(
            lead_source_id=lead_source["_id"],
            cursor=None,
            complete=True if source_complete else None,
            newest_seen_at=newest_seen_at,
            truncated_at=None,
            completed_form_ids=done_now,
        )

        if not source_complete:
            return

        if newest_seen_at is not None:
            await self._record_watermark(
                lead_source_id=lead_source["_id"],
                last_lead_created_at=newest_seen_at,
            )

    async def import_from_source(self, lead_source: dict[str, Any]) -> LeadBatchResult:
        if not getattr(settings, "meta_lead_ads_enabled", True):
            raise MetaLeadSourceNotConfiguredError(
                "Meta Lead Ads importing is switched off on this server (META_LEAD_ADS_ENABLED)."
            )

        access_token = self._decrypt_token(lead_source.get("encryptedMetaAccessToken"))
        if not access_token:
            raise MetaLeadSourceNotConfiguredError()

        backfill = resolve_meta_backfill_state(lead_source)
        since = None if backfill.backfilling else resolve_meta_since(lead_source)
        forms = await self.resolve_form_ids(lead_source, access_token)

        graph_leads: list[tuple[dict[str, Any], str | None]] = []
        truncated = False
        next_after: str | None = None

        meta = lead_source.get("meta") or {}
        completed_form_ids = meta.get("backfillCompletedFormIds") or []

        forms_this_tick = (
            [f for f in forms if f["id"] not in completed_form_ids][:1]
            if backfill.backfilling
            else forms
        )
        backfill_exhausted = backfill.backfilling and len(forms_this_tick) == 0

        for form in forms_this_tick:
            if len(graph_leads) >= self.max_leads_per_tick:
                truncated = True
                break

            page_result = await self._fetch_leads(
                form["id"],
                access_token,
                since=since,
                max_leads=self.max_leads_per_tick - len(graph_leads),
                max_pages=self.max_pages_per_tick,
                after=backfill.cursor if backfill.backfilling else None,
                timeout_ms=self.timeout_ms,
            )

            is_trunc = getattr(page_result, "truncated", False) if hasattr(page_result, "truncated") else page_result.get("truncated", False)
            if is_trunc:
                truncated = True
                next_after = getattr(page_result, "next_after", None) if hasattr(page_result, "next_after") else page_result.get("nextAfter")

            leads_list = getattr(page_result, "leads", []) if hasattr(page_result, "leads") else page_result.get("leads", [])
            for item in leads_list:
                graph_leads.append((item, form.get("name")))

        mapped = []
        floor = lead_source.get("importFromTime")
        if floor and floor.tzinfo is None:
            floor = floor.replace(tzinfo=timezone.utc)
        wants_past = not floor or floor.timestamp() <= 0

        for gl, f_name in graph_leads:
            ml = self._map_lead(
                lead=gl,
                column_mapping=lead_source.get("columnMapping"),
                form_name=f_name,
            )
            # Enforce floor unless backfill was asked for
            if wants_past or not ml.submitted_at:
                mapped.append(ml)
            else:
                s_at = ml.submitted_at
                if s_at.tzinfo is None:
                    s_at = s_at.replace(tzinfo=timezone.utc)
                if s_at >= floor:
                    mapped.append(ml)

        # Oldest first: Meta serves newest first, taking oldest means watermark only advances
        # over leads that were actually processed
        mapped.sort(key=lambda m: m.submitted_at.timestamp() if m.submitted_at else 0)

        result = await self.pipeline.import_leads(lead_source=lead_source, leads=mapped)

        clean = result.counts.failed == 0
        if clean:
            try:
                if backfill.backfilling:
                    await self.advance_backfill(
                        lead_source=lead_source,
                        result=result,
                        truncated=truncated,
                        next_after=next_after,
                        forms_this_tick=forms_this_tick,
                        completed_form_ids=completed_form_ids,
                        all_form_ids=[f["id"] for f in forms],
                        exhausted=backfill_exhausted,
                    )
                elif result.newest_submitted_at is not None:
                    await self._record_watermark(
                        lead_source_id=lead_source["_id"],
                        last_lead_created_at=result.newest_submitted_at,
                    )
            except Exception as prog_err:
                logger.warning(
                    "Could not record Meta import progress for source %s: %s; next poll will retry.",
                    str(lead_source["_id"]),
                    str(prog_err),
                )

        return result


def create_meta_lead_import_service(pipeline: LeadPipeline, **kwargs: Any) -> MetaLeadImportService:
    return MetaLeadImportService(pipeline=pipeline, **kwargs)

