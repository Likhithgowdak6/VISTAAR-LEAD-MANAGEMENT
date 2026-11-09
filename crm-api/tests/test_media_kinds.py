"""
Tests for media kinds, MIME normalization, container magic bytes sniffing, safe filename sanitization,
and inline-safety gating. Ported from backend/src/modules/media/media-kinds.test.ts, verified against
tests/fixtures/media.json.
"""

import json
from pathlib import Path
import pytest

from app.media_kinds import (
    is_inline_safe_media_type,
    resolve_media_format,
    sniff_media_signature,
    to_safe_file_name,
)

FIXTURES_PATH = Path(__file__).parent / "fixtures" / "media.json"


def _bytes(*vals: int) -> bytes:
    return bytes(vals)


def _with_ascii(text: str, padding: int = 0) -> bytes:
    return text.encode("ascii") + (b"\x00" * padding)


JPEG = _bytes(0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10)
PNG = _bytes(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00)
PDF = _with_ascii("%PDF-1.7\n", 8)
ZIP = _bytes(0x50, 0x4B, 0x03, 0x04, 0x14, 0x00)
OGG = _with_ascii("OggS", 24)
MATROSKA = _bytes(0x1A, 0x45, 0xDF, 0xA3, 0x01, 0x00)
MP4 = _bytes(0x00, 0x00, 0x00, 0x18) + b"ftypmp42"
WEBP = b"RIFF" + _bytes(0x00, 0x00, 0x00, 0x00) + b"WEBP"
WAV = b"RIFF" + _bytes(0x00, 0x00, 0x00, 0x00) + b"WAVE"
EXECUTABLE = _bytes(0x4D, 0x5A, 0x90, 0x00, 0x03)


class TestSniffMediaSignature:
    @pytest.mark.parametrize(
        ("expected", "data"),
        [
            ("jpeg", JPEG),
            ("png", PNG),
            ("pdf", PDF),
            ("zip", ZIP),
            ("ogg", OGG),
            ("matroska", MATROSKA),
            ("isobmff", MP4),
            ("webp", WEBP),
            ("wav", WAV),
        ],
    )
    def test_recognises_container(self, expected: str, data: bytes):
        assert sniff_media_signature(data) == expected

    def test_tells_webp_and_wav_apart(self):
        # Both start with RIFF. Reading 4 bytes would confuse them.
        assert sniff_media_signature(WEBP) == "webp"
        assert sniff_media_signature(WAV) == "wav"

    def test_returns_none_for_unrecognised_file(self):
        assert sniff_media_signature(EXECUTABLE) is None
        assert sniff_media_signature(b"") is None


class TestResolveMediaFormat:
    def test_accepts_valid_photo(self):
        res = resolve_media_format(
            declared_mime_type="image/jpeg",
            file_name="venue.jpg",
            bytes=JPEG,
        )
        assert res["ok"] is True
        assert res["mimeType"] == "image/jpeg"
        assert res["messageType"] == "image"
        assert res["fileName"] == "venue.jpg"

    def test_refuses_executable_dressed_as_photo(self):
        res = resolve_media_format(
            declared_mime_type="image/png",
            file_name="totally-a-photo.png",
            bytes=EXECUTABLE,
        )
        assert res == {"ok": False, "reason": "content_mismatch"}

    def test_refuses_unsupported_type(self):
        res = resolve_media_format(
            declared_mime_type="application/x-msdownload",
            file_name="setup.exe",
            bytes=EXECUTABLE,
        )
        assert res == {"ok": False, "reason": "unsupported_type"}

    def test_refuses_empty_file(self):
        res = resolve_media_format(
            declared_mime_type="image/jpeg",
            file_name="x.jpg",
            bytes=b"",
        )
        assert res == {"ok": False, "reason": "empty_file"}

    def test_strips_codec_parameters(self):
        res = resolve_media_format(
            declared_mime_type="audio/webm;codecs=opus",
            file_name="note.webm",
            bytes=MATROSKA,
        )
        assert res["ok"] is True
        assert res["mimeType"] == "audio/webm"
        assert res["messageType"] == "audio"

    def test_accepts_docx_as_zip(self):
        res = resolve_media_format(
            declared_mime_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            file_name="brief.docx",
            bytes=ZIP,
        )
        assert res["ok"] is True
        assert res["messageType"] == "document"
        assert res["fileName"] == "brief.docx"

    def test_takes_plain_text_on_its_word(self):
        res = resolve_media_format(
            declared_mime_type="text/plain",
            file_name="notes.txt",
            bytes=b"just words",
        )
        assert res["ok"] is True
        assert res["messageType"] == "document"

    def test_forces_canonical_extension(self):
        res = resolve_media_format(
            declared_mime_type="application/pdf",
            file_name="invoice.pdf.exe",
            bytes=PDF,
        )
        assert res["ok"] is True
        assert res["fileName"] == "invoice.pdf.pdf"


class TestSafeFileName:
    def test_drops_directory_part(self):
        assert to_safe_file_name("../../etc/passwd", ".txt") == "passwd.txt"
        assert to_safe_file_name("C:\\Users\\x\\secret.pdf", ".pdf") == "secret.pdf"

    def test_removes_quotes(self):
        assert to_safe_file_name('a"weird\'name.pdf', ".pdf") == "a weird name.pdf"

    def test_falls_back_when_empty(self):
        assert to_safe_file_name("", ".pdf") == "attachment.pdf"
        assert to_safe_file_name("///", ".pdf") == "attachment.pdf"

    def test_truncates_long_names(self):
        res = to_safe_file_name("a" * 400, ".pdf")
        assert len(res) == 124

    def test_fixture_parity(self):
        with open(FIXTURES_PATH, "r", encoding="utf-8") as f:
            fixtures = json.load(f)
        for item in fixtures.get("safeFileName", []):
            inp = item["input"]
            out = to_safe_file_name(inp["raw"], inp["ext"])
            assert out == item["output"], f"Failed for {inp}: expected {item['output']} got {out}"


class TestInlineSafeMediaType:
    def test_allows_safe_types(self):
        assert is_inline_safe_media_type("image/png") is True
        assert is_inline_safe_media_type("video/mp4") is True
        assert is_inline_safe_media_type("audio/ogg") is True

    def test_refuses_documents(self):
        assert is_inline_safe_media_type("application/pdf") is False
        assert is_inline_safe_media_type("text/plain") is False
        assert is_inline_safe_media_type("application/octet-stream") is False
        assert is_inline_safe_media_type(None) is False

    def test_fixture_parity(self):
        with open(FIXTURES_PATH, "r", encoding="utf-8") as f:
            fixtures = json.load(f)
        for item in fixtures.get("inlineSafe", []):
            out = is_inline_safe_media_type(item["input"])
            assert out == item["output"], f"Failed for {item['input']}: expected {item['output']} got {out}"

