"""
Tests for voice note verification and transcoding gating.
Ported from backend/src/modules/media/voice-note.test.ts.
"""

from unittest.mock import AsyncMock
import pytest

from app.voice_note import (
    is_ogg_opus,
    prepare_voice_note,
    probe_ffmpeg_available,
)


def _ogg_opus() -> bytes:
    return b"OggS" + (b"\x00" * 24) + b"OpusHead" + (b"\x00" * 8)


def _ogg_vorbis() -> bytes:
    return b"OggS" + (b"\x00" * 24) + b"vorbis" + (b"\x00" * 8)


def _webm_opus() -> bytes:
    return bytes([0x1A, 0x45, 0xDF, 0xA3]) + (b"\x00" * 64)


class TestIsOggOpus:
    def test_accepts_ogg_carrying_opus(self):
        assert is_ogg_opus(_ogg_opus()) is True

    def test_rejects_ogg_carrying_vorbis(self):
        # Container alone is not enough; WhatsApp plays Opus
        assert is_ogg_opus(_ogg_vorbis()) is False

    def test_rejects_webm(self):
        assert is_ogg_opus(_webm_opus()) is False

    def test_rejects_short_buffer(self):
        assert is_ogg_opus(b"OggS") is False


class TestPrepareVoiceNote:
    @pytest.mark.asyncio
    async def test_sends_ogg_opus_straight_through_without_ffmpeg(self):
        ffmpeg_mock = AsyncMock()

        result = await prepare_voice_note(
            bytes=_ogg_opus(),
            mime_type="audio/ogg; codecs=opus",
            ffmpeg=ffmpeg_mock,
        )

        assert result["ok"] is True
        assert result["mimeType"] == "audio/ogg"
        assert result["extension"] == ".ogg"
        assert result["converted"] is False
        ffmpeg_mock.assert_not_called()

    @pytest.mark.asyncio
    async def test_converts_chrome_webm_recording(self):
        converted_bytes = _ogg_opus()
        ffmpeg_mock = AsyncMock(return_value={"ok": True, "output": converted_bytes})

        result = await prepare_voice_note(
            bytes=_webm_opus(),
            mime_type="audio/webm;codecs=opus",
            ffmpeg=ffmpeg_mock,
        )

        assert result["ok"] is True
        assert result["mimeType"] == "audio/ogg"
        assert result["extension"] == ".ogg"
        assert result["converted"] is True
        ffmpeg_mock.assert_called_once()

        args = ffmpeg_mock.call_args[0][0]
        assert "-c:a" in args and "libopus" in args
        assert "-f" in args and "ogg" in args

    @pytest.mark.asyncio
    async def test_converts_ogg_file_that_is_not_opus(self):
        converted_bytes = _ogg_opus()
        ffmpeg_mock = AsyncMock(return_value={"ok": True, "output": converted_bytes})

        result = await prepare_voice_note(
            bytes=_ogg_vorbis(),
            mime_type="audio/ogg",
            ffmpeg=ffmpeg_mock,
        )

        assert result["ok"] is True
        assert result["converted"] is True
        ffmpeg_mock.assert_called_once()

    @pytest.mark.asyncio
    async def test_refuses_when_ffmpeg_not_installed(self):
        ffmpeg_mock = AsyncMock(return_value={"ok": False, "reason": "missing"})

        result = await prepare_voice_note(
            bytes=_webm_opus(),
            mime_type="audio/webm",
            ffmpeg=ffmpeg_mock,
        )

        assert result == {"ok": False, "reason": "transcode_unavailable"}

    @pytest.mark.asyncio
    async def test_reports_failed_conversion_separately(self):
        ffmpeg_mock = AsyncMock(return_value={"ok": False, "reason": "failed"})

        result = await prepare_voice_note(
            bytes=_webm_opus(),
            mime_type="audio/webm",
            ffmpeg=ffmpeg_mock,
        )

        assert result == {"ok": False, "reason": "transcode_failed"}

    @pytest.mark.asyncio
    async def test_refuses_output_that_is_not_ogg_opus(self):
        ffmpeg_mock = AsyncMock(return_value={"ok": True, "output": _webm_opus()})

        result = await prepare_voice_note(
            bytes=_webm_opus(),
            mime_type="audio/webm",
            ffmpeg=ffmpeg_mock,
        )

        assert result == {"ok": False, "reason": "transcode_failed"}


class TestProbeFfmpegAvailable:
    @pytest.mark.asyncio
    async def test_probe_ffmpeg(self):
        ffmpeg_mock = AsyncMock(return_value={"ok": True, "output": b"ffmpeg version 5.0"})
        avail = await probe_ffmpeg_available(ffmpeg=ffmpeg_mock)
        assert avail is True

        ffmpeg_missing = AsyncMock(return_value={"ok": False, "reason": "missing"})
        avail_missing = await probe_ffmpeg_available(ffmpeg=ffmpeg_missing)
        assert avail_missing is False

