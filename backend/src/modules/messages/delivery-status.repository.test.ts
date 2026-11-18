/**
 * Applying a provider delivery receipt, and specifically REFUSING to apply it backwards.
 *
 * Why this narrow file exists: Meta's receipts arrive out of order. A `read` webhook routinely
 * lands before the `delivered` one for the same message, and the obvious implementation - set the
 * status to whatever arrived - shows a message the customer has already read as merely delivered,
 * for good.
 *
 * The guard is a `$in` on the statuses that sit BEHIND the incoming one, pushed into the query
 * rather than checked in application code. That placement is the whole point: two receipts can
 * arrive on overlapping deliveries, and a check-then-update would let the later-but-lower one win
 * whenever it lost the race. A filter is exactly the kind of thing that looks right in review and
 * is wrong in production, so it is asserted directly.
 *
 * Mocked model, no real Mongo - the same approach as message.repository.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const mocks = vi.hoisted(() => ({
  findOneAndUpdate: vi.fn(),
}));

vi.mock('./message.model.js', () => ({
  Message: {
    findOneAndUpdate: mocks.findOneAndUpdate,
  },
}));

const { applyProviderDeliveryStatus } = await import('./message.repository.js');
const { MESSAGE_STATUSES } = await import('../../constants/message-statuses.js');

const apply = (overrides: Record<string, unknown> = {}) =>
  applyProviderDeliveryStatus({
    organizationId: 'org-1',
    whatsappAccountId: 'account-1',
    providerMessageId: 'wamid.ABC',
    status: MESSAGE_STATUSES.DELIVERED,
    now: new Date('2026-08-25T10:00:00.000Z'),
    ...overrides,
  } as never);

const lastFilter = () => mocks.findOneAndUpdate.mock.calls.at(-1)![0];
const lastUpdate = () => mocks.findOneAndUpdate.mock.calls.at(-1)![1];

beforeEach(() => {
  mocks.findOneAndUpdate.mockReset();
  mocks.findOneAndUpdate.mockReturnValue({ exec: () => Promise.resolve({ _id: 'message-1' }) });
});

describe('addressing', () => {
  it('finds the message by the id the PROVIDER issued, scoped to org and account', async () => {
    await apply();

    expect(lastFilter()).toMatchObject({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      providerMessageId: 'wamid.ABC',
    });
  });

  it('trims the provider message id', async () => {
    await apply({ providerMessageId: '  wamid.ABC  ' });

    expect(lastFilter().providerMessageId).toBe('wamid.ABC');
  });

  it.each([null, undefined, '', '   '])(
    'does not touch the database for a %s provider message id',
    async (providerMessageId) => {
      await expect(apply({ providerMessageId })).resolves.toBeNull();

      expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
    },
  );

  it('does not touch the database for a status it does not recognize', async () => {
    await expect(apply({ status: 'teleported' })).resolves.toBeNull();

    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('monotonic advancement', () => {
  it('lets `delivered` overwrite only statuses behind it', async () => {
    await apply({ status: MESSAGE_STATUSES.DELIVERED });

    const allowed = lastFilter().status.$in;

    expect(allowed).toEqual(
      expect.arrayContaining([
        MESSAGE_STATUSES.QUEUED,
        MESSAGE_STATUSES.SENDING,
        MESSAGE_STATUSES.SENT,
      ]),
    );

    // The ones at or ahead of `delivered` must not be in the set.
    expect(allowed).not.toContain(MESSAGE_STATUSES.DELIVERED);
    expect(allowed).not.toContain(MESSAGE_STATUSES.READ);
    expect(allowed).not.toContain(MESSAGE_STATUSES.FAILED_PERMANENT);
  });

  /** The out-of-order case that motivated the whole mechanism. */
  it('does not let a late `delivered` overwrite a message already `read`', async () => {
    await apply({ status: MESSAGE_STATUSES.DELIVERED });

    expect(lastFilter().status.$in).not.toContain(MESSAGE_STATUSES.READ);
  });

  it('lets `read` overwrite `delivered`', async () => {
    await apply({ status: MESSAGE_STATUSES.READ });

    expect(lastFilter().status.$in).toContain(MESSAGE_STATUSES.DELIVERED);
  });

  /**
   * A failure reported after a delivery receipt is the truth: Meta can accept a message,
   * acknowledge it, and then refuse it. The agent needs to see that it did not arrive far more
   * than they need the earlier optimistic tick.
   */
  it('lets a failure overwrite an earlier delivered or read', async () => {
    await apply({ status: MESSAGE_STATUSES.FAILED_PERMANENT });

    expect(lastFilter().status.$in).toEqual(
      expect.arrayContaining([MESSAGE_STATUSES.DELIVERED, MESSAGE_STATUSES.READ]),
    );
  });

  it('returns null when nothing matched, which covers both unknown and already-ahead', async () => {
    mocks.findOneAndUpdate.mockReturnValue({ exec: () => Promise.resolve(null) });

    await expect(apply()).resolves.toBeNull();
  });
});

describe('what is written', () => {
  it('sets the status and stamps when it changed', async () => {
    await apply({ status: MESSAGE_STATUSES.READ });

    expect(lastUpdate().$set).toMatchObject({
      status: MESSAGE_STATUSES.READ,
      statusUpdatedAt: new Date('2026-08-25T10:00:00.000Z'),
    });
  });

  it('records a failure reason when one is given', async () => {
    await apply({ status: MESSAGE_STATUSES.FAILED_PERMANENT, error: 'window_closed' });

    expect(lastUpdate().$set.lastDeliveryError).toBe('window_closed');
  });

  /**
   * A successful receipt must not wipe the reason an earlier attempt failed - that history is
   * what explains a message that eventually went out on the third try.
   */
  it('leaves lastDeliveryError untouched when no reason is given', async () => {
    await apply({ status: MESSAGE_STATUSES.DELIVERED, error: null });

    expect(lastUpdate().$set).not.toHaveProperty('lastDeliveryError');
  });

  it('truncates an over-long reason rather than failing validation', async () => {
    await apply({ status: MESSAGE_STATUSES.FAILED_PERMANENT, error: 'x'.repeat(500) });

    expect(lastUpdate().$set.lastDeliveryError).toHaveLength(300);
  });
});
