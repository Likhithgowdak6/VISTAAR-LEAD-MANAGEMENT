/**
 * Storing a rejection, and the three things that write has to do atomically.
 *
 * The one that costs money if it is wrong is the promise cancellation: `markSalesRejected` nulls
 * the pending customer-facing follow-up in the SAME write that records the rejection, so there
 * is no window in which the rejection is on record and the promise sweep is still about to send
 * "as promised, here are the packages" to somebody who just cancelled.
 *
 * Mocked Conversation model, no real Mongo.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  findOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
  countDocuments: vi.fn(),
}));

vi.mock('./conversation.model.js', () => ({
  Conversation: {
    find: mocks.find,
    findOne: mocks.findOne,
    findOneAndUpdate: mocks.findOneAndUpdate,
    countDocuments: mocks.countDocuments,
  },
}));

const {
  clearSalesRejection,
  findDuePromisedFollowUps,
  findNurturableConversations,
  findConversationsDueForAutoGreet,
  markSalesRejected,
} = await import('./conversation.repository.js');

const organizationId = 'org-1';
const NOW = new Date('2026-10-21T17:00:00.000Z');

const mockUpdateResult = (value: unknown) => {
  const exec = vi.fn().mockResolvedValue(value);
  mocks.findOneAndUpdate.mockReturnValue({ exec });

  return exec;
};

const mockFindChain = () => {
  const exec = vi.fn().mockResolvedValue([]);
  const limit = vi.fn().mockReturnValue({ exec });
  const sort = vi.fn().mockReturnValue({ limit });
  mocks.find.mockReturnValue({ sort, limit, exec });
};

const recordedSet = () =>
  (mocks.findOneAndUpdate.mock.calls[0]?.[1] as { $set?: Record<string, unknown> })?.$set ?? {};

const recordedFilter = () =>
  mocks.findOneAndUpdate.mock.calls[0]?.[0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('markSalesRejected', () => {
  it('records the rejection with the lead’s words and its source', async () => {
    mockUpdateResult({ _id: 'conv-1' });

    await markSalesRejected({
      conversationId: 'conv-1',
      organizationId,
      quote: 'we booked another photographer',
      source: 'ai_classifier',
      now: NOW,
    });

    expect(recordedSet()).toMatchObject({
      salesRejectedAt: NOW,
      salesRejectionQuote: 'we booked another photographer',
      salesRejectionSource: 'ai_classifier',
    });
  });

  it('CANCELS A PENDING PROMISE FOLLOW-UP in the same write', async () => {
    // Not a second update. Splitting them leaves a window in which the lead has rejected us and
    // the promise sweep is still holding a due time it is about to act on.
    mockUpdateResult({ _id: 'conv-1' });

    await markSalesRejected({
      conversationId: 'conv-1',
      organizationId,
      source: 'ai_classifier',
      now: NOW,
    });

    expect(recordedSet()).toMatchObject({
      promisedFollowUpAt: null,
      promisedFollowUpKey: null,
      promisedFollowUpDirection: null,
      promisedFollowUpQuote: null,
    });
  });

  it('turns automation off, so every existing guard stops it too', async () => {
    mockUpdateResult({ _id: 'conv-1' });

    await markSalesRejected({ conversationId: 'conv-1', organizationId, source: 'ai_classifier' });

    expect(recordedSet()).toMatchObject({ aiAutomationEnabled: false });
    expect(recordedSet().aiAutomationPausedReason).toBeTruthy();
  });

  it('NEVER sets optedOutAt - that belongs to the opt-out mechanism alone', async () => {
    // Conflating them would mean a service rejection silently firing the opt-out owner alert
    // and confirmation flow, which the customer never asked for.
    mockUpdateResult({ _id: 'conv-1' });

    await markSalesRejected({ conversationId: 'conv-1', organizationId, source: 'ai_classifier' });

    expect(recordedSet()).not.toHaveProperty('optedOutAt');
  });

  it('is STICKY ON WRITE: it refuses to overwrite an existing rejection', async () => {
    // The concurrency guard. Two workers reading the same burst both get here; the filter means
    // the second one matches nothing, returns null, and writes no second activity row. It also
    // stops a later classifier verdict re-dating a decision already on record.
    mockUpdateResult(null);

    const result = await markSalesRejected({
      conversationId: 'conv-1',
      organizationId,
      source: 'ai_classifier',
    });

    expect(recordedFilter()).toMatchObject({ salesRejectedAt: null });
    expect(result).toBeNull();
  });

  it('scopes the write to one organization', async () => {
    mockUpdateResult({ _id: 'conv-1' });

    await markSalesRejected({ conversationId: 'conv-1', organizationId, source: 'ai_classifier' });

    expect(recordedFilter()).toMatchObject({ _id: 'conv-1', organizationId });
  });

  it('truncates a long quote rather than refusing the rejection', async () => {
    mockUpdateResult({ _id: 'conv-1' });

    await markSalesRejected({
      conversationId: 'conv-1',
      organizationId,
      quote: 'x'.repeat(500),
      source: 'ai_classifier',
    });

    expect((recordedSet().salesRejectionQuote as string).length).toBe(300);
  });
});

describe('clearSalesRejection', () => {
  it('clears only the sticky flag', async () => {
    mockUpdateResult({ _id: 'conv-1' });

    await clearSalesRejection({ conversationId: 'conv-1', organizationId });

    expect(recordedSet()).toEqual({ salesRejectedAt: null });
  });

  it('keeps the quote and source, so the CRM history still says they said it', async () => {
    mockUpdateResult({ _id: 'conv-1' });

    await clearSalesRejection({ conversationId: 'conv-1', organizationId });

    expect(recordedSet()).not.toHaveProperty('salesRejectionQuote');
    expect(recordedSet()).not.toHaveProperty('salesRejectionSource');
  });

  it('cannot, by itself, start anything sending', async () => {
    // Deliberately does not touch aiAutomationEnabled: its one caller is already turning
    // automation on in the same transaction, behind ai.automation.manage.
    mockUpdateResult({ _id: 'conv-1' });

    await clearSalesRejection({ conversationId: 'conv-1', organizationId });

    expect(recordedSet()).not.toHaveProperty('aiAutomationEnabled');
  });

  it('returns null when the lead was not rejected, so no reopen is logged', async () => {
    mockUpdateResult(null);

    const result = await clearSalesRejection({ conversationId: 'conv-1', organizationId });

    expect(recordedFilter()).toMatchObject({ salesRejectedAt: { $ne: null } });
    expect(result).toBeNull();
  });

  it('is scoped to one organization', async () => {
    mockUpdateResult({ _id: 'conv-1' });

    await clearSalesRejection({ conversationId: 'conv-1', organizationId });

    expect(recordedFilter()).toMatchObject({ organizationId });
  });
});

describe('the sweep queries exclude rejected leads', () => {
  it('the nurture sweep never picks one up', async () => {
    mockFindChain();

    await findNurturableConversations({ organizationId });

    expect(mocks.find).toHaveBeenCalledWith(
      expect.objectContaining({ salesRejectedAt: null }),
    );
  });

  it('the auto-greet sweep never picks one up', async () => {
    // Its filter already had `aiAutomationEnabled: true`, which an approval card resolved with
    // resumeAutomation turns back on - so without this a rejected lead could be auto-greeted.
    mockFindChain();

    await findConversationsDueForAutoGreet({ organizationId });

    expect(mocks.find).toHaveBeenCalledWith(
      expect.objectContaining({ salesRejectedAt: null }),
    );
  });

  it('the nurture filter keeps opt-out and rejection as SEPARATE conditions', async () => {
    // Two different nos. Collapsing them would lose the distinction the whole design rests on.
    mockFindChain();

    await findNurturableConversations({ organizationId });

    expect(mocks.find).toHaveBeenCalledWith(
      expect.objectContaining({ optedOutAt: null, salesRejectedAt: null }),
    );
  });

  it('the promise sweep leaves the check to the service, which records WHY', async () => {
    // Deliberate: filtering here would drop a due promise silently, where the service claims it
    // and writes a skip row naming the reason.
    mockFindChain();

    await findDuePromisedFollowUps({ now: NOW });

    expect(mocks.find.mock.calls[0]?.[0]).not.toHaveProperty('salesRejectedAt');
  });
});
