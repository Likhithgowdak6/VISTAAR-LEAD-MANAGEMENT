/**
 * The database side of the classification rules.
 *
 * WHAT THESE CAN AND CANNOT PROVE. They assert the filter documents that get handed to
 * MongoDB - that every bucket produces a distinct, non-empty predicate, that the buckets do not
 * silently overlap on the fields they key on, and above all that COMBINING filters ANDs them
 * together instead of one quietly overwriting another. That last one is the bug this file is
 * really here for: `filter.$expr = x` twice in a row loses the first condition, and the result
 * is an inbox that answers "enquiries awaiting a reply" with "everything awaiting a reply".
 *
 * They cannot prove that MongoDB agrees with the TypeScript rules on real documents - that
 * needs a database, and it is listed as an outstanding check in the report.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const mocks = vi.hoisted(() => ({ find: vi.fn() }));

vi.mock('../conversations/conversation.model.js', () => ({
  Conversation: { find: mocks.find },
  CONVERSATION_STATUSES: { OPEN: 'open', CLOSED: 'closed' },
}));

const { aiResponseStatusFilter, enquiryClassFilter, needsAttentionFilter } = await import(
  './classification-filters.js'
);
const { AI_RESPONSE_STATUS_VALUES, ENQUIRY_CLASS_VALUES } = await import(
  './conversation-classification.js'
);

describe('enquiry class filters', () => {
  it('keys on the established qualification and nothing else', () => {
    expect(enquiryClassFilter('enquiry')).toEqual({ leadQualificationStatus: 'confirmed' });
    expect(enquiryClassFilter('not_enquiry')).toEqual({ leadQualificationStatus: 'rejected' });
  });

  it('matches rows with the field MISSING as needs review', () => {
    // `$nin` matches a document that has no such field at all, which is what every
    // conversation written before the qualification field existed looks like. `$eq: 'unknown'`
    // would quietly drop all of them from the counts.
    const filter = enquiryClassFilter('needs_review') as {
      leadQualificationStatus: { $nin: string[] };
    };

    expect(filter.leadQualificationStatus.$nin).toEqual(['confirmed', 'rejected']);
  });

  it('produces a filter for every class, with no two the same', () => {
    const produced = ENQUIRY_CLASS_VALUES.map((value) => JSON.stringify(enquiryClassFilter(value)));

    expect(new Set(produced).size).toBe(ENQUIRY_CLASS_VALUES.length);
  });
});

describe('AI response status filters', () => {
  it('produces a distinct, non-empty filter for every status', () => {
    const produced = AI_RESPONSE_STATUS_VALUES.map((value) =>
      JSON.stringify(aiResponseStatusFilter(value)),
    );

    expect(new Set(produced).size).toBe(AI_RESPONSE_STATUS_VALUES.length);
    produced.forEach((filter) => expect(filter.length).toBeGreaterThan(2));
  });

  it('excludes rejected conversations from every bucket except "not needed"', () => {
    // Otherwise a non-enquiry would be counted twice - once as "no reply owed" and again as
    // whatever its timestamps happen to look like. Two ways to satisfy this: pin the status to
    // `confirmed`, or exclude `rejected` outright. Both are sufficient; this asserts one holds.
    for (const status of AI_RESPONSE_STATUS_VALUES) {
      if (status === 'ai_not_needed') {
        continue;
      }

      const { leadQualificationStatus } = aiResponseStatusFilter(status) as {
        leadQualificationStatus?: unknown;
      };

      const pinnedToConfirmed = leadQualificationStatus === 'confirmed';
      const excludesRejected =
        JSON.stringify(leadQualificationStatus ?? null) === JSON.stringify({ $ne: 'rejected' });

      expect(
        pinnedToConfirmed || excludesRejected,
        `${status} must not be able to match a rejected conversation`,
      ).toBe(true);
    }
  });

  it('requires automation to be on for every bucket that implies the AI will act', () => {
    for (const status of ['awaiting_ai_reply', 'ai_replied', 'ai_reply_failed'] as const) {
      const filter = aiResponseStatusFilter(status) as Record<string, unknown>;

      expect(filter.aiAutomationEnabled).toEqual({ $ne: false });
      expect(filter.optedOutAt).toBeNull();
    }
  });

  it('treats a paused thread as paused rather than awaiting', () => {
    const paused = aiResponseStatusFilter('ai_paused') as Record<string, unknown>;
    const awaiting = aiResponseStatusFilter('awaiting_ai_reply') as Record<string, unknown>;

    expect(paused.aiAutomationEnabled).toBe(false);
    expect(awaiting.aiAutomationEnabled).toEqual({ $ne: false });
  });
});

describe('needs attention filter', () => {
  it('includes an overdue follow-up, bounded by the supplied clock', () => {
    const now = new Date('2026-10-20T09:00:00.000Z');
    const filter = needsAttentionFilter(now) as { $or: Array<Record<string, unknown>> };

    expect(filter.$or).toContainEqual({ nextFollowUpAt: { $ne: null, $lte: now } });
  });

  it('excludes non-enquiries and opted-out contacts', () => {
    const filter = needsAttentionFilter() as Record<string, unknown>;

    expect(filter.leadQualificationStatus).toEqual({ $ne: 'rejected' });
    expect(filter.optedOutAt).toBeNull();
  });
});

describe('combining filters in listConversations', () => {
  const capture = () => {
    const chain = {
      sort: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      lean: vi.fn().mockReturnThis(),
      exec: vi.fn().mockResolvedValue([]),
    };
    mocks.find.mockReturnValue(chain);

    return chain;
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ANDs a classification filter with an AI-status filter', async () => {
    // "Enquiries + awaiting a reply" has to mean both. Assigning each to the filter object
    // directly would leave only the second, because both contribute an `$expr`.
    capture();
    const { listConversations } = await import('../conversations/conversation.repository.js');

    await listConversations({
      organizationId: 'org-1' as never,
      enquiryClass: 'enquiry',
      aiStatus: 'awaiting_ai_reply',
    });

    const filter = mocks.find.mock.calls[0]?.[0] as { $and?: unknown[] };
    expect(filter.$and).toHaveLength(2);
  });

  it('keeps the existing stage and account filters alongside the new ones', async () => {
    capture();
    const { listConversations } = await import('../conversations/conversation.repository.js');

    await listConversations({
      organizationId: 'org-1' as never,
      stage: 'new',
      whatsappAccountId: 'acct-1' as never,
      needsAttention: true,
    });

    const filter = mocks.find.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(filter.stage).toBe('new');
    expect(filter.whatsappAccountId).toBe('acct-1');
    expect(filter.organizationId).toBe('org-1');
    expect(filter.$and).toHaveLength(1);
  });

  it('adds nothing when no classification filter is requested', async () => {
    // The existing inbox must issue exactly the query it always did.
    capture();
    const { listConversations } = await import('../conversations/conversation.repository.js');

    await listConversations({ organizationId: 'org-1' as never });

    const filter = mocks.find.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(filter.$and).toBeUndefined();
  });

  it('still scopes to the organization when every filter is applied', async () => {
    capture();
    const { listConversations } = await import('../conversations/conversation.repository.js');

    await listConversations({
      organizationId: 'org-1' as never,
      assignedTo: 'user-1' as never,
      enquiryClass: 'needs_review',
      aiStatus: 'needs_review',
      needsAttention: true,
    });

    const filter = mocks.find.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(filter.organizationId).toBe('org-1');
    expect(filter.assignedTo).toBe('user-1');
    expect(filter.$and).toHaveLength(3);
  });
});
