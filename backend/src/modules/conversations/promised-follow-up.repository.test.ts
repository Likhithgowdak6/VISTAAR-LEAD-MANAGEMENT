/**
 * The storage layer of a promised follow-up: recording one, finding the due ones, and - the
 * assertion that actually prevents a double send - claiming one atomically.
 *
 * Also pins the cancellation rule, which lives in `updateConversationPreview` rather than in the
 * sweep: the promise is nulled by the same write that records the lead's reply, so there is no
 * window in which a sweep could read a promise the lead has already superseded.
 *
 * Mocked Conversation model, no real Mongo - same approach as conversation.repository.test.ts,
 * kept in its own file so that suite's import list stays about the nurture sweep.
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

const { claimPromisedFollowUp, findDuePromisedFollowUps, setPromisedFollowUp, updateConversationPreview } =
  await import('./conversation.repository.js');

const organizationId = 'org-1';
const DUE = new Date('2026-10-21T17:00:00.000Z');

/** The `find().sort().limit().exec()` chain the cursor queries use. */
const createFindChain = (rows: unknown[]) => {
  const exec = vi.fn().mockResolvedValue(rows);
  const limit = vi.fn().mockReturnValue({ exec });
  const sort = vi.fn().mockReturnValue({ limit });

  return { sort, limit, exec };
};

const mockUpdateResult = (value: unknown) => {
  const exec = vi.fn().mockResolvedValue(value);
  mocks.findOneAndUpdate.mockReturnValue({ exec });

  return exec;
};

/** The `$set` of the single findOneAndUpdate recorded by the mock. */
const recordedSet = () =>
  (mocks.findOneAndUpdate.mock.calls[0]?.[1] as { $set?: Record<string, unknown> })?.$set ?? {};

const recordedFilter = () =>
  mocks.findOneAndUpdate.mock.calls[0]?.[0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('setPromisedFollowUp', () => {
  it('records the time, the key, the direction and the lead’s own words', async () => {
    mockUpdateResult({ _id: 'conv-1' });

    await setPromisedFollowUp({
      conversationId: 'conv-1',
      organizationId,
      dueAt: DUE,
      key: 'lead-commit:msg-9',
      direction: 'await_lead',
      quote: 'I will confirm by Friday',
    });

    expect(recordedFilter()).toEqual({ _id: 'conv-1', organizationId });
    expect(recordedSet()).toEqual({
      promisedFollowUpAt: DUE,
      promisedFollowUpKey: 'lead-commit:msg-9',
      promisedFollowUpDirection: 'await_lead',
      promisedFollowUpQuote: 'I will confirm by Friday',
    });
  });

  it('overwrites rather than accumulating, so "make it 6 instead" moves the one promise', async () => {
    // Unconditional $set with no guard on the existing value: the second call replaces the
    // first. Two promises on one conversation would mean two messages.
    mockUpdateResult({ _id: 'conv-1' });

    await setPromisedFollowUp({
      conversationId: 'conv-1',
      organizationId,
      dueAt: DUE,
      key: 'lead-commit:msg-9',
      direction: 'contact_lead',
    });

    expect(recordedFilter()).not.toHaveProperty('promisedFollowUpAt');
    expect(recordedSet()).toMatchObject({ promisedFollowUpAt: DUE });
  });

  it('truncates a long quote instead of rejecting the promise', async () => {
    mockUpdateResult({ _id: 'conv-1' });

    await setPromisedFollowUp({
      conversationId: 'conv-1',
      organizationId,
      dueAt: DUE,
      key: 'k',
      direction: 'contact_lead',
      quote: 'x'.repeat(500),
    });

    expect((recordedSet().promisedFollowUpQuote as string).length).toBe(300);
  });

  it('stores null rather than an empty string when there is no quote', async () => {
    mockUpdateResult({ _id: 'conv-1' });

    await setPromisedFollowUp({
      conversationId: 'conv-1',
      organizationId,
      dueAt: DUE,
      key: 'k',
      direction: 'contact_lead',
      quote: '',
    });

    expect(recordedSet().promisedFollowUpQuote).toBeNull();
  });
});

describe('findDuePromisedFollowUps', () => {
  it('returns only conversations whose promised time has arrived', async () => {
    const chain = createFindChain([]);
    mocks.find.mockReturnValue(chain);

    await findDuePromisedFollowUps({ now: DUE });

    expect(mocks.find).toHaveBeenCalledWith(
      expect.objectContaining({
        deletedAt: null,
        // $type rather than $ne so the partial index backing this query is actually
        // eligible - see the note in findDuePromisedFollowUps.
        promisedFollowUpAt: { $type: 'date', $lte: DUE },
      }),
    );
  });

  it('scans every organization unless one is named', async () => {
    // The sweep is cross-organization, like the nurture one.
    const chain = createFindChain([]);
    mocks.find.mockReturnValue(chain);

    await findDuePromisedFollowUps({ now: DUE });

    expect(mocks.find.mock.calls[0]?.[0]).not.toHaveProperty('organizationId');

    await findDuePromisedFollowUps({ organizationId, now: DUE });

    expect(mocks.find.mock.calls[1]?.[0]).toMatchObject({ organizationId });
  });

  it('pages forward on _id', async () => {
    const chain = createFindChain([]);
    mocks.find.mockReturnValue(chain);

    await findDuePromisedFollowUps({ afterId: 'conv-50', now: DUE });

    expect(mocks.find).toHaveBeenCalledWith(
      expect.objectContaining({ _id: { $gt: 'conv-50' } }),
    );
    expect(chain.sort).toHaveBeenCalledWith({ _id: 1 });
  });

  it('does not filter on automation or stage - the sweep records WHY it skipped', async () => {
    // Filtering here would drop a promise silently; the service claims it, then writes an
    // activity row naming the reason. See promise-follow-up.service.ts.
    const chain = createFindChain([]);
    mocks.find.mockReturnValue(chain);

    await findDuePromisedFollowUps({ now: DUE });

    const filter = mocks.find.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(filter).not.toHaveProperty('aiAutomationEnabled');
    expect(filter).not.toHaveProperty('stage');
  });
});

describe('claimPromisedFollowUp', () => {
  it('matches on the exact due time, so two racing sweeps cannot both win', async () => {
    // THE DUPLICATE-SEND GUARD. Without `promisedFollowUpAt` in the filter this is a plain
    // clear, and both workers proceed to send.
    mockUpdateResult({ _id: 'conv-1', promisedFollowUpAt: DUE });

    await claimPromisedFollowUp({ conversationId: 'conv-1', organizationId, dueAt: DUE });

    expect(recordedFilter()).toEqual({
      _id: 'conv-1',
      organizationId,
      promisedFollowUpAt: DUE,
    });
  });

  it('clears the promise in the same write that claims it', async () => {
    mockUpdateResult({ _id: 'conv-1' });

    await claimPromisedFollowUp({ conversationId: 'conv-1', organizationId, dueAt: DUE });

    expect(recordedSet()).toEqual({ promisedFollowUpAt: null });
  });

  it('returns the document as it was BEFORE the claim', async () => {
    // The sweep reads its guards off this, so it must be the pre-clear snapshot - and it is
    // atomically consistent with the claim, which is what makes the guards non-stale.
    mockUpdateResult({ _id: 'conv-1', promisedFollowUpAt: DUE, aiAutomationEnabled: true });

    const claimed = await claimPromisedFollowUp({
      conversationId: 'conv-1',
      organizationId,
      dueAt: DUE,
    });

    expect(mocks.findOneAndUpdate.mock.calls[0]?.[2]).toMatchObject({
      returnDocument: 'before',
    });
    expect(claimed).toMatchObject({ promisedFollowUpAt: DUE });
  });

  it('returns null when another worker got there first', async () => {
    mockUpdateResult(null);

    await expect(
      claimPromisedFollowUp({ conversationId: 'conv-1', organizationId, dueAt: DUE }),
    ).resolves.toBeNull();
  });
});

describe('cancellation when the lead replies', () => {
  it('clears the promise in the same write that records their message', async () => {
    // REQUIREMENT 5, and it lives here rather than in the sweep on purpose: an inbound message
    // and the cancellation are one atomic update, so no sweep can observe a promise the lead
    // has already answered.
    mockUpdateResult({ _id: 'conv-1' });

    await updateConversationPreview({
      conversationId: 'conv-1',
      organizationId,
      lastInboundAt: new Date('2026-10-21T12:00:00.000Z'),
      lastMessageAt: new Date('2026-10-21T12:00:00.000Z'),
    });

    expect(recordedSet()).toMatchObject({
      promisedFollowUpAt: null,
      promisedFollowUpKey: null,
      promisedFollowUpDirection: null,
      promisedFollowUpQuote: null,
    });
  });

  it('OUR OWN outbound does not cancel it', async () => {
    // The nightmare this guards: the promise message itself - or any other send - clearing the
    // very promise it was keeping, or cancelling one that is still owed.
    mockUpdateResult({ _id: 'conv-1' });

    await updateConversationPreview({
      conversationId: 'conv-1',
      organizationId,
      lastOutboundAt: new Date('2026-10-21T12:00:00.000Z'),
      lastMessageAt: new Date('2026-10-21T12:00:00.000Z'),
    });

    const set = recordedSet();

    expect(set).not.toHaveProperty('promisedFollowUpAt');
    expect(set).not.toHaveProperty('promisedFollowUpKey');
  });

  it('cancels and restarts the silence sequence together', async () => {
    // Both resets are keyed on the same field for the same reason; asserting them together
    // stops one being removed without the other.
    mockUpdateResult({ _id: 'conv-1' });

    await updateConversationPreview({
      conversationId: 'conv-1',
      organizationId,
      lastInboundAt: new Date('2026-10-21T12:00:00.000Z'),
    });

    expect(recordedSet()).toMatchObject({ nurtureStep: 0, promisedFollowUpAt: null });
  });
});
