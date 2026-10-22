/**
 * The rules for `Conversation.nextFollowUpAt`.
 *
 * This field was read in several places and written by none, so every feature that consulted it
 * - the inbox hint, the analytics attention list - was reading a value that was permanently
 * null. These tests pin down what it now means, because a derived field that drifts is worse
 * than one that does not exist: nobody distrusts a number that has always been there.
 *
 * The rules, each with a test below:
 *   - the EARLIEST due time among the conversation's PENDING reminders;
 *   - overdue-but-pending still counts (a late reminder is still work);
 *   - null when nothing is pending, so a completed reminder's time is never left behind;
 *   - personal reminders (no conversation) never touch any conversation;
 *   - recomputed from the tasks, never adjusted, so it is idempotent and self-healing;
 *   - a failure to sync never fails the reminder that was already saved.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createNextFollowUpSync } from './next-follow-up.service.js';

const ORG = 'org-1';
const CONVERSATION = 'conv-1';
const SOON = new Date('2026-10-21T09:00:00.000Z');
const LATER = new Date('2026-10-23T09:00:00.000Z');
const PAST = new Date('2026-10-19T09:00:00.000Z');

const harness = (earliest: Date | null = null) => {
  const findEarliestPendingDueAt = vi.fn().mockResolvedValue(earliest);
  const setConversationNextFollowUpAt = vi.fn().mockResolvedValue({ acknowledged: true });
  const logger = { error: vi.fn() };

  const sync = createNextFollowUpSync({
    findEarliestPendingDueAt,
    setConversationNextFollowUpAt,
    logger,
  });

  return { sync, findEarliestPendingDueAt, setConversationNextFollowUpAt, logger };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('what gets written', () => {
  it('stores the earliest pending due time', async () => {
    const { sync, setConversationNextFollowUpAt } = harness(SOON);

    await expect(
      sync.syncNextFollowUpAt({ organizationId: ORG, conversationId: CONVERSATION }),
    ).resolves.toEqual(SOON);

    expect(setConversationNextFollowUpAt).toHaveBeenCalledWith({
      organizationId: ORG,
      conversationId: CONVERSATION,
      nextFollowUpAt: SOON,
    });
  });

  it('asks only for PENDING reminders', async () => {
    // Completed and cancelled reminders are not work. If this ever widened, a closed reminder's
    // time could become the conversation's "next" one.
    const { sync, findEarliestPendingDueAt } = harness(SOON);

    await sync.syncNextFollowUpAt({ organizationId: ORG, conversationId: CONVERSATION });

    expect(findEarliestPendingDueAt).toHaveBeenCalledWith({
      organizationId: ORG,
      conversationId: CONVERSATION,
      status: 'pending',
    });
  });

  it('keeps an OVERDUE pending reminder, rather than treating a past time as stale', async () => {
    // The distinction that makes the field useful: overdue is a reading of this value, not a
    // reason to clear it. Clearing it would hide exactly the reminders that need attention.
    const { sync, setConversationNextFollowUpAt } = harness(PAST);

    await sync.syncNextFollowUpAt({ organizationId: ORG, conversationId: CONVERSATION });

    expect(setConversationNextFollowUpAt).toHaveBeenCalledWith(
      expect.objectContaining({ nextFollowUpAt: PAST }),
    );
  });

  it('CLEARS the field when nothing pending remains', async () => {
    // What makes completing the last reminder correct. Without this the conversation keeps
    // advertising a reminder that has already been dealt with.
    const { sync, setConversationNextFollowUpAt } = harness(null);

    await expect(
      sync.syncNextFollowUpAt({ organizationId: ORG, conversationId: CONVERSATION }),
    ).resolves.toBeNull();

    expect(setConversationNextFollowUpAt).toHaveBeenCalledWith(
      expect.objectContaining({ nextFollowUpAt: null }),
    );
  });

  it('is scoped by organization on both the read and the write', async () => {
    const { sync, findEarliestPendingDueAt, setConversationNextFollowUpAt } = harness(SOON);

    await sync.syncNextFollowUpAt({ organizationId: ORG, conversationId: CONVERSATION });

    expect(findEarliestPendingDueAt).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG }),
    );
    expect(setConversationNextFollowUpAt).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG }),
    );
  });
});

describe('personal reminders', () => {
  it('touches no conversation when there is no conversation id', async () => {
    // A personal reminder has no lead. Picking one would be the exact bug the brief forbids.
    const { sync, findEarliestPendingDueAt, setConversationNextFollowUpAt } = harness(SOON);

    await expect(
      sync.syncNextFollowUpAt({ organizationId: ORG, conversationId: null }),
    ).resolves.toBeNull();

    expect(findEarliestPendingDueAt).not.toHaveBeenCalled();
    expect(setConversationNextFollowUpAt).not.toHaveBeenCalled();
  });

  it('does nothing without an organization either', async () => {
    const { sync, setConversationNextFollowUpAt } = harness(SOON);

    await sync.syncNextFollowUpAt({ organizationId: null, conversationId: CONVERSATION });

    expect(setConversationNextFollowUpAt).not.toHaveBeenCalled();
  });
});

describe('idempotence and drift', () => {
  it('recomputes from the tasks rather than adjusting the stored value', async () => {
    // Nothing in the call reads the conversation's current value, which is what makes two
    // concurrent syncs safe: they race to write the same derived answer.
    const { sync, setConversationNextFollowUpAt } = harness(LATER);

    await sync.syncNextFollowUpAt({ organizationId: ORG, conversationId: CONVERSATION });
    await sync.syncNextFollowUpAt({ organizationId: ORG, conversationId: CONVERSATION });

    expect(setConversationNextFollowUpAt).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ nextFollowUpAt: LATER }),
    );
    expect(setConversationNextFollowUpAt).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ nextFollowUpAt: LATER }),
    );
  });

  it('self-heals: a later sync writes the new truth, whatever was stored before', async () => {
    const { sync, findEarliestPendingDueAt, setConversationNextFollowUpAt } = harness(LATER);

    await sync.syncNextFollowUpAt({ organizationId: ORG, conversationId: CONVERSATION });
    findEarliestPendingDueAt.mockResolvedValue(SOON);
    await sync.syncNextFollowUpAt({ organizationId: ORG, conversationId: CONVERSATION });

    expect(setConversationNextFollowUpAt).toHaveBeenLastCalledWith(
      expect.objectContaining({ nextFollowUpAt: SOON }),
    );
  });
});

describe('failure isolation', () => {
  it('does not throw when the write fails', async () => {
    // THE IMPORTANT ONE. This runs after a reminder has been saved. Throwing would turn a
    // successful create into an error the caller reports to the owner, for a derived hint.
    const { sync, logger } = harness(SOON);
    const setConversationNextFollowUpAt = vi.fn().mockRejectedValue(new Error('mongo down'));
    const failing = createNextFollowUpSync({
      findEarliestPendingDueAt: vi.fn().mockResolvedValue(SOON),
      setConversationNextFollowUpAt,
      logger,
    });

    await expect(
      failing.syncQuietly({ organizationId: ORG, conversationId: CONVERSATION }),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalled();
    void sync;
  });

  it('does not throw when the read fails', async () => {
    const logger = { error: vi.fn() };
    const failing = createNextFollowUpSync({
      findEarliestPendingDueAt: vi.fn().mockRejectedValue(new Error('timeout')),
      setConversationNextFollowUpAt: vi.fn(),
      logger,
    });

    await expect(
      failing.syncQuietly({ organizationId: ORG, conversationId: CONVERSATION }),
    ).resolves.toBeUndefined();
  });

  it('logs ids and error shape, never customer data', async () => {
    // A reminder's title and quote are the customer's own words.
    const logger = { error: vi.fn() };
    const failing = createNextFollowUpSync({
      findEarliestPendingDueAt: vi
        .fn()
        .mockRejectedValue(new Error('failed for lead Priya Sharma on +919812345678')),
      setConversationNextFollowUpAt: vi.fn(),
      logger,
    });

    await failing.syncQuietly({ organizationId: ORG, conversationId: CONVERSATION });

    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).not.toContain('Priya');
    expect(logged).not.toContain('919812345678');
  });

  it('still surfaces a failure to a caller that asked for the value directly', async () => {
    // syncQuietly swallows; syncNextFollowUpAt does not. The backfill wants the real error.
    const failing = createNextFollowUpSync({
      findEarliestPendingDueAt: vi.fn().mockRejectedValue(new Error('timeout')),
      setConversationNextFollowUpAt: vi.fn(),
      logger: { error: vi.fn() },
    });

    await expect(
      failing.syncNextFollowUpAt({ organizationId: ORG, conversationId: CONVERSATION }),
    ).rejects.toThrow('timeout');
  });
});
