/**
 * Decisions 1 and 2 against a real MongoDB: the silence cadence and promise follow-ups.
 *
 * WHAT THIS ADDS OVER THE MOCKED SUITE. Those tests inject fake repositories, so they prove the
 * decisions the services make and nothing about the queries that feed them. Every claim below
 * depends on the database actually behaving as assumed:
 *
 *   - duplicate suppression is a UNIQUE INDEX rejecting a second insert, not a mock returning
 *     the same string twice;
 *   - the nurture sweep finding (or not finding) a conversation is a real query against real
 *     documents, including the partial index on `promisedFollowUpAt`;
 *   - the promise claim is a real `findOneAndUpdate` compare-and-set, which is the only way to
 *     learn whether two workers can both win it.
 *
 * NOTHING HERE CAN SEND. The AI client is stubbed and no WhatsApp session is constructed; the
 * outbound path stops at a `queued` row, which is what the assertions read.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Types } from 'mongoose';

import { ACTIVITY_EVENTS } from '../../src/constants/activity-events.js';
import { ActivityLog } from '../../src/modules/activity/activity-log.model.js';
import { FOLLOWUP_STATUSES } from '../../src/constants/followup-statuses.js';
import { FOLLOWUP_TYPES } from '../../src/constants/followup-types.js';
import { REMINDER_SOURCES } from '../../src/constants/reminder-channels.js';
import { SALES_REJECTION_SOURCES } from '../../src/constants/sales-rejection.js';
import { createNurtureSweepService } from '../../src/modules/ai-brain/nurture-sweep.service.js';
import { createPromiseFollowUpService } from '../../src/modules/followups/promise-follow-up.service.js';
import { Conversation } from '../../src/modules/conversations/conversation.model.js';
import {
  markSalesRejected,
  setPromisedFollowUp,
  updateConversationPreview,
} from '../../src/modules/conversations/conversation.repository.js';
import { createFollowUpTask } from '../../src/modules/followups/followup-task.repository.js';
import { FollowUpTask } from '../../src/modules/followups/followup-task.model.js';
import {
  cleanupRunData,
  connectIntegrationDatabase,
  disconnectIntegrationDatabase,
  newRunOrganizationId,
} from './db.js';
import {
  countOutbound,
  hoursAgo,
  hoursFromNow,
  newRunContext,
  outboundKeys,
  seedConversation,
  stubAiBrainContext,
  stubGetFollowup,
  type RunContext,
} from './fixtures.js';

const organizationId = newRunOrganizationId();
let run: RunContext;

/** Real repositories, real Mongo - only the AI call is replaced. */
const nurtureSweep = () =>
  createNurtureSweepService({
    getFollowup: stubGetFollowup as never,
    buildAiBrainContext: stubAiBrainContext as never,
  });

const promiseSweep = () =>
  createPromiseFollowUpService({
    getFollowup: stubGetFollowup as never,
    buildAiBrainContext: stubAiBrainContext as never,
  });

beforeAll(async () => {
  await connectIntegrationDatabase();
  run = newRunContext(organizationId);
  // Build the indexes this suite asserts on, rather than relying on autoIndex having run.
  await Conversation.syncIndexes();
});

afterEach(async () => {
  // Between scenarios, not at the end: each test seeds its own conversation and a leftover one
  // would be picked up by the next sweep. Still scoped to this run's organisation.
  await cleanupRunData(organizationId);
});

afterAll(async () => {
  await cleanupRunData(organizationId);
  await disconnectIntegrationDatabase();
});

describe('1-3: the silence cadence', () => {
  it('1. queues exactly one follow-up for a lead silent for three hours', async () => {
    const conversation = await seedConversation(run, {
      lastInboundAt: hoursAgo(3),
      lastOutboundAt: hoursAgo(2.5),
      nurtureStep: 0,
    });

    const result = await nurtureSweep().sweepOnce({ organizationId });

    expect(result).toMatchObject({ nudged: 1 });
    expect(await countOutbound(run, conversation._id)).toBe(1);

    const reloaded = await Conversation.findById(conversation._id).lean();
    expect(reloaded?.nurtureStep).toBe(1);
  });

  it('2a. a second sweep immediately after is simply not due', async () => {
    // The ordinary case, and worth separating from the one below: after the first nudge the
    // step is 1, whose due time is anchor + 26h, so the second sweep declines on the schedule
    // alone and never reaches the database guard at all.
    const conversation = await seedConversation(run, {
      lastInboundAt: hoursAgo(3),
      lastOutboundAt: hoursAgo(2.5),
    });

    await nurtureSweep().sweepOnce({ organizationId });
    const second = await nurtureSweep().sweepOnce({ organizationId });

    expect(second).toMatchObject({ nudged: 0 });
    expect(await countOutbound(run, conversation._id)).toBe(1);
  });

  it('2b. a retry that recomputes the SAME key is refused by the unique index', async () => {
    // THE DATABASE GUARD, actually exercised. The test above cannot reach it - the step has
    // already advanced, so the second sweep is not due and no insert is attempted. Resetting
    // the step reproduces the case the idempotency key exists for: a crash between the enqueue
    // and the step bump, after which the sweep legitimately believes step 1 is still owed.
    //
    // The key is (conversation, anchor, step) and all three are unchanged, so the second insert
    // must be rejected by MongoDB's unique index rather than by any in-process bookkeeping -
    // which is the one thing the mocked suite cannot demonstrate.
    const conversation = await seedConversation(run, {
      lastInboundAt: hoursAgo(3),
      lastOutboundAt: hoursAgo(2.5),
    });

    await nurtureSweep().sweepOnce({ organizationId });

    const firstKeys = await outboundKeys(run, conversation._id);
    expect(firstKeys).toHaveLength(1);

    await Conversation.updateOne(
      { _id: conversation._id, organizationId },
      { $set: { nurtureStep: 0 } },
    );

    await nurtureSweep().sweepOnce({ organizationId });

    const afterRetry = await outboundKeys(run, conversation._id);

    expect(afterRetry).toHaveLength(1);
    expect(afterRetry[0]).toBe(firstKeys[0]);
  });

  it('3. a new inbound resets the step and the next sequence uses a different key', async () => {
    // The anchor is part of the key precisely so a restarted sequence does not collide with the
    // first one on the unique index and get silently swallowed.
    const conversation = await seedConversation(run, {
      lastInboundAt: hoursAgo(3),
      lastOutboundAt: hoursAgo(2.5),
    });

    await nurtureSweep().sweepOnce({ organizationId });

    const firstKeys = await outboundKeys(run, conversation._id);

    // The customer writes again. This is the write ingestion performs.
    const newInbound = new Date();
    await updateConversationPreview({
      conversationId: conversation._id,
      organizationId,
      lastInboundAt: newInbound,
      lastMessageAt: newInbound,
    });

    const afterReply = await Conversation.findById(conversation._id).lean();
    expect(afterReply?.nurtureStep).toBe(0);

    // The new sequence becomes due. A CLEARLY different anchor - four hours rather than three -
    // so the two keys differ because the anchor moved, not because two `hoursAgo(3)` calls
    // happened to land a few milliseconds apart. That weaker version would pass even if the
    // anchor were dropped from the key entirely.
    const newAnchor = hoursAgo(4);

    await Conversation.updateOne(
      { _id: conversation._id, organizationId },
      { $set: { lastInboundAt: newAnchor, lastOutboundAt: hoursAgo(3.5) } },
    );

    await nurtureSweep().sweepOnce({ organizationId });

    const allKeys = await outboundKeys(run, conversation._id);

    expect(allKeys).toHaveLength(2);
    expect(allKeys[1]).not.toBe(firstKeys[0]);
    // Both sequences are at step 1, so the ONLY thing that can distinguish the keys is the
    // anchor. Naming it here is what makes this a test of the anchor rather than of inequality.
    expect(allKeys[1]).toContain(String(newAnchor.getTime()));
  });
});

describe('4-6: promise follow-ups', () => {
  const ownerId = new Types.ObjectId();

  it('4. persists both the owner reminder and the customer-facing schedule', async () => {
    const conversation = await seedConversation(run);
    const dueAt = hoursFromNow(5);

    const task = await createFollowUpTask({
      organizationId,
      whatsappAccountId: run.whatsappAccountId,
      conversationId: conversation._id,
      assignedTo: ownerId,
      createdBy: ownerId,
      type: FOLLOWUP_TYPES.CALL,
      title: 'Send the packages',
      dueAt,
      source: REMINDER_SOURCES.LEAD_COMMITMENT,
      idempotencyKey: `itest:lead-commit:${conversation._id.toString()}`,
    });

    await setPromisedFollowUp({
      conversationId: conversation._id,
      organizationId,
      dueAt,
      key: `lead-commit:${conversation._id.toString()}`,
      direction: 'contact_lead',
      quote: 'send me the packages at 5',
    });

    const storedTask = await FollowUpTask.findById(task?._id).lean();
    const storedConversation = await Conversation.findById(conversation._id).lean();

    expect(storedTask).toMatchObject({ status: FOLLOWUP_STATUSES.PENDING });
    expect(storedTask?.dueAt?.getTime()).toBe(dueAt.getTime());
    expect(storedConversation?.promisedFollowUpAt?.getTime()).toBe(dueAt.getTime());
    expect(storedConversation?.promisedFollowUpQuote).toBe('send me the packages at 5');
  });

  it('5. a reply before it is due invalidates the promise but keeps the owner reminder', async () => {
    const conversation = await seedConversation(run);
    const dueAt = hoursFromNow(5);

    const task = await createFollowUpTask({
      organizationId,
      whatsappAccountId: run.whatsappAccountId,
      conversationId: conversation._id,
      assignedTo: ownerId,
      createdBy: ownerId,
      type: FOLLOWUP_TYPES.CALL,
      title: 'Send the packages',
      dueAt,
      source: REMINDER_SOURCES.LEAD_COMMITMENT,
      idempotencyKey: `itest:lead-commit-2:${conversation._id.toString()}`,
    });

    await setPromisedFollowUp({
      conversationId: conversation._id,
      organizationId,
      dueAt,
      key: 'lead-commit:x',
      direction: 'await_lead',
    });

    // The customer writes back first.
    await updateConversationPreview({
      conversationId: conversation._id,
      organizationId,
      lastInboundAt: new Date(),
      lastMessageAt: new Date(),
    });

    const storedConversation = await Conversation.findById(conversation._id).lean();
    const storedTask = await FollowUpTask.findById(task?._id).lean();

    expect(storedConversation?.promisedFollowUpAt).toBeNull();
    expect(storedConversation?.promisedFollowUpKey).toBeNull();
    // THE OWNER REMINDER IS UNTOUCHED. Cancelling the customer-facing half must never silently
    // take the owner's own to-do with it.
    expect(storedTask?.status).toBe(FOLLOWUP_STATUSES.PENDING);
    expect(storedTask?.dueAt?.getTime()).toBe(dueAt.getTime());
  });

  it('6. a pending promise suppresses the competing silence nudge', async () => {
    const conversation = await seedConversation(run, {
      lastInboundAt: hoursAgo(3),
      lastOutboundAt: hoursAgo(2.5),
      promisedFollowUpAt: hoursFromNow(2),
      promisedFollowUpKey: 'lead-commit:y',
      promisedFollowUpDirection: 'contact_lead',
    });

    const result = await nurtureSweep().sweepOnce({ organizationId });

    expect(result).toMatchObject({ nudged: 0 });
    expect(await countOutbound(run, conversation._id)).toBe(0);

    // And the sequence has not advanced, so it resumes where it left off afterwards.
    const reloaded = await Conversation.findById(conversation._id).lean();
    expect(reloaded?.nurtureStep).toBe(0);
  });
});

describe('7: a firm rejection stops both mechanisms', () => {
  it('clears the pending promise fields and drops out of the nurture query', async () => {
    const conversation = await seedConversation(run, {
      lastInboundAt: hoursAgo(3),
      lastOutboundAt: hoursAgo(2.5),
      promisedFollowUpAt: hoursFromNow(1),
      promisedFollowUpKey: 'lead-commit:z',
      promisedFollowUpDirection: 'contact_lead',
      promisedFollowUpQuote: 'send them at 5',
    });

    const updated = await markSalesRejected({
      conversationId: conversation._id,
      organizationId,
      quote: 'we booked another photographer',
      source: SALES_REJECTION_SOURCES.AI_CLASSIFIER,
    });

    expect(updated).not.toBeNull();

    const stored = await Conversation.findById(conversation._id).lean();

    // One atomic write did all of it.
    expect(stored?.salesRejectedAt).toBeInstanceOf(Date);
    expect(stored?.promisedFollowUpAt).toBeNull();
    expect(stored?.promisedFollowUpKey).toBeNull();
    expect(stored?.aiAutomationEnabled).toBe(false);

    // And the sweep's own query no longer returns it.
    const result = await nurtureSweep().sweepOnce({ organizationId });

    expect(result.nudged).toBe(0);
    expect(await countOutbound(run, conversation._id)).toBe(0);
  });

  it('is sticky: a second rejection does not overwrite the first', async () => {
    const conversation = await seedConversation(run);

    const first = await markSalesRejected({
      conversationId: conversation._id,
      organizationId,
      source: SALES_REJECTION_SOURCES.AI_CLASSIFIER,
    });

    const second = await markSalesRejected({
      conversationId: conversation._id,
      organizationId,
      source: SALES_REJECTION_SOURCES.HUMAN,
    });

    expect(first).not.toBeNull();
    // The filter refuses the second write, which is what stops a later verdict re-dating a
    // decision already on record.
    expect(second).toBeNull();

    const stored = await Conversation.findById(conversation._id).lean();
    expect(stored?.salesRejectionSource).toBe(SALES_REJECTION_SOURCES.AI_CLASSIFIER);
  });

  it('the promise sweep sends nothing for a rejected lead', async () => {
    // AUTOMATION IS LEFT ON DELIBERATELY. In production a rejected conversation always has it
    // off, so seeding `aiAutomationEnabled: false` would let the automation guard stop the send
    // and the test would pass with the rejection check deleted. Leaving it on means only the
    // rejection guard can account for the skip - and the recorded reason proves which one did.
    const conversation = await seedConversation(run, {
      promisedFollowUpAt: hoursAgo(1),
      promisedFollowUpKey: 'lead-commit:w',
      promisedFollowUpDirection: 'contact_lead',
      salesRejectedAt: hoursAgo(2),
      aiAutomationEnabled: true,
    });

    const result = await promiseSweep().sweepOnce({ organizationId });

    expect(result.sent).toBe(0);
    expect(await countOutbound(run, conversation._id)).toBe(0);

    const skipped = await ActivityLog.findOne({
      organizationId,
      conversationId: conversation._id,
      eventType: ACTIVITY_EVENTS.AI_BRAIN_PROMISE_FOLLOW_UP_SKIPPED,
    }).lean();

    expect(skipped?.metadata).toMatchObject({ reason: 'sales_rejected' });
  });
});

/**
 * WHAT "CONCURRENT" MEANS HERE, AND WHAT IT DOES NOT.
 *
 * Both tests below run two sweeps inside ONE Node process via `Promise.all`. Node is
 * single-threaded, so the two interleave at their `await` points rather than executing
 * simultaneously - what overlaps is the time each spends waiting on MongoDB, which is exactly
 * where the race lives: both sweeps read the row, then both try to write it.
 *
 * So these DO exercise real contention at the database: two in-flight operations against one
 * document, resolved by the server's own atomicity rather than by anything in this process.
 *
 * They do NOT exercise independent-process contention - two API containers, two machines,
 * OS-level parallelism, or a replica-set failover mid-claim. Interleaving at `await` boundaries
 * is a weaker schedule than true parallelism, and a bug that only appears when two writes land
 * in the same microsecond would not be caught here. Proving that needs multiple processes
 * against a real cluster, which is a load-test harness and not this suite.
 *
 * Stated here rather than only in a report, because the gap is easy to forget and the tests
 * look like they prove more than they do.
 */
describe('10: two workers racing one due promise', () => {
  it('exactly one claims it and exactly one message is queued', async () => {
    // THE CLAIM THIS SUITE EXISTS FOR, and the one the mocked tests genuinely cannot make. Two
    // sweeps run concurrently against the same row; the compare-and-set on `promisedFollowUpAt`
    // is what decides the winner, and only a real server can settle whether it does.
    const conversation = await seedConversation(run, {
      promisedFollowUpAt: hoursAgo(1),
      promisedFollowUpKey: `lead-commit:race:${Date.now()}`,
      promisedFollowUpDirection: 'contact_lead',
      promisedFollowUpQuote: 'send them at 5',
    });

    const [a, b] = await Promise.all([
      promiseSweep().sweepOnce({ organizationId }),
      promiseSweep().sweepOnce({ organizationId }),
    ]);

    // EXACTLY one, not "at most one". `<=` is also satisfied by both workers doing nothing -
    // a broken query, a claim that always fails - which would read as a pass for the strongest
    // possible wrong reason.
    expect(a.sent + b.sent).toBe(1);
    expect(await countOutbound(run, conversation._id)).toBe(1);

    const stored = await Conversation.findById(conversation._id).lean();
    expect(stored?.promisedFollowUpAt).toBeNull();
  });

  it('two concurrent nurture sweeps queue exactly one nudge', async () => {
    // The other half of the same question: here the duplicate guard is the unique index on
    // `idempotencyKey` rather than a compare-and-set, so a real race also exercises a real
    // E11000 being raised and handled.
    const conversation = await seedConversation(run, {
      lastInboundAt: hoursAgo(3),
      lastOutboundAt: hoursAgo(2.5),
    });

    await Promise.all([
      nurtureSweep().sweepOnce({ organizationId }),
      nurtureSweep().sweepOnce({ organizationId }),
    ]);

    // Exactly one, for the same reason as above: one worker wins the insert and the other is
    // refused by the unique index, so "nobody sent anything" is a failure, not a pass.
    //
    // ASSERTED ON THE MESSAGE COUNT, NOT ON `nudged`. Both sweeps legitimately report
    // `nudged: 1` - the loser's E11000 is handled by `enqueueOutboundMessage`, which returns
    // the message that already exists rather than an error. That is correct behaviour, so
    // "tightening" this to `a.nudged + b.nudged === 1` would be asserting a bug. What must be
    // exactly one is the thing the customer would receive.
    expect(await countOutbound(run, conversation._id)).toBe(1);
  });
});
