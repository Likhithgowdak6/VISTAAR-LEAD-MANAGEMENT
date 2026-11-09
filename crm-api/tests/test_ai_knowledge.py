"""
Tests for AI Knowledge base module: routes, service, validation, and error mapping.
Ported from backend/src/modules/ai-knowledge/ai-knowledge.service.test.ts.
"""

from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch
from bson import ObjectId
from fastapi.testclient import TestClient
import pytest

from app.ai_brain import AiBrainNotConfiguredError, AiBrainRequestError
from app.ai_knowledge_common import (
    AI_KNOWLEDGE_CATEGORIES,
    AI_KNOWLEDGE_CATEGORY_VALUES,
    AI_KNOWLEDGE_SECTION_VALUES,
    AI_KNOWLEDGE_STATUSES,
)
from app.ai_knowledge_service import (
    archive_knowledge_for_actor,
    create_knowledge_for_actor,
    delete_knowledge_for_actor,
    list_knowledge_for_organization,
    optimize_knowledge_draft,
    update_knowledge_for_actor,
)
from app.deps import AuthContext
from app.main import app
from app.permissions import AI_KNOWLEDGE_MANAGE
from app.routers import ai_knowledge as ai_k_router

ORG_ID = str(ObjectId())
USER_ID = str(ObjectId())
KNOWLEDGE_ID = str(ObjectId())


def _auth(permissions=None):
    user = {
        "id": ObjectId(USER_ID),
        "_id": ObjectId(USER_ID),
        "organizationId": ObjectId(ORG_ID),
        "role": "admin",
        "email": "admin@example.com",
    }
    org = {
        "id": ObjectId(ORG_ID),
        "_id": ObjectId(ORG_ID),
        "name": "Test Org",
        "status": "active",
    }
    class MockAuth(AuthContext):
        def __init__(self):
            super().__init__(
                user=user,
                organization=org,
                session={},
                permissions=frozenset(permissions or [AI_KNOWLEDGE_MANAGE]),
            )
    return MockAuth()


@pytest.fixture(autouse=True)
def clean_overrides():
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()


@pytest.fixture
def client():
    return TestClient(app)


def test_section_and_category_constants():
    assert AI_KNOWLEDGE_SECTION_VALUES == ("company", "services", "pricing", "rules")
    for legacy in ("policy", "product", "faq", "other"):
        assert legacy in AI_KNOWLEDGE_CATEGORY_VALUES


def test_list_knowledge_permission_gated(client):
    from fastapi import HTTPException
    def _raise_denied():
        raise HTTPException(status_code=403, detail={"error": {"code": "PERMISSION_DENIED", "message": "Denied"}})

    app.dependency_overrides[ai_k_router._require_manage] = _raise_denied
    res = client.get("/api/v1/ai/knowledge")
    assert res.status_code == 403


def test_list_knowledge_success(client):
    app.dependency_overrides[ai_k_router._require_manage] = lambda: _auth([AI_KNOWLEDGE_MANAGE])

    with patch("app.routers.ai_knowledge.list_knowledge_for_organization", new_callable=AsyncMock) as mock_list:
        mock_list.return_value = [
            {"id": KNOWLEDGE_ID, "label": "Pricing Rule", "category": "pricing", "status": "active"}
        ]
        res = client.get("/api/v1/ai/knowledge?limit=20&skip=0")
        assert res.status_code == 200
        assert len(res.json()["data"]) == 1
        assert res.json()["meta"]["count"] == 1


def test_create_knowledge_success_and_validation(client):
    app.dependency_overrides[ai_k_router._require_manage] = lambda: _auth([AI_KNOWLEDGE_MANAGE])

    with patch("app.routers.ai_knowledge.create_knowledge_for_actor", new_callable=AsyncMock) as mock_create:
        mock_create.return_value = {
            "id": KNOWLEDGE_ID,
            "label": "Wedding Photography",
            "content": "Packages start at 1.5 Lakhs.",
            "category": "pricing",
        }

        res = client.post(
            "/api/v1/ai/knowledge",
            json={
                "label": "Wedding Photography",
                "content": "Packages start at 1.5 Lakhs.",
                "category": "pricing",
            },
        )
        assert res.status_code == 201
        assert res.json()["data"]["category"] == "pricing"

    # Reject empty content
    res_bad = client.post("/api/v1/ai/knowledge", json={"label": "Short", "content": ""})
    assert res_bad.status_code == 400


def test_optimize_knowledge_route(client):
    app.dependency_overrides[ai_k_router._require_manage] = lambda: _auth([AI_KNOWLEDGE_MANAGE])

    # Success case
    with patch("app.routers.ai_knowledge.optimize_knowledge_draft", new_callable=AsyncMock) as mock_opt:
        mock_opt.return_value = {
            "label": "Pre-Wedding Booking Policy",
            "content": "A 25% non-refundable advance is required to secure the date.",
            "category": "rules",
            "notes": "Rewrote into formal directive",
            "rawText": "we take 25% advance for pre wedding not refundable",
        }

        res = client.post(
            "/api/v1/ai/knowledge/optimize",
            json={"rawText": "we take 25% advance for pre wedding not refundable"},
        )
        assert res.status_code == 200
        assert res.json()["data"]["category"] == "rules"

    # Brain not configured -> 409
    with patch("app.routers.ai_knowledge.optimize_knowledge_draft", new_callable=AsyncMock) as mock_opt:
        mock_opt.side_effect = AiBrainNotConfiguredError("AI_BRAIN_NOT_CONFIGURED")
        res2 = client.post("/api/v1/ai/knowledge/optimize", json={"rawText": "raw note"})
        assert res2.status_code == 409
        assert res2.json()["error"]["code"] == "AI_BRAIN_NOT_CONFIGURED"

    # Brain upstream error -> 502
    with patch("app.routers.ai_knowledge.optimize_knowledge_draft", new_callable=AsyncMock) as mock_opt:
        mock_opt.side_effect = AiBrainRequestError("Failed", 500, {"detail": "LLM timeout"})
        res3 = client.post("/api/v1/ai/knowledge/optimize", json={"rawText": "raw note"})
        assert res3.status_code == 502
        assert res3.json()["error"]["code"] == "AI_BRAIN_UPSTREAM_ERROR"


def test_update_archive_delete_routes(client):
    app.dependency_overrides[ai_k_router._require_manage] = lambda: _auth([AI_KNOWLEDGE_MANAGE])

    with patch("app.routers.ai_knowledge.update_knowledge_for_actor", new_callable=AsyncMock) as mock_up, \
         patch("app.routers.ai_knowledge.archive_knowledge_for_actor", new_callable=AsyncMock) as mock_arc, \
         patch("app.routers.ai_knowledge.delete_knowledge_for_actor", new_callable=AsyncMock) as mock_del:

        mock_up.return_value = {"id": KNOWLEDGE_ID, "label": "Updated"}
        mock_arc.return_value = {"id": KNOWLEDGE_ID, "status": "archived"}
        mock_del.return_value = {"id": KNOWLEDGE_ID, "label": "Deleted"}

        # Update
        patch_res = client.patch(f"/api/v1/ai/knowledge/{KNOWLEDGE_ID}", json={"label": "Updated"})
        assert patch_res.status_code == 200

        # Archive
        arc_res = client.patch(f"/api/v1/ai/knowledge/{KNOWLEDGE_ID}/archive")
        assert arc_res.status_code == 200
        assert arc_res.json()["data"]["status"] == "archived"

        # Delete
        del_res = client.delete(f"/api/v1/ai/knowledge/{KNOWLEDGE_ID}")
        assert del_res.status_code == 200

        # Empty update rejected
        bad_up = client.patch(f"/api/v1/ai/knowledge/{KNOWLEDGE_ID}", json={})
        assert bad_up.status_code == 400


@pytest.mark.asyncio
async def test_ai_knowledge_service_business_logic():
    actor = {"_id": ObjectId(USER_ID)}

    # Test 1: Category change does not blank existing content
    existing_entry = {
        "_id": ObjectId(KNOWLEDGE_ID),
        "organizationId": ObjectId(ORG_ID),
        "label": "Warranty Terms",
        "content": "Two years warranty on albums.",
        "category": "policy",
        "status": "active",
    }

    with patch("app.ai_knowledge_service.find_knowledge_by_id", new_callable=AsyncMock) as mock_find, \
         patch("app.ai_knowledge_service.update_knowledge", new_callable=AsyncMock) as mock_repo_up, \
         patch("app.ai_knowledge_service.serialize_knowledge") as mock_ser:

        mock_find.return_value = existing_entry
        mock_repo_up.return_value = {**existing_entry, "category": "rules"}
        mock_ser.return_value = {**existing_entry, "category": "rules"}

        res = await update_knowledge_for_actor(
            organization_id=ORG_ID,
            knowledge_id=KNOWLEDGE_ID,
            actor=actor,
            category="rules",
        )
        _, kwargs = mock_repo_up.call_args
        assert kwargs["category"] == "rules"
        assert kwargs["content"] is None
        assert kwargs["label"] is None

    # Test 2: Unowned or missing ID raises AI_KNOWLEDGE_NOT_FOUND (not silent no-op)
    with patch("app.ai_knowledge_service.find_knowledge_by_id", new_callable=AsyncMock) as mock_find:
        mock_find.return_value = None

        with pytest.raises(ValueError, match="AI_KNOWLEDGE_NOT_FOUND"):
            await update_knowledge_for_actor(
                organization_id=ORG_ID,
                knowledge_id=KNOWLEDGE_ID,
                actor=actor,
                label="New Name",
            )

        with pytest.raises(ValueError, match="AI_KNOWLEDGE_NOT_FOUND"):
            await delete_knowledge_for_actor(
                organization_id=ORG_ID,
                knowledge_id=KNOWLEDGE_ID,
            )

        with pytest.raises(ValueError, match="AI_KNOWLEDGE_NOT_FOUND"):
            await archive_knowledge_for_actor(
                organization_id=ORG_ID,
                knowledge_id=KNOWLEDGE_ID,
                actor=actor,
            )


@pytest.mark.asyncio
async def test_optimize_knowledge_draft_fallback():
    async def mock_fn(raw_text, category_options):
        return {"label": "L", "content": "C", "category": "unknown_invented_category", "notes": "N"}

    draft = await optimize_knowledge_draft("some text", fn_optimize=mock_fn)
    assert draft["category"] == "rules"


@pytest.mark.asyncio
async def test_archive_knowledge_repository_updates_status():
    from app.ai_knowledge_repository import archive_knowledge

    with patch("app.ai_knowledge_repository._coll") as mock_coll:
        mock_find_one = AsyncMock(return_value={"_id": ObjectId(KNOWLEDGE_ID), "status": "archived"})
        mock_coll.return_value.find_one_and_update = mock_find_one

        res = await archive_knowledge(knowledge_id=KNOWLEDGE_ID, organization_id=ORG_ID)
        args, kwargs = mock_find_one.call_args
        set_dict = args[1]["$set"] if len(args) > 1 else kwargs["update"]["$set"]
        assert set_dict["status"] == "archived"

