"""
Delimited text (CSV/TSV) reader compatible with Google Sheet exports.
Ported from Node's backend/src/modules/lead-sources/csv.parser.ts.

RFC 4180 reader: handles quoted fields, `""` escapes, and delimiters or newlines
inside quotes. Google's CSV export is comma-separated, but sheets pasted or
re-exported as TSV are handled by auto-detecting the delimiter on the header line.
"""

from __future__ import annotations

from typing import Any, NamedTuple


BYTE_ORDER_MARK = "\ufeff"


class ParsedTable(NamedTuple):
    headers: list[str]
    rows: list[dict[str, str]]


def detect_delimiter(text: str) -> str:
    """Picks tab if first line has more tabs than commas, else comma."""
    first_line = text.splitlines()[0] if text.splitlines() else ""
    return "\t" if first_line.count("\t") > first_line.count(",") else ","


def split_records(text: str, delimiter: str) -> list[list[str]]:
    """RFC 4180 state machine matching Node's implementation."""
    records: list[list[str]] = []
    fields: list[str] = []
    field = ""
    in_quotes = False
    index = 0
    length = len(text)

    def end_field() -> None:
        nonlocal field
        fields.append(field)
        field = ""

    def end_record() -> None:
        nonlocal fields
        end_field()
        records.append(fields)
        fields = []

    while index < length:
        char = text[index]

        if in_quotes:
            if char == '"':
                if index + 1 < length and text[index + 1] == '"':
                    field += '"'
                    index += 2
                    continue
                in_quotes = False
                index += 1
                continue
            field += char
            index += 1
            continue

        if char == '"' and field == "":
            in_quotes = True
            index += 1
            continue

        if char == delimiter:
            end_field()
            index += 1
            continue

        if char == "\r":
            index += 1
            continue

        if char == "\n":
            end_record()
            index += 1
            continue

        field += char
        index += 1

    if field != "" or len(fields) > 0:
        end_record()

    return records


def is_blank_record(record: list[str]) -> bool:
    return all(value.strip() == "" for value in record)


def parse_delimited_text(text: Any, delimiter: str | None = None) -> ParsedTable:
    """Parse CSV or TSV text into headers and list of row dicts."""
    raw = str(text or "").replace(BYTE_ORDER_MARK, "")
    if not raw.strip():
        return ParsedTable(headers=[], rows=[])

    delim = delimiter or detect_delimiter(raw)
    records = split_records(raw, delim)
    if not records:
        return ParsedTable(headers=[], rows=[])

    header_record = records.pop(0)
    raw_headers = [h.strip() for h in header_record]

    valid_headers = [h for h in raw_headers if h != ""]
    rows: list[dict[str, str]] = []

    for record in records:
        if is_blank_record(record):
            continue
        row: dict[str, str] = {}
        for col_idx, header in enumerate(raw_headers):
            if not header:
                continue
            val = record[col_idx].strip() if col_idx < len(record) else ""
            row[header] = val
        rows.append(row)

    return ParsedTable(headers=valid_headers, rows=rows)

