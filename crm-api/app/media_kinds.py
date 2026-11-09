"""
What the CRM is willing to accept as an attachment, and how it decides.

A PORT OF backend/src/modules/media/media-kinds.ts.

TWO INDEPENDENT ANSWERS MUST AGREE. The browser tells us a MIME type, and the first bytes of
the file tell us a container format. Either on its own is a bad gate: the declared type is
attacker-controlled (a `.exe` announced as `image/png`), and a signature alone cannot tell a
.docx from a .xlsx because both are zip archives. So the declared type must be on the
allowlist below, AND the bytes must be a container that type is actually stored in. A
disagreement is refused rather than guessed at.

WHAT THIS IS NOT. It is not a virus scanner and does not claim to be. Nothing here is ever
executed, rendered as HTML, or served from the app's own origin as an inline document - the
download route sets a non-negotiable Content-Type and attaches rather than displays anything
that is not an image, a video or an audio file.
"""

import re
from typing import Any, NamedTuple


class AcceptedMediaFormat(NamedTuple):
    message_type: str
    signatures: tuple[str, ...]
    extension: str


ACCEPTED_MEDIA_FORMATS: dict[str, AcceptedMediaFormat] = {
    "image/jpeg": AcceptedMediaFormat("image", ("jpeg",), ".jpg"),
    "image/png": AcceptedMediaFormat("image", ("png",), ".png"),
    "image/webp": AcceptedMediaFormat("image", ("webp",), ".webp"),
    "image/gif": AcceptedMediaFormat("image", ("gif",), ".gif"),

    "video/mp4": AcceptedMediaFormat("video", ("isobmff",), ".mp4"),
    "video/quicktime": AcceptedMediaFormat("video", ("isobmff",), ".mov"),
    "video/3gpp": AcceptedMediaFormat("video", ("isobmff",), ".3gp"),
    "video/webm": AcceptedMediaFormat("video", ("matroska",), ".webm"),

    "audio/mpeg": AcceptedMediaFormat("audio", ("mp3",), ".mp3"),
    "audio/mp4": AcceptedMediaFormat("audio", ("isobmff",), ".m4a"),
    "audio/x-m4a": AcceptedMediaFormat("audio", ("isobmff",), ".m4a"),
    "audio/ogg": AcceptedMediaFormat("audio", ("ogg",), ".ogg"),
    "audio/opus": AcceptedMediaFormat("audio", ("ogg",), ".opus"),
    "audio/webm": AcceptedMediaFormat("audio", ("matroska",), ".webm"),
    "audio/wav": AcceptedMediaFormat("audio", ("wav",), ".wav"),
    "audio/x-wav": AcceptedMediaFormat("audio", ("wav",), ".wav"),
    "audio/amr": AcceptedMediaFormat("audio", ("amr",), ".amr"),

    "application/pdf": AcceptedMediaFormat("document", ("pdf",), ".pdf"),
    "application/msword": AcceptedMediaFormat("document", ("ole2",), ".doc"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": AcceptedMediaFormat("document", ("zip",), ".docx"),
    "application/vnd.ms-excel": AcceptedMediaFormat("document", ("ole2",), ".xls"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": AcceptedMediaFormat("document", ("zip",), ".xlsx"),
    "application/vnd.ms-powerpoint": AcceptedMediaFormat("document", ("ole2",), ".ppt"),
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": AcceptedMediaFormat("document", ("zip",), ".pptx"),
    "text/plain": AcceptedMediaFormat("document", (), ".txt"),
    "text/csv": AcceptedMediaFormat("document", (), ".csv"),
}


def _matches_at(data: bytes, signature: bytes, offset: int) -> bool:
    if len(data) < offset + len(signature):
        return False
    return data[offset : offset + len(signature)] == signature


def sniff_media_signature(data: bytes) -> str | None:
    """
    The container format of a buffer, or None if it is not one we recognise.

    Only the first few bytes are read, so this is cheap enough to run on every upload
    before anything is written to disk.
    """
    if _matches_at(data, b"\xff\xd8\xff", 0):
        return "jpeg"

    if _matches_at(data, b"\x89PNG\r\n\x1a\n", 0):
        return "png"

    if _matches_at(data, b"GIF8", 0):
        return "gif"

    # RIFF family (WebP or WAV)
    if _matches_at(data, b"RIFF", 0):
        if _matches_at(data, b"WEBP", 8):
            return "webp"
        if _matches_at(data, b"WAVE", 8):
            return "wav"
        return None

    if _matches_at(data, b"ftyp", 4):
        return "isobmff"

    if _matches_at(data, b"\x1a\x45\xdf\xa3", 0):
        return "matroska"

    if _matches_at(data, b"OggS", 0):
        return "ogg"

    if _matches_at(data, b"ID3", 0):
        return "mp3"

    # Bare MPEG frame sync: 11 set bits
    if len(data) >= 2 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0:
        return "mp3"

    if _matches_at(data, b"#!AMR", 0):
        return "amr"

    if _matches_at(data, b"%PDF-", 0):
        return "pdf"

    if _matches_at(data, b"PK\x03\x04", 0):
        return "zip"

    if _matches_at(data, b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", 0):
        return "ole2"

    return None


def base_mime_type(mime_type: str | None) -> str:
    """Strips parameters off a MIME type: audio/webm;codecs=opus -> audio/webm"""
    return str(mime_type or "").split(";")[0].strip().lower()


_PATH_RE = re.compile(r"^.*[\\/]")
_EXT_RE = re.compile(r"\.[^.]*$")
_CONTROL_CHARS_RE = re.compile(r'[\u0000-\u001f\u007f"\'`\\/:*?<>|]+')
_SPACES_RE = re.compile(r"\s+")


def to_safe_file_name(raw_name: str | None, extension: str) -> str:
    """
    A filename safe to store, to put in a Content-Disposition header, and to hand to WhatsApp.

    Directory parts are dropped rather than escaped, and the canonical extension is forced on.
    """
    without_path = _PATH_RE.sub("", str(raw_name or ""))
    base = _EXT_RE.sub("", without_path)
    base = _CONTROL_CHARS_RE.sub(" ", base)
    base = _SPACES_RE.sub(" ", base).strip()[:120]

    safe_base = base if base != "" else "attachment"
    return f"{safe_base}{extension}"


def resolve_media_format(
    *,
    declared_mime_type: str | None,
    file_name: str | None,
    bytes: bytes,
) -> dict[str, Any]:
    """
    Decides what an uploaded buffer actually is, refusing anything the two answers disagree about.
    """
    if len(bytes) == 0:
        return {"ok": False, "reason": "empty_file"}

    mime_type = base_mime_type(declared_mime_type)
    format_info = ACCEPTED_MEDIA_FORMATS.get(mime_type)

    if not format_info:
        return {"ok": False, "reason": "unsupported_type"}

    signature = sniff_media_signature(bytes)

    if len(format_info.signatures) > 0 and (not signature or signature not in format_info.signatures):
        return {"ok": False, "reason": "content_mismatch"}

    return {
        "ok": True,
        "mimeType": mime_type,
        "messageType": format_info.message_type,
        "fileName": to_safe_file_name(file_name, format_info.extension),
        "signature": signature,
    }


def is_inline_safe_media_type(mime_type: str | None) -> bool:
    """
    Whether a stored file may be shown inline by the download route.
    Images, video and audio are safe; documents are always downloaded as attachments.
    """
    base = base_mime_type(mime_type)
    format_info = ACCEPTED_MEDIA_FORMATS.get(base)
    if not format_info:
        return False

    return format_info.message_type in ("image", "video", "audio")

