"""
Tests for media upload and download routes.
Ported from backend/src/modules/media/media.controller.test.ts.
"""

from unittest.mock import AsyncMock, MagicMock, patch
from bson import ObjectId
from fastapi import HTTPException, UploadFile
import pytest

from app.conversation_access import ConversationAccessDenied
from app.deps import AuthContext
from app.routers.media import download_message_media, upload_conversation_media

ORG = "507f1f77bcf86cd799439011"
CONVERSATION = "507f191e810c19729de860ea"
MESSAGE = "507f191e810c19729de860ff"

JPEG = bytes([0xFF, 0xD8, 0xFF, 0xE0]) + (b"\x00" * 32)
EXECUTABLE = bytes([0x4D, 0x5A, 0x90, 0x00, 0x03])


def _auth_context(permissions=None):
    return AuthContext(
        user={
            "_id": ObjectId("507f1f77bcf86cd799439012"),
            "role": "manager",
        },
        organization={
            "_id": ObjectId(ORG),
        },
        session={},
        permissions=list(permissions or ["messages.send", "conversations.read", "conversations.read_assigned", "conversations.read_all"]),
    )


def _upload_file(filename: str, content_type: str, data: bytes) -> UploadFile:
    mock_file = AsyncMock()
    mock_file.filename = filename
    mock_file.content_type = content_type
    mock_file.read = AsyncMock(return_value=data)
    return mock_file


class TestUploadMedia:
    @pytest.mark.asyncio
    async def test_stores_valid_photo_under_org_and_conversation(self):
        auth = _auth_context()
        file = _upload_file("venue.jpg", "image/jpeg", JPEG)

        with patch("app.routers.media.load_visible_conversation_for_actor", new_callable=AsyncMock) as mock_vis, \
             patch("app.routers.media.get_media_storage") as mock_storage_factory:
            mock_vis.return_value = {"_id": ObjectId(CONVERSATION)}
            mock_storage = MagicMock()
            mock_storage.write_media_object = AsyncMock(return_value={"objectKey": "k", "sizeBytes": len(JPEG)})
            mock_storage_factory.return_value = mock_storage

            res = await upload_conversation_media(
                auth=auth,
                conversationId=CONVERSATION,
                file=file,
                kind="file",
            )

            assert "data" in res
            data = res["data"]
            assert data["type"] == "image"
            assert data["mimeType"] == "image/jpeg"
            assert data["fileName"] == "venue.jpg"
            assert data["objectKey"].startswith(f"{ORG}/{CONVERSATION}/")
            mock_storage.write_media_object.assert_called_once()

    @pytest.mark.asyncio
    async def test_checks_caller_visibility_before_storing(self):
        auth = _auth_context()
        file = _upload_file("venue.jpg", "image/jpeg", JPEG)

        with patch("app.routers.media.load_visible_conversation_for_actor", new_callable=AsyncMock) as mock_vis, \
             patch("app.routers.media.get_media_storage") as mock_storage_factory:
            mock_vis.side_effect = ConversationAccessDenied("CONVERSATION_ACCESS_DENIED")
            mock_storage = MagicMock()
            mock_storage.write_media_object = AsyncMock()
            mock_storage_factory.return_value = mock_storage

            with pytest.raises(HTTPException) as exc_info:
                await upload_conversation_media(
                    auth=auth,
                    conversationId=CONVERSATION,
                    file=file,
                    kind="file",
                )

            assert exc_info.value.status_code == 403
            mock_storage.write_media_object.assert_not_called()

    @pytest.mark.asyncio
    async def test_refuses_content_mismatch(self):
        auth = _auth_context()
        file = _upload_file("photo.png", "image/png", EXECUTABLE)

        with patch("app.routers.media.load_visible_conversation_for_actor", new_callable=AsyncMock) as mock_vis, \
             patch("app.routers.media.get_media_storage") as mock_storage_factory:
            mock_vis.return_value = {"_id": ObjectId(CONVERSATION)}
            mock_storage = MagicMock()
            mock_storage.write_media_object = AsyncMock()
            mock_storage_factory.return_value = mock_storage

            with pytest.raises(HTTPException) as exc_info:
                await upload_conversation_media(
                    auth=auth,
                    conversationId=CONVERSATION,
                    file=file,
                    kind="file",
                )

            assert exc_info.value.status_code == 415
            assert exc_info.value.detail["error"]["code"] == "CONTENT_MISMATCH"
            mock_storage.write_media_object.assert_not_called()

    @pytest.mark.asyncio
    async def test_refuses_unsupported_type(self):
        auth = _auth_context()
        file = _upload_file("setup.exe", "application/x-msdownload", EXECUTABLE)

        with patch("app.routers.media.load_visible_conversation_for_actor", new_callable=AsyncMock) as mock_vis:
            mock_vis.return_value = {"_id": ObjectId(CONVERSATION)}

            with pytest.raises(HTTPException) as exc_info:
                await upload_conversation_media(
                    auth=auth,
                    conversationId=CONVERSATION,
                    file=file,
                    kind="file",
                )

            assert exc_info.value.status_code == 415
            assert exc_info.value.detail["error"]["code"] == "UNSUPPORTED_TYPE"

    @pytest.mark.asyncio
    async def test_refuses_invalid_kind(self):
        auth = _auth_context()
        file = _upload_file("venue.jpg", "image/jpeg", JPEG)

        with pytest.raises(HTTPException) as exc_info:
            await upload_conversation_media(
                auth=auth,
                conversationId=CONVERSATION,
                file=file,
                kind="unsupported_kind",
            )
        assert exc_info.value.status_code == 400
        assert exc_info.value.detail["error"]["code"] == "INVALID_KIND"

    @pytest.mark.asyncio
    async def test_refuses_oversized_file(self):
        auth = _auth_context()
        oversized = bytes([0xFF, 0xD8, 0xFF, 0xE0]) + (b"\x00" * 200)
        file = _upload_file("huge.jpg", "image/jpeg", oversized)

        with patch("app.routers.media.load_visible_conversation_for_actor", new_callable=AsyncMock) as mock_vis, \
             patch("app.routers.media.settings") as mock_settings:
            mock_vis.return_value = {"_id": ObjectId(CONVERSATION)}
            mock_settings.media_max_upload_bytes = 100

            with pytest.raises(HTTPException) as exc_info:
                await upload_conversation_media(
                    auth=auth,
                    conversationId=CONVERSATION,
                    file=file,
                    kind="file",
                )
            assert exc_info.value.status_code == 413
            assert exc_info.value.detail["error"]["code"] == "LIMIT_FILE_SIZE"

    @pytest.mark.asyncio
    async def test_refuses_no_file(self):
        auth = _auth_context()
        with pytest.raises(HTTPException) as exc_info:
            await upload_conversation_media(
                auth=auth,
                conversationId=CONVERSATION,
                file=None,
                kind="file",
            )
        assert exc_info.value.status_code == 400
        assert exc_info.value.detail["error"]["code"] == "NO_FILE"

    def test_trailing_slash_returns_404_parity_with_node(self):
        from fastapi.testclient import TestClient
        from app.main import app

        client = TestClient(app)
        res = client.post(
            f"/api/v1/conversations/{CONVERSATION}/media/",
            follow_redirects=False,
        )
        assert res.status_code == 404

    @pytest.mark.asyncio
    async def test_converts_voice_recording(self):
        auth = _auth_context()
        raw_webm = bytes([0x1A, 0x45, 0xDF, 0xA3]) + (b"\x00" * 16)
        converted_ogg = b"OggS" + (b"\x00" * 24) + b"OpusHead" + (b"\x00" * 8)
        file = _upload_file("voice-note.webm", "audio/webm;codecs=opus", raw_webm)

        with patch("app.routers.media.load_visible_conversation_for_actor", new_callable=AsyncMock) as mock_vis, \
             patch("app.routers.media.prepare_voice_note", new_callable=AsyncMock) as mock_prep, \
             patch("app.routers.media.get_media_storage") as mock_storage_factory:
            mock_vis.return_value = {"_id": ObjectId(CONVERSATION)}
            mock_prep.return_value = {
                "ok": True,
                "bytes": converted_ogg,
                "mimeType": "audio/ogg",
                "extension": ".ogg",
                "converted": True,
            }
            mock_storage = MagicMock()
            mock_storage.write_media_object = AsyncMock()
            mock_storage_factory.return_value = mock_storage

            res = await upload_conversation_media(
                auth=auth,
                conversationId=CONVERSATION,
                file=file,
                kind="voice",
            )

            assert res["data"]["isVoiceNote"] is True
            assert res["data"]["mimeType"] == "audio/ogg"
            # Converted bytes are stored, not original webm
            mock_storage.write_media_object.assert_called_once_with(
                object_key=res["data"]["objectKey"],
                bytes=converted_ogg,
            )

    @pytest.mark.asyncio
    async def test_refuses_voice_note_when_transcode_unavailable(self):
        auth = _auth_context()
        raw_webm = bytes([0x1A, 0x45, 0xDF, 0xA3]) + (b"\x00" * 16)
        file = _upload_file("voice-note.webm", "audio/webm", raw_webm)

        with patch("app.routers.media.load_visible_conversation_for_actor", new_callable=AsyncMock) as mock_vis, \
             patch("app.routers.media.prepare_voice_note", new_callable=AsyncMock) as mock_prep:
            mock_vis.return_value = {"_id": ObjectId(CONVERSATION)}
            mock_prep.return_value = {"ok": False, "reason": "transcode_unavailable"}

            with pytest.raises(HTTPException) as exc_info:
                await upload_conversation_media(
                    auth=auth,
                    conversationId=CONVERSATION,
                    file=file,
                    kind="voice",
                )

            assert exc_info.value.status_code == 503
            assert exc_info.value.detail["error"]["code"] == "TRANSCODE_UNAVAILABLE"


class TestDownloadMedia:
    def _stored_message(self, **overrides):
        msg = {
            "_id": ObjectId(MESSAGE),
            "conversationId": ObjectId(CONVERSATION),
            "organizationId": ObjectId(ORG),
            "mediaObjectKey": f"{ORG}/{CONVERSATION}/11111111-1111-1111-1111-111111111111.jpg",
            "media": {
                "mimeType": "image/jpeg",
                "fileName": "venue.jpg",
                "sizeBytes": 1024,
                "storageStatus": "stored",
            },
        }
        msg.update(overrides)
        return msg

    @pytest.mark.asyncio
    async def test_streams_stored_photo_with_headers(self):
        auth = _auth_context()
        msg = self._stored_message()

        with patch("app.db.get_database") as mock_db, \
             patch("app.routers.media.load_visible_conversation_for_actor", new_callable=AsyncMock) as mock_vis, \
             patch("app.routers.media.get_media_storage") as mock_storage_factory:
            collection_mock = MagicMock()
            collection_mock.find_one = AsyncMock(return_value=msg)
            mock_db.return_value = {"messages": collection_mock}
            mock_vis.return_value = {"_id": ObjectId(CONVERSATION)}

            mock_storage = MagicMock()
            mock_storage.stat_media_object = AsyncMock(return_value={"exists": True, "sizeBytes": 1024})
            mock_storage.get_object_path.return_value = "/tmp/media/test.jpg"
            mock_storage_factory.return_value = mock_storage

            response = await download_message_media(auth=auth, messageId=MESSAGE)

            assert response.headers["Content-Type"] == "image/jpeg"
            assert response.headers["Content-Length"] == "1024"
            assert response.headers["X-Content-Type-Options"] == "nosniff"
            assert "sandbox" in response.headers["Content-Security-Policy"]
            assert response.headers["Content-Disposition"].startswith("inline;")
            assert "private" in response.headers["Cache-Control"]

    @pytest.mark.asyncio
    async def test_scopes_lookup_to_callers_organization(self):
        auth = _auth_context()

        with patch("app.db.get_database") as mock_db:
            collection_mock = MagicMock()
            collection_mock.find_one = AsyncMock(return_value=None)
            mock_db.return_value = {"messages": collection_mock}

            with pytest.raises(HTTPException) as exc_info:
                await download_message_media(auth=auth, messageId=MESSAGE)

            assert exc_info.value.status_code == 404
            assert exc_info.value.detail["error"]["code"] == "MESSAGE_NOT_FOUND"

    @pytest.mark.asyncio
    async def test_checks_actor_visibility_on_download(self):
        auth = _auth_context()
        msg = self._stored_message()

        with patch("app.db.get_database") as mock_db, \
             patch("app.routers.media.load_visible_conversation_for_actor", new_callable=AsyncMock) as mock_vis, \
             patch("app.routers.media.get_media_storage") as mock_storage_factory:
            collection_mock = MagicMock()
            collection_mock.find_one = AsyncMock(return_value=msg)
            mock_db.return_value = {"messages": collection_mock}
            mock_vis.side_effect = ConversationAccessDenied("CONVERSATION_ACCESS_DENIED")

            with pytest.raises(HTTPException) as exc_info:
                await download_message_media(auth=auth, messageId=MESSAGE)

            assert exc_info.value.status_code == 403

    @pytest.mark.asyncio
    async def test_404_when_never_stored(self):
        auth = _auth_context()
        msg = self._stored_message(mediaObjectKey=None, media={"storageStatus": "not_applicable"})

        with patch("app.db.get_database") as mock_db, \
             patch("app.routers.media.load_visible_conversation_for_actor", new_callable=AsyncMock):
            collection_mock = MagicMock()
            collection_mock.find_one = AsyncMock(return_value=msg)
            mock_db.return_value = {"messages": collection_mock}

            with pytest.raises(HTTPException) as exc_info:
                await download_message_media(auth=auth, messageId=MESSAGE)

            assert exc_info.value.status_code == 404
            assert exc_info.value.detail["error"]["code"] == "MEDIA_NOT_AVAILABLE"

    @pytest.mark.asyncio
    async def test_404_when_missing_from_disk(self):
        auth = _auth_context()
        msg = self._stored_message()

        with patch("app.db.get_database") as mock_db, \
             patch("app.routers.media.load_visible_conversation_for_actor", new_callable=AsyncMock), \
             patch("app.routers.media.get_media_storage") as mock_storage_factory:
            collection_mock = MagicMock()
            collection_mock.find_one = AsyncMock(return_value=msg)
            mock_db.return_value = {"messages": collection_mock}

            mock_storage = MagicMock()
            mock_storage.stat_media_object = AsyncMock(return_value={"exists": False, "sizeBytes": 0})
            mock_storage_factory.return_value = mock_storage

            with pytest.raises(HTTPException) as exc_info:
                await download_message_media(auth=auth, messageId=MESSAGE)

            assert exc_info.value.status_code == 404
            assert exc_info.value.detail["error"]["code"] == "MEDIA_NOT_AVAILABLE"

    @pytest.mark.asyncio
    async def test_attaches_document_with_nosniff(self):
        auth = _auth_context()
        msg = self._stored_message(
            media={
                "mimeType": "application/pdf",
                "fileName": "quote.pdf",
                "sizeBytes": 2048,
                "storageStatus": "stored",
            }
        )

        with patch("app.db.get_database") as mock_db, \
             patch("app.routers.media.load_visible_conversation_for_actor", new_callable=AsyncMock), \
             patch("app.routers.media.get_media_storage") as mock_storage_factory:
            collection_mock = MagicMock()
            collection_mock.find_one = AsyncMock(return_value=msg)
            mock_db.return_value = {"messages": collection_mock}

            mock_storage = MagicMock()
            mock_storage.stat_media_object = AsyncMock(return_value={"exists": True, "sizeBytes": 2048})
            mock_storage.get_object_path.return_value = "/tmp/media/quote.pdf"
            mock_storage_factory.return_value = mock_storage

            response = await download_message_media(auth=auth, messageId=MESSAGE)

            assert response.headers["Content-Disposition"] == 'attachment; filename="quote.pdf"'
            assert response.headers["X-Content-Type-Options"] == "nosniff"

    @pytest.mark.asyncio
    async def test_strips_quotes_from_filename(self):
        auth = _auth_context()
        msg = self._stored_message(
            media={
                "mimeType": "application/pdf",
                "fileName": 'quote";attachment;x="y.pdf',
                "sizeBytes": 10,
                "storageStatus": "stored",
            }
        )

        with patch("app.db.get_database") as mock_db, \
             patch("app.routers.media.load_visible_conversation_for_actor", new_callable=AsyncMock), \
             patch("app.routers.media.get_media_storage") as mock_storage_factory:
            collection_mock = MagicMock()
            collection_mock.find_one = AsyncMock(return_value=msg)
            mock_db.return_value = {"messages": collection_mock}

            mock_storage = MagicMock()
            mock_storage.stat_media_object = AsyncMock(return_value={"exists": True, "sizeBytes": 10})
            mock_storage.get_object_path.return_value = "/tmp/media/clean.pdf"
            mock_storage_factory.return_value = mock_storage

            response = await download_message_media(auth=auth, messageId=MESSAGE)

            assert response.headers["Content-Disposition"] == 'attachment; filename="quote;attachment;x=y.pdf"'
