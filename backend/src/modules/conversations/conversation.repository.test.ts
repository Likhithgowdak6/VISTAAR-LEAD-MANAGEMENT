/**
 * Exercises the nurture-sweep query/update functions added to this repository:
 * findNurturableConversations' filter shape and cursor paging, bumpNurtureStep, and
 * markConversationCold - against a mocked Conversation model, no real Mongo. Every import this
 * file pulls in from conversation.repository.ts other than the Mongoose model itself is either a
 * pure constant or a type-only import (erased at compile time), so nothing else needs mocking.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// conversation.repository.ts only type-imports config/database.js (erased at compile time by
// TypeScript, but this project's vitest/esbuild transform does not elide it at the module-graph
// level), so its real top-level env validation still runs unless this is mocked - same reason
// every other repository/service test in this codebase mocks it.
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
  AI_FACTS_PRECEDENCE,
  applyEventDateFromFacts,
  bumpNurtureStep,
  claimEventReminder,
  claimHotLeadAlert,
  claimNewLeadAlert,
  countConversationsCreatedSince,
  findConversationsDueForHandoverRead,
  findGoingColdConversations,
  findConversationsWithUpcomingEvents,
  findNurturableConversations,
  findParkedConversations,
  markConversationCold,
  markOptedOut,
  mergeConversationAiContext,
  releaseEventReminderClaim,
  updateLeadScore,
} = await import('./conversation.repository.js');

const organizationId = 'org-1';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findNurturableConversations', () => {
  const createFindChain = (result: unknown[]) => {
    const exec = vi.fn().mockResolvedValue(result);
    const limit = vi.fn().mockReturnValue({ exec });
    const sort = vi.fn().mockReturnValue({ limit });
    return { sort, limit, exec };
  };

  it('filters on the active pipeline stages, automation-on, and having sent at least one outbound message', async () => {
    const chain = createFindChain([]);
    mocks.find.mockReturnValue(chain);

    await findNurturableConversations({ organizationId });

    expect(mocks.find).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: { $in: ['new', 'contacted', 'qualified', 'proposal'] },
        aiAutomationEnabled: true,
        lastOutboundAt: { $ne: null },
        organizationId,
      }),
    );
    expect(chain.sort).toHaveBeenCalledWith({ _id: 1 });
  });

  it('never selects a conversation whose lead asked to stop', async () => {
    const chain = createFindChain([]);
    mocks.find.mockReturnValue(chain);

    await findNurturableConversations({ organizationId });

    expect(mocks.find).toHaveBeenCalledWith(expect.objectContaining({ optedOutAt: null }));
  });

  it('omits organizationId from the filter when sweeping across every organization', async () => {
    const chain = createFindChain([]);
    mocks.find.mockReturnValue(chain);

    await findNurturableConversations({});

    const filter = mocks.find.mock.calls[0]![0] as Record<string, unknown>;
    expect(filter.organizationId).toBeUndefined();
  });

  it('adds an _id cursor filter when afterId is given, for paging without skip()', async () => {
    const chain = createFindChain([]);
    mocks.find.mockReturnValue(chain);

    await findNurturableConversations({ organizationId, afterId: 'conv-50' });

    expect(mocks.find).toHaveBeenCalledWith(
      expect.objectContaining({ _id: { $gt: 'conv-50' } }),
    );
  });

  it('defaults the batch limit to 200 and honors an explicit one', async () => {
    const chain = createFindChain([]);
    mocks.find.mockReturnValue(chain);

    await findNurturableConversations({ organizationId });
    expect(chain.limit).toHaveBeenCalledWith(200);

    await findNurturableConversations({ organizationId, limit: 50 });
    expect(chain.limit).toHaveBeenCalledWith(50);
  });
});

describe('bumpNurtureStep', () => {
  it('sets nurtureStep on the given conversation', async () => {
    const exec = vi.fn().mockResolvedValue({ nurtureStep: 3 });
    mocks.findOneAndUpdate.mockReturnValue({ exec });

    const result = await bumpNurtureStep({ conversationId: 'conv-1', organizationId, step: 3 });

    expect(mocks.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'conv-1', organizationId },
      { $set: { nurtureStep: 3 } },
      expect.objectContaining({ returnDocument: 'after' }),
    );
    expect(result).toEqual({ nurtureStep: 3 });
  });
});

describe('markConversationCold', () => {
  it('turns automation off and records the paused reason without touching stage', async () => {
    const exec = vi.fn().mockResolvedValue({ aiAutomationEnabled: false });
    mocks.findOneAndUpdate.mockReturnValue({ exec });

    await markConversationCold({
      conversationId: 'conv-1',
      organizationId,
      pausedReason: 'Gone quiet for 20+ days — marked cold.',
    });

    expect(mocks.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'conv-1', organizationId },
      {
        $set: {
          aiAutomationEnabled: false,
          aiAutomationPausedReason: 'Gone quiet for 20+ days — marked cold.',
        },
      },
      expect.objectContaining({ returnDocument: 'after' }),
    );
  });
});

describe('markOptedOut', () => {
  it('stamps optedOutAt, turns automation off and records why, without touching the stage', async () => {
    const exec = vi.fn().mockResolvedValue({ optedOutAt: new Date() });
    mocks.findOneAndUpdate.mockReturnValue({ exec });
    const now = new Date('2026-08-25T03:00:00.000Z');

    await markOptedOut({
      conversationId: 'conv-1',
      organizationId,
      pausedReason: 'This lead asked to stop receiving messages.',
      now,
    });

    expect(mocks.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'conv-1', organizationId },
      {
        $set: {
          optedOutAt: now,
          aiAutomationEnabled: false,
          aiAutomationPausedReason: 'This lead asked to stop receiving messages.',
        },
      },
      expect.objectContaining({ returnDocument: 'after' }),
    );
  });
});

// --------------------------------------------------------------------------
// Phase 5/6: the morning handover read's due query, the digest's sections, and the new-lead
// alert's atomic claim.
// --------------------------------------------------------------------------
describe('findConversationsDueForHandoverRead', () => {
  const createFindChain = (result: unknown[]) => {
    const exec = vi.fn().mockResolvedValue(result);
    const limit = vi.fn().mockReturnValue({ exec });
    const sort = vi.fn().mockReturnValue({ limit });
    return { sort, limit, exec };
  };

  const before = new Date('2026-08-24T18:30:00.000Z');

  it('only returns automation-off conversations the owner typed into before today started', async () => {
    const chain = createFindChain([]);
    mocks.find.mockReturnValue(chain);

    await findConversationsDueForHandoverRead({ organizationId, before });

    expect(mocks.find).toHaveBeenCalledWith(
      expect.objectContaining({
        aiAutomationEnabled: false,
        ownerLastTypedAt: { $ne: null, $lt: before },
        organizationId,
      }),
    );
    expect(chain.sort).toHaveBeenCalledWith({ _id: 1 });
  });

  it('omits organizationId when reading across every organization', async () => {
    const chain = createFindChain([]);
    mocks.find.mockReturnValue(chain);

    await findConversationsDueForHandoverRead({ before });

    const filter = mocks.find.mock.calls[0]![0] as Record<string, unknown>;
    expect(filter.organizationId).toBeUndefined();
  });

  it('adds an _id cursor filter when afterId is given', async () => {
    const chain = createFindChain([]);
    mocks.find.mockReturnValue(chain);

    await findConversationsDueForHandoverRead({ organizationId, before, afterId: 'conv-50' });

    expect(mocks.find).toHaveBeenCalledWith(expect.objectContaining({ _id: { $gt: 'conv-50' } }));
  });
});

describe('findParkedConversations', () => {
  it('returns automation-off conversations that carry a paused reason', async () => {
    const exec = vi.fn().mockResolvedValue([]);
    const limit = vi.fn().mockReturnValue({ exec });
    const sort = vi.fn().mockReturnValue({ limit });
    mocks.find.mockReturnValue({ sort, limit, exec });

    await findParkedConversations({ organizationId });

    expect(mocks.find).toHaveBeenCalledWith(
      expect.objectContaining({
        aiAutomationEnabled: false,
        aiAutomationPausedReason: { $ne: null },
        organizationId,
      }),
    );
  });
});

describe('findGoingColdConversations', () => {
  it('returns leads deep into the nurture cadence that are still in an active stage', async () => {
    const exec = vi.fn().mockResolvedValue([]);
    const limit = vi.fn().mockReturnValue({ exec });
    const sort = vi.fn().mockReturnValue({ limit });
    mocks.find.mockReturnValue({ sort, limit, exec });

    await findGoingColdConversations({ organizationId });

    expect(mocks.find).toHaveBeenCalledWith(
      expect.objectContaining({
        nurtureStep: { $gte: 2 },
        stage: { $in: ['new', 'contacted', 'qualified', 'proposal'] },
      }),
    );
  });
});

describe('countConversationsCreatedSince', () => {
  it('counts conversations created at or after the cutoff', async () => {
    const exec = vi.fn().mockResolvedValue(3);
    mocks.countDocuments.mockReturnValue({ exec });
    const since = new Date('2026-08-24T03:40:00.000Z');

    await expect(countConversationsCreatedSince({ organizationId, since })).resolves.toBe(3);

    expect(mocks.countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ createdAt: { $gte: since }, organizationId }),
    );
  });
});

describe('claimNewLeadAlert', () => {
  it('only claims a conversation whose alert has never been sent', async () => {
    const exec = vi.fn().mockResolvedValue({ _id: 'conv-1' });
    mocks.findOneAndUpdate.mockReturnValue({ exec });
    const now = new Date('2026-08-25T03:40:00.000Z');

    await claimNewLeadAlert({ conversationId: 'conv-1', organizationId, now });

    expect(mocks.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'conv-1', organizationId, newLeadAlertSentAt: null },
      { $set: { newLeadAlertSentAt: now } },
      expect.objectContaining({ returnDocument: 'after' }),
    );
  });

  it('returns null when someone else already claimed it (the whole idempotency guarantee)', async () => {
    const exec = vi.fn().mockResolvedValue(null);
    mocks.findOneAndUpdate.mockReturnValue({ exec });

    await expect(
      claimNewLeadAlert({ conversationId: 'conv-1', organizationId }),
    ).resolves.toBeNull();
  });
});

// --------------------------------------------------------------------------
// Lead scoring: the number, its band and the breakdown, plus the claim that makes the owner's
// 🔥 alert fire exactly once per conversation however often the score crosses 80.
// --------------------------------------------------------------------------
describe('updateLeadScore', () => {
  it('sets the score, the band and the fired signals in one write', async () => {
    const exec = vi.fn().mockResolvedValue({ _id: 'conv-1' });
    mocks.findOneAndUpdate.mockReturnValue({ exec });

    await updateLeadScore({
      conversationId: 'conv-1',
      organizationId,
      score: 85,
      band: 'hot',
      signals: ['event_date', 'venue', 'replied'],
    });

    expect(mocks.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'conv-1', organizationId },
      {
        $set: {
          leadScore: 85,
          leadScoreBand: 'hot',
          leadScoreSignals: ['event_date', 'venue', 'replied'],
        },
      },
      expect.objectContaining({ returnDocument: 'after', runValidators: true }),
    );
  });

  it('copies the signals rather than storing the caller\'s array', async () => {
    const exec = vi.fn().mockResolvedValue({ _id: 'conv-1' });
    mocks.findOneAndUpdate.mockReturnValue({ exec });
    const signals = ['replied'];

    await updateLeadScore({ conversationId: 'conv-1', organizationId, score: 20, band: 'cold', signals });

    const written = (mocks.findOneAndUpdate.mock.calls[0]?.[1] as { $set: { leadScoreSignals: string[] } })
      .$set.leadScoreSignals;

    expect(written).toEqual(['replied']);
    expect(written).not.toBe(signals);
  });
});

describe('claimHotLeadAlert', () => {
  it('only claims a conversation whose hot alert has never been sent', async () => {
    const exec = vi.fn().mockResolvedValue({ _id: 'conv-1' });
    mocks.findOneAndUpdate.mockReturnValue({ exec });
    const now = new Date('2026-08-25T03:40:00.000Z');

    await claimHotLeadAlert({ conversationId: 'conv-1', organizationId, now });

    expect(mocks.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'conv-1', organizationId, leadScoreHotAlertSentAt: null },
      { $set: { leadScoreHotAlertSentAt: now } },
      expect.objectContaining({ returnDocument: 'after' }),
    );
  });

  it('returns null when it has already been claimed - a score oscillating around 80 stays quiet', async () => {
    const exec = vi.fn().mockResolvedValue(null);
    mocks.findOneAndUpdate.mockReturnValue({ exec });

    await expect(
      claimHotLeadAlert({ conversationId: 'conv-1', organizationId }),
    ).resolves.toBeNull();
  });
});

// --------------------------------------------------------------------------
// The event date: the one fact this business's whole follow-up cadence turns on. Lifted out of
// the `aiFacts` blob into a typed column so it can be queried and compared.
// --------------------------------------------------------------------------
describe('applyEventDateFromFacts', () => {
  const now = new Date('2026-06-15T09:30:00.000Z');

  it('writes the parsed date from a form fact', async () => {
    const exec = vi.fn().mockResolvedValue({ _id: 'conv-1' });
    mocks.findOneAndUpdate.mockReturnValue({ exec });

    await applyEventDateFromFacts({
      conversationId: 'conv-1',
      organizationId,
      facts: { event_date: '12/09/2026', city: 'Bangalore' },
      now,
    });

    expect(mocks.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'conv-1', organizationId },
      { $set: { eventDate: new Date('2026-09-12T00:00:00.000Z') } },
      expect.objectContaining({ returnDocument: 'after' }),
    );
  });

  it('writes nothing at all when the answer is not a date', async () => {
    await expect(
      applyEventDateFromFacts({
        conversationId: 'conv-1',
        organizationId,
        facts: { event_date: 'not decided yet' },
        now,
      }),
    ).resolves.toBeNull();

    // An unreadable answer must never clear a date somebody already gave us.
    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('writes nothing when the facts carry no date key', async () => {
    await applyEventDateFromFacts({
      conversationId: 'conv-1',
      organizationId,
      facts: { city: 'Bangalore' },
      now,
    });

    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('mergeConversationAiContext — who wins on a key both sides have', () => {
  const mergeOperands = async (
    facts: Record<string, unknown>,
    factsPrecedence?: string,
  ): Promise<unknown[]> => {
    mocks.findOneAndUpdate.mockReturnValueOnce({
      exec: vi.fn().mockResolvedValue({ _id: 'conv-1', aiFacts: {} }),
    });

    await mergeConversationAiContext({
      conversationId: 'conv-1',
      organizationId,
      facts,
      factsPrecedence: factsPrecedence as never,
    });

    const pipeline = mocks.findOneAndUpdate.mock.calls[0]![1] as { $set: Record<string, unknown> }[];

    return (pipeline[0]!.$set.aiFacts as { $mergeObjects: unknown[] }).$mergeObjects;
  };

  it('defaults to STORED: the incoming facts go first, so nothing stored is overwritten', async () => {
    const operands = await mergeOperands({ city: 'Bangalore' });

    expect(operands).toEqual([
      { $literal: { city: 'Bangalore' } },
      { $ifNull: ['$aiFacts', {}] },
    ]);
  });

  it('puts a real incoming answer LAST under NEW_ANSWERS, so it beats a stale stored one', async () => {
    const operands = await mergeOperands(
      { event_date: '14 September 2026', city: 'Whitefield' },
      AI_FACTS_PRECEDENCE.NEW_ANSWERS,
    );

    expect(operands).toEqual([
      { $literal: {} },
      { $ifNull: ['$aiFacts', {}] },
      { $literal: { event_date: '14 September 2026', city: 'Whitefield' } },
    ]);
  });

  it('keeps an incoming "not decided yet" first, so it fills a gap but erases nothing', async () => {
    // The AI still needs to read its own "not decided yet" back next turn to know it already
    // asked - it just must never overwrite the date the lead gave last week.
    const operands = await mergeOperands(
      { event_date: 'not decided yet', city: 'Whitefield' },
      AI_FACTS_PRECEDENCE.NEW_ANSWERS,
    );

    expect(operands).toEqual([
      { $literal: { event_date: 'not decided yet' } },
      { $ifNull: ['$aiFacts', {}] },
      { $literal: { city: 'Whitefield' } },
    ]);
  });

  it('drops keys Mongo cannot store, whichever precedence is asked for', async () => {
    const operands = await mergeOperands(
      { '$bad': 'x', 'has.dot': 'y', city: 'Whitefield' },
      AI_FACTS_PRECEDENCE.NEW_ANSWERS,
    );

    expect(operands[2]).toEqual({ $literal: { city: 'Whitefield' } });
  });

  it('writes nothing at all when every incoming fact is unstorable', async () => {
    const exec = vi.fn().mockResolvedValue(null);
    mocks.findOne.mockReturnValue({ exec });

    await mergeConversationAiContext({
      conversationId: 'conv-1',
      organizationId,
      facts: { '$bad': 'x' },
      factsPrecedence: AI_FACTS_PRECEDENCE.NEW_ANSWERS,
    });

    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.findOne).toHaveBeenCalled();
  });
});

describe('mergeConversationAiContext — the event date it derives', () => {
  const now = new Date('2026-06-15T09:30:00.000Z');

  it('sets eventDate from the MERGED facts after writing an imported form’s answers', async () => {
    // First call: the merge pipeline, answering with the merged document. Second: the derived
    // eventDate write, which reads that document's facts rather than the incoming ones.
    mocks.findOneAndUpdate
      .mockReturnValueOnce({
        exec: vi.fn().mockResolvedValue({
          _id: 'conv-1',
          aiFacts: { event_date: '12 September 2026', city: 'Bangalore' },
        }),
      })
      .mockReturnValueOnce({
        exec: vi.fn().mockResolvedValue({
          _id: 'conv-1',
          eventDate: new Date('2026-09-12T00:00:00.000Z'),
        }),
      });

    const result = await mergeConversationAiContext({
      conversationId: 'conv-1',
      organizationId,
      facts: { event_date: '12 September 2026', city: 'Bangalore' },
      category: 'event_photography',
      now,
    });

    expect(mocks.findOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(mocks.findOneAndUpdate.mock.calls[1]![1]).toEqual({
      $set: { eventDate: new Date('2026-09-12T00:00:00.000Z') },
    });
    expect(result).toEqual(
      expect.objectContaining({ eventDate: new Date('2026-09-12T00:00:00.000Z') }),
    );
  });

  it('leaves the conversation exactly as the merge left it when no date can be read', async () => {
    const merged = { _id: 'conv-1', aiFacts: { event_date: 'next Saturday' } };
    mocks.findOneAndUpdate.mockReturnValueOnce({
      exec: vi.fn().mockResolvedValue(merged),
    });

    const result = await mergeConversationAiContext({
      conversationId: 'conv-1',
      organizationId,
      facts: { event_date: 'next Saturday' },
      now,
    });

    expect(mocks.findOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(result).toBe(merged);
  });
});

describe('findConversationsWithUpcomingEvents', () => {
  const createFindChain = (result: unknown[]) => {
    const exec = vi.fn().mockResolvedValue(result);
    const limit = vi.fn().mockReturnValue({ exec });
    const sort = vi.fn().mockReturnValue({ limit });
    return { sort, limit, exec };
  };

  const from = new Date('2026-09-11T09:00:00.000Z');
  const to = new Date('2026-09-12T09:00:00.000Z');

  it('only returns won conversations with an event in the window that has not been reminded about', async () => {
    const chain = createFindChain([]);
    mocks.find.mockReturnValue(chain);

    await findConversationsWithUpcomingEvents({ organizationId, from, to });

    expect(mocks.find).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: 'won',
        eventDate: { $gt: from, $lte: to },
        eventReminderSentAt: null,
        organizationId,
      }),
    );
    expect(chain.sort).toHaveBeenCalledWith({ _id: 1 });
    expect(chain.limit).toHaveBeenCalledWith(200);
  });

  it('omits organizationId when sweeping across every organization, and pages by _id', async () => {
    const chain = createFindChain([]);
    mocks.find.mockReturnValue(chain);

    await findConversationsWithUpcomingEvents({ from, to, afterId: 'conv-50' });

    const filter = mocks.find.mock.calls[0]![0] as Record<string, unknown>;
    expect(filter.organizationId).toBeUndefined();
    expect(filter._id).toEqual({ $gt: 'conv-50' });
  });
});

describe('claimEventReminder', () => {
  it('only claims a booking whose reminder has never been sent', async () => {
    const exec = vi.fn().mockResolvedValue({ _id: 'conv-1' });
    mocks.findOneAndUpdate.mockReturnValue({ exec });
    const now = new Date('2026-09-11T12:00:00.000Z');

    await claimEventReminder({ conversationId: 'conv-1', organizationId, now });

    expect(mocks.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'conv-1', organizationId, eventReminderSentAt: null },
      { $set: { eventReminderSentAt: now } },
      expect.objectContaining({ returnDocument: 'after' }),
    );
  });

  it('returns null when another sweep already claimed it', async () => {
    const exec = vi.fn().mockResolvedValue(null);
    mocks.findOneAndUpdate.mockReturnValue({ exec });

    await expect(
      claimEventReminder({ conversationId: 'conv-1', organizationId }),
    ).resolves.toBeNull();
  });
});

describe('releaseEventReminderClaim', () => {
  it('hands the claim back so a failed send is retried rather than lost', async () => {
    const exec = vi.fn().mockResolvedValue({ _id: 'conv-1', eventReminderSentAt: null });
    mocks.findOneAndUpdate.mockReturnValue({ exec });

    await releaseEventReminderClaim({ conversationId: 'conv-1', organizationId });

    expect(mocks.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'conv-1', organizationId },
      { $set: { eventReminderSentAt: null } },
      expect.objectContaining({ returnDocument: 'after' }),
    );
  });
});
