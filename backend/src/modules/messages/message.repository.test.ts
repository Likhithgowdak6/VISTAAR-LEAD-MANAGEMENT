/**
 * The evidence query behind legacy lead adoption.
 *
 * WHY THIS NARROW FILE EXISTS. `hasDeliveredAiReply` is the only thing standing between "this
 * conversation predates leadQualificationStatus" and "treat it as an established lead that the
 * classifier no longer interviews". Everything about whether that adoption is safe is in the
 * shape of one Mongo filter, and a filter is exactly the kind of thing that looks right in
 * review and is wrong in production.
 *
 * The two ways it could be wrong both matter:
 *
 *   - too NARROW (dropping `delivered`/`read`) misses the oldest, most established threads,
 *     which are precisely the ones this exists for;
 *   - too WIDE (admitting `queued`, `sending` or either failed state) confirms conversations
 *     where a reply was drafted and never arrived - the customer was never spoken to, and the
 *     gate would stop interviewing a thread on the strength of a message nobody received.
 *
 * Mocked model, no real Mongo - the same approach as conversation.repository.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const mocks = vi.hoisted(() => ({
  countDocuments: vi.fn(),
}));

vi.mock('./message.model.js', () => ({
  Message: {
    countDocuments: mocks.countDocuments,
  },
}));

const { hasDeliveredAiReply } = await import('./message.repository.js');

const resolving = (count: number) => {
  mocks.countDocuments.mockReturnValue({ exec: vi.fn().mockResolvedValue(count) });
};

/** The filter the last call was made with. */
const lastFilter = () => mocks.countDocuments.mock.calls.at(-1)![0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('hasDeliveredAiReply', () => {
  it('asks only about outbound messages the AI wrote', async () => {
    resolving(1);

    await hasDeliveredAiReply({ organizationId: 'org-1', conversationId: 'conv-1' });

    // An owner's own reply is not evidence that the AI engaged this person as a lead, and an
    // inbound message is not evidence of anything at all.
    expect(lastFilter()).toMatchObject({
      organizationId: 'org-1',
      conversationId: 'conv-1',
      direction: 'out',
      authoredBy: 'ai',
    });
  });

  it('counts only statuses that a successful send produces', async () => {
    resolving(1);

    await hasDeliveredAiReply({ organizationId: 'org-1', conversationId: 'conv-1' });

    expect(lastFilter().status).toEqual({ $in: ['sent', 'delivered', 'read'] });
  });

  it.each(['queued', 'sending', 'failed', 'failed_permanent', 'created'])(
    'never admits a %j message',
    async (status) => {
      resolving(1);

      await hasDeliveredAiReply({ organizationId: 'org-1', conversationId: 'conv-1' });

      // THE ONE THAT MATTERS. A reply that was drafted, queued and never arrived means the
      // customer was never spoken to - adopting on that basis would qualify a conversation the
      // business has said nothing in.
      expect((lastFilter().status as { $in: string[] }).$in).not.toContain(status);
    },
  );

  it('stops at the first match', async () => {
    resolving(1);

    await hasDeliveredAiReply({ organizationId: 'org-1', conversationId: 'conv-1' });

    // One is all the evidence needed; counting a long thread's whole history on an inbound
    // hot path is wasted work.
    expect(mocks.countDocuments.mock.calls.at(-1)![1]).toEqual({ limit: 1 });
  });

  it('is true when a delivered AI reply exists', async () => {
    resolving(1);

    await expect(
      hasDeliveredAiReply({ organizationId: 'org-1', conversationId: 'conv-1' }),
    ).resolves.toBe(true);
  });

  it('is false when none does', async () => {
    resolving(0);

    await expect(
      hasDeliveredAiReply({ organizationId: 'org-1', conversationId: 'conv-1' }),
    ).resolves.toBe(false);
  });

  it('is organization-scoped', async () => {
    resolving(1);

    await hasDeliveredAiReply({ organizationId: 'someone-else', conversationId: 'conv-1' });

    expect(lastFilter()).toMatchObject({ organizationId: 'someone-else' });
  });
});
