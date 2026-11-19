"""Customer replies start a fresh silence cycle; old work must not overwrite it."""
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from bson import ObjectId
from mongomock_motor import AsyncMongoMockClient
from app import db, nurture_sweep
from app.conversations_repository import update_conversation_preview, bump_nurture_step, mark_conversation_cold


NOW = datetime(2026, 11, 19, 8, tzinfo=timezone.utc)


@pytest_asyncio.fixture
async def context(monkeypatch):
    database = AsyncMongoMockClient()['nurture_restart']
    monkeypatch.setattr(db, 'get_database', lambda: database)
    org, cid = ObjectId(), ObjectId()
    conversation = {'_id': cid, 'organizationId': org, 'whatsappAccountId': ObjectId(),
        'stage': 'contacted', 'aiAutomationEnabled': True, 'nurtureEnabled': True,
        'createdAt': NOW-timedelta(days=15), 'lastInboundAt': NOW-timedelta(days=5),
        'lastOutboundAt': NOW-timedelta(days=4), 'nurtureStep': 4}
    await database.conversations.insert_one(conversation)
    return database, org, cid, conversation


@pytest.mark.asyncio
async def test_customer_reply_resets_silence_step_and_superseded_promise(context):
    database, org, cid, _ = context
    await database.conversations.update_one({'_id':cid}, {'$set':{
        'promisedFollowUpAt':NOW+timedelta(days=1), 'promisedFollowUpKey':'old-promise',
        'promisedFollowUpDirection':'await_lead', 'promisedFollowUpQuote':'old quote'}})
    updated = await update_conversation_preview(cid, org, last_message_at=NOW, last_inbound_at=NOW)
    assert updated['nurtureStep'] == 0
    assert updated['promisedFollowUpAt'] is None
    assert updated['promisedFollowUpKey'] is None


@pytest.mark.asyncio
async def test_reply_does_not_override_owner_pause_or_opt_out(context):
    database, org, cid, _ = context
    await database.conversations.update_one({'_id':cid}, {'$set':{
        'aiAutomationEnabled':False, 'nurtureEnabled':False, 'optedOutAt':NOW}})
    updated = await update_conversation_preview(cid, org, last_inbound_at=NOW)
    assert updated['aiAutomationEnabled'] is False
    assert updated['nurtureEnabled'] is False
    assert updated['optedOutAt']


@pytest.mark.asyncio
async def test_our_own_reply_does_not_reset_silence_step(context):
    _, org, cid, _ = context
    updated = await update_conversation_preview(cid, org, last_message_at=NOW, unread_count_increment=0)
    assert updated['nurtureStep'] == 4


@pytest.mark.asyncio
async def test_reply_then_ai_answer_then_silence_restarts_step_one(context, monkeypatch):
    database, org, cid, _ = context
    followup = AsyncMock(return_value={'message':'Synthetic follow-up'})
    monkeypatch.setattr(nurture_sweep, 'build_ai_brain_context', AsyncMock(return_value={}))
    monkeypatch.setattr(nurture_sweep, 'get_or_create_ai_system_user', AsyncMock(return_value={'_id':ObjectId()}))
    queued = []
    async def enqueue(**kwargs):
        queued.append(kwargs)
        return {'_id':ObjectId()}
    monkeypatch.setattr(nurture_sweep, 'enqueue_outbound_message', enqueue)
    service = nurture_sweep.NurtureSweepService(
        message_repo=type('Messages', (), {'find_messages_by_conversation_cursor':AsyncMock(return_value=[])})(),
        get_followup_fn=followup, create_activity_fn=AsyncMock())
    old = await database.conversations.find_one({'_id':cid})
    assert await service.process_conversation(old, NOW) == 'nudged'
    reply = NOW+timedelta(minutes=10)
    await update_conversation_preview(cid, org, last_inbound_at=reply, last_message_at=reply)
    await database.conversations.update_one({'_id':cid}, {'$set':{'lastOutboundAt':reply+timedelta(minutes=1)}})
    restarted = await database.conversations.find_one({'_id':cid})
    assert await service.process_conversation(restarted, reply+timedelta(hours=1)) == 'skipped'
    assert await service.process_conversation(restarted, reply+timedelta(hours=2, minutes=1)) == 'nudged'
    assert followup.call_args.kwargs['step'] == 1
    assert queued[0]['idempotency_key'] != queued[1]['idempotency_key']
    assert (await database.conversations.find_one({'_id':cid}))['nurtureStep'] == 1


@pytest.mark.asyncio
async def test_old_sweep_cannot_overwrite_new_reply_reset(context):
    database, org, cid, old = context
    await update_conversation_preview(cid, org, last_inbound_at=NOW)
    result = await bump_nurture_step(conversation_id=cid, organization_id=org, step=5,
        expected_cycle={'lastInboundAt':old['lastInboundAt'], 'nurtureResumedAt':None})
    assert result is None
    assert (await database.conversations.find_one({'_id':cid}))['nurtureStep'] == 0


@pytest.mark.asyncio
async def test_old_expired_cycle_cannot_pause_new_conversation(context):
    database, org, cid, old = context
    await update_conversation_preview(cid, org, last_inbound_at=NOW)
    result = await mark_conversation_cold(cid, org, 'old cycle exhausted',
        expected_cycle={'lastInboundAt':old['lastInboundAt'], 'nurtureResumedAt':None})
    assert result is None
    assert (await database.conversations.find_one({'_id':cid}))['aiAutomationEnabled'] is True


@pytest.mark.asyncio
async def test_old_draft_cannot_make_new_reply_look_answered(context, monkeypatch):
    from app import outbound_messages
    database, org, cid, old = context
    monkeypatch.setattr(outbound_messages, 'create_activity', AsyncMock())
    monkeypatch.setattr(outbound_messages, 'enqueue_conversation_changed', AsyncMock())
    await update_conversation_preview(cid, org, last_inbound_at=NOW, last_message_at=NOW)
    key = f"nurture:{cid}:{int(old['lastInboundAt'].timestamp()*1000)}:5"
    await outbound_messages.enqueue_outbound_message(organization_id=org, conversation=old,
        actor={'_id':ObjectId()}, body='Old-cycle draft', idempotency_key=key, authored_by='ai')
    current = await database.conversations.find_one({'_id':cid})
    assert current['lastOutboundAt'] == old['lastOutboundAt'].replace(tzinfo=None)
    assert current['lastMessageAt'] == NOW.replace(tzinfo=None)
    assert current['nurtureStep'] == 0
    assert outbound_messages.enqueue_conversation_changed.call_args.kwargs['reason'] == 'outbound'


@pytest.mark.asyncio
@pytest.mark.parametrize('reply_during_delivery', [False, True])
async def test_old_cycle_is_blocked_at_the_actual_send_boundary(context, reply_during_delivery):
    from app.outbound_delivery import OutboundDeliveryService
    _, org, cid, old = context
    key = f"nurture:{cid}:{int(old['lastInboundAt'].timestamp()*1000)}:5"
    current = {**old, 'lastInboundAt':NOW-timedelta(minutes=1), 'nurtureStep':0}
    find = AsyncMock(side_effect=[old, current] if reply_during_delivery else [current])
    message = {'_id':ObjectId(), 'organizationId':org, 'conversationId':cid,
        'whatsappAccountId':old['whatsappAccountId'], 'contactId':ObjectId(),
        'authoredBy':'ai', 'idempotencyKey':key, 'body':'Old-cycle draft', 'createdAt':NOW}
    send = AsyncMock()
    session = type('Session', (), {'send_text_message':send})()
    failed = AsyncMock()
    service = OutboundDeliveryService(session_service=session, send_enabled=True, allowed_numbers='',
        quiet_hours_start=0, quiet_hours_end=0, business_timezone='UTC', now_fn=lambda:NOW,
        claim_next_fn=AsyncMock(return_value=message), find_conversation_fn=find,
        find_contact_pii_fn=AsyncMock(return_value={'phone':'919999999999'}),
        mark_failed_fn=failed, publish_event_fn=AsyncMock())
    outcome = await service.deliver_next()
    assert outcome['reason'] == 'superseded_by_inbound'
    send.assert_not_awaited()
    assert failed.call_args.kwargs['permanent'] is True


@pytest.mark.asyncio
async def test_restarted_proposal_remains_eligible_but_closed_or_paused_leads_do_not(context):
    from app.conversations_repository import find_nurturable_conversations
    database, org, cid, _ = context
    await database.conversations.update_one({'_id':cid}, {'$set':{'stage':'proposal'}})
    await update_conversation_preview(cid, org, last_inbound_at=NOW)
    for changes in ({'stage':'won'}, {'stage':'lost'}, {'aiAutomationEnabled':False},
                    {'nurtureEnabled':False}, {'optedOutAt':NOW}, {'salesRejectedAt':NOW}):
        await database.conversations.insert_one({**context[3], **changes, '_id':ObjectId()})
    rows = await find_nurturable_conversations(organization_id=org, now=NOW, db_override=database)
    assert [row['_id'] for row in rows] == [cid]
