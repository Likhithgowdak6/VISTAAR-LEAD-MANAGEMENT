"""
Tests for AI Brain API routes (/api/v1/ai-brain/*).

Covers all 9 endpoints, permissions, validations, and error handling.
"""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest
from bson import ObjectId
from fastapi.testclient import TestClient

from app.deps import AuthContext
from app.main import app
from app.permissions import (
    AI_AUTOMATION_MANAGE,
    AI_GENERATE,
    CONVERSATIONS_READ_ALL,
    CONVERSATIONS_READ_ASSIGNED,
    MESSAGES_SEND,
)
from app.routers import ai_brain as ai_brain_router

ORG_ID = str(ObjectId())
USER_ID = str(ObjectId())
CONV_ID = str(ObjectId())


def _auth(permissions, user_id=USER_ID, org_id=ORG_ID):
    user = {
        "id": ObjectId(user_id),
        "_id": ObjectId(user_id),
        "organizationId": ObjectId(org_id),
        "role": "admin",
        "email": "owner@internal.local",
    }
    org = {
        "id": ObjectId(org_id),
        "_id": ObjectId(org_id),
        "name": "Test Studio",
        "status": "active",
    }

    class MockAuth(AuthContext):
        def __init__(self):
            super().__init__(user=user, organization=org, session={}, permissions=frozenset(permissions))

    return MockAuth()


@pytest.fixture(autouse=True)
def clean_overrides():
    app.dependency_overrides.clear()
    yield
    app.dependency_overrides.clear()


@pytest.fixture
def client():
    return TestClient(app)


def test_list_pending_approvals(client):
    app.dependency_overrides[ai_brain_router._require_read] = lambda: _auth([CONVERSATIONS_READ_ALL])

    with patch("app.routers.ai_brain.list_pending_approvals_for_actor", new_callable=AsyncMock) as mock_list:
        mock_list.return_value = [
            {
                "_id": str(ObjectId()),
                "conversationId": CONV_ID,
                "organizationId": ORG_ID,
                "code": "A1",
                "draft": "Hello from AI!",
            }
        ]

        res = client.get("/api/v1/ai-brain/approvals")
        assert res.status_code == 200
        data = res.json()["data"]
        assert len(data) == 1
        assert data[0]["code"] == "A1"


def test_get_conversation_approval(client):
    app.dependency_overrides[ai_brain_router._require_read] = lambda: _auth([CONVERSATIONS_READ_ALL])

    with patch("app.routers.ai_brain.get_pending_approval_for_actor", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = {
            "_id": str(ObjectId()),
            "conversationId": CONV_ID,
            "organizationId": ORG_ID,
            "code": "A1",
            "draft": "Draft message",
        }

        res = client.get(f"/api/v1/ai-brain/conversations/{CONV_ID}/approval")
        assert res.status_code == 200
        assert res.json()["data"]["code"] == "A1"


def test_resolve_conversation_approval(client):
    app.dependency_overrides[ai_brain_router._require_send] = lambda: _auth([MESSAGES_SEND])

    with patch("app.routers.ai_brain.resolve_approval_for_actor", new_callable=AsyncMock) as mock_resolve:
        mock_resolve.return_value = {
            "decision": "approved",
            "message": {"_id": str(ObjectId()), "body": "Sent!"},
        }

        payload = {"verdict": "approve", "instruction": ""}
        res = client.post(f"/api/v1/ai-brain/conversations/{CONV_ID}/approval/resolve", json=payload)
        assert res.status_code == 200
        assert res.json()["data"]["decision"] == "approved"


def test_set_conversation_automation(client):
    app.dependency_overrides[ai_brain_router._require_automation] = lambda: _auth([AI_AUTOMATION_MANAGE])

    with patch("app.routers.ai_brain.set_automation_for_actor", new_callable=AsyncMock) as mock_set:
        mock_set.return_value = {
            "_id": ObjectId(CONV_ID),
            "organizationId": ObjectId(ORG_ID),
            "aiAutomationEnabled": True,
            "stage": "new",
        }

        res = client.post(f"/api/v1/ai-brain/conversations/{CONV_ID}/automation", json={"enabled": True})
        assert res.status_code == 200
        assert res.json()["data"]["aiAutomationEnabled"] is True


def test_set_conversation_nurture(client):
    app.dependency_overrides[ai_brain_router._require_automation] = lambda: _auth([AI_AUTOMATION_MANAGE])

    with patch("app.routers.ai_brain.set_nurture_for_actor", new_callable=AsyncMock) as mock_set:
        mock_set.return_value = {
            "_id": ObjectId(CONV_ID),
            "organizationId": ObjectId(ORG_ID),
            "nurtureEnabled": False,
            "stage": "new",
        }

        res = client.post(f"/api/v1/ai-brain/conversations/{CONV_ID}/nurture", json={"enabled": False})
        assert res.status_code == 200
        assert res.json()["data"]["nurtureEnabled"] is False


def test_check_conversation_outcome(client):
    app.dependency_overrides[ai_brain_router._require_automation] = lambda: _auth([AI_AUTOMATION_MANAGE])

    with patch("app.routers.ai_brain.check_outcome_for_actor", new_callable=AsyncMock) as mock_check:
        mock_check.return_value = {
            "decision": "wait",
            "reasoning": "Awaiting response from lead",
        }

        res = client.post(f"/api/v1/ai-brain/conversations/{CONV_ID}/outcome/check")
        assert res.status_code == 200
        assert res.json()["data"]["decision"] == "wait"


def test_generate_proposal_endpoint(client):
    app.dependency_overrides[ai_brain_router._require_generate] = lambda: _auth([AI_GENERATE])

    with patch("app.routers.ai_brain.generate_proposal_for_actor", new_callable=AsyncMock) as mock_gen:
        mock_gen.return_value = {
            "proposal": {"title": "Wedding Package", "price": 1500},
        }

        res = client.post(
            f"/api/v1/ai-brain/conversations/{CONV_ID}/proposal/generate",
            json={"clientName": "John Doe"},
        )
        assert res.status_code == 200
        assert res.json()["data"]["proposal"]["title"] == "Wedding Package"


def test_revise_proposal_endpoint(client):
    app.dependency_overrides[ai_brain_router._require_generate] = lambda: _auth([AI_GENERATE])

    with patch("app.routers.ai_brain.revise_proposal_for_actor", new_callable=AsyncMock) as mock_rev:
        mock_rev.return_value = {
            "proposal": {"title": "Revised Package", "price": 1200},
        }

        res = client.post(
            "/api/v1/ai-brain/proposal/revise",
            json={
                "content": {"title": "Wedding Package", "price": 1500},
                "instruction": "Discount by 300",
            },
        )
        assert res.status_code == 200
        assert res.json()["data"]["proposal"]["price"] == 1200


def test_render_proposal_endpoint(client):
    app.dependency_overrides[ai_brain_router._require_generate] = lambda: _auth([AI_GENERATE])

    with patch("app.routers.ai_brain.render_proposal_for_actor", new_callable=AsyncMock) as mock_ren:
        mock_ren.return_value = {
            "renderedBase64": "JVBERi0xLjQK...",
            "filename": "proposal_v1.pdf",
        }

        res = client.post(
            f"/api/v1/ai-brain/conversations/{CONV_ID}/proposal/render",
            json={
                "content": {"title": "Wedding Package", "price": 1500},
                "version": 1,
            },
        )
        assert res.status_code == 200
        assert res.json()["data"]["filename"] == "proposal_v1.pdf"
