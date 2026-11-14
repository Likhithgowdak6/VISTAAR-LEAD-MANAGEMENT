"""
Tests for Phase 1 & 2 JARVIS Assistant Intelligence Upgrade:
- Pipeline metrics & aggregations (total leads, presets, stages, sources, assignees, comparisons)
- Meta/Facebook integration & lead form intelligence (connected status, forms listing, metrics per form, conversion rates)
- Role permissions (Admin vs Staff scoping)
- Cross-tenant data isolation
- Multi-turn and multi-tool question handling
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any
from bson import ObjectId
import pytest
import pytest_asyncio
from mongomock_motor import AsyncMongoMockClient

from app import db, assistant_tools
from app.assistant_tools import (
    ToolContext,
    execute_tool,
    TOOL_REGISTRY,
    PipelineMetricsInput,
    ListMetaLeadFormsInput,
    FormLeadMetricsInput,
    MetaIntegrationStatusInput,
    WhatsAppIntegrationStatusInput,
    ConversationStatisticsInput,
    ReminderMetricsInput,
    TeamOverviewInput,
)
from app.permissions import (
    CONVERSATIONS_READ_ALL,
    CONVERSATIONS_READ_ASSIGNED,
    CRM_TASKS_MANAGE,
)

ORG = ObjectId()
OTHER_ORG = ObjectId()
ADMIN_USER = ObjectId()
STAFF_USER = ObjectId()
COLLEAGUE_USER = ObjectId()
WHATSAPP_ACCOUNT_ID = ObjectId()

NOW = datetime.now(timezone.utc)

ADMIN_CTX = ToolContext(
    organization_id=ORG,
    actor_id=ADMIN_USER,
    permissions=(CONVERSATIONS_READ_ALL, CONVERSATIONS_READ_ASSIGNED, CRM_TASKS_MANAGE),
)

STAFF_CTX = ToolContext(
    organization_id=ORG,
    actor_id=STAFF_USER,
    permissions=(CONVERSATIONS_READ_ASSIGNED,),
)

OTHER_ORG_CTX = ToolContext(
    organization_id=OTHER_ORG,
    actor_id=ObjectId(),
    permissions=(CONVERSATIONS_READ_ALL, CONVERSATIONS_READ_ASSIGNED, CRM_TASKS_MANAGE),
)


@pytest_asyncio.fixture
async def mock_db(monkeypatch):
    client = AsyncMongoMockClient()
    test_db = client["vistaar_crm_test"]
    monkeypatch.setattr(db, "get_database", lambda: test_db)
    return test_db


class TestEmptyCrm:
    @pytest.mark.asyncio
    async def test_empty_pipeline_metrics(self, mock_db):
        res = await execute_tool(
            name="get_pipeline_metrics",
            arguments={"date_preset": "all_time"},
            context=ADMIN_CTX,
        )
        assert res["totalLeads"] == 0
        assert res["summary"]["wonCount"] == 0
        assert res["summary"]["lostCount"] == 0
        assert res["summary"]["unassignedCount"] == 0
        assert res["summary"]["conversionRate"] == "0.0%"

    @pytest.mark.asyncio
    async def test_empty_meta_status(self, mock_db):
        res = await execute_tool(
            name="get_meta_integration_status",
            arguments={},
            context=ADMIN_CTX,
        )
        assert res["connected"] is False
        assert res["totalFormSources"] == 0
        assert res["healthStatus"] == "disconnected"

    @pytest.mark.asyncio
    async def test_empty_meta_forms_list(self, mock_db):
        res = await execute_tool(
            name="list_meta_lead_forms",
            arguments={},
            context=ADMIN_CTX,
        )
        assert res["count"] == 0
        assert res["forms"] == []

    @pytest.mark.asyncio
    async def test_empty_form_lead_metrics(self, mock_db):
        res = await execute_tool(
            name="get_form_lead_metrics",
            arguments={},
            context=ADMIN_CTX,
        )
        assert res["count"] == 0
        assert res["totalLeadsAcrossForms"] == 0
        assert res["topPerformingForm"] is None


class TestPipelineMetrics:
    @pytest_asyncio.fixture(autouse=True)
    async def seed_leads(self, mock_db):
        # 3 users
        await mock_db["users"].insert_many([
            {"_id": ADMIN_USER, "organizationId": ORG, "name": "Admin User", "status": "active"},
            {"_id": STAFF_USER, "organizationId": ORG, "name": "Staff Alice", "status": "active"},
            {"_id": COLLEAGUE_USER, "organizationId": ORG, "name": "Staff Bob", "status": "active"},
        ])

        # 2 lead sources
        self.src_meta = ObjectId()
        self.src_sheet = ObjectId()
        await mock_db["leadsources"].insert_many([
            {"_id": self.src_meta, "organizationId": ORG, "name": "Facebook Wedding Ads", "kind": "meta_lead_ad"},
            {"_id": self.src_sheet, "organizationId": ORG, "name": "Google Sheets Import", "kind": "google_sheet"},
        ])

        # Leads:
        # 1. Staff lead won, today, meta source
        # 2. Staff lead new, today, meta source
        # 3. Staff lead lost, yesterday, sheet source
        # 4. Bob lead won, yesterday, meta source
        # 5. Bob lead new, 10 days ago (this month), sheet source
        # 6. Unassigned lead new, today, None source (organic)
        # 7. Unassigned lead won, 40 days ago (last month)
        # 8. Deleted lead (must be excluded)
        # 9. Owner assistant thread (kind="owner_assistant", must be excluded)
        # 10. Other org lead (must be excluded)

        today = NOW
        yesterday = NOW - timedelta(days=1)
        ten_days_ago = NOW - timedelta(days=10)
        forty_days_ago = NOW - timedelta(days=40)

        leads = [
            {"_id": ObjectId(), "organizationId": ORG, "assignedTo": STAFF_USER, "stage": "won", "status": "active", "leadSourceId": self.src_meta, "createdAt": today, "deletedAt": None, "kind": "customer"},
            {"_id": ObjectId(), "organizationId": ORG, "assignedTo": STAFF_USER, "stage": "new", "status": "active", "leadSourceId": self.src_meta, "createdAt": today, "deletedAt": None, "kind": "customer"},
            {"_id": ObjectId(), "organizationId": ORG, "assignedTo": STAFF_USER, "stage": "lost", "status": "active", "leadSourceId": self.src_sheet, "createdAt": yesterday, "deletedAt": None, "kind": "customer"},
            {"_id": ObjectId(), "organizationId": ORG, "assignedTo": COLLEAGUE_USER, "stage": "won", "status": "active", "leadSourceId": self.src_meta, "createdAt": yesterday, "deletedAt": None, "kind": "customer"},
            {"_id": ObjectId(), "organizationId": ORG, "assignedTo": COLLEAGUE_USER, "stage": "new", "status": "active", "leadSourceId": self.src_sheet, "createdAt": ten_days_ago, "deletedAt": None, "kind": "customer"},
            {"_id": ObjectId(), "organizationId": ORG, "assignedTo": None, "stage": "new", "status": "active", "leadSourceId": None, "createdAt": today, "deletedAt": None, "kind": "customer"},
            {"_id": ObjectId(), "organizationId": ORG, "assignedTo": None, "stage": "won", "status": "active", "leadSourceId": self.src_meta, "createdAt": forty_days_ago, "deletedAt": None, "kind": "customer"},
            # Soft-deleted
            {"_id": ObjectId(), "organizationId": ORG, "assignedTo": STAFF_USER, "stage": "won", "status": "active", "createdAt": today, "deletedAt": today, "kind": "customer"},
            # Assistant kind
            {"_id": ObjectId(), "organizationId": ORG, "assignedTo": ADMIN_USER, "stage": "won", "status": "active", "createdAt": today, "deletedAt": None, "kind": "owner_assistant"},
            # Other organization
            {"_id": ObjectId(), "organizationId": OTHER_ORG, "assignedTo": ObjectId(), "stage": "won", "status": "active", "createdAt": today, "deletedAt": None, "kind": "customer"},
        ]
        await mock_db["conversations"].insert_many(leads)

    @pytest.mark.asyncio
    async def test_total_lead_count_all_time(self, mock_db):
        res = await execute_tool(name="get_pipeline_metrics", arguments={"date_preset": "all_time"}, context=ADMIN_CTX)
        # 7 valid leads in ORG (excluding deleted, owner_assistant, and other org)
        assert res["totalLeads"] == 7
        assert res["summary"]["wonCount"] == 3
        assert res["summary"]["lostCount"] == 1
        assert res["summary"]["unassignedCount"] == 2
        assert res["summary"]["conversionRate"] == "42.9%"

    @pytest.mark.asyncio
    async def test_date_preset_today(self, mock_db):
        res = await execute_tool(name="get_pipeline_metrics", arguments={"date_preset": "today"}, context=ADMIN_CTX)
        # 3 leads created today (lead 1, 2, 6)
        assert res["totalLeads"] == 3
        assert res["summary"]["wonCount"] == 1
        assert res["summary"]["unassignedCount"] == 1

    @pytest.mark.asyncio
    async def test_date_preset_yesterday(self, mock_db):
        res = await execute_tool(name="get_pipeline_metrics", arguments={"date_preset": "yesterday"}, context=ADMIN_CTX)
        # 2 leads created yesterday (lead 3, 4)
        assert res["totalLeads"] == 2
        assert res["summary"]["wonCount"] == 1
        assert res["summary"]["lostCount"] == 1

    @pytest.mark.asyncio
    async def test_group_by_stage(self, mock_db):
        res = await execute_tool(
            name="get_pipeline_metrics",
            arguments={"group_by": "stage", "date_preset": "all_time"},
            context=ADMIN_CTX,
        )
        assert "breakdown" in res
        by_stage = {b["stage"]: b["count"] for b in res["breakdown"]}
        assert by_stage["won"] == 3
        assert by_stage["new"] == 3
        assert by_stage["lost"] == 1

    @pytest.mark.asyncio
    async def test_group_by_source(self, mock_db):
        res = await execute_tool(
            name="get_pipeline_metrics",
            arguments={"group_by": "source", "date_preset": "all_time"},
            context=ADMIN_CTX,
        )
        assert "breakdown" in res
        by_source_name = {b["sourceName"]: b["count"] for b in res["breakdown"]}
        assert by_source_name["Facebook Wedding Ads"] == 4
        assert by_source_name["Google Sheets Import"] == 2
        assert by_source_name["Direct / Organic WhatsApp"] == 1

    @pytest.mark.asyncio
    async def test_group_by_assignee(self, mock_db):
        res = await execute_tool(
            name="get_pipeline_metrics",
            arguments={"group_by": "assignee", "date_preset": "all_time"},
            context=ADMIN_CTX,
        )
        assert "breakdown" in res
        by_user_name = {b["userName"]: b["count"] for b in res["breakdown"]}
        assert by_user_name["Staff Alice"] == 3
        assert by_user_name["Staff Bob"] == 2
        assert by_user_name["Unassigned"] == 2

    @pytest.mark.asyncio
    async def test_staff_scoping_limits_to_assigned_leads(self, mock_db):
        res = await execute_tool(
            name="get_pipeline_metrics",
            arguments={"date_preset": "all_time"},
            context=STAFF_CTX,
        )
        # Staff Alice has exactly 3 leads
        assert res["totalLeads"] == 3
        assert res["scopedToActor"] is True
        assert res["summary"]["wonCount"] == 1
        assert res["summary"]["lostCount"] == 1
        assert res["summary"]["unassignedCount"] == 0

    @pytest.mark.asyncio
    async def test_compare_previous_window(self, mock_db):
        res = await execute_tool(
            name="get_pipeline_metrics",
            arguments={"date_preset": "today", "compare_previous": True},
            context=ADMIN_CTX,
        )
        assert "previousPeriod" in res
        prev = res["previousPeriod"]
        assert "totalLeads" in prev
        assert "difference" in prev


class TestMetaAndLeadFormsIntelligence:
    @pytest_asyncio.fixture(autouse=True)
    async def seed_meta_data(self, mock_db):
        self.form1_id = "fb_form_1001"
        self.form2_id = "fb_form_1002"
        self.src1_id = ObjectId()
        self.src2_id = ObjectId()
        self.src_paused_id = ObjectId()

        # Meta connection document
        await mock_db["metaconnections"].insert_one({
            "organizationId": ORG,
            "status": "active",
            "metaUserId": "1234567890",
            "metaUserName": "Vistaar Photography",
            "grantedScopes": ["pages_show_list", "leads_retrieval", "pages_read_engagement"],
            "lastCheckedAt": NOW,
            "lastError": None,
        })

        # Meta lead sources
        await mock_db["leadsources"].insert_many([
            {
                "_id": self.src1_id,
                "organizationId": ORG,
                "name": "Wedding Shoot Enquiries",
                "kind": "meta_lead_ad",
                "status": "active",
                "meta": {
                    "pageId": "page_991",
                    "pageName": "Vistaar Studio Bangalore",
                    "formId": self.form1_id,
                    "formName": "Wedding Shoot Lead Form",
                    "webhookSubscribedAt": NOW,
                    "webhookError": None,
                },
                "totalImported": 15,
                "lastSyncedAt": NOW - timedelta(minutes=5),
                "lastSyncStatus": "success",
                "lastError": None,
            },
            {
                "_id": self.src2_id,
                "organizationId": ORG,
                "name": "Corporate Event Shoot",
                "kind": "meta_lead_ad",
                "status": "active",
                "meta": {
                    "pageId": "page_992",
                    "pageName": "Vistaar Productions",
                    "formId": self.form2_id,
                    "formName": "Corporate Form 2026",
                    "webhookSubscribedAt": NOW,
                    "webhookError": None,
                },
                "totalImported": 6,
                "lastSyncedAt": NOW - timedelta(hours=1),
                "lastSyncStatus": "success",
                "lastError": None,
            },
            {
                "_id": self.src_paused_id,
                "organizationId": ORG,
                "name": "Old Summer Promo",
                "kind": "meta_lead_ad",
                "status": "paused",
                "meta": {
                    "pageId": "page_991",
                    "pageName": "Vistaar Studio Bangalore",
                    "formId": "fb_form_old",
                    "formName": "Summer Discount Form",
                },
                "totalImported": 30,
                "lastSyncedAt": NOW - timedelta(days=20),
                "lastSyncStatus": "success",
                "lastError": None,
            },
        ])

        # Conversations attached to form1 (Wedding Shoot): 4 leads, 2 won
        await mock_db["conversations"].insert_many([
            {"_id": ObjectId(), "organizationId": ORG, "leadSourceId": self.src1_id, "displayName": "Ananya Sharma", "stage": "won", "status": "active", "createdAt": NOW - timedelta(hours=2), "deletedAt": None, "kind": "customer"},
            {"_id": ObjectId(), "organizationId": ORG, "leadSourceId": self.src1_id, "displayName": "Rohan Verma", "stage": "won", "status": "active", "createdAt": NOW - timedelta(hours=5), "deletedAt": None, "kind": "customer"},
            {"_id": ObjectId(), "organizationId": ORG, "leadSourceId": self.src1_id, "displayName": "Priya Nair", "stage": "new", "status": "active", "createdAt": NOW - timedelta(days=1), "deletedAt": None, "kind": "customer"},
            {"_id": ObjectId(), "organizationId": ORG, "leadSourceId": self.src1_id, "displayName": "Vikram Seth", "stage": "contacted", "status": "active", "createdAt": NOW - timedelta(days=2), "deletedAt": None, "kind": "customer"},
            # Conversations attached to form2 (Corporate): 2 leads, 0 won
            {"_id": ObjectId(), "organizationId": ORG, "leadSourceId": self.src2_id, "displayName": "Infosys HR Team", "stage": "new", "status": "active", "createdAt": NOW - timedelta(hours=3), "deletedAt": None, "kind": "customer"},
            {"_id": ObjectId(), "organizationId": ORG, "leadSourceId": self.src2_id, "displayName": "Wipro Events", "stage": "contacted", "status": "active", "createdAt": NOW - timedelta(days=1), "deletedAt": None, "kind": "customer"},
        ])

    @pytest.mark.asyncio
    async def test_meta_integration_status(self, mock_db):
        res = await execute_tool(name="get_meta_integration_status", arguments={}, context=ADMIN_CTX)
        assert res["connected"] is True
        assert res["account"]["metaUserName"] == "Vistaar Photography"
        assert res["pageCount"] == 2
        assert res["totalFormSources"] == 3
        assert res["activeSources"] == 2
        assert res["pausedSources"] == 1
        assert res["totalImportedLeads"] == 51
        assert res["healthStatus"] == "healthy"

    @pytest.mark.asyncio
    async def test_list_meta_lead_forms_all(self, mock_db):
        res = await execute_tool(name="list_meta_lead_forms", arguments={}, context=ADMIN_CTX)
        assert res["count"] == 3
        form_names = {f["formName"] for f in res["forms"]}
        assert "Wedding Shoot Lead Form" in form_names
        assert "Corporate Form 2026" in form_names
        assert "Summer Discount Form" in form_names

    @pytest.mark.asyncio
    async def test_list_meta_lead_forms_active_only(self, mock_db):
        res = await execute_tool(name="list_meta_lead_forms", arguments={"status": "active"}, context=ADMIN_CTX)
        assert res["count"] == 2
        statuses = {f["status"] for f in res["forms"]}
        assert statuses == {"active"}

    @pytest.mark.asyncio
    async def test_get_form_lead_metrics_overall_and_top_form(self, mock_db):
        res = await execute_tool(name="get_form_lead_metrics", arguments={}, context=ADMIN_CTX)
        # Wedding Shoot has 4 live leads; Corporate has 2
        assert res["totalLeadsAcrossForms"] == 6
        assert res["topPerformingForm"] is not None
        assert res["topPerformingForm"]["formName"] == "Wedding Shoot Lead Form"
        assert res["topPerformingForm"]["leadCount"] == 4
        assert res["topPerformingForm"]["conversionRate"] == "50.0%"

    @pytest.mark.asyncio
    async def test_get_form_lead_metrics_specific_form_search(self, mock_db):
        res = await execute_tool(
            name="get_form_lead_metrics",
            arguments={"form_name": "Wedding Shoot", "include_recent_leads": True, "recent_leads_limit": 5},
            context=ADMIN_CTX,
        )
        assert res["count"] == 1
        form = res["forms"][0]
        assert form["formName"] == "Wedding Shoot Lead Form"
        assert form["leadCount"] == 4
        assert form["wonCount"] == 2
        assert form["conversionRate"] == "50.0%"
        assert "recentLeads" in res
        assert len(res["recentLeads"]) == 4
        lead_names = [l["displayName"] for l in res["recentLeads"]]
        assert "Ananya Sharma" in lead_names

    @pytest.mark.asyncio
    async def test_staff_cannot_access_meta_tools_without_read_all(self, mock_db):
        from fastapi import HTTPException
        with pytest.raises(HTTPException) as exc_info:
            await execute_tool(name="get_meta_integration_status", arguments={}, context=STAFF_CTX)
        assert exc_info.value.status_code == 403

        with pytest.raises(HTTPException) as exc_info:
            await execute_tool(name="list_meta_lead_forms", arguments={}, context=STAFF_CTX)
        assert exc_info.value.status_code == 403

        with pytest.raises(HTTPException) as exc_info:
            await execute_tool(name="get_form_lead_metrics", arguments={}, context=STAFF_CTX)
        assert exc_info.value.status_code == 403


class TestWhatsAppAndOtherIntelligenceTools:
    @pytest_asyncio.fixture(autouse=True)
    async def seed_data(self, mock_db):
        await mock_db["whatsappaccounts"].insert_many([
            {"_id": ObjectId(), "organizationId": ORG, "name": "Primary Studio WA", "brandKey": "studio", "status": "active", "lastConnectedAt": NOW, "lastDisconnectedAt": None},
            {"_id": ObjectId(), "organizationId": ORG, "name": "Backup Support", "brandKey": "support", "status": "disconnected", "lastConnectedAt": None, "lastDisconnectedAt": NOW - timedelta(days=2), "disconnectReason": "LOGGED_OUT"},
        ])

        # Conversations waiting for reply:
        # Lead 1: inbound at 2 hours ago, outbound is None -> waiting 2 hours
        # Lead 2: inbound at 5 hours ago, outbound at 1 hour ago -> answered (not waiting)
        await mock_db["conversations"].insert_many([
            {"_id": ObjectId(), "organizationId": ORG, "displayName": "Client In Need", "stage": "new", "status": "active", "lastInboundAt": NOW - timedelta(hours=2), "lastOutboundAt": None, "lastMessageAt": NOW - timedelta(hours=2), "deletedAt": None, "kind": "customer"},
            {"_id": ObjectId(), "organizationId": ORG, "displayName": "Client Handled", "stage": "qualified", "status": "active", "lastInboundAt": NOW - timedelta(hours=5), "lastOutboundAt": NOW - timedelta(hours=1), "lastMessageAt": NOW - timedelta(hours=1), "deletedAt": None, "kind": "customer"},
        ])

        # Follow-up tasks: 1 overdue, 1 due today
        await mock_db["followuptasks"].insert_many([
            {"_id": ObjectId(), "organizationId": ORG, "assignedTo": ADMIN_USER, "title": "Call client back", "status": "pending", "dueAt": NOW - timedelta(hours=3)},
            {"_id": ObjectId(), "organizationId": ORG, "assignedTo": ADMIN_USER, "title": "Send price catalog", "status": "pending", "dueAt": NOW + timedelta(hours=2)},
        ])

    @pytest.mark.asyncio
    async def test_whatsapp_status(self, mock_db):
        res = await execute_tool(name="get_whatsapp_integration_status", arguments={}, context=ADMIN_CTX)
        assert res["connected"] is True
        assert res["activeAccountCount"] == 1
        assert res["totalAccounts"] == 2
        acc_names = [a["name"] for a in res["accounts"]]
        assert "Primary Studio WA" in acc_names
        assert "Backup Support" in acc_names

    @pytest.mark.asyncio
    async def test_conversation_statistics_unanswered(self, mock_db):
        res = await execute_tool(name="get_conversation_statistics", arguments={"limit": 5}, context=ADMIN_CTX)
        assert res["totalConversations"] == 2
        assert res["unansweredInboundCount"] == 1
        assert len(res["leadsWaitingForReply"]) == 1
        assert res["leadsWaitingForReply"][0]["displayName"] == "Client In Need"
        assert res["leadsWaitingForReply"][0]["hoursWaiting"] >= 1.9

    @pytest.mark.asyncio
    async def test_reminder_metrics(self, mock_db):
        res = await execute_tool(name="get_reminder_metrics", arguments={"limit": 5}, context=ADMIN_CTX)
        assert res["totalPending"] == 2
        assert res["overdueCount"] == 1
        assert len(res["overdueReminders"]) == 1
        assert res["overdueReminders"][0]["title"] == "Call client back"

    @pytest.mark.asyncio
    async def test_team_overview(self, mock_db):
        res = await execute_tool(name="get_team_overview", arguments={}, context=ADMIN_CTX)
        assert "teamMembers" in res
        assert "unassignedLeads" in res

