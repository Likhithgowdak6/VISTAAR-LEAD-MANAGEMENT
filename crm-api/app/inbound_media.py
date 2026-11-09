"""
Fetching the bytes behind an attachment a lead sent us.

A PORT OF backend/src/modules/media/inbound-media.service.ts.

WHY THIS IS CAREFUL:
- OFF BY DEFAULT (`media_inbound_download_enabled`), so disk consumption is an operator decision;
- CAPPED by size WhatsApp advertised, before a byte is transferred;
- CHECKED against the format allowlist;
- FAILURE-ISOLATED: A download failure must never turn an inbound message that was saved into an error.
  The row keeps its label (e.g. "📷 Photo").
"""

import logging
from typing import Any, Callable

from bson import ObjectId

from app import db
from app.config import settings
from app.media_kinds import resolve_media_format
from app.media_storage import (
    MediaStorage,
    build_media_object_key,
    get_media_storage,
)

_logger = logging.getLogger("crm-api.inbound-media")


def _to_object_id(val: Any) -> ObjectId | None:
    if isinstance(val, ObjectId):
        return val
    if isinstance(val, str) and len(val) == 24:
        try:
            return ObjectId(val)
        except Exception:
            return None
    return None


async def default_update_message_media_storage(
    *,
    organization_id: Any,
    message_id: Any,
    storage_status: str,
    media_object_key: str | None = None,
    mime_type: str | None = None,
    size_bytes: int | None = None,
    file_name: str | None = None,
) -> Any:
    mid = _to_object_id(message_id) or message_id
    oid = _to_object_id(organization_id) or organization_id

    set_doc: dict[str, Any] = {"media.storageStatus": storage_status}
    if media_object_key is not None:
        set_doc["mediaObjectKey"] = media_object_key
    if mime_type is not None:
        set_doc["media.mimeType"] = mime_type
    if size_bytes is not None:
        set_doc["media.sizeBytes"] = size_bytes
    if file_name is not None:
        set_doc["media.fileName"] = file_name

    return await db.get_database()["messages"].update_one(
        {"_id": mid, "organizationId": oid},
        {"$set": set_doc},
    )


class InboundMediaService:
    """Manages downloading and storing attachments sent by leads."""

    def __init__(
        self,
        *,
        config: Any = None,
        media_storage: MediaStorage | None = None,
        update_message_media_storage: Callable[..., Any] = default_update_message_media_storage,
        logger: Any = None,
    ):
        self.config = config or settings
        self.media_storage = media_storage or get_media_storage()
        self.update_message_media_storage = update_message_media_storage
        self.logger = logger or _logger

    async def _mark_failed(self, *, organization_id: Any, message_id: Any) -> None:
        try:
            await self.update_message_media_storage(
                organization_id=organization_id,
                message_id=message_id,
                storage_status="failed",
            )
        except Exception:
            pass

    async def store_inbound_media(
        self,
        *,
        organization_id: Any,
        conversation_id: Any,
        message_id: Any,
        message_type: str,
        mime_type: str | None,
        file_name: str | None,
        size_bytes: int | None,
        download: Callable[[], Any],
    ) -> dict[str, Any]:
        enabled = getattr(self.config, "media_inbound_download_enabled", False)
        if not enabled:
            return {"stored": False, "reason": "disabled"}

        limit = getattr(self.config, "media_inbound_max_download_bytes", 16 * 1024 * 1024)

        if isinstance(size_bytes, int) and size_bytes > limit:
            return {"stored": False, "reason": "too_large"}

        try:
            bytes_data = await download()
        except Exception as err:
            code = getattr(err, "code", None)
            name = type(err).__name__
            if hasattr(self.logger, "error"):
                self.logger.error("Could not download inbound media.", extra={"code": code, "name": name})
            await self._mark_failed(organization_id=organization_id, message_id=message_id)
            return {"stored": False, "reason": "download_failed"}

        if not isinstance(bytes_data, (bytes, bytearray)) or len(bytes_data) == 0 or len(bytes_data) > limit:
            await self._mark_failed(organization_id=organization_id, message_id=message_id)
            return {"stored": False, "reason": "too_large" if len(bytes_data or b"") > limit else "download_failed"}

        format_res = resolve_media_format(
            declared_mime_type=mime_type,
            file_name=file_name,
            bytes=bytes_data,
        )

        if not format_res.get("ok") or format_res.get("messageType") != message_type:
            await self._mark_failed(organization_id=organization_id, message_id=message_id)
            return {"stored": False, "reason": "unsupported"}

        resolved_file_name = format_res.get("fileName", "")
        ext = resolved_file_name[resolved_file_name.rfind(".") :] if "." in resolved_file_name else ".bin"

        object_key = build_media_object_key(
            organization_id=str(organization_id),
            conversation_id=str(conversation_id),
            extension=ext,
        )

        try:
            await self.media_storage.write_media_object(object_key=object_key, bytes=bytes_data)
            await self.update_message_media_storage(
                organization_id=organization_id,
                message_id=message_id,
                media_object_key=object_key,
                storage_status="stored",
                mime_type=format_res.get("mimeType"),
                size_bytes=len(bytes_data),
                file_name=format_res.get("fileName"),
            )
        except Exception as err:
            code = getattr(err, "code", None)
            name = type(err).__name__
            if hasattr(self.logger, "error"):
                self.logger.error("Could not store inbound media.", extra={"code": code, "name": name})
            await self._mark_failed(organization_id=organization_id, message_id=message_id)
            return {"stored": False, "reason": "download_failed"}

        return {"stored": True, "objectKey": object_key, "sizeBytes": len(bytes_data)}


def create_inbound_media_service(**kwargs: Any) -> InboundMediaService:
    return InboundMediaService(**kwargs)

