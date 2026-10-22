/**
 * Decision 3 against a real MongoDB: opt-out, queued-message suppression, reopen, isolation and
 * the indexes the sweeps depend on.
 *
 * The two that matter most here are 9 and 12. Nine is the only guard in the system that acts on
 * a message which has ALREADY passed every other check - it is the last thing between "we booked
 * another photographer" and a cheerful reply landing ten seconds later. Twelve is the one that
 * cannot be faked at all: an index either exists on the server with the shape the query needs,
 * or the sweeps are doing collection scans in production and nobody has noticed.
 *
 * No WhatsApp session is constructed anywhere in this file. The delivery service is driven with
 * a stubbed session whose send function throws if it is ever called, so "nothing was sent" is
 * enforced rather than assumed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

import { ACCOUNT_ACCESS_MODES } from '../../src/constants/account-access-modes.js';
import { ACTIVITY_EVENTS } from '../../src/constants/activity-events.js';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from '../../src/constants/permissions.js';
import { USER_STATUSES } from '../../src/constants/user-statuses.js';
import { ActivityLog } from '../../src/modules/activity/activity-log.model.js';
import { User } from '../../src/modules/users/user.model.js';
import { setAutomationForActor } from '../../src/modules/ai-brain/ai-brain.service.js';
import { MESSAGE_AUTHORS } from '../../src/constants/message-authors.js';
import { MESSAGE_STATUSES } from '../../src/constants/message-statuses.js';
import { SALES_REJECTION_SOURCES } from '../../src/constants/sales-rejection.js';
import { OPT_OUT_PAUSED_REASON, isOptOutRequest } from '../../src/modules/whatsapp/automation/opt-out.js';
import { Conversation } from '../../src/modules/conversations/conversation.model.js';
import { Message } from '../../src/modules/messages/message.model.js';
import {
  clearSalesRejection,
  findConversationsDueForAutoGreet,
  findDuePromisedFollowUps,
  findNurturableConversations,
  markOptedOut,
  markSalesRejected,
  updateAutomationState,
} from '../../src/modules/conversations/conversation.repository.js';
import {
  cleanupRunData,
  connectIntegrationDatabase,
  disconnectIntegrationDatabase,
  newRunOrganizationId,
} from './db.js';
import {
  hoursAgo,
  hoursFromNow,
  newRunContext,
  seedConversation,
  seedQueuedMessage,
  type RunContext,
} from './fixtures.js';

const organizationId = newRunOrganizationId();
let run: RunContext;

/**
 * Additional organisations minted by the isolation tests.
 *
 * Tracked at module level so teardown is a property of the LIFECYCLE rather than of each test
 * remembering a `finally`. A test that throws before its cleanup line - or one added later by
 * somebody who does not know the convention - still leaves nothing behind. Every id here was
 * created by this run, so deleting by it is as narrowly scoped as the main organisation's.
 */
let extraOrganizationIds: Types.ObjectId[] = [];

const useAdditionalOrganization = (): RunContext => {
  const extra = new Types.ObjectId();
  extraOrganizationIds.push(extra);

  return newRunContext(extra);
};

beforeAll(async () => {
  await connectIntegrationDatabase();
  run = newRunContext(organizationId);
  await Conversation.syncIndexes();
  await Message.syncIndexes();
});

afterEach(async () => {
  await cleanupRunData(organizationId);

  for (const extra of extraOrganizationIds) {
    await cleanupRunData(extra);
  }

  extraOrganizationIds = [];
});

afterAll(async () => {
  await cleanupRunData(organizationId);

  // Belt and braces: afterEach already drains these, but a failure inside afterEach itself
  // would otherwise leave documents behind with an id nothing else records.
  for (const extra of extraOrganizationIds) {
    await cleanupRunData(extra);
  }

  await disconnectIntegrationDatabase();
});

describe('8: an explicit opt-out uses the existing mechanism', () => {
  it('the matcher reads the phrases the brief named', () => {
    // Pure, but asserted here too so the integration run fails loudly if the deterministic
    // layer regresses - a rejection classifier must never be what catches "stop messaging me".
    expect(isOptOutRequest('Please stop messaging me')).toBe(true);
    expect(isOptOutRequest("I'm not interested. Don't contact me again.")).toBe(true);
    expect(isOptOutRequest("don't stop sending me updates")).toBe(false);
    expect(isOptOutRequest('I will confirm tomorrow')).toBe(false);
  });

  it('markOptedOut writes the opt-out state and nothing else', async () => {
    const conversation = await seedConversation(run);

    await markOptedOut({
      conversationId: conversation._id,
      organizationId,
      pausedReason: OPT_OUT_PAUSED_REASON,
    });

    const stored = await Conversation.findById(conversation._id).lean();

    expect(stored?.optedOutAt).toBeInstanceOf(Date);
    expect(stored?.aiAutomationEnabled).toBe(false);
    expect(stored?.aiAutomationPausedReason).toBe(OPT_OUT_PAUSED_REASON);
    // TWO MECHANISMS, NOT ONE. An opt-out is a request about contact; it must not masquerade
    // as a sales decision, or the dashboard would report a rejection nobody made.
    expect(stored?.salesRejectedAt).toBeNull();
  });

  it('a sales rejection never sets the opt-out flag', async () => {
    const conversation = await seedConversation(run);

    await markSalesRejected({
      conversationId: conversation._id,
      organizationId,
      source: SALES_REJECTION_SOURCES.AI_CLASSIFIER,
    });

    const stored = await Conversation.findById(conversation._id).lean();

    expect(stored?.salesRejectedAt).toBeInstanceOf(Date);
    // The inverse of the test above. Conflating them would fire the opt-out confirmation flow
    // at a customer who only said they had chosen another photographer.
    expect(stored?.optedOutAt).toBeNull();
  });

  it('an opted-out lead is excluded from the nurture query', async () => {
    // Automation left ON so that `optedOutAt: null` in the filter is the only thing that can
    // account for the exclusion. With it off, the test would pass even if the opt-out condition
    // were deleted from the query - which is the guarantee that survives somebody flipping
    // automation back on from the dashboard.
    const conversation = await seedConversation(run, {
      optedOutAt: hoursAgo(1),
      aiAutomationEnabled: true,
    });

    const nurturable = await findNurturableConversations({ organizationId });

    expect(nurturable.map((row) => row._id.toString())).not.toContain(
      conversation._id.toString(),
    );
  });
});

describe('9: a queued AI message after a rejection', () => {
  /**
   * The delivery service, wired so the ONLY thing it cannot do is reach WhatsApp.
   *
   * THREE THINGS ARE DELIBERATELY NOT REAL HERE, and each for a reason:
   *
   *   `sessionService` - a recorded fake. There is no socket anywhere in this process, so
   *   "nothing was sent" is structural rather than asserted. It returns a success shape rather
   *   than throwing, because a throwing stub makes the human-authored case ambiguous: a test
   *   that only checks "the error was not lead_rejected_service" passes just as happily when
   *   the message was never claimed at all.
   *
   *   `contactRepository` - stubbed. Recipient resolution happens BEFORE the rejection gate, so
   *   a conversation whose contact does not exist fails with `no_recipient` and never reaches
   *   the thing under test. Stubbing it also keeps a phone number out of the test database.
   *
   *   `config` - the allowlist is pinned to the fake recipient. `WHATSAPP_TEST_ALLOWED_NUMBERS`
   *   is set in the developer's own .env, and the allowlist is checked before the rejection
   *   gate too, so without this the test's result would depend on whose machine it ran on. Note
   *   it is pinned ACTIVE rather than emptied - the safety mechanism stays on, it is simply
   *   pointed at an address that does not exist.
   *
   * Everything the test actually asserts - the message row, its status, its error, and the
   * conversation it reads - is real MongoDB.
   */
  const TEST_RECIPIENT = '910000000000';

  const createDelivery = async () => {
    const { createOutboundDeliveryService } = await import(
      '../../src/modules/whatsapp/delivery/outbound-delivery.service.js'
    );
    const { env } = await import('../../src/config/env.js');

    const sendTextMessage = vi.fn(async () => ({ providerMessageId: 'itest-provider-id' }));

    return {
      sendTextMessage,
      // No `as never`: the fakes below satisfy the real interfaces, so TypeScript checks this
      // wiring rather than being told to look away.
      service: createOutboundDeliveryService({
        sessionService: { sendTextMessage },
        config: { ...env, WHATSAPP_TEST_ALLOWED_NUMBERS: TEST_RECIPIENT },
        contactRepository: {
          findContactPrivatePiiForInternalUse: async () => ({
            phone: TEST_RECIPIENT,
            providerJids: [],
          }),
        },
      }),
    };
  };

  it('suppresses a queued AI message and records WHY', async () => {
    const conversation = await seedConversation(run, {
      salesRejectedAt: hoursAgo(1),
      aiAutomationEnabled: false,
    });
    const queued = await seedQueuedMessage(run, conversation._id, {
      authoredBy: MESSAGE_AUTHORS.AI,
    });

    const { service, sendTextMessage } = await createDelivery();
    const result = await service.deliverNext({
      organizationId,
      whatsappAccountId: run.whatsappAccountId,
    });

    expect(sendTextMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ reason: 'lead_rejected_service', permanent: true });

    const stored = await Message.findById(queued._id).lean();

    // The row is FAILED, not deleted - cancellation never destroys CRM history.
    expect(stored?.status).toBe(MESSAGE_STATUSES.FAILED_PERMANENT);
    expect(stored?.lastDeliveryError).toBe('lead_rejected_service');
  });

  it('still delivers a human-authored message to the same lead', async () => {
    // The difference from an opt-out: the owner may still want to reply personally - "no
    // problem, all the best". A service rejection stops the ROBOT, not the business.
    //
    // Asserted positively - the send fake WAS called and the row reached `sent` - because the
    // negative form ("the error was not lead_rejected_service") is also satisfied by a message
    // that was never picked up, which would hide a broken claim query.
    const conversation = await seedConversation(run, {
      salesRejectedAt: hoursAgo(1),
      aiAutomationEnabled: false,
    });
    const queued = await seedQueuedMessage(run, conversation._id, {
      authoredBy: MESSAGE_AUTHORS.HUMAN,
    });

    const { service, sendTextMessage } = await createDelivery();
    const result = await service.deliverNext({
      organizationId,
      whatsappAccountId: run.whatsappAccountId,
    });

    expect(sendTextMessage).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ delivered: true });

    const stored = await Message.findById(queued._id).lean();

    expect(stored?.status).toBe(MESSAGE_STATUSES.SENT);
    expect(stored?.lastDeliveryError).toBeNull();
  });
});

describe('11: rejection survives an automation toggle', () => {
  it('stays rejected after automation is switched off and back on', async () => {
    // The reason the sticky field exists at all. `aiAutomationEnabled` is flipped back on by an
    // approval card, by an owner instruction, and by this toggle - none of which is a decision
    // to start selling to somebody who said no.
    const conversation = await seedConversation(run);

    await markSalesRejected({
      conversationId: conversation._id,
      organizationId,
      source: SALES_REJECTION_SOURCES.AI_CLASSIFIER,
    });

    await updateAutomationState({
      conversationId: conversation._id,
      organizationId,
      aiAutomationEnabled: false,
      aiAutomationPausedReason: null,
    });

    await updateAutomationState({
      conversationId: conversation._id,
      organizationId,
      aiAutomationEnabled: true,
      aiAutomationPausedReason: null,
    });

    const stored = await Conversation.findById(conversation._id).lean();

    expect(stored?.salesRejectedAt).toBeInstanceOf(Date);

    // And it is still excluded from the sweep even with automation back on.
    const nurturable = await findNurturableConversations({ organizationId });
    expect(nurturable.map((row) => row._id.toString())).not.toContain(
      conversation._id.toString(),
    );
  });

  /**
   * The reopen as a user actually performs it.
   *
   * TWO LAYERS GUARD THIS, and they are enforced in different places, so both are checked:
   *
   *   The ROUTE requires `ai.automation.manage` (ai-brain.routes.ts, `requireAiAutomationManage`).
   *   That is Express middleware - it never reaches the service - so it is asserted against the
   *   role matrix rather than by calling the service with a doctored permission list, which
   *   would prove nothing about the real check.
   *
   *   The SERVICE requires the conversation to be visible to the actor: `conversations.read_all`,
   *   or the conversation assigned to them. That one runs inside `setAutomationForActor` against
   *   a real document, so it is exercised directly here.
   *
   * Nothing below changes production authorization. The denied case asserts that the rejection
   * SURVIVES, which is the property that matters - a failed reopen must not half-succeed.
   */
  describe('through setAutomationForActor, the real reopen path', () => {
    const actorFor = async (role: 'admin' | 'staff') =>
      User.create({
        organizationId,
        name: `Integration ${role}`,
        email: `itest-${role}-${new Types.ObjectId().toString()}@example.test`,
        passwordHash: 'x'.repeat(60),
        role,
        accountAccessMode: ACCOUNT_ACCESS_MODES.ALL,
        status: USER_STATUSES.ACTIVE,
        mustChangePassword: false,
      });

    it('an authorised human reopening the lead clears the rejection', async () => {
      const conversation = await seedConversation(run);
      const admin = await actorFor('admin');

      await markSalesRejected({
        conversationId: conversation._id,
        organizationId,
        source: SALES_REJECTION_SOURCES.AI_CLASSIFIER,
      });

      await setAutomationForActor({
        organizationId,
        conversationId: conversation._id,
        permissions: DEFAULT_ROLE_PERMISSIONS.admin,
        actor: admin,
        enabled: true,
      });

      const stored = await Conversation.findById(conversation._id).lean();

      expect(stored?.salesRejectedAt).toBeNull();
      expect(stored?.aiAutomationEnabled).toBe(true);
      // The history of what they said survives the reopen.
      expect(stored?.salesRejectionSource).toBe(SALES_REJECTION_SOURCES.AI_CLASSIFIER);

      // And it is back in the nurture population, which is the point of reopening.
      const nurturable = await findNurturableConversations({ organizationId });
      expect(nurturable.map((row) => row._id.toString())).toContain(
        conversation._id.toString(),
      );
    });

    it('records WHO reopened it', async () => {
      const conversation = await seedConversation(run);
      const admin = await actorFor('admin');

      await markSalesRejected({
        conversationId: conversation._id,
        organizationId,
        source: SALES_REJECTION_SOURCES.AI_CLASSIFIER,
      });

      await setAutomationForActor({
        organizationId,
        conversationId: conversation._id,
        permissions: DEFAULT_ROLE_PERMISSIONS.admin,
        actor: admin,
        enabled: true,
      });

      const logged = await ActivityLog.findOne({
        organizationId,
        conversationId: conversation._id,
        eventType: ACTIVITY_EVENTS.AI_BRAIN_SALES_REJECTION_CLEARED,
      }).lean();

      expect(logged).not.toBeNull();
      expect(logged?.actorId?.toString()).toBe(admin._id.toString());
    });

    it('turning automation OFF through the same path does NOT clear it', async () => {
      // Otherwise off-then-on would launder a rejection away without anybody deciding to
      // reopen the lead.
      const conversation = await seedConversation(run);
      const admin = await actorFor('admin');

      await markSalesRejected({
        conversationId: conversation._id,
        organizationId,
        source: SALES_REJECTION_SOURCES.AI_CLASSIFIER,
      });

      await setAutomationForActor({
        organizationId,
        conversationId: conversation._id,
        permissions: DEFAULT_ROLE_PERMISSIONS.admin,
        actor: admin,
        enabled: false,
      });

      const stored = await Conversation.findById(conversation._id).lean();

      expect(stored?.salesRejectedAt).toBeInstanceOf(Date);
    });

    it('a staff member cannot reopen a lead that is not theirs', async () => {
      // `staff` holds neither `conversations.read_all` nor `ai.automation.manage`. Here the
      // SERVICE-level visibility check refuses them against a real unassigned document, and
      // the rejection is still in place afterwards.
      const conversation = await seedConversation(run, { assignedTo: null });
      const staff = await actorFor('staff');

      await markSalesRejected({
        conversationId: conversation._id,
        organizationId,
        source: SALES_REJECTION_SOURCES.AI_CLASSIFIER,
      });

      await expect(
        setAutomationForActor({
          organizationId,
          conversationId: conversation._id,
          permissions: DEFAULT_ROLE_PERMISSIONS.staff,
          actor: staff,
          enabled: true,
        }),
      ).rejects.toThrow('CONVERSATION_ACCESS_DENIED');

      const stored = await Conversation.findById(conversation._id).lean();

      // A refused reopen must not half-succeed.
      expect(stored?.salesRejectedAt).toBeInstanceOf(Date);
      expect(stored?.aiAutomationEnabled).toBe(false);
    });

    it('the route-level permission is one `staff` does not hold', async () => {
      // The middleware guard, asserted where it actually lives. Calling the service with a
      // hand-written permission array could never prove this, because the service does not
      // check this permission at all - Express does, before the service is reached.
      expect(DEFAULT_ROLE_PERMISSIONS.staff).not.toContain(PERMISSIONS.AI_AUTOMATION_MANAGE);
      expect(DEFAULT_ROLE_PERMISSIONS.admin).toContain(PERMISSIONS.AI_AUTOMATION_MANAGE);
      expect(DEFAULT_ROLE_PERMISSIONS.manager).toContain(PERMISSIONS.AI_AUTOMATION_MANAGE);
    });

    it('reopening does not clear an opt-out', async () => {
      // Reopening a deal is not consent to message somebody who asked to be left alone. The
      // existing precedence - opt-out outranks automation - must be unchanged.
      const conversation = await seedConversation(run, { optedOutAt: hoursAgo(2) });
      const admin = await actorFor('admin');

      await markSalesRejected({
        conversationId: conversation._id,
        organizationId,
        source: SALES_REJECTION_SOURCES.AI_CLASSIFIER,
      });

      await setAutomationForActor({
        organizationId,
        conversationId: conversation._id,
        permissions: DEFAULT_ROLE_PERMISSIONS.admin,
        actor: admin,
        enabled: true,
      });

      const stored = await Conversation.findById(conversation._id).lean();

      expect(stored?.salesRejectedAt).toBeNull();
      expect(stored?.optedOutAt).toBeInstanceOf(Date);
    });

    it('the repository-level clear is still exact about what it touches', async () => {
      // Kept alongside the service-level tests: this is the function the service calls, and
      // its filter is what makes a second reopen a no-op rather than a second activity row.
      const conversation = await seedConversation(run);

      await markSalesRejected({
        conversationId: conversation._id,
        organizationId,
        source: SALES_REJECTION_SOURCES.AI_CLASSIFIER,
      });

      expect(
        await clearSalesRejection({ conversationId: conversation._id, organizationId }),
      ).not.toBeNull();
      expect(
        await clearSalesRejection({ conversationId: conversation._id, organizationId }),
      ).toBeNull();
    });
  });
});

describe('12: organization isolation', () => {
  it('a sweep query never returns another organisation’s conversations', async () => {
    const otherRun = useAdditionalOrganization();

    const mine = await seedConversation(run, { lastInboundAt: hoursAgo(3) });
    const theirs = await seedConversation(otherRun, { lastInboundAt: hoursAgo(3) });

    const nurturable = await findNurturableConversations({ organizationId });
    const ids = nurturable.map((row) => row._id.toString());

    // `mine` is asserted too: without it this passes just as well when the query returns
    // nothing at all, which is not isolation, it is a broken filter.
    expect(ids).toContain(mine._id.toString());
    expect(ids).not.toContain(theirs._id.toString());
  });

  it('a write cannot reach a conversation in another organisation', async () => {
    const otherRun = useAdditionalOrganization();
    const theirs = await seedConversation(otherRun);

    // Right conversation id, wrong organisation. Every repository filter pairs the two, so a
    // caller holding a valid id from elsewhere still cannot reach the document.
    const result = await markSalesRejected({
      conversationId: theirs._id,
      organizationId,
      source: SALES_REJECTION_SOURCES.AI_CLASSIFIER,
    });

    expect(result).toBeNull();

    const stored = await Conversation.findById(theirs._id).lean();
    expect(stored?.salesRejectedAt).toBeNull();
  });
});

describe('12: the indexes the sweeps depend on', () => {
  /** Index key patterns actually present on the server, as JSON for comparison. */
  const indexKeys = async (model: typeof Conversation | typeof Message) => {
    const indexes = await model.collection.indexes();

    return indexes.map((index) => JSON.stringify(index.key));
  };

  it('the promised-follow-up index exists and is partial', async () => {
    // Partial on `$type: 'date'`, which is why the query spells the same predicate: MongoDB
    // only uses a partial index when the query provably matches a subset of it.
    const indexes = await Conversation.collection.indexes();
    const promised = indexes.find(
      (index) => JSON.stringify(index.key) === JSON.stringify({ promisedFollowUpAt: 1 }),
    );

    expect(promised).toBeDefined();
    expect(promised?.partialFilterExpression).toEqual({
      promisedFollowUpAt: { $type: 'date' },
    });
  });

  it('the nurture sweep index exists', async () => {
    expect(await indexKeys(Conversation)).toContain(
      JSON.stringify({ aiAutomationEnabled: 1, stage: 1, lastOutboundAt: 1 }),
    );
  });

  it('idempotencyKey is unique, which is what stops a duplicate send', async () => {
    const indexes = await Message.collection.indexes();
    const idempotency = indexes.find((index) => 'idempotencyKey' in (index.key ?? {}));

    expect(idempotency?.unique).toBe(true);
  });

  it('the due-promise query is ELIGIBLE for the partial index', async () => {
    // THE BUG THIS CATCHES: a partial index is only usable when the query provably matches a
    // subset of its filter. `findDuePromisedFollowUps` spells `$type: 'date'` for exactly that
    // reason, and if someone "simplifies" it back to `$ne: null` the planner stops considering
    // the index and the sweep silently becomes a collection scan.
    //
    // Asserted on eligibility - the index appearing in the winning OR a rejected plan - rather
    // than on the winning plan being an IXSCAN. On a near-empty collection the cost-based
    // planner may legitimately prefer a COLLSCAN, which would make an IXSCAN assertion flaky
    // for a reason that has nothing to do with the property being tested. An ineligible index
    // appears in neither list.
    await seedConversation(run, { promisedFollowUpAt: hoursFromNow(1) });

    const explained = await Conversation.collection
      .find({
        organizationId,
        deletedAt: null,
        promisedFollowUpAt: { $type: 'date', $lte: new Date() },
      })
      .explain('queryPlanner');

    const considered = JSON.stringify({
      winning: explained.queryPlanner?.winningPlan ?? {},
      rejected: explained.queryPlanner?.rejectedPlans ?? [],
    });

    expect(considered).toContain('promisedFollowUpAt_1');
  });

  it('an `$ne: null` spelling is NOT eligible for the same index', async () => {
    // The control that gives the test above its meaning: the weaker predicate the production
    // query deliberately avoids. If this ever starts matching, the partial filter has been
    // widened and the comment in findDuePromisedFollowUps is no longer true.
    const explained = await Conversation.collection
      .find({
        organizationId,
        deletedAt: null,
        promisedFollowUpAt: { $ne: null, $lte: new Date() },
      })
      .explain('queryPlanner');

    const considered = JSON.stringify({
      winning: explained.queryPlanner?.winningPlan ?? {},
      rejected: explained.queryPlanner?.rejectedPlans ?? [],
    });

    expect(considered).not.toContain('promisedFollowUpAt_1');
  });

  it('findDuePromisedFollowUps and the auto-greet query both run against the server', async () => {
    // Smoke-level, but they are real queries: a filter that references a field the schema does
    // not have, or a malformed operator, fails here and nowhere in the mocked suite.
    await expect(findDuePromisedFollowUps({ organizationId })).resolves.toBeInstanceOf(Array);
    await expect(findConversationsDueForAutoGreet({ organizationId })).resolves.toBeInstanceOf(
      Array,
    );
  });
});
