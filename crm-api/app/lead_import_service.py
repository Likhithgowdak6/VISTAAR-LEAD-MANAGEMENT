"""
Turns Meta lead-form submissions into CRM leads, whichever way they arrive.

PORTED FROM backend/src/modules/lead-sources/lead-import.service.ts.

This file owns the *sheet* leg (fetch the CSV export, parse it, map the rows) and the
per-source bookkeeping both legs share: which importer a source gets, and what `lastSyncStatus`
/ `lastSyncCounts` / `lastError` say afterwards. Everything from "here is a list of leads"
onwards lives in lead_pipeline.py, and the Graph API leg lives in
meta_lead_import_service.py — see the comment at the top of each.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Callable

from app.config import settings
from app.csv_parser import parse_delimited_text as default_parse_delimited_text
from app.google_sheet_client import fetch_sheet_csv as default_fetch_sheet_csv
from app.lead_pipeline import (
    LeadImportCounts,
    LeadPipeline,
    create_lead_pipeline,
    describe_error,
)
from app.lead_sources_common import (
    LEAD_SOURCE_SYNC_STATUSES,
)
from app.lead_sources_repository import (
    find_active_lead_sources as default_find_active_lead_sources,
    record_lead_source_sync as default_record_lead_source_sync,
)
from app.meta_lead_import_service import (
    MetaLeadImportService,
    create_meta_lead_import_service,
    is_meta_lead_source,
    sync_status_for_meta_error,
)
from app.meta_lead_mapper import map_meta_lead_row as default_map_meta_lead_row

logger = logging.getLogger(__name__)


class LeadImportService:
    """
    Coordinates polling synchronization across Google Sheet and Meta Lead Ads lead sources.
    """

    def __init__(
        self,
        *,
        pipeline: LeadPipeline | None = None,
        meta_importer: MetaLeadImportService | None = None,
        fn_fetch_sheet: Callable[..., Any] = default_fetch_sheet_csv,
        fn_parse_delimited: Callable[..., Any] = default_parse_delimited_text,
        fn_map_row: Callable[..., Any] = default_map_meta_lead_row,
        fn_find_active_sources: Callable[..., Any] = default_find_active_lead_sources,
        fn_record_sync: Callable[..., Any] = default_record_lead_source_sync,
        now_fn: Callable[[], datetime] | None = None,
    ):
        self.pipeline = pipeline or create_lead_pipeline()
        self.meta_importer = meta_importer or create_meta_lead_import_service(pipeline=self.pipeline)
        self._fetch_sheet = fn_fetch_sheet
        self._parse_delimited = fn_parse_delimited
        self._map_row = fn_map_row
        self._find_active_sources = fn_find_active_sources
        self._record_sync = fn_record_sync
        self._now = now_fn or (lambda: datetime.now(timezone.utc))

    async def import_from_sheet(self, lead_source: dict[str, Any]) -> LeadImportCounts:
        sheet_url = lead_source.get("sheetUrl") or ""
        sheet_id = lead_source.get("sheetId") or ""
        gid = lead_source.get("gid") or "0"
        is_published = "/spreadsheets/d/e/" in sheet_url

        csv_text = await self._fetch_sheet(
            sheet_id=sheet_id,
            gid=gid,
            published=is_published,
        )

        parse_res = self._parse_delimited(csv_text)
        rows = getattr(parse_res, "rows", []) if hasattr(parse_res, "rows") else parse_res.get("rows", [])

        col_mapping = lead_source.get("columnMapping")
        leads = [self._map_row(row=r, column_mapping=col_mapping) for r in rows]

        batch_result = await self.pipeline.import_leads(lead_source=lead_source, leads=leads)
        return batch_result.counts

    async def import_from_source(self, lead_source: dict[str, Any]) -> LeadImportCounts:
        """The dispatch. Which importer a source gets is decided here and nowhere else."""
        if is_meta_lead_source(lead_source):
            batch_result = await self.meta_importer.import_from_source(lead_source)
            return batch_result.counts

        return await self.import_from_sheet(lead_source)

    async def sync_source(self, lead_source: dict[str, Any]) -> LeadImportCounts:
        ls_id = lead_source["_id"]
        synced_at = self._now()

        try:
            counts = await self.import_from_source(lead_source)

            sync_status = (
                LEAD_SOURCE_SYNC_STATUSES.FAILED
                if counts.failed > 0
                else LEAD_SOURCE_SYNC_STATUSES.OK
            )
            last_err = f"{counts.failed} row(s) failed to import." if counts.failed > 0 else None

            await self._record_sync(
                lead_source_id=ls_id,
                sync_status=sync_status,
                last_error=last_err,
                counts={
                    "imported": counts.imported,
                    "duplicates": counts.duplicates,
                    "skipped": counts.skipped,
                    "failed": counts.failed,
                },
                imported_increment=counts.imported,
                synced_at=synced_at,
            )
            return counts
        except Exception as exc:
            # A dead Meta token is not "the last sync failed", it is "this source has stopped working
            # and only a human can restart it". The distinction is the difference between a red badge
            # an admin learns to ignore and one that means something.
            is_meta = is_meta_lead_source(lead_source)
            sync_status = sync_status_for_meta_error(exc) if is_meta else LEAD_SOURCE_SYNC_STATUSES.FAILED

            await self._record_sync(
                lead_source_id=ls_id,
                sync_status=sync_status,
                last_error=describe_error(exc),
                synced_at=synced_at,
            )
            raise

    async def drain(self) -> LeadImportCounts:
        """
        Polls every active lead source. Failure isolated per source.
        """
        imported_total = 0
        duplicates_total = 0
        skipped_total = 0
        failed_total = 0

        sources = await self._find_active_sources()

        for ls in sources:
            try:
                counts = await self.sync_source(ls)
                imported_total += counts.imported
                duplicates_total += counts.duplicates
                skipped_total += counts.skipped
                failed_total += counts.failed
            except Exception as exc:
                logger.warning(
                    "Lead source sync failed safely for source %s: %s",
                    str(ls.get("_id")),
                    describe_error(exc),
                )

        return LeadImportCounts(
            imported=imported_total,
            duplicates=duplicates_total,
            skipped=skipped_total,
            failed=failed_total,
        )


def create_lead_import_service(**kwargs: Any) -> LeadImportService:
    return LeadImportService(**kwargs)

