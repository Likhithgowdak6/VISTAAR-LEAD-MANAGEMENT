"""
Tests for csv_parser.py and google_sheet_client.py.
"""

import pytest
import httpx

from app.csv_parser import parse_delimited_text, detect_delimiter
from app.google_sheet_client import (
    GoogleSheetRef,
    build_csv_export_url,
    fetch_sheet_csv,
    parse_google_sheet_url,
)
from app.lead_sources_common import LeadSheetFetchError


def test_detect_delimiter():
    assert detect_delimiter("a,b,c\n1,2,3") == ","
    assert detect_delimiter("a\tb\tc\n1\t2\t3") == "\t"


def test_parse_delimited_text_csv():
    csv_text = 'full_name,phone_number,event_date,package\nRiya Sharma,"+91 98765-43210","12 January, 2026","Only ""Photography"""\n'
    table = parse_delimited_text(csv_text)
    assert table.headers == ["full_name", "phone_number", "event_date", "package"]
    assert len(table.rows) == 1
    row = table.rows[0]
    assert row["full_name"] == "Riya Sharma"
    assert row["phone_number"] == "+91 98765-43210"
    assert row["event_date"] == "12 January, 2026"
    assert row["package"] == 'Only "Photography"'


def test_parse_delimited_text_empty_and_trailing_columns():
    csv_text = "name,email,\nAlice,alice@example.com,\n"
    table = parse_delimited_text(csv_text)
    assert table.headers == ["name", "email"]
    assert len(table.rows) == 1
    assert table.rows[0]["name"] == "Alice"
    assert table.rows[0]["email"] == "alice@example.com"


def test_parse_google_sheet_url():
    edit_url = "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit#gid=12345"
    ref = parse_google_sheet_url(edit_url)
    assert ref is not None
    assert ref.sheet_id == "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms"
    assert ref.gid == "12345"
    assert ref.published is False

    pub_url = "https://docs.google.com/spreadsheets/d/e/2PACX-1vT1/pubhtml?gid=678"
    pub_ref = parse_google_sheet_url(pub_url)
    assert pub_ref is not None
    assert pub_ref.sheet_id == "2PACX-1vT1"
    assert pub_ref.gid == "678"
    assert pub_ref.published is True

    assert parse_google_sheet_url("not a sheet url") is None


def test_build_csv_export_url():
    ref = GoogleSheetRef("sheet1", "0", False)
    assert build_csv_export_url(ref) == "https://docs.google.com/spreadsheets/d/sheet1/export?format=csv&gid=0"

    pub_ref = GoogleSheetRef("pub1", "123", True)
    assert build_csv_export_url(pub_ref) == "https://docs.google.com/spreadsheets/d/e/pub1/pub?gid=123&single=true&output=csv"


@pytest.mark.asyncio
async def test_fetch_sheet_csv_success():
    def handler(request):
        return httpx.Response(200, text="a,b\n1,2")

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        ref = GoogleSheetRef("test", "0", False)
        csv = await fetch_sheet_csv(ref, client=client)
        assert csv == "a,b\n1,2"


@pytest.mark.asyncio
async def test_fetch_sheet_csv_html_signin_raises_not_shared():
    def handler(request):
        return httpx.Response(200, text="<!DOCTYPE html><html>Sign in</html>")

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        ref = GoogleSheetRef("test", "0", False)
        with pytest.raises(LeadSheetFetchError) as exc_info:
            await fetch_sheet_csv(ref, client=client)
        assert exc_info.value.code == "LEAD_SHEET_NOT_SHARED"


@pytest.mark.asyncio
async def test_fetch_sheet_csv_404_raises_not_found():
    def handler(request):
        return httpx.Response(404, text="Not Found")

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        ref = GoogleSheetRef("test", "0", False)
        with pytest.raises(LeadSheetFetchError) as exc_info:
            await fetch_sheet_csv(ref, client=client)
        assert exc_info.value.code == "LEAD_SHEET_NOT_FOUND"
