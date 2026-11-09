"""
Tests for media storage service: path traversal safety, key structure enforcement, exclusive writes.
Ported from backend/src/modules/media/media-storage.service.test.ts.
"""

import json
from pathlib import Path
import shutil
import tempfile
import pytest

from app.media_storage import (
    InvalidMediaObjectKeyError,
    MediaStorage,
    build_media_object_key,
    create_media_storage,
    is_valid_media_object_key,
    media_object_key_belongs_to,
)

FIXTURES_PATH = Path(__file__).parent / "fixtures" / "media.json"

ORG = "507f1f77bcf86cd799439011"
CONVERSATION = "507f191e810c19729de860ea"
OTHER_CONVERSATION = "507f191e810c19729de860eb"


class TestBuildMediaObjectKey:
    def test_mints_key_under_org_and_conversation(self):
        key = build_media_object_key(
            organization_id=ORG,
            conversation_id=CONVERSATION,
            extension=".jpg",
        )
        assert key.startswith(f"{ORG}/{CONVERSATION}/")
        assert is_valid_media_object_key(key) is True

    def test_never_puts_caller_filename_in_path(self):
        key = build_media_object_key(
            organization_id=ORG,
            conversation_id=CONVERSATION,
            extension=".pdf",
        )
        assert ".." not in key
        assert len(key.split("/")) == 3

    def test_normalizes_leading_dot(self):
        k1 = build_media_object_key(
            organization_id=ORG,
            conversation_id=CONVERSATION,
            extension=".png",
        )
        k2 = build_media_object_key(
            organization_id=ORG,
            conversation_id=CONVERSATION,
            extension="png",
        )
        assert k1.endswith(".png")
        assert k2.endswith(".png")


class TestMediaObjectKeyBelongsTo:
    def test_matches_correct_org_and_conv(self):
        key = build_media_object_key(
            organization_id=ORG,
            conversation_id=CONVERSATION,
            extension=".jpg",
        )
        assert media_object_key_belongs_to(
            object_key=key,
            organization_id=ORG,
            conversation_id=CONVERSATION,
        ) is True
        assert media_object_key_belongs_to(
            object_key=key,
            organization_id=ORG,
            conversation_id=OTHER_CONVERSATION,
        ) is False

    def test_fixture_parity(self):
        with open(FIXTURES_PATH, "r", encoding="utf-8") as f:
            fixtures = json.load(f)
        for item in fixtures.get("keyValidation", []):
            inp = item["input"]
            valid = is_valid_media_object_key(inp)
            assert valid == item["valid"], f"Validation failed for {inp}: expected {item['valid']}, got {valid}"

            belongs = media_object_key_belongs_to(
                object_key=inp,
                organization_id="507f1f77bcf86cd799439011",
                conversation_id="507f1f77bcf86cd799439012",
            )
            assert belongs == item["belongsTo"], f"belongsTo failed for {inp}: expected {item['belongsTo']}, got {belongs}"


class TestMediaStorageFilesystem:
    @pytest.fixture(autouse=True)
    def setup_temp_dir(self):
        self.tmp_dir = tempfile.mkdtemp(prefix="vistaar-media-test-")
        class Config:
            media_storage_dir = self.tmp_dir
        self.storage = create_media_storage(config=Config())
        yield
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    @pytest.mark.asyncio
    async def test_writes_and_reads_bytes(self):
        key = build_media_object_key(
            organization_id=ORG,
            conversation_id=CONVERSATION,
            extension=".bin",
        )
        data = b"hello media storage"
        write_res = await self.storage.write_media_object(object_key=key, bytes=data)
        assert write_res["objectKey"] == key
        assert write_res["sizeBytes"] == len(data)

        read_data = await self.storage.read_media_object(key)
        assert read_data == data

        stat = await self.storage.stat_media_object(key)
        assert stat["exists"] is True
        assert stat["sizeBytes"] == len(data)

    @pytest.mark.asyncio
    async def test_exclusive_creation_refuses_overwrite(self):
        key = build_media_object_key(
            organization_id=ORG,
            conversation_id=CONVERSATION,
            extension=".bin",
        )
        await self.storage.write_media_object(object_key=key, bytes=b"first")
        with pytest.raises(FileExistsError):
            await self.storage.write_media_object(object_key=key, bytes=b"second")

    @pytest.mark.asyncio
    async def test_deletes_media_object(self):
        key = build_media_object_key(
            organization_id=ORG,
            conversation_id=CONVERSATION,
            extension=".bin",
        )
        await self.storage.write_media_object(object_key=key, bytes=b"to delete")
        await self.storage.delete_media_object(key)
        stat = await self.storage.stat_media_object(key)
        assert stat["exists"] is False

    @pytest.mark.asyncio
    async def test_refuses_path_traversal(self):
        with pytest.raises(InvalidMediaObjectKeyError):
            await self.storage.read_media_object("../../etc/passwd")

        with pytest.raises(InvalidMediaObjectKeyError):
            await self.storage.write_media_object(object_key="../../escape.bin", bytes=b"bad")

