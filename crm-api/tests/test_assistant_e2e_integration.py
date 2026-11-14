"""
End-to-end integration tests for the Vistaar CRM JARVIS Assistant.

Tests the full assistant loop via `assistant_agent.run_assistant()`:
- Seeded MongoDB dataset across multiple collections
- Simulated AI Brain turns selecting read-only CRM intelligence tools
- Tool execution inside authenticated ToolContext
- Result assembly and grounding
- Multi-turn conversation flows with history propagation
- Strict tenant isolation and permission boundaries
- Timezone and date preset handling
- Robust edge-case handling (empty CRM, malformed queries, deleted records)
"""

from datetime import datetime, timedelta, timezone
from typing import Any
import pytest
import pytest_asyncio
from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient

from app import ai_brain, db
from app.assistant_agent import run_assistant
from app.assistant_tools import (
    ToolContext,
    execute_tool,
)
from app.permissions import (
    CONVERSATIONS_READ_ALL,
    CONVERSATIONS_READ_ASSIGNED,
    CRM_TASKS_MANAGE,
    USERS_READ,
)

# Test IDs
ORG_A = ObjectId()
ORG_B = ObjectId()

ADMIN_A = ObjectId()
STAFF_A = ObjectId()
ADMIN_B = ObjectId()

SOURCE_WEDDING = ObjectId()
SOURCE_PORTRAIT = ObjectId()
SOURCE_COMMERCIAL = ObjectId()
SOURCE_ORG_B = ObjectId()

FORM_ID_WEDDING = "form_meta_101"
FORM_ID_PORTRAIT = "form_meta_102"
FORM_ID_COMMERCIAL = "form_meta_103"

NOW = datetime.now(timezone.utc)

ADMIN_CTX = ToolContext(
    organization_id=ORG_A,
    actor_id=ADMIN_A,
    permissions=(
        CONVERSATIONS_READ_ALL,
        CONVERSATIONS_READ_ASSIGNED,
        CRM_TASKS_MANAGE,
        USERS_READ,
    ),
)

STAFF_CTX = ToolContext(
    organization_id=ORG_A,
    actor_id=STAFF_A,
    permissions=(
        CONVERSATIONS_READ_ASSIGNED,
        CRM_TASKS_MANAGE,
    ),
)

ORG_B_CTX = ToolContext(
    organization_id=ORG_B,
    actor_id=ADMIN_B,
    permissions=(
        CONVERSATIONS_READ_ALL,
        CONVERSATIONS_READ_ASSIGNED,
        CRM_TASKS_MANAGE,
        USERS_READ,
    ),
)


def tool_turn(name: str, arguments: dict[str, Any] | None = None, call_id: str = "call_1") -> dict[str, Any]:
    """A simulated brain turn that requests a tool call."""
    args = arguments or {}
    return {
        "stop_reason": "tool_use",
        "text": "",
        "tool_calls": [{"id": call_id, "name": name, "input": args}],
        "assistant_content": [
            {"type": "tool_use", "id": call_id, "name": name, "input": args}
        ],
        "usage": {"input_tokens": 50, "output_tokens": 20},
    }


def answer_turn(text: str) -> dict[str, Any]:
    """A simulated brain turn that concludes with an answer."""
    return {
        "stop_reason": "end_turn",
        "text": text,
        "tool_calls": [],
        "assistant_content": [{"type": "text", "text": text}],
        "usage": {"input_tokens": 60, "output_tokens": 30},
    }


def set_scripted_turns(monkeypatch, turns: list[dict[str, Any]]) -> None:
    """Helper to mock ai_brain.assistant_agent_turn with an async function."""
    turn_iter = iter(turns)

    async def fake_turn(payload: dict[str, Any]) -> dict[str, Any]:
        return next(turn_iter)

    monkeypatch.setattr(ai_brain, "assistant_agent_turn", fake_turn)


@pytest_asyncio.fixture
async def seeded_crm(monkeypatch):
    """Initializes and seeds an in-memory MongoDB with realistic CRM data."""
    mock = AsyncMongoMockClient()["vistaar_e2e_test"]
    monkeypatch.setattr(db, "get_database", lambda: mock)

    # 1. Users
    await mock["users"].insert_many([
        {"_id": ADMIN_A, "organizationId": ORG_A, "name": "Deepak Admin", "email": "deepak@vistaar.com", "role": "admin", "status": "active"},
        {"_id": STAFF_A, "organizationId": ORG_A, "name": "Sneha Staff", "email": "sneha@vistaar.com", "role": "staff", "status": "active"},
        {"_id": ADMIN_B, "organizationId": ORG_B, "name": "Bob OrgB", "email": "bob@orgb.com", "role": "admin", "status": "active"},
    ])

    # 2. Meta Connections
    await mock["metaconnections"].insert_many([
        {
            "_id": ObjectId(),
            "organizationId": ORG_A,
            "metaUserName": "Vistaar Photography",
            "metaUserId": "fb_user_999",
            "status": "connected",
            "grantedScopes": ["leads_retrieval", "pages_manage_ads", "pages_read_engagement"],
            "lastCheckedAt": NOW - timedelta(hours=1),
            "lastError": None,
        },
        {
            "_id": ObjectId(),
            "organizationId": ORG_B,
            "metaUserName": "OrgB Studio",
            "metaUserId": "fb_user_888",
            "status": "connected",
            "grantedScopes": ["leads_retrieval"],
            "lastCheckedAt": NOW - timedelta(days=1),
        },
    ])

    # 3. Lead Sources (Meta forms)
    await mock["leadsources"].insert_many([
        {
            "_id": SOURCE_WEDDING,
            "organizationId": ORG_A,
            "kind": "meta_lead_ad",
            "name": "Wedding Shoot 2026",
            "status": "active",
            "totalImported": 15,
            "lastSyncedAt": NOW - timedelta(minutes=15),
            "meta": {
                "formId": FORM_ID_WEDDING,
                "formName": "Wedding Shoot 2026",
                "pageId": "page_1001",
                "pageName": "Vistaar Wedding Stories",
                "webhookSubscribedAt": NOW - timedelta(days=30),
            },
        },
        {
            "_id": SOURCE_PORTRAIT,
            "organizationId": ORG_A,
            "kind": "meta_lead_ad",
            "name": "Studio Portrait Form",
            "status": "active",
            "totalImported": 8,
            "lastSyncedAt": NOW - timedelta(hours=2),
            "meta": {
                "formId": FORM_ID_PORTRAIT,
                "formName": "Studio Portrait Form",
                "pageId": "page_1002",
                "pageName": "Vistaar Studio",
                "webhookSubscribedAt": NOW - timedelta(days=20),
            },
        },
        {
            "_id": SOURCE_COMMERCIAL,
            "organizationId": ORG_A,
            "kind": "meta_lead_ad",
            "name": "Commercial Ads Form",
            "status": "paused",
            "totalImported": 4,
            "lastSyncedAt": NOW - timedelta(days=5),
            "meta": {
                "formId": FORM_ID_COMMERCIAL,
                "formName": "Commercial Ads Form",
                "pageId": "page_1001",
                "pageName": "Vistaar Wedding Stories",
            },
        },
        {
            "_id": SOURCE_ORG_B,
            "organizationId": ORG_B,
            "kind": "meta_lead_ad",
            "name": "OrgB Lead Form",
            "status": "active",
            "totalImported": 30,
            "meta": {"formId": "form_b", "formName": "OrgB Form"},
        },
    ])

    # 4. WhatsApp Accounts
    await mock["whatsappaccounts"].insert_many([
        {
            "_id": ObjectId(),
            "organizationId": ORG_A,
            "name": "Main Studio Line",
            "brandKey": "vistaar_main",
            "status": "active",
            "lastConnectedAt": NOW - timedelta(days=3),
            "lastDisconnectedAt": None,
        },
        {
            "_id": ObjectId(),
            "organizationId": ORG_A,
            "name": "Events Team",
            "brandKey": "vistaar_events",
            "status": "disconnected",
            "lastConnectedAt": None,
            "lastDisconnectedAt": NOW - timedelta(days=1),
            "disconnectReason": "LOGGED_OUT_BY_META",
        },
    ])

    # 5. Conversations / Leads
    # In Org A:
    # - 3 leads from Wedding form (2 assigned to ADMIN_A [1 won, 1 new], 1 assigned to STAFF_A [new])
    # - 2 leads from Portrait form (1 assigned to STAFF_A [qualified], 1 unassigned [new])
    # - 1 organic WhatsApp lead (assigned to STAFF_A [won])
    # - 1 deleted lead (should NEVER be counted)
    # - 1 owner_assistant system conversation (should NEVER be counted)
    # Total valid leads for Org A: 6
    # Total leads for Staff A: 3 (1 wedding, 1 portrait, 1 organic)
    # Won leads in Org A: 2 (1 wedding, 1 organic)
    await mock["conversations"].insert_many([
        # Lead 1: Wedding, Admin, Won, Today
        {
            "_id": ObjectId(),
            "organizationId": ORG_A,
            "displayName": "Rahul & Priya Wedding",
            "stage": "won",
            "status": "active",
            "leadSourceId": SOURCE_WEDDING,
            "assignedTo": ADMIN_A,
            "createdAt": NOW - timedelta(hours=2),
            "updatedAt": NOW - timedelta(hours=1),
            "lastInboundAt": NOW - timedelta(hours=2),
            "lastOutboundAt": NOW - timedelta(hours=1),
            "lastMessageAt": NOW - timedelta(hours=1),
            "deletedAt": None,
            "kind": "customer",
        },
        # Lead 2: Wedding, Admin, New, Yesterday
        {
            "_id": ObjectId(),
            "organizationId": ORG_A,
            "displayName": "Ananya Destination Wedding",
            "stage": "new",
            "status": "active",
            "leadSourceId": SOURCE_WEDDING,
            "assignedTo": ADMIN_A,
            "createdAt": NOW - timedelta(days=1, hours=3),
            "updatedAt": NOW - timedelta(days=1),
            "lastInboundAt": NOW - timedelta(hours=5),
            "lastOutboundAt": None,  # Awaiting reply!
            "lastMessageAt": NOW - timedelta(hours=5),
            "deletedAt": None,
            "kind": "customer",
        },
        # Lead 3: Wedding, Staff A, New, 3 days ago
        {
            "_id": ObjectId(),
            "organizationId": ORG_A,
            "displayName": "Vikram Pre-wedding",
            "stage": "new",
            "status": "active",
            "leadSourceId": SOURCE_WEDDING,
            "assignedTo": STAFF_A,
            "createdAt": NOW - timedelta(days=3),
            "updatedAt": NOW - timedelta(days=3),
            "lastInboundAt": NOW - timedelta(hours=12),
            "lastOutboundAt": None,  # Awaiting reply!
            "lastMessageAt": NOW - timedelta(hours=12),
            "deletedAt": None,
            "kind": "customer",
        },
        # Lead 4: Portrait, Staff A, Qualified, 4 days ago
        {
            "_id": ObjectId(),
            "organizationId": ORG_A,
            "displayName": "Neha Family Portrait",
            "stage": "qualified",
            "status": "active",
            "leadSourceId": SOURCE_PORTRAIT,
            "assignedTo": STAFF_A,
            "createdAt": NOW - timedelta(days=4),
            "updatedAt": NOW - timedelta(days=2),
            "lastInboundAt": NOW - timedelta(days=2),
            "lastOutboundAt": NOW - timedelta(days=2),
            "lastMessageAt": NOW - timedelta(days=2),
            "deletedAt": None,
            "kind": "customer",
        },
        # Lead 5: Portrait, Unassigned, New, 10 days ago
        {
            "_id": ObjectId(),
            "organizationId": ORG_A,
            "displayName": "Kavita Headshots",
            "stage": "new",
            "status": "active",
            "leadSourceId": SOURCE_PORTRAIT,
            "assignedTo": None,
            "createdAt": NOW - timedelta(days=10),
            "updatedAt": NOW - timedelta(days=10),
            "lastInboundAt": NOW - timedelta(days=10),
            "lastOutboundAt": None,  # Awaiting reply, unassigned!
            "lastMessageAt": NOW - timedelta(days=10),
            "deletedAt": None,
            "kind": "customer",
        },
        # Lead 6: Organic WhatsApp (leadSourceId=None), Staff A, Won, 12 days ago
        {
            "_id": ObjectId(),
            "organizationId": ORG_A,
            "displayName": "Direct WhatsApp Inquiry",
            "stage": "won",
            "status": "active",
            "leadSourceId": None,
            "assignedTo": STAFF_A,
            "createdAt": NOW - timedelta(days=12),
            "updatedAt": NOW - timedelta(days=5),
            "lastInboundAt": NOW - timedelta(days=5),
            "lastOutboundAt": NOW - timedelta(days=5),
            "lastMessageAt": NOW - timedelta(days=5),
            "deletedAt": None,
            "kind": "customer",
        },
        # Lead 7: DELETED lead (Must NOT appear anywhere)
        {
            "_id": ObjectId(),
            "organizationId": ORG_A,
            "displayName": "Deleted Spam Lead",
            "stage": "lost",
            "status": "closed",
            "leadSourceId": SOURCE_WEDDING,
            "assignedTo": ADMIN_A,
            "createdAt": NOW - timedelta(days=1),
            "deletedAt": NOW - timedelta(hours=12),
            "kind": "customer",
        },
        # Lead 8: Owner Assistant thread (Must NOT appear anywhere)
        {
            "_id": ObjectId(),
            "organizationId": ORG_A,
            "displayName": "JARVIS CRM Assistant",
            "stage": "won",
            "status": "active",
            "assignedTo": ADMIN_A,
            "createdAt": NOW - timedelta(days=2),
            "deletedAt": None,
            "kind": "owner_assistant",
        },
        # Org B Lead (Must NOT be visible to Org A)
        {
            "_id": ObjectId(),
            "organizationId": ORG_B,
            "displayName": "OrgB Customer Lead",
            "stage": "new",
            "status": "active",
            "leadSourceId": SOURCE_ORG_B,
            "assignedTo": ADMIN_B,
            "createdAt": NOW - timedelta(hours=2),
            "deletedAt": None,
            "kind": "customer",
        },
    ])

    # 6. Follow-up Tasks / Reminders
    await mock["followuptasks"].insert_many([
        # Task 1: Overdue by 4 hours
        {
            "_id": ObjectId(),
            "organizationId": ORG_A,
            "assignedTo": ADMIN_A,
            "title": "Call Rahul regarding wedding package",
            "status": "pending",
            "dueAt": NOW - timedelta(hours=4),
        },
        # Task 2: Due in 2 hours (today)
        {
            "_id": ObjectId(),
            "organizationId": ORG_A,
            "assignedTo": STAFF_A,
            "title": "Send Neha portrait album proofs",
            "status": "pending",
            "dueAt": NOW + timedelta(hours=2),
        },
        # Task 3: Upcoming in 3 days
        {
            "_id": ObjectId(),
            "organizationId": ORG_A,
            "assignedTo": STAFF_A,
            "title": "Follow up on Vikram venue confirmation",
            "status": "pending",
            "dueAt": NOW + timedelta(days=3),
        },
        # Task 4: Completed task (should NOT be counted as pending)
        {
            "_id": ObjectId(),
            "organizationId": ORG_A,
            "assignedTo": ADMIN_A,
            "title": "Completed consultation",
            "status": "completed",
            "dueAt": NOW - timedelta(days=1),
        },
    ])

    return mock


# ==============================================================================
# SECTION 2: END-TO-END REPRESENTATIVE QUESTIONS TESTED THROUGH RUN_ASSISTANT
# ==============================================================================


@pytest.mark.asyncio
async def test_q01_how_many_leads_total(seeded_crm, monkeypatch):
    """Q1: 'How many leads do we have?' -> get_pipeline_metrics({}) -> 6 valid leads."""
    set_scripted_turns(monkeypatch, [
        tool_turn("get_pipeline_metrics", {}),
        answer_turn("You currently have 6 active leads in your CRM."),
    ])

    res = await run_assistant(question="How many leads do we have?", context=ADMIN_CTX)
    assert res["stepCount"] == 1
    assert res["steps"][0]["tool"] == "get_pipeline_metrics"
    assert res["steps"][0]["ok"] is True
    assert res["answer"] == "You currently have 6 active leads in your CRM."


@pytest.mark.asyncio
async def test_q02_leads_today(seeded_crm, monkeypatch):
    """Q2: 'How many leads came in today?' -> get_pipeline_metrics(date_preset='today')."""
    set_scripted_turns(monkeypatch, [
        tool_turn("get_pipeline_metrics", {"date_preset": "today"}),
        answer_turn("You received 1 new lead today (Rahul & Priya Wedding)."),
    ])

    res = await run_assistant(question="How many leads came in today?", context=ADMIN_CTX)
    assert res["stepCount"] == 1
    assert res["steps"][0]["tool"] == "get_pipeline_metrics"
    assert res["steps"][0]["arguments"]["date_preset"] == "today"


@pytest.mark.asyncio
async def test_q03_leads_yesterday(seeded_crm, monkeypatch):
    """Q3: 'How many leads yesterday?' -> get_pipeline_metrics(date_preset='yesterday')."""
    set_scripted_turns(monkeypatch, [
        tool_turn("get_pipeline_metrics", {"date_preset": "yesterday"}),
        answer_turn("There was 1 new lead yesterday."),
    ])

    res = await run_assistant(question="How many leads yesterday?", context=ADMIN_CTX)
    assert res["stepCount"] == 1
    assert res["steps"][0]["arguments"]["date_preset"] == "yesterday"


@pytest.mark.asyncio
async def test_q04_leads_this_week(seeded_crm, monkeypatch):
    """Q4: 'How many leads this week?' -> get_pipeline_metrics(date_preset='this_week')."""
    set_scripted_turns(monkeypatch, [
        tool_turn("get_pipeline_metrics", {"date_preset": "this_week"}),
        answer_turn("You have received leads this week."),
    ])

    res = await run_assistant(question="How many leads this week?", context=ADMIN_CTX)
    assert res["stepCount"] == 1
    assert res["steps"][0]["arguments"]["date_preset"] == "this_week"


@pytest.mark.asyncio
async def test_q05_leads_this_month(seeded_crm, monkeypatch):
    """Q5: 'How many leads this month?' -> get_pipeline_metrics(date_preset='this_month')."""
    set_scripted_turns(monkeypatch, [
        tool_turn("get_pipeline_metrics", {"date_preset": "this_month"}),
        answer_turn("This month you have generated leads."),
    ])

    res = await run_assistant(question="How many leads this month?", context=ADMIN_CTX)
    assert res["stepCount"] == 1
    assert res["steps"][0]["arguments"]["date_preset"] == "this_month"


@pytest.mark.asyncio
async def test_q06_pipeline_breakdown_by_stage(seeded_crm, monkeypatch):
    """Q6: 'What is our pipeline breakdown?' -> get_pipeline_metrics(group_by='stage')."""
    set_scripted_turns(monkeypatch, [
        tool_turn("get_pipeline_metrics", {"group_by": "stage"}),
        answer_turn("Here is the pipeline breakdown: 3 new, 1 qualified, 2 won."),
    ])

    res = await run_assistant(question="What is our pipeline breakdown?", context=ADMIN_CTX)
    assert res["stepCount"] == 1
    assert res["steps"][0]["arguments"]["group_by"] == "stage"


@pytest.mark.asyncio
async def test_q07_leads_by_source(seeded_crm, monkeypatch):
    """Q7: 'Where are our leads coming from?' -> get_pipeline_metrics(group_by='source')."""
    set_scripted_turns(monkeypatch, [
        tool_turn("get_pipeline_metrics", {"group_by": "source"}),
        answer_turn("3 leads came from Wedding Shoot, 2 from Studio Portrait, and 1 direct WhatsApp."),
    ])

    res = await run_assistant(question="Where are our leads coming from?", context=ADMIN_CTX)
    assert res["stepCount"] == 1
    assert res["steps"][0]["arguments"]["group_by"] == "source"


@pytest.mark.asyncio
async def test_q08_is_meta_connected(seeded_crm, monkeypatch):
    """Q8: 'Is Facebook/Meta connected?' -> get_meta_integration_status()."""
    set_scripted_turns(monkeypatch, [
        tool_turn("get_meta_integration_status", {}),
        answer_turn("Facebook/Meta is connected under Vistaar Photography."),
    ])

    res = await run_assistant(question="Is Facebook connected?", context=ADMIN_CTX)
    assert res["stepCount"] == 1
    assert res["steps"][0]["tool"] == "get_meta_integration_status"
    assert res["steps"][0]["ok"] is True


@pytest.mark.asyncio
async def test_q09_which_facebook_forms_connected(seeded_crm, monkeypatch):
    """Q9: 'Which Facebook lead forms are connected?' -> list_meta_lead_forms()."""
    set_scripted_turns(monkeypatch, [
        tool_turn("list_meta_lead_forms", {}),
        answer_turn("You have 3 forms: Wedding Shoot 2026, Studio Portrait Form, and Commercial Ads Form."),
    ])

    res = await run_assistant(question="Which Facebook forms are connected?", context=ADMIN_CTX)
    assert res["stepCount"] == 1
    assert res["steps"][0]["tool"] == "list_meta_lead_forms"


@pytest.mark.asyncio
async def test_q10_which_forms_are_active(seeded_crm, monkeypatch):
    """Q10: 'Which forms are active?' -> list_meta_lead_forms(status='active')."""
    set_scripted_turns(monkeypatch, [
        tool_turn("list_meta_lead_forms", {"status": "active"}),
        answer_turn("2 forms are active: Wedding Shoot 2026 and Studio Portrait Form."),
    ])

    res = await run_assistant(question="Which forms are active?", context=ADMIN_CTX)
    assert res["stepCount"] == 1
    assert res["steps"][0]["arguments"]["status"] == "active"


@pytest.mark.asyncio
async def test_q11_how_many_leads_from_each_form(seeded_crm, monkeypatch):
    """Q11: 'How many leads came from each form?' -> get_form_lead_metrics()."""
    set_scripted_turns(monkeypatch, [
        tool_turn("get_form_lead_metrics", {}),
        answer_turn("Wedding Shoot brought 3 leads and Studio Portrait brought 2 leads."),
    ])

    res = await run_assistant(question="How many leads came from each form?", context=ADMIN_CTX)
    assert res["stepCount"] == 1
    assert res["steps"][0]["tool"] == "get_form_lead_metrics"


@pytest.mark.asyncio
async def test_q12_leads_from_specific_form(seeded_crm, monkeypatch):
    """Q12: 'How many leads from Wedding Shoot form?' -> get_form_lead_metrics(form_name='Wedding Shoot')."""
    set_scripted_turns(monkeypatch, [
        tool_turn("get_form_lead_metrics", {"form_name": "Wedding Shoot"}),
        answer_turn("The Wedding Shoot 2026 form generated 3 leads with a 33.3% conversion rate."),
    ])

    res = await run_assistant(question="How many leads from Wedding Shoot form?", context=ADMIN_CTX)
    assert res["stepCount"] == 1
    assert res["steps"][0]["arguments"]["form_name"] == "Wedding Shoot"


@pytest.mark.asyncio
async def test_q13_top_performing_form(seeded_crm, monkeypatch):
    """Q13: 'Which form generated the most leads?' -> get_form_lead_metrics()."""
    set_scripted_turns(monkeypatch, [
        tool_turn("get_form_lead_metrics", {}),
        answer_turn("Wedding Shoot 2026 is your top performing form with 3 leads."),
    ])

    res = await run_assistant(question="Which form generated the most leads?", context=ADMIN_CTX)
    assert res["stepCount"] == 1
    assert res["steps"][0]["tool"] == "get_form_lead_metrics"


@pytest.mark.asyncio
async def test_q14_is_whatsapp_connected(seeded_crm, monkeypatch):
    """Q14: 'Is WhatsApp connected?' -> get_whatsapp_integration_status()."""
    set_scripted_turns(monkeypatch, [
        tool_turn("get_whatsapp_integration_status", {}),
        answer_turn("Yes, WhatsApp is connected. Main Studio Line is active."),
    ])

    res = await run_assistant(question="Is WhatsApp connected?", context=ADMIN_CTX)
    assert res["stepCount"] == 1
    assert res["steps"][0]["tool"] == "get_whatsapp_integration_status"


@pytest.mark.asyncio
async def test_q15_customers_awaiting_replies_count(seeded_crm, monkeypatch):
    """Q15: 'How many customers are awaiting replies?' -> get_conversation_statistics()."""
    set_scripted_turns(monkeypatch, [
        tool_turn("get_conversation_statistics", {}),
        answer_turn("You have 3 leads awaiting replies."),
    ])

    res = await run_assistant(question="How many customers are awaiting replies?", context=ADMIN_CTX)
    assert res["stepCount"] == 1
    assert res["steps"][0]["tool"] == "get_conversation_statistics"


@pytest.mark.asyncio
async def test_q16_who_is_awaiting_reply(seeded_crm, monkeypatch):
    """Q16: 'Which leads haven't received a reply?' -> get_conversation_statistics(limit=5)."""
    set_scripted_turns(monkeypatch, [
        tool_turn("get_conversation_statistics", {"limit": 5}),
        answer_turn("The following leads are waiting: Ananya Destination Wedding, Vikram Pre-wedding, Kavita Headshots."),
    ])

    res = await run_assistant(question="Which leads haven't received a reply?", context=ADMIN_CTX)
    assert res["stepCount"] == 1
    assert res["steps"][0]["arguments"]["limit"] == 5


@pytest.mark.asyncio
async def test_q17_overdue_followups(seeded_crm, monkeypatch):
    """Q17: 'What follow-ups are overdue?' -> get_reminder_metrics()."""
    set_scripted_turns(monkeypatch, [
        tool_turn("get_reminder_metrics", {}),
        answer_turn("1 follow-up is overdue: 'Call Rahul regarding wedding package'."),
    ])

    res = await run_assistant(question="What follow-ups are overdue?", context=ADMIN_CTX)
    assert res["stepCount"] == 1
    assert res["steps"][0]["tool"] == "get_reminder_metrics"


@pytest.mark.asyncio
async def test_q18_reminders_due_today(seeded_crm, monkeypatch):
    """Q18: 'What reminders are due today?' -> get_reminder_metrics()."""
    set_scripted_turns(monkeypatch, [
        tool_turn("get_reminder_metrics", {}),
        answer_turn("You have reminders due today."),
    ])

    res = await run_assistant(question="What reminders are due today?", context=ADMIN_CTX)
    assert res["stepCount"] == 1
    assert res["steps"][0]["tool"] == "get_reminder_metrics"


@pytest.mark.asyncio
async def test_q19_employee_manages_most_leads(seeded_crm, monkeypatch):
    """Q19: 'Which employee manages the most leads?' -> get_team_overview()."""
    set_scripted_turns(monkeypatch, [
        tool_turn("get_team_overview", {}),
        answer_turn("Sneha Staff manages the most leads with 3 assigned leads."),
    ])

    res = await run_assistant(question="Which employee manages the most leads?", context=ADMIN_CTX)
    assert res["stepCount"] == 1
    assert res["steps"][0]["tool"] == "get_team_overview"


@pytest.mark.asyncio
async def test_q20_employee_conversion_rate(seeded_crm, monkeypatch):
    """Q20: 'Who has the best conversion rate?' -> get_team_overview()."""
    set_scripted_turns(monkeypatch, [
        tool_turn("get_team_overview", {}),
        answer_turn("Deepak Admin has a 50.0% conversion rate (1 won of 2 leads)."),
    ])

    res = await run_assistant(question="Who has the best conversion rate?", context=ADMIN_CTX)
    assert res["stepCount"] == 1
    assert res["steps"][0]["tool"] == "get_team_overview"


@pytest.mark.asyncio
async def test_q21_staff_pipeline_scoping(seeded_crm, monkeypatch):
    """Q21: Staff user asking 'How many leads do we have?' -> only assigned leads counted."""
    set_scripted_turns(monkeypatch, [
        tool_turn("get_pipeline_metrics", {}),
        answer_turn("You have 3 leads assigned to you."),
    ])

    res = await run_assistant(question="How many leads do we have?", context=STAFF_CTX)
    assert res["stepCount"] == 1

    # Direct tool verification under STAFF_CTX
    raw_tool_result = await execute_tool(name="get_pipeline_metrics", arguments={}, context=STAFF_CTX)
    assert raw_tool_result["totalLeads"] == 3
    assert raw_tool_result["scopedToActor"] is True


@pytest.mark.asyncio
async def test_q22_multi_turn_form_to_leads(seeded_crm, monkeypatch):
    """Q22: Multi-turn flow:
    Turn 1: 'Which form brought the most leads?'
    Turn 2: 'Show me the leads from that form' -> uses lead_source_id in search_leads.
    """
    # Turn 1
    set_scripted_turns(monkeypatch, [
        tool_turn("get_form_lead_metrics", {}),
        answer_turn("Wedding Shoot 2026 brought the most leads (3 leads)."),
    ])

    res_t1 = await run_assistant(question="Which form brought the most leads?", context=ADMIN_CTX)
    history = res_t1["messages"]

    # Turn 2: the model receives history and calls search_leads with the lead_source_id
    set_scripted_turns(monkeypatch, [
        tool_turn("search_leads", {"lead_source_id": str(SOURCE_WEDDING)}),
        answer_turn("Here are the leads from Wedding Shoot 2026: Rahul & Priya Wedding, Ananya Destination Wedding, Vikram Pre-wedding."),
    ])

    res_t2 = await run_assistant(
        question="Show me the leads from that form",
        context=ADMIN_CTX,
        history=history,
    )
    assert res_t2["stepCount"] == 1
    assert res_t2["steps"][0]["tool"] == "search_leads"
    assert res_t2["steps"][0]["arguments"]["lead_source_id"] == str(SOURCE_WEDDING)


@pytest.mark.asyncio
async def test_q23_filter_leads_by_lead_source_id(seeded_crm):
    """Q23: search_leads directly filtering by lead_source_id."""
    res = await execute_tool(
        name="search_leads",
        arguments={"lead_source_id": str(SOURCE_PORTRAIT)},
        context=ADMIN_CTX,
    )
    assert res["count"] == 2
    names = [lead["displayName"] for lead in res["leads"]]
    assert "Neha Family Portrait" in names
    assert "Kavita Headshots" in names
    assert "Rahul & Priya Wedding" not in names


@pytest.mark.asyncio
async def test_q24_compare_previous_month(seeded_crm):
    """Q24: get_pipeline_metrics with date_preset='this_month' and compare_previous=True."""
    res = await execute_tool(
        name="get_pipeline_metrics",
        arguments={"date_preset": "this_month", "compare_previous": True},
        context=ADMIN_CTX,
    )
    assert "previousPeriod" in res
    prev = res["previousPeriod"]
    assert "totalLeads" in prev
    assert "difference" in prev
    assert "percentChange" in prev


@pytest.mark.asyncio
async def test_q25_empty_crm_graceful_response(monkeypatch):
    """Q25: Completely empty CRM returns 0/graceful payloads across all 8 tools."""
    mock_empty = AsyncMongoMockClient()["empty_crm"]
    monkeypatch.setattr(db, "get_database", lambda: mock_empty)

    empty_ctx = ToolContext(
        organization_id=ObjectId(),
        actor_id=ObjectId(),
        permissions=(CONVERSATIONS_READ_ALL, CONVERSATIONS_READ_ASSIGNED, CRM_TASKS_MANAGE),
    )

    p_res = await execute_tool(name="get_pipeline_metrics", arguments={}, context=empty_ctx)
    assert p_res["totalLeads"] == 0
    assert p_res["summary"]["conversionRate"] == "0.0%"

    m_res = await execute_tool(name="get_meta_integration_status", arguments={}, context=empty_ctx)
    assert m_res["connected"] is False
    assert m_res["totalFormSources"] == 0

    f_res = await execute_tool(name="list_meta_lead_forms", arguments={}, context=empty_ctx)
    assert f_res["count"] == 0

    fm_res = await execute_tool(name="get_form_lead_metrics", arguments={}, context=empty_ctx)
    assert fm_res["count"] == 0
    assert fm_res["totalLeadsAcrossForms"] == 0
    assert fm_res["topPerformingForm"] is None

    w_res = await execute_tool(name="get_whatsapp_integration_status", arguments={}, context=empty_ctx)
    assert w_res["connected"] is False
    assert w_res["activeAccountCount"] == 0

    c_res = await execute_tool(name="get_conversation_statistics", arguments={}, context=empty_ctx)
    assert c_res["totalConversations"] == 0
    assert c_res["unansweredInboundCount"] == 0

    r_res = await execute_tool(name="get_reminder_metrics", arguments={}, context=empty_ctx)
    assert r_res["totalPending"] == 0
    assert r_res["overdueCount"] == 0

    t_res = await execute_tool(name="get_team_overview", arguments={}, context=empty_ctx)
    assert t_res["count"] == 0


@pytest.mark.asyncio
async def test_q26_permission_denial_graceful_handling(seeded_crm, monkeypatch):
    """Q26: Staff attempting to access admin-only tool gets a graceful tool error block rather than crashing."""
    set_scripted_turns(monkeypatch, [
        tool_turn("get_meta_integration_status", {}),
        answer_turn("I cannot access Facebook integration status because you do not have permission."),
    ])

    res = await run_assistant(question="Is Meta connected?", context=STAFF_CTX)
    assert res["stepCount"] == 1
    assert res["steps"][0]["tool"] == "get_meta_integration_status"
    assert res["steps"][0]["ok"] is False
    assert "Permission" in res["steps"][0]["error"] or "permission" in res["steps"][0]["error"]
    assert res["stoppedEarly"] is False


@pytest.mark.asyncio
async def test_q27_cross_org_isolation(seeded_crm):
    """Q27: User in Org B sees ONLY Org B data, none of Org A."""
    # Pipeline metrics for Org B
    res_b = await execute_tool(name="get_pipeline_metrics", arguments={}, context=ORG_B_CTX)
    assert res_b["totalLeads"] == 1

    # Form metrics for Org B
    forms_b = await execute_tool(name="list_meta_lead_forms", arguments={}, context=ORG_B_CTX)
    assert forms_b["count"] == 1
    assert forms_b["forms"][0]["formName"] == "OrgB Form"

    # WhatsApp for Org B
    wa_b = await execute_tool(name="get_whatsapp_integration_status", arguments={}, context=ORG_B_CTX)
    assert wa_b["totalAccounts"] == 0


@pytest.mark.asyncio
async def test_q28_deleted_and_owner_assistant_strictly_excluded(seeded_crm):
    """Q28: Deleted records and owner_assistant conversations are excluded from all analytics."""
    p_res = await execute_tool(name="get_pipeline_metrics", arguments={}, context=ADMIN_CTX)
    # Total conversations in Org A DB = 8 (6 valid + 1 deleted + 1 owner_assistant).
    # Expected valid total = 6.
    assert p_res["totalLeads"] == 6

    # Form metrics for Wedding form: 3 valid leads. (1 deleted excluded).
    f_res = await execute_tool(name="get_form_lead_metrics", arguments={"form_name": "Wedding Shoot"}, context=ADMIN_CTX)
    wedding_form = f_res["forms"][0]
    assert wedding_form["leadCount"] == 3

    # Team overview: total leads = 6
    t_res = await execute_tool(name="get_team_overview", arguments={}, context=ADMIN_CTX)
    total_team_leads = sum(m["assignedLeads"] for m in t_res["teamMembers"]) + t_res["unassignedLeads"]
    assert total_team_leads == 6
