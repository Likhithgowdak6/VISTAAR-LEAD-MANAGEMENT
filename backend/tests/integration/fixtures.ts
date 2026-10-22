/**
 * Seeds and stubs shared by the staged integration suite.
 *
 * WHAT IS REAL AND WHAT IS NOT, stated here once so no individual test has to re-argue it:
 *
 *   REAL - MongoDB. Every read, write, index, unique-constraint violation, compare-and-set and
 *   transaction in these tests goes to an actual server. That is the entire point: the mocked
 *   suite already proves the logic, and what it cannot prove is that the queries, the partial
 *   index and the atomic claims behave as assumed against a real engine.
 *
 *   STUBBED - ai-brain-service and WhatsApp. The AI client is replaced with a function that
 *   returns a fixed string, and no WhatsApp session is ever constructed. Nothing in this suite
 *   can send a message: the outbound path stops at a `queued` row in Mongo, which is precisely
 *   what the tests assert on. `WHATSAPP_ENABLED` and `WHATSAPP_OUTBOUND_DELIVERY_ENABLED` stay
 *   false, and the delivery runner is never started.
 *
 * Every document created here carries the run's `organizationId`, which is what makes the
 * scoped cleanup in db.ts safe.
 */
import { Types } from 'mongoose';

import { CONVERSATION_STAGES } from '../../src/constants/conversation-stages.js';
import { MESSAGE_DIRECTIONS } from '../../src/constants/message-directions.js';
import { MESSAGE_STATUSES, type MessageStatus } from '../../src/constants/message-statuses.js';
import { MESSAGE_AUTHORS } from '../../src/constants/message-authors.js';
import { Conversation } from '../../src/modules/conversations/conversation.model.js';
import { Message } from '../../src/modules/messages/message.model.js';

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export const hoursAgo = (hours: number): Date => new Date(Date.now() - hours * HOUR_MS);
export const hoursFromNow = (hours: number): Date => new Date(Date.now() + hours * HOUR_MS);

export interface RunContext {
  organizationId: Types.ObjectId;
  whatsappAccountId: Types.ObjectId;
}

export const newRunContext = (organizationId: Types.ObjectId): RunContext => ({
  organizationId,
  whatsappAccountId: new Types.ObjectId(),
});

let leadCounter = 0;

/**
 * A conversation in the state the follow-up sweeps consider live.
 *
 * Defaults match what `findNurturableConversations` filters on - active stage, automation on,
 * not opted out, not rejected - so a test that wants to prove an exclusion only has to override
 * the one field it is about.
 */
export const seedConversation = async (
  run: RunContext,
  overrides: Record<string, unknown> = {},
) => {
  leadCounter += 1;

  return Conversation.create({
    organizationId: run.organizationId,
    whatsappAccountId: run.whatsappAccountId,
    contactId: new Types.ObjectId(),
    leadId: `ITEST-${Date.now()}-${leadCounter}`,
    displayName: `Integration Lead ${leadCounter}`,
    stage: CONVERSATION_STAGES.QUALIFIED,
    aiAutomationEnabled: true,
    optedOutAt: null,
    salesRejectedAt: null,
    nurtureStep: 0,
    lastInboundAt: hoursAgo(3),
    lastOutboundAt: hoursAgo(2.5),
    eventDate: null,
    aiFacts: {},
    ...overrides,
  });
};

/** An inbound message row. Used where a test needs a transcript to exist, not just a timestamp. */
export const seedInboundMessage = async (
  run: RunContext,
  conversationId: Types.ObjectId,
  body: string,
  sentAt: Date = new Date(),
) =>
  Message.create({
    organizationId: run.organizationId,
    whatsappAccountId: run.whatsappAccountId,
    conversationId,
    contactId: new Types.ObjectId(),
    direction: MESSAGE_DIRECTIONS.IN,
    type: 'text',
    body,
    status: MESSAGE_STATUSES.RECEIVED,
    sentAt,
    authoredBy: MESSAGE_AUTHORS.HUMAN,
  });

/**
 * A queued outbound message, written directly rather than through the outbound service.
 *
 * Used by the delivery-suppression test, which needs a row sitting in the queue in a known
 * state before the rejection lands - the same situation a reply drafted seconds before the
 * customer said no would be in.
 */
export const seedQueuedMessage = async (
  run: RunContext,
  conversationId: Types.ObjectId,
  overrides: Record<string, unknown> = {},
) =>
  Message.create({
    organizationId: run.organizationId,
    whatsappAccountId: run.whatsappAccountId,
    conversationId,
    contactId: new Types.ObjectId(),
    direction: MESSAGE_DIRECTIONS.OUT,
    type: 'text',
    body: 'Queued before the decision that should have stopped it.',
    status: MESSAGE_STATUSES.QUEUED,
    sentAt: new Date(),
    authoredBy: MESSAGE_AUTHORS.AI,
    idempotencyKey: `itest:queued:${new Types.ObjectId().toString()}`,
    ...overrides,
  });

/**
 * The AI client stand-in.
 *
 * Returns a fixed message so the tests assert on scheduling and persistence rather than on
 * prose, and - more importantly - so no test can reach ai-brain-service or spend a token.
 */
export const stubGetFollowup = async () => ({ message: 'Integration test follow-up.' });

export const stubAiBrainContext = async () => ({ knowledgeText: '', styleExamples: '' });

/** Counts outbound rows this run created for a conversation, by status. */
export const countOutbound = async (
  run: RunContext,
  conversationId: Types.ObjectId,
  status?: MessageStatus,
) =>
  Message.countDocuments({
    organizationId: run.organizationId,
    conversationId,
    direction: MESSAGE_DIRECTIONS.OUT,
    ...(status ? { status } : {}),
  });

/** The idempotency keys of this run's outbound rows, oldest first. */
export const outboundKeys = async (run: RunContext, conversationId: Types.ObjectId) => {
  const rows = await Message.find({
    organizationId: run.organizationId,
    conversationId,
    direction: MESSAGE_DIRECTIONS.OUT,
  })
    .sort({ _id: 1 })
    .lean();

  return rows.map((row) => row.idempotencyKey ?? null);
};
