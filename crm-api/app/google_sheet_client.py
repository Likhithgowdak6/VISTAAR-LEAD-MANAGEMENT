"""
Google Sheets export parser and fetcher.
Ported from Node's backend/src/modules/lead-sources/google-sheet.client.ts.
"""

from __future__ import annotations

import re
from typing import Any, Callable, NamedTuple
import httpx

from app.lead_sources_common import LeadSheetFetchError


class GoogleSheetRef(NamedTuple):
    sheet_id: str
    gid: str
    published: bool


EDIT_URL_PATTERN = re.compile(r"/spreadsheets/d/(?!e/)([a-zA-Z0-9-_]+)")
PUBLISHED_URL_PATTERN = re.compile(r"/spreadsheets/d/e/([a-zA-Z0-9-_]+)")
GID_PATTERN = re.compile(r"[#?&]gid=(\d+)")


def parse_google_sheet_url(url: Any) -> GoogleSheetRef | None:
    """Extracts spreadsheet id, gid, and published flag from edit or web-published links."""
    if not isinstance(url, str) or not url.strip():
        return None

    norm = url.strip()
    gid_match = GID_PATTERN.search(norm)
    gid = gid_match.group(1) if gid_match else "0"

    pub_match = PUBLISHED_URL_PATTERN.search(norm)
    if pub_match:
        return GoogleSheetRef(sheet_id=pub_match.group(1), gid=gid, published=True)

    edit_match = EDIT_URL_PATTERN.search(norm)
    if not edit_match:
        return None

    return GoogleSheetRef(sheet_id=edit_match.group(1), gid=gid, published=False)


def build_csv_export_url(sheet_ref: GoogleSheetRef) -> str:
    """Constructs direct CSV export URL."""
    if sheet_ref.published:
        return f"https://docs.google.com/spreadsheets/d/e/{sheet_ref.sheet_id}/pub?gid={sheet_ref.gid}&single=true&output=csv"
    return f"https://docs.google.com/spreadsheets/d/{sheet_ref.sheet_id}/export?format=csv&gid={sheet_ref.gid}"


def looks_like_html(body: str) -> bool:
    return bool(re.search(r"^\s*<(!doctype|html)", body, re.IGNORECASE))


async def fetch_sheet_csv(
    sheet_ref: GoogleSheetRef,
    client: httpx.AsyncClient | None = None,
    timeout_ms: int = 20_000,
) -> str:
    """
    Fetch CSV from Google Sheets.
    If the sheet is not link-shared, Google returns an HTML sign-in page, which raises LEAD_SHEET_NOT_SHARED.
    """
    url = build_csv_export_url(sheet_ref)
    timeout_secs = timeout_ms / 1000.0

    try:
        if client is not None:
            response = await client.get(url, follow_redirects=True, timeout=timeout_secs)
        else:
            async with httpx.AsyncClient() as c:
                response = await c.get(url, follow_redirects=True, timeout=timeout_secs)
    except Exception as error:
        raise LeadSheetFetchError("Could not reach the Google Sheet.", cause=error)

    if response.status_code != 200:
        code = "LEAD_SHEET_NOT_FOUND" if response.status_code == 404 else "LEAD_SHEET_FETCH_FAILED"
        raise LeadSheetFetchError(f"Google returned {response.status_code} for the sheet.", code=code)

    body = response.text
    if looks_like_html(body):
        raise LeadSheetFetchError(
            'The sheet is not link-shared. Set it to "anyone with the link can view".',
            code="LEAD_SHEET_NOT_SHARED",
        )

    return body

