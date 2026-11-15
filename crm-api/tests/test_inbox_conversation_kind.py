from datetime import datetime, timedelta, timezone

from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient
import pytest

from app import db
from app.conversations_repository import list_conversations


@pytest.mark.asyncio
async def test_kind_filters_before_paging_and_keeps_visibility_scope(monkeypatch):
    database = AsyncMongoMockClient()["inbox_kind"]
    monkeypatch.setattr(db, "get_database", lambda: database)
    org, actor, other_org, other_actor = [ObjectId() for _ in range(4)]
    now = datetime.now(timezone.utc)
    assistant = {
        "_id": ObjectId(), "organizationId": org, "assignedTo": actor,
        "kind": "owner_assistant", "updatedAt": now - timedelta(days=30),
    }
    leads = [{
        "_id": ObjectId(), "organizationId": org, "assignedTo": actor,
        "displayName": "Owner Assistant" if i == 0 else f"Lead {i}", "updatedAt": now,
    } for i in range(60)]
    await database.conversations.insert_many([
        *leads, assistant,
        {**assistant, "_id": ObjectId(), "organizationId": other_org, "updatedAt": now},
        {**assistant, "_id": ObjectId(), "assignedTo": other_actor, "updatedAt": now},
        {**assistant, "_id": ObjectId(), "deletedAt": now, "updatedAt": now},
    ])
    owner_rows = await list_conversations(
        organization_id=org, assigned_to=actor, kind="owner_assistant", limit=1,
    )
    assert [row["_id"] for row in owner_rows] == [assistant["_id"]]
    lead_rows = await list_conversations(
        organization_id=org, assigned_to=actor, kind="lead", limit=100,
    )
    assert {row["_id"] for row in lead_rows} == {row["_id"] for row in leads}
    # Existing API consumers keep their original behavior when kind is omitted.
    all_rows = await list_conversations(organization_id=org, assigned_to=actor, limit=100)
    assert len(all_rows) == 61
