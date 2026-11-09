"""
Tests for inbound media downloading: size checks, format allowlist, fail-safe message updates.
Ported from backend/src/modules/media/inbound-media.service.test.ts.
"""

from unittest.mock import AsyncMock, MagicMock
import pytest

from app.inbound_media import InboundMediaService

ORG = "507f1f77bcf86cd799439011"
CONVERSATION = "507f191e810c19729de860ea"
MESSAGE = "507f191e810c19729de860ff"

JPEG = bytes([0xFF, 0xD8, 0xFF, 0xE0]) + (b"\x00" * 64)
EXECUTABLE = bytes([0x4D, 0x5A, 0x90, 0x00, 0x03])


def _create_harness(config_overrides=None):
    class Config:
        media_inbound_download_enabled = True
        media_inbound_max_download_bytes = 1024 * 1024

    cfg = Config()
    if config_overrides:
        for k, v in config_overrides.items():
            setattr(cfg, k, v)

    write_mock = AsyncMock(return_value={"objectKey": "k", "sizeBytes": len(JPEG)})
    storage = MagicMock()
    storage.write_media_object = write_mock

    update_mock = AsyncMock(return_value={"acknowledged": True})
    logger = MagicMock()

    service = InboundMediaService(
        config=cfg,
        media_storage=storage,
        update_message_media_storage=update_mock,
        logger=logger,
    )
    return service, write_mock, update_mock, logger


class TestInboundMediaService:
    @pytest.mark.asyncio
    async def test_does_not_download_when_switched_off(self):
        service, write_mock, update_mock, _ = _create_harness(
            {"media_inbound_download_enabled": False}
        )
        download_mock = AsyncMock()

        res = await service.store_inbound_media(
            organization_id=ORG,
            conversation_id=CONVERSATION,
            message_id=MESSAGE,
            message_type="image",
            mime_type="image/jpeg",
            file_name="from-lead.jpg",
            size_bytes=len(JPEG),
            download=download_mock,
        )

        assert res["stored"] is False
        assert res["reason"] == "disabled"
        download_mock.assert_not_called()
        write_mock.assert_not_called()
        update_mock.assert_not_called()

    @pytest.mark.asyncio
    async def test_downloads_and_stores_valid_photo(self):
        service, write_mock, update_mock, _ = _create_harness()
        download_mock = AsyncMock(return_value=JPEG)

        res = await service.store_inbound_media(
            organization_id=ORG,
            conversation_id=CONVERSATION,
            message_id=MESSAGE,
            message_type="image",
            mime_type="image/jpeg",
            file_name="venue.jpg",
            size_bytes=len(JPEG),
            download=download_mock,
        )

        assert res["stored"] is True
        download_mock.assert_called_once()
        write_mock.assert_called_once()
        update_mock.assert_called_once()

        update_kwargs = update_mock.call_args[1]
        assert update_kwargs["storage_status"] == "stored"
        assert update_kwargs["media_object_key"].startswith(f"{ORG}/{CONVERSATION}/")
        assert update_kwargs["mime_type"] == "image/jpeg"

    @pytest.mark.asyncio
    async def test_refuses_oversized_file_before_download(self):
        service, write_mock, update_mock, _ = _create_harness(
            {"media_inbound_max_download_bytes": 100}
        )
        download_mock = AsyncMock()

        res = await service.store_inbound_media(
            organization_id=ORG,
            conversation_id=CONVERSATION,
            message_id=MESSAGE,
            message_type="image",
            mime_type="image/jpeg",
            file_name="huge.jpg",
            size_bytes=200,
            download=download_mock,
        )

        assert res["stored"] is False
        assert res["reason"] == "too_large"
        download_mock.assert_not_called()
        write_mock.assert_not_called()

    @pytest.mark.asyncio
    async def test_refuses_after_downloading_when_advertised_size_was_a_lie(self):
        service, write_mock, update_mock, _ = _create_harness(
            {"media_inbound_max_download_bytes": 32}
        )
        download_mock = AsyncMock(return_value=JPEG)  # JPEG is 68 bytes > 32

        res = await service.store_inbound_media(
            organization_id=ORG,
            conversation_id=CONVERSATION,
            message_id=MESSAGE,
            message_type="image",
            mime_type="image/jpeg",
            file_name="huge.jpg",
            size_bytes=10,  # Advertised 10, but actual is 68
            download=download_mock,
        )

        assert res["stored"] is False
        assert res["reason"] == "too_large"
        write_mock.assert_not_called()
        update_mock.assert_called_once_with(
            organization_id=ORG,
            message_id=MESSAGE,
            storage_status="failed",
        )

    @pytest.mark.asyncio
    async def test_refuses_content_mismatch_after_download(self):
        service, write_mock, update_mock, _ = _create_harness()
        download_mock = AsyncMock(return_value=EXECUTABLE)

        res = await service.store_inbound_media(
            organization_id=ORG,
            conversation_id=CONVERSATION,
            message_id=MESSAGE,
            message_type="image",
            mime_type="image/jpeg",
            file_name="bad.jpg",
            size_bytes=len(EXECUTABLE),
            download=download_mock,
        )

        assert res["stored"] is False
        assert res["reason"] == "unsupported"
        write_mock.assert_not_called()
        update_mock.assert_called_once_with(
            organization_id=ORG,
            message_id=MESSAGE,
            storage_status="failed",
        )

    @pytest.mark.asyncio
    async def test_handles_download_failure_gracefully(self):
        service, write_mock, update_mock, _ = _create_harness()
        download_mock = AsyncMock(side_effect=RuntimeError("Network timeout"))

        res = await service.store_inbound_media(
            organization_id=ORG,
            conversation_id=CONVERSATION,
            message_id=MESSAGE,
            message_type="image",
            mime_type="image/jpeg",
            file_name="timeout.jpg",
            size_bytes=len(JPEG),
            download=download_mock,
        )

        assert res["stored"] is False
        assert res["reason"] == "download_failed"
        write_mock.assert_not_called()
        update_mock.assert_called_once_with(
            organization_id=ORG,
            message_id=MESSAGE,
            storage_status="failed",
        )

    @pytest.mark.asyncio
    async def test_refuses_when_bytes_are_different_kind_from_message_type(self):
        service, write_mock, update_mock, _ = _create_harness()
        download_mock = AsyncMock(return_value=JPEG)

        res = await service.store_inbound_media(
            organization_id=ORG,
            conversation_id=CONVERSATION,
            message_id=MESSAGE,
            message_type="document",
            mime_type="image/jpeg",
            file_name="from-lead.jpg",
            size_bytes=len(JPEG),
            download=download_mock,
        )

        assert res["stored"] is False
        assert res["reason"] == "unsupported"
        write_mock.assert_not_called()

    @pytest.mark.asyncio
    async def test_reports_failed_write_instead_of_throwing(self):
        service, write_mock, update_mock, _ = _create_harness()
        write_mock.side_effect = Exception("disk full")
        download_mock = AsyncMock(return_value=JPEG)

        res = await service.store_inbound_media(
            organization_id=ORG,
            conversation_id=CONVERSATION,
            message_id=MESSAGE,
            message_type="image",
            mime_type="image/jpeg",
            file_name="venue.jpg",
            size_bytes=len(JPEG),
            download=download_mock,
        )

        assert res["stored"] is False
        assert res["reason"] == "download_failed"

    @pytest.mark.asyncio
    async def test_never_logs_the_filename_or_the_error_message(self):
        service, write_mock, update_mock, logger = _create_harness()
        download_mock = AsyncMock(side_effect=Exception("failed for https://mmg.whatsapp.net/secret"))

        await service.store_inbound_media(
            organization_id=ORG,
            conversation_id=CONVERSATION,
            message_id=MESSAGE,
            message_type="image",
            mime_type="image/jpeg",
            file_name="client-contract-signed.pdf",
            size_bytes=len(JPEG),
            download=download_mock,
        )

        logged = str(logger.error.call_args_list)
        assert "client-contract-signed" not in logged
        assert "mmg.whatsapp.net" not in logged

    @pytest.mark.asyncio
    async def test_survives_the_failure_bookkeeping_itself_failing(self):
        service, write_mock, update_mock, _ = _create_harness()
        download_mock = AsyncMock(side_effect=Exception("x"))
        update_mock.side_effect = Exception("mongo is down")

        res = await service.store_inbound_media(
            organization_id=ORG,
            conversation_id=CONVERSATION,
            message_id=MESSAGE,
            message_type="image",
            mime_type="image/jpeg",
            file_name="venue.jpg",
            size_bytes=len(JPEG),
            download=download_mock,
        )

        assert res["stored"] is False
        assert res["reason"] == "download_failed"
