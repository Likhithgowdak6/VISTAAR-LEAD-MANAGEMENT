"""
Turning a browser recording into something WhatsApp will actually play as a voice note.

A PORT OF backend/src/modules/media/voice-note.ts.

WhatsApp plays voice notes as Ogg/Opus; a WebM/Opus recording (produced by Chrome's
MediaRecorder) carries the same Opus frames in a container WhatsApp does not open.
So bytes must be converted into Ogg/Opus using ffmpeg. When ffmpeg is missing,
the voice note is refused with a clear message rather than sending silent audio.
"""

import asyncio
from typing import Any, Callable

from app.media_kinds import base_mime_type

OGG_MAGIC = b"OggS"
OPUS_HEAD = b"OpusHead"

FFMPEG_ARGS: tuple[str, ...] = (
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    "pipe:0",
    "-vn",
    "-map_metadata",
    "-1",
    "-ac",
    "1",
    "-ar",
    "48000",
    "-c:a",
    "libopus",
    "-b:a",
    "32k",
    "-f",
    "ogg",
    "pipe:1",
)

TRANSCODE_TIMEOUT_MS = 30_000


def is_ogg_opus(data: bytes) -> bool:
    """True only for Ogg carrying an Opus stream."""
    if len(data) < 4 or data[:4] != OGG_MAGIC:
        return False
    return OPUS_HEAD in data[:1024]


async def run_ffmpeg(
    args: tuple[str, ...],
    input_bytes: bytes,
    timeout_ms: int = TRANSCODE_TIMEOUT_MS,
) -> dict[str, Any]:
    """Runs ffmpeg with input on stdin and output on stdout; nothing touches disk."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg",
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        return {"ok": False, "reason": "missing"}
    except Exception:
        return {"ok": False, "reason": "failed"}

    try:
        stdout, _ = await asyncio.wait_for(
            proc.communicate(input=input_bytes),
            timeout=timeout_ms / 1000.0,
        )
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except Exception:
            pass
        return {"ok": False, "reason": "failed"}

    if proc.returncode == 0 and len(stdout) > 0:
        return {"ok": True, "output": stdout}
    return {"ok": False, "reason": "failed"}


async def prepare_voice_note(
    *,
    bytes: bytes,
    mime_type: str,
    ffmpeg: Callable[..., Any] = run_ffmpeg,
    timeout_ms: int = TRANSCODE_TIMEOUT_MS,
) -> dict[str, Any]:
    """
    Returns bytes that WhatsApp will play as a voice note, converting only when needed.
    """
    base = base_mime_type(mime_type)

    if (base == "audio/ogg" or base == "audio/opus") and is_ogg_opus(bytes):
        return {
            "ok": True,
            "bytes": bytes,
            "mimeType": "audio/ogg",
            "extension": ".ogg",
            "converted": False,
        }

    result = await ffmpeg(FFMPEG_ARGS, bytes, timeout_ms)

    if not result.get("ok"):
        reason = "transcode_unavailable" if result.get("reason") == "missing" else "transcode_failed"
        return {"ok": False, "reason": reason}

    output = result.get("output", b"")
    if not is_ogg_opus(output):
        return {"ok": False, "reason": "transcode_failed"}

    return {
        "ok": True,
        "bytes": output,
        "mimeType": "audio/ogg",
        "extension": ".ogg",
        "converted": True,
    }


async def probe_ffmpeg_available(ffmpeg: Callable[..., Any] = run_ffmpeg) -> bool:
    """Whether ffmpeg is callable at all."""
    result = await ffmpeg(("-hide_banner", "-version"), b"", 5_000)
    return bool(result.get("ok"))

