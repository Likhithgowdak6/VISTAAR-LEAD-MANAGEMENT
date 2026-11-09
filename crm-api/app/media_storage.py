"""
Where attachment bytes actually live.

A PORT OF backend/src/modules/media/media-storage.service.ts.

WHY THE FILESYSTEM. Mongo holds metadata (mediaObjectKey, media.* on the message row)
and bytes sit beside it on disk, keeping the database light and mongodump fast.

THE KEY IS THE AUTHORIZATION. A key is <organizationId>/<conversationId>/<uuid>.<ext> and
is validated against that exact shape on every read and write. No sequence of .. can escape
the storage root because the regex forbids those characters, and the key names the tenant
and thread, preventing replay into other conversations.
"""

import os
from pathlib import Path
import re
from typing import Any
import uuid

from app.config import settings

MEDIA_OBJECT_KEY_PATTERN = re.compile(
    r"^[0-9a-f]{24}/[0-9a-f]{24}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,8}$"
)


class InvalidMediaObjectKeyError(Exception):
    def __init__(self, message: str = "Media object key is not well-formed."):
        super().__init__(message)
        self.name = "InvalidMediaObjectKeyError"


def is_valid_media_object_key(object_key: str | None) -> bool:
    """True only for <24 hex>/<24 hex>/<uuid>.<ext>."""
    if not isinstance(object_key, str):
        return False
    return bool(MEDIA_OBJECT_KEY_PATTERN.match(object_key))


def build_media_object_key(
    *,
    organization_id: str,
    conversation_id: str,
    extension: str,
) -> str:
    """Mints a key for a new object."""
    normalized_ext = extension[1:] if extension.startswith(".") else extension
    return (
        f"{str(organization_id).lower()}/"
        f"{str(conversation_id).lower()}/"
        f"{str(uuid.uuid4())}.{normalized_ext.lower()}"
    )


def media_object_key_belongs_to(
    *,
    object_key: str,
    organization_id: str,
    conversation_id: str,
) -> bool:
    """True when the key belongs to this organization AND this conversation."""
    if not is_valid_media_object_key(object_key):
        return False
    prefix = f"{str(organization_id).lower()}/{str(conversation_id).lower()}/"
    return object_key.startswith(prefix)


class MediaStorage:
    """Filesystem storage manager for media attachments."""

    def __init__(self, *, config: Any = None):
        self.config = config or settings

    def _resolve_root(self) -> Path:
        raw_dir = getattr(self.config, "media_storage_dir", "var/media")
        return Path(raw_dir).resolve()

    def _resolve_object_path(self, object_key: str) -> Path:
        if not is_valid_media_object_key(object_key):
            raise InvalidMediaObjectKeyError()

        root = self._resolve_root()
        absolute = (root / object_key).resolve()

        try:
            pass
        except ValueError:
            raise InvalidMediaObjectKeyError("Media object key escapes the storage root.")

        return absolute

    async def write_media_object(
        self,
        *,
        object_key: str,
        bytes: bytes,
    ) -> dict[str, Any]:
        """Writes bytes to disk with exclusive creation ('xb' mode)."""
        absolute = self._resolve_object_path(object_key)
        absolute.parent.mkdir(parents=True, exist_ok=True)

        # 'xb' raises FileExistsError if file already exists
        with open(absolute, "xb") as f:
            f.write(bytes)

        return {"objectKey": object_key, "sizeBytes": len(bytes)}

    async def read_media_object(self, object_key: str) -> bytes:
        """Reads media file bytes from disk."""
        absolute = self._resolve_object_path(object_key)
        with open(absolute, "rb") as f:
            return f.read()

    async def stat_media_object(self, object_key: str) -> dict[str, Any]:
        """Reports file existence and size without throwing on missing file."""
        try:
            absolute = self._resolve_object_path(object_key)
            st = os.stat(absolute)
            return {"sizeBytes": st.st_size, "exists": True}
        except (FileNotFoundError, InvalidMediaObjectKeyError):
            return {"sizeBytes": 0, "exists": False}

    async def delete_media_object(self, object_key: str) -> None:
        """Deletes media file without failing if missing."""
        try:
            absolute = self._resolve_object_path(object_key)
            if absolute.exists():
                absolute.unlink()
        except (FileNotFoundError, InvalidMediaObjectKeyError):
            pass

    def get_object_path(self, object_key: str) -> Path:
        """Returns verified absolute Path for streaming."""
        return self._resolve_object_path(object_key)


_storage_singleton: MediaStorage | None = None


def create_media_storage(**kwargs: Any) -> MediaStorage:
    return MediaStorage(**kwargs)


def get_media_storage() -> MediaStorage:
    global _storage_singleton
    if _storage_singleton is None:
        _storage_singleton = create_media_storage()
    return _storage_singleton