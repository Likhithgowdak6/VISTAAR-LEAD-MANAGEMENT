"""
The seven analytics routes, end to end against an in-memory MongoDB.

WHAT THIS ADDS over the pipeline and service tests. Those prove the pipelines match Node
stage-for-stage and the assembly matches Node's rules. This proves the two halves are wired
together: that the route runs the pipeline it should, reads the facet keys it wrote, and gates
the phone column on the permission rather than on the shape of the data.

THE PHONE COLUMN IS THE REASON THIS FILE EXISTS. `/attention.csv` is the second path by which a
customer's number can leave the backend — `contact.service.ts` calls itself "the only path", and
that guarantee stops being true the moment this export forgets its obligations. Three of them:
the permission, the audit entry, and one entry per REQUEST rather than per row.
"""

import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import jwt
import pytest
import pytest_asyncio
from bson import ObjectId
from fastapi import FastAPI
from fastapi.testclient import TestClient
from mongomock_motor import AsyncMongoMockClient

from app import audit, db
from app.config import settings as config
from app.errors import install_error_handlers
from app.main import API_PREFIX
from app.permissions import (
    CLIENT_PII_REVEAL,
    CONVERSATIONS_READ_ALL,
)
from app.request_context import RequestContextMiddleware
from app.routers import analytics as analytics_router

FIXTURES = json.loads(
    (Path(__file__).parent / "fixtures" / "encrypted_fields.json").read_text(encoding="utf-8")
)
PHONE_CASE = next(c for c in FIXTURES["cases"] if c["plaintext"] == "919876543210")

ORG = ObjectId()
USER = ObjectId()
SESSION = ObjectId()
FAMILY = ObjectId()
OTHER_ORG = ObjectId()
CONTACT = ObjectId()


def build_app() -> FastAPI:
    application = FastAPI()
    application.add_middleware(RequestContextMiddleware)
    install_error_handlers(application)
    application.include_router(analytics_router.router, prefix=f"{API_PREFIX}/analytics")

    return application


def token() -> str:
    return jwt.encode(
        {
            "sub": str(USER),
            "sid": str(SESSION),
            "org": str(ORG),
            "type": "access",
            "exp": int(time.time()) + 900,
        },
        config.jwt_access_secret,
        algorithm="HS256",
    )


def headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {token()}"}


@pytest.fixture(autouse=True)
def key_ring(monkeypatch):
    monkeypatch.setenv("ENCRYPTION_KEY_V1", FIXTURES["key"])


@pytest.fixture
def database(monkeypatch):
    mock = AsyncMongoMockClient()["vistaar_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)
    return mock


@pytest.fixture
def client():
    return TestClient(build_app())


def recent(days_ago: int = 1) -> datetime:
    return datetime.now(timezone.utc) - timedelta(days=days_ago)


async def seed_auth(database, role: str = "admin", **overrides: Any) -> None:
    await database.organizations.insert_one({"_id": ORG, "status": "active"})
    await database.users.insert_one(
        {"_id": USER, "status": "active", "role": role, "name": "Himanshu", **overrides}
    )
    await database.refreshsessions.insert_one(
        {
            "_id": SESSION,
            "userId": USER,
            "organizationId": ORG,
            "familyId": FAMILY,
            "status": "active",
        }
    )


async def seed_conversation(database, **over: Any) -> dict[str, Any]:
    document = {
        "_id": ObjectId(),
        "organizationId": ORG,
        "contactId": CONTACT,
        "displayName": "Ananya",
        "stage": "new",
        "deletedAt": None,
        "assignedTo": None,
        "leadSourceId": None,
        "leadQualificationStatus": "confirmed",
        "leadQualificationSource": None,
        "leadQualifiedAt": None,
        "aiAutomationEnabled": True,
        "optedOutAt": None,
        "lastInboundAt": recent(2),
        "lastAiReplyAt": None,
        "lastDeliveredOutboundAt": None,
        "lastAiSendFailedAt": None,
        "nextFollowUpAt": None,
        "createdAt": recent(1),
        **over,
    }
    await database.conversations.insert_one(document)

    return document


async def seed_contact(database) -> None:
    await database.contacts.insert_one(
        {
            "_id": CONTACT,
            "organizationId": ORG,
            "encryptedPhone": PHONE_CASE["field"],
        }
    )


def _supports_lookup_pipeline() -> bool:
    """
    Whether the backing database implements `$lookup` with a SUB-PIPELINE.

    MONGOMOCK DOES NOT - neither the `pipeline` form nor the correlated `let` form. Five of the
    seven routes need one. The stage
    breakdown resolves a custom stage label, the reminder pipelines check conversation
    visibility, and the first-response pipeline pairs each conversation with its own earliest
    messages. Real MongoDB has supported this since 3.6 and the Node implementation relies on
    it; mongomock raises NotImplementedError.

    So those tests SKIP here rather than being rewritten to suit the mock. Rewriting them would
    mean shipping a different pipeline than Node ships, which is the one thing this port must
    not do - and the pipelines themselves are already compared stage-for-stage against Node in
    tests/test_analytics_pipelines.py, which is the stronger check.

    This is a probe rather than a hard skip so the same tests execute unchanged the moment the
    suite is pointed at a real MongoDB.
    """
    import asyncio

    async def probe() -> bool:
        mock = AsyncMongoMockClient()["probe"]
        await mock.a.insert_one({"_id": 1, "k": "x"})

        try:
            cursor = mock.a.aggregate(
                [
                    {
                        "$lookup": {
                            "from": "a",
                            "let": {"k": "$k"},
                            "pipeline": [{"$match": {"$expr": {"$eq": ["$k", "$$k"]}}}],
                            "as": "self",
                        }
                    }
                ]
            )
            [row async for row in cursor]

            return True
        except Exception:  # noqa: BLE001
            return False

    return asyncio.run(probe())


SUPPORTS_LOOKUP_PIPELINE = _supports_lookup_pipeline()

needs_lookup_pipeline = pytest.mark.skipif(
    not SUPPORTS_LOOKUP_PIPELINE,
    reason=(
        "mongomock does not implement $lookup with a sub-pipeline. The pipeline is compared to Node "
        "structurally in test_analytics_pipelines.py; this route test runs against a real "
        "MongoDB."
    ),
)


class TestAuthAndScope:
    @pytest.mark.parametrize(
        "path",
        [
            "/overview",
            "/trends",
            "/ai-performance",
            "/breakdowns",
            "/reminders",
            "/attention",
            "/attention.csv",
        ],
    )
    def test_every_route_refuses_an_unauthenticated_request(self, client, database, path):
        assert client.get(f"/api/v1/analytics{path}").status_code == 401

    @pytest.mark.asyncio
    async def test_A_STAFF_USER_SEES_ONLY_THEIR_OWN_THREADS(self, client, database):
        # The narrowing restated a third time in Python. Forgetting it totals the organisation
        # for someone whose inbox shows only their own threads, and neither screen looks wrong.
        await seed_auth(database, role="staff")
        await seed_conversation(database, assignedTo=USER)
        await seed_conversation(database, assignedTo=ObjectId())

        response = client.get("/api/v1/analytics/overview", headers=headers())

        assert response.status_code == 200
        assert response.json()["data"]["totalConversations"]["value"] == 1

    @pytest.mark.asyncio
    async def test_an_admin_sees_the_whole_organization(self, client, database):
        await seed_auth(database)
        await seed_conversation(database, assignedTo=USER)
        await seed_conversation(database, assignedTo=ObjectId())

        data = client.get("/api/v1/analytics/overview", headers=headers()).json()["data"]

        assert data["totalConversations"]["value"] == 2

    @pytest.mark.asyncio
    async def test_REQUESTING_SOMEONE_ELSE_WITHOUT_READ_ALL_IS_403(self, client, database):
        # Refused, not quietly rewritten: answering a different question would show them their
        # own numbers under another person's name.
        await seed_auth(database, role="staff")

        response = client.get(
            f"/api/v1/analytics/overview?assignedTo={ObjectId()}", headers=headers()
        )

        assert response.status_code == 403
        assert response.json()["error"]["code"] == "ANALYTICS_SCOPE_DENIED"

    @pytest.mark.asyncio
    async def test_ANOTHER_ORGANIZATIONS_CONVERSATIONS_ARE_NEVER_COUNTED(self, client, database):
        await seed_auth(database)
        await seed_conversation(database)
        await seed_conversation(database, organizationId=OTHER_ORG)

        data = client.get("/api/v1/analytics/overview", headers=headers()).json()["data"]

        assert data["totalConversations"]["value"] == 1

    @pytest.mark.asyncio
    async def test_a_deleted_conversation_is_excluded(self, client, database):
        # A soft-deleted thread still counting is one the owner deleted and can still see the
        # shadow of.
        await seed_auth(database)
        await seed_conversation(database)
        await seed_conversation(database, deletedAt=recent(1))

        data = client.get("/api/v1/analytics/overview", headers=headers()).json()["data"]

        assert data["totalConversations"]["value"] == 1


class TestValidation:
    @pytest.mark.asyncio
    async def test_an_incoherent_custom_range_is_400(self, client, database):
        await seed_auth(database)

        response = client.get(
            "/api/v1/analytics/overview?preset=custom&fromDate=2026-03-31&toDate=2026-03-01",
            headers=headers(),
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "INVALID_DATE_RANGE"

    @pytest.mark.asyncio
    async def test_a_custom_range_missing_an_end_is_400(self, client, database):
        await seed_auth(database)

        response = client.get(
            "/api/v1/analytics/overview?preset=custom&fromDate=2026-03-01", headers=headers()
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "INVALID_DATE_RANGE"

    @pytest.mark.asyncio
    async def test_a_malformed_date_is_rejected_by_the_schema(self, client, database):
        await seed_auth(database)

        response = client.get(
            "/api/v1/analytics/overview?fromDate=01/03/2026", headers=headers()
        )

        assert response.status_code == 400
        assert response.json()["error"]["code"] == "VALIDATION_FAILED"

    @pytest.mark.asyncio
    async def test_AN_UPPER_CASE_OBJECT_ID_FILTER_IS_ACCEPTED(self, client, database):
        # DEFECT 12, found in Phase 9. Node's `objectIdSchema` is `/^[a-f\d]{24}$/i`; FastAPI's
        # `pattern=` takes no flags, so `[a-f]` alone turned an upper-case `leadSourceId` or
        # `assignedTo` into a 400 on all seven analytics routes where Node answers with data.
        await seed_auth(database)

        response = client.get(
            f"/api/v1/analytics/overview?leadSourceId={str(ObjectId()).upper()}",
            headers=headers(),
        )

        assert response.status_code == 200

    @pytest.mark.asyncio
    async def test_a_malformed_object_id_filter_is_still_400(self, client, database):
        # The widened character class must not have widened the shape rule.
        await seed_auth(database)

        response = client.get(
            "/api/v1/analytics/overview?leadSourceId=not-an-object-id", headers=headers()
        )

        assert response.status_code == 400

    @pytest.mark.asyncio
    async def test_PERMISSION_IS_CHECKED_BEFORE_THE_RANGE(self, client, database):
        # A bad range must not mask a permission refusal - otherwise a staff user probing
        # another person's analytics gets a 400 and learns nothing, which reads as a client bug
        # rather than as a refusal.
        await seed_auth(database, role="staff")

        response = client.get(
            f"/api/v1/analytics/overview?assignedTo={ObjectId()}&preset=custom",
            headers=headers(),
        )

        assert response.status_code == 403


class TestOverview:
    @pytest.mark.asyncio
    async def test_EVERY_BUCKET_IS_PRESENT_EVEN_AT_ZERO(self, client, database):
        # A status that vanishes because nothing matched is a status the UI cannot draw, and the
        # reader cannot tell "none" from "not measured".
        await seed_auth(database)
        await seed_conversation(database)

        data = client.get("/api/v1/analytics/overview", headers=headers()).json()["data"]

        assert len(data["enquiryClassCounts"]) == 3
        assert len(data["aiStatusCounts"]) == 6
        assert all(isinstance(row["count"], int) for row in data["aiStatusCounts"])

    @pytest.mark.asyncio
    async def test_the_cards_carry_their_definitions(self, client, database):
        await seed_auth(database)

        data = client.get("/api/v1/analytics/overview", headers=headers()).json()["data"]

        assert data["totalConversations"]["definition"]
        assert data["enquiryRate"]["definition"]

    @pytest.mark.asyncio
    async def test_AN_EMPTY_ORGANIZATION_RETURNS_ZEROES_NOT_AN_ERROR(self, client, database):
        await seed_auth(database)

        response = client.get("/api/v1/analytics/overview", headers=headers())

        assert response.status_code == 200
        assert response.json()["data"]["totalConversations"]["value"] == 0
        assert response.json()["data"]["enquiryRate"]["value"] is None


@needs_lookup_pipeline
class TestTrends:
    @pytest.mark.asyncio
    async def test_EVERY_DAY_IN_THE_RANGE_IS_PRESENT(self, client, database):
        await seed_auth(database)

        data = client.get(
            "/api/v1/analytics/trends?preset=last_7_days", headers=headers()
        ).json()["data"]

        assert len(data["points"]) == 7
        assert all("day" in point for point in data["points"])

    @pytest.mark.asyncio
    async def test_the_definition_names_the_business_timezone(self, client, database):
        await seed_auth(database)

        data = client.get("/api/v1/analytics/trends", headers=headers()).json()["data"]

        assert "Asia/Kolkata" in data["definitions"]["day"]


@needs_lookup_pipeline
class TestAiPerformanceAndBreakdowns:
    @pytest.mark.asyncio
    async def test_ai_performance_returns_a_null_sample_when_nothing_was_answered(
        self, client, database
    ):
        await seed_auth(database)
        await seed_conversation(database)

        data = client.get("/api/v1/analytics/ai-performance", headers=headers()).json()["data"]

        assert data["firstResponseSeconds"]["sampleSize"] == 0
        assert data["firstResponseSeconds"]["median"] is None

    @pytest.mark.asyncio
    async def test_breakdowns_label_a_built_in_stage(self, client, database):
        await seed_auth(database)
        await seed_conversation(database, stage="won")

        data = client.get("/api/v1/analytics/breakdowns", headers=headers()).json()["data"]

        assert data["currentStageCounts"][0]["label"] == "Won"

    @pytest.mark.asyncio
    async def test_breakdowns_name_the_null_source(self, client, database):
        await seed_auth(database)
        await seed_conversation(database)

        data = client.get("/api/v1/analytics/breakdowns", headers=headers()).json()["data"]

        assert data["bySource"][0]["sourceName"] == "Direct - no lead source"

    @pytest.mark.asyncio
    async def test_breakdowns_carry_an_as_of_stamp(self, client, database):
        await seed_auth(database)

        data = client.get("/api/v1/analytics/breakdowns", headers=headers()).json()["data"]

        assert data["asOf"].endswith("Z")


@needs_lookup_pipeline
class TestReminders:
    @pytest.mark.asyncio
    async def test_the_meta_total_is_the_pending_count_not_the_preview_length(
        self, client, database
    ):
        # Five rows under a pending count of forty must read as a preview rather than as the
        # whole story.
        await seed_auth(database)
        for index in range(3):
            await database.followuptasks.insert_one(
                {
                    "_id": ObjectId(),
                    "organizationId": ORG,
                    "assignedTo": None,
                    "conversationId": None,
                    "status": "pending",
                    "dueAt": recent(1),
                    "title": f"Call back {index}",
                    "source": "manual",
                    "sourceQuote": None,
                }
            )

        body = client.get("/api/v1/analytics/reminders?limit=2", headers=headers()).json()

        assert body["meta"]["count"] == 2
        assert body["meta"]["total"] == 3

    @pytest.mark.asyncio
    async def test_A_PERSONAL_REMINDER_GETS_NO_INVENTED_LEAD_NAME(self, client, database):
        await seed_auth(database)
        await database.followuptasks.insert_one(
            {
                "_id": ObjectId(),
                "organizationId": ORG,
                "assignedTo": None,
                "conversationId": None,
                "status": "pending",
                "dueAt": recent(1),
                "title": "Buy batteries",
                "source": "manual",
                "sourceQuote": None,
            }
        )

        row = client.get("/api/v1/analytics/reminders", headers=headers()).json()["data"]["next"][0]

        assert row["isPersonal"] is True
        assert row["leadName"] is None
        assert row["overdue"] is True

    @pytest.mark.asyncio
    async def test_the_definitions_name_the_business_timezone(self, client, database):
        await seed_auth(database)

        data = client.get("/api/v1/analytics/reminders", headers=headers()).json()["data"]

        assert "Asia/Kolkata" in json.dumps(data["definitions"])


@needs_lookup_pipeline
class TestAttentionList:
    @pytest.mark.asyncio
    async def test_returns_a_reason_per_row(self, client, database):
        await seed_auth(database)
        await seed_conversation(database, lastInboundAt=recent(1))

        rows = client.get("/api/v1/analytics/attention", headers=headers()).json()["data"]["rows"]

        assert len(rows) == 1
        assert rows[0]["reason"]
        assert rows[0]["aiResponseStatus"] in {"awaiting_ai_reply", "needs_review"}

    @pytest.mark.asyncio
    async def test_WAITING_MINUTES_IS_NULL_WHEN_NOBODY_EVER_MESSAGED(self, client, database):
        # "We have never heard from them" is not "they messaged a moment ago", and a zero would
        # say the second.
        await seed_auth(database)
        await seed_conversation(
            database, lastInboundAt=None, nextFollowUpAt=recent(1)
        )

        rows = client.get("/api/v1/analytics/attention", headers=headers()).json()["data"]["rows"]

        assert rows[0]["waitingMinutes"] is None

    @pytest.mark.asyncio
    async def test_THE_PHONE_IS_NULL_WITHOUT_THE_PERMISSION(self, client, database):
        # The column stays in the shape so the UI does not branch, but no number is decrypted -
        # so none can leak through a cached response.
        await seed_auth(database, role="staff")
        await seed_contact(database)
        await seed_conversation(database, assignedTo=USER)

        rows = client.get("/api/v1/analytics/attention", headers=headers()).json()["data"]["rows"]

        assert rows[0]["phone"] is None

    @pytest.mark.asyncio
    async def test_the_phone_is_decrypted_with_the_permission(self, client, database):
        await seed_auth(database)
        await seed_contact(database)
        await seed_conversation(database)

        rows = client.get("/api/v1/analytics/attention", headers=headers()).json()["data"]["rows"]

        assert rows[0]["phone"] == "919876543210"


@needs_lookup_pipeline
class TestAttentionCsv:
    @pytest.mark.asyncio
    async def test_the_file_is_a_csv_attachment(self, client, database):
        await seed_auth(database)
        await seed_conversation(database)

        response = client.get("/api/v1/analytics/attention.csv", headers=headers())

        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/csv")
        assert "attachment" in response.headers["content-disposition"]
        assert response.headers["x-content-type-options"] == "nosniff"

    @pytest.mark.asyncio
    async def test_A_CLIPPED_EXPORT_ANNOUNCES_ITSELF(self, client, database):
        # X-Total-Count against X-Row-Count. A file that silently held fewer rows than the
        # filters matched would be read as the whole answer.
        await seed_auth(database)
        for _ in range(3):
            await seed_conversation(database)

        response = client.get("/api/v1/analytics/attention.csv?limit=1", headers=headers())

        assert response.headers["x-row-count"] == "1"
        assert response.headers["x-total-count"] == "3"

    @pytest.mark.asyncio
    async def test_THERE_IS_NO_PHONE_COLUMN_WITHOUT_THE_PERMISSION(self, client, database):
        # No column at all, rather than a column of blanks that looks like missing data.
        await seed_auth(database, role="staff")
        await seed_contact(database)
        await seed_conversation(database, assignedTo=USER)

        response = client.get("/api/v1/analytics/attention.csv", headers=headers())
        header_line = response.text.splitlines()[0]

        assert "Phone" not in header_line
        assert "919876543210" not in response.text

    @pytest.mark.asyncio
    async def test_the_phone_column_appears_with_the_permission(self, client, database):
        await seed_auth(database)
        await seed_contact(database)
        await seed_conversation(database)

        response = client.get("/api/v1/analytics/attention.csv", headers=headers())

        assert "Phone" in response.text.splitlines()[0]
        assert "919876543210" in response.text

    @pytest.mark.asyncio
    async def test_AN_EXPORT_THAT_REVEALS_A_NUMBER_IS_AUDITED(self, client, database):
        # contact.service.ts calls itself "the only path by which a phone number leaves the
        # backend". This is the second such path, so it carries the same obligation or that
        # guarantee quietly stops being true.
        await seed_auth(database)
        await seed_contact(database)
        await seed_conversation(database)

        client.get("/api/v1/analytics/attention.csv", headers=headers())
        row = await database[audit.COLLECTION].find_one({})

        assert row is not None
        assert row["eventType"] == "CLIENT_PII_REVEALED"
        assert row["actorId"] == USER
        assert row["metadata"]["context"] == "analytics.attention.csv"
        assert row["metadata"]["contactCount"] == 1

    @pytest.mark.asyncio
    async def test_THE_AUDIT_ROW_NEVER_CONTAINS_A_NUMBER(self, client, database):
        await seed_auth(database)
        await seed_contact(database)
        await seed_conversation(database)

        client.get("/api/v1/analytics/attention.csv", headers=headers())
        row = await database[audit.COLLECTION].find_one({})

        assert "919876543210" not in json.dumps(row, default=str)

    @pytest.mark.asyncio
    async def test_ONE_AUDIT_ENTRY_PER_REQUEST_NOT_PER_ROW(self, client, database):
        # What is worth recording is that a named person took N numbers at a known moment. A
        # hundred identical rows would bury that rather than sharpen it.
        await seed_auth(database)
        await seed_contact(database)
        for _ in range(3):
            await seed_conversation(database)

        client.get("/api/v1/analytics/attention.csv", headers=headers())

        assert await database[audit.COLLECTION].count_documents({}) == 1

    @pytest.mark.asyncio
    async def test_AN_EMPTY_EXPORT_LOGS_NOTHING(self, client, database):
        # An export that decrypted no numbers must not log a reveal that never happened.
        await seed_auth(database)

        response = client.get("/api/v1/analytics/attention.csv", headers=headers())

        assert response.status_code == 200
        assert await database[audit.COLLECTION].find_one({}) is None

    @pytest.mark.asyncio
    async def test_an_export_without_the_permission_logs_nothing(self, client, database):
        await seed_auth(database, role="staff")
        await seed_contact(database)
        await seed_conversation(database, assignedTo=USER)

        client.get("/api/v1/analytics/attention.csv", headers=headers())

        assert await database[audit.COLLECTION].find_one({}) is None

    @pytest.mark.asyncio
    async def test_A_FORMULA_IN_A_DISPLAY_NAME_IS_NEUTRALISED(self, client, database):
        # A customer chooses their own WhatsApp display name. The CRM renders it harmlessly
        # everywhere else; the export is what would turn it into code.
        await seed_auth(database)
        await seed_conversation(database, displayName='=HYPERLINK("https://evil.test","x")')

        response = client.get("/api/v1/analytics/attention.csv", headers=headers())

        assert '"\'=HYPERLINK' in response.text

    @pytest.mark.asyncio
    async def test_the_file_name_carries_the_date(self, client, database):
        await seed_auth(database)

        response = client.get("/api/v1/analytics/attention.csv", headers=headers())

        assert "needs-attention-" in response.headers["content-disposition"]
        assert response.headers["content-disposition"].endswith('.csv"')
