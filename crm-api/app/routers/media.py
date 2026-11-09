"""
Attachment upload and download endpoints.

A PORT OF backend/src/modules/media/media.controller.ts and media.routes.ts.

TWO SIDES OF AN ATTACHMENT'S LIFE OVER HTTP:
  1. Uploaded to a conversation (POST /conversations/:conversationId/media)
  2. Read back from a message (GET /messages/:messageId/media)

UPLOAD IS NOT SEND:
  This route validates the file, converts voice notes if needed, stores bytes on disk,
  and returns a scoped mediaObjectKey. No message row exists yet and nothing reaches WhatsApp.
  The subsequent send carries the key and is idempotent. Splitting them means a 12 MB video
  uploads once under its own progress bar, and a double-tap on Send cannot re-upload it.

THE KEY IS SCOPED AND RE-CHECKED:
  Keys are minted as `<organizationId>/<conversationId>/<uuid>.<ext>`. The upload verifies
  the caller has visibility of the conversation, and the later message-send re-verifies that
  the key matches the thread being sent to.

DOWNLOAD IS STRICTLY AUTHENTICATED:
  There is no static mount and no signed public URL. Every byte passes through download_message_media
  after checking the caller's session against the message's organization AND their visibility
  of the conversation it belongs to. Assignment-restricted staff cannot download photos from
  threads they are not permitted to read.

HEADERS DEFEND AGAINST CONTENT SNIFFING AND CROSS-ORIGIN EXECUTION:
  - `X-Content-Type-Options: nosniff`
  - `Content-Security-Policy: default-src 'none'; sandbox`
  - `Cache-Control: private, max-age=3600, immutable`
  - Inline disposition for image/video/audio; attachment disposition for all documents.
"""

import os
import re
from typing import Any

from bson import ObjectId
from fastapi import APIRouter, Depends, File, Form, HTTPException, Path, UploadFile
from fastapi.responses import FileResponse

from app import db
from app.config import settings
from app.conversation_access import (
    ConversationAccessDenied,
    ConversationNotFound,
    http_error,
    load_visible_conversation_for_actor,
)
from app.deps import AuthContext, require_any_permission
from app.media_kinds import is_inline_safe_media_type, resolve_media_format
from app.media_storage import (
    build_media_object_key,
    get_media_storage,
)
from app.permissions import (
    CONVERSATIONS_READ_ALL,
    CONVERSATIONS_READ_ASSIGNED,
    MESSAGES_SEND,
)
from app.voice_note import prepare_voice_note

#: Regex pattern for a 24-character hexadecimal MongoDB ObjectId.
#: Case-insensitive matching matches Node's objectIdSchema.
OBJECT_ID_REGEX = r"^[a-fA-F0-9]{24}$"
OBJECT_ID_PATTERN = re.compile(OBJECT_ID_REGEX)

UPLOAD_ERROR_MESSAGES: dict[str, tuple[int, str]] = {
    "empty_file": (400, "That file is empty."),
    "unsupported_type": (415, "That file type cannot be sent on WhatsApp."),
    "content_mismatch": (415, "That file's contents do not match its type."),
    "transcode_unavailable": (
        503,
        "Voice notes need ffmpeg installed on the server. Send it as an audio file instead, or ask your administrator to install ffmpeg.",
    ),
    "transcode_failed": (422, "That recording could not be converted into a voice note."),
}

_require_send = require_any_permission(MESSAGES_SEND)
_require_read = require_any_permission(CONVERSATIONS_READ_ASSIGNED, CONVERSATIONS_READ_ALL)

conversation_router = APIRouter()
messages_router = APIRouter()
router = messages_router


def _fail_upload(reason: str) -> None:
    """Raises HTTPException with the mapped status code and uppercase code."""
    status_code, message = UPLOAD_ERROR_MESSAGES.get(
        reason, (400, "That file could not be uploaded.")
    )
    raise HTTPException(
        status_code=status_code,
        detail={"error": {"code": reason.upper(), "message": message}},
    )


@conversation_router.post(
    "",
    status_code=201,
)
async def upload_conversation_media(
    conversationId: str = Path(..., pattern=OBJECT_ID_REGEX),
    file: UploadFile | None = File(None),
    kind: str = Form("file"),
    auth: AuthContext = Depends(_require_send),
) -> dict[str, Any]:
    """
    Stages an attachment file for a conversation before sending.

    Validates visibility, checks container format signatures against allowlists,
    transcodes voice notes when requested, stores bytes in media storage, and returns
    the generated scoped objectKey with metadata.
    """
    if file is None:
        raise HTTPException(
            status_code=400,
            detail={"error": {"code": "NO_FILE", "message": "No file was uploaded."}},
        )

    if kind not in ("file", "voice"):
        raise HTTPException(
            status_code=400,
            detail={"error": {"code": "INVALID_KIND", "message": "kind must be 'file' or 'voice'."}},
        )

    # 1. Authorization before anything is done with the bytes: check visibility.
    conv_oid = ObjectId(conversationId)
    org_oid = auth.organization["_id"]
    if not isinstance(org_oid, ObjectId):
        org_oid = ObjectId(str(org_oid))

    try:
        conversation = await load_visible_conversation_for_actor(
            organization_id=org_oid,
            conversation_id=conv_oid,
            permissions=auth.permissions,
            actor_id=auth.user["_id"],
        )
    except (ConversationNotFound, ConversationAccessDenied) as exc:
        raise http_error(exc)

    # 2. Read bytes into memory and enforce max upload size limit.
    bytes_data = await file.read()
    max_bytes = getattr(settings, "media_max_upload_bytes", 16 * 1024 * 1024)
    if len(bytes_data) > max_bytes:
        mb = round(max_bytes / (1024 * 1024))
        raise HTTPException(
            status_code=413,
            detail={
                "error": {
                    "code": "LIMIT_FILE_SIZE",
                    "message": f"That file is too large. The limit is {mb} MB.",
                }
            },
        )

    # 3. Validate format against allowlist & sniff container magic bytes.
    format_info = resolve_media_format(
        declared_mime_type=file.content_type,
        file_name=file.filename,
        bytes=bytes_data,
    )

    if not format_info.get("ok"):
        _fail_upload(format_info.get("reason", "unsupported_type"))

    message_type = format_info["messageType"]
    mime_type = format_info["mimeType"]
    file_name = format_info["fileName"]
    dot_idx = file_name.rfind(".")
    extension = file_name[dot_idx:] if dot_idx >= 0 else ".bin"
    is_voice_note = False

    # 4. Handle voice note conversion if kind == 'voice'.
    if kind == "voice":
        if message_type != "audio":
            _fail_upload("unsupported_type")

        prepared = await prepare_voice_note(bytes=bytes_data, mime_type=mime_type)
        if not prepared.get("ok"):
            _fail_upload(prepared.get("reason", "transcode_failed"))

        bytes_data = prepared["bytes"]
        mime_type = prepared["mimeType"]
        extension = prepared["extension"]
        file_name = f"voice-note{extension}"
        is_voice_note = True

    # 5. Mint scoped key and write to disk with exclusive creation.
    object_key = build_media_object_key(
        organization_id=str(org_oid),
        conversation_id=str(conversation["_id"]),
        extension=extension,
    )

    storage = get_media_storage()
    await storage.write_media_object(object_key=object_key, bytes=bytes_data)

    return {
        "data": {
            "objectKey": object_key,
            "type": message_type,
            "mimeType": mime_type,
            "fileName": file_name,
            "sizeBytes": len(bytes_data),
            "isVoiceNote": is_voice_note,
        }
    }


@messages_router.get(
    "/{messageId}/media",
)
async def download_message_media(
    messageId: str = Path(..., pattern=OBJECT_ID_REGEX),
    auth: AuthContext = Depends(_require_read),
) -> FileResponse:
    """
    Downloads the media attachment associated with a stored message.

    Enforces organization isolation, conversation visibility, existence in disk storage,
    and returns FileResponse with security headers (nosniff, CSP sandbox, private Cache-Control).
    """
    msg_oid = ObjectId(messageId)
    org_oid = auth.organization["_id"]
    if not isinstance(org_oid, ObjectId):
        org_oid = ObjectId(str(org_oid))

    message = await db.get_database()["messages"].find_one(
        {"_id": msg_oid, "organizationId": org_oid}
    )

    if not message:
        raise HTTPException(
            status_code=404,
            detail={"error": {"code": "MESSAGE_NOT_FOUND", "message": "Message not found."}},
        )

    # Actor visibility check for the thread
    conv_id = message.get("conversationId")
    if not isinstance(conv_id, ObjectId):
        conv_id = ObjectId(str(conv_id))

    try:
        await load_visible_conversation_for_actor(
            organization_id=org_oid,
            conversation_id=conv_id,
            permissions=auth.permissions,
            actor_id=auth.user["_id"],
        )
    except (ConversationNotFound, ConversationAccessDenied) as exc:
        raise http_error(exc)

    media_object_key = message.get("mediaObjectKey")
    media_meta = message.get("media") or {}
    storage_status = media_meta.get("storageStatus")

    if not media_object_key or storage_status != "stored":
        raise HTTPException(
            status_code=404,
            detail={"error": {"code": "MEDIA_NOT_AVAILABLE", "message": "This attachment is not available."}},
        )

    storage = get_media_storage()
    stat = await storage.stat_media_object(media_object_key)

    if not stat.get("exists"):
        raise HTTPException(
            status_code=404,
            detail={"error": {"code": "MEDIA_NOT_AVAILABLE", "message": "This attachment is no longer stored."}},
        )

    mime_type = media_meta.get("mimeType") or "application/octet-stream"
    raw_file_name = media_meta.get("fileName") or "attachment"
    safe_file_name = raw_file_name.replace('"', "").replace("\\", "")
    disposition = "inline" if is_inline_safe_media_type(mime_type) else "attachment"

    headers = {
        "Content-Type": mime_type,
        "Content-Length": str(stat["sizeBytes"]),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Disposition": f'{disposition}; filename="{safe_file_name}"',
        "Cache-Control": "private, max-age=3600, immutable",
    }

    file_path = storage.get_object_path(media_object_key)
    return FileResponse(
        path=str(file_path),
        media_type=mime_type,
        headers=headers,
    )
