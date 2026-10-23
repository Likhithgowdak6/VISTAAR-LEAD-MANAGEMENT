/**
 * Who owns a handset, and who is allowed to silence one.
 *
 * THE FAILURE THESE EXIST FOR. An FCM token is one string per app install. If a row could
 * exist twice under two organisations, one tenant's reminders would arrive on another
 * tenant's phone - the worst thing this feature could do. And if removal were keyed on the
 * token alone, knowing somebody's token would be enough to stop their phone ringing.
 *
 * Mocked model, no real Mongo: what is asserted is the FILTER, which is where both properties
 * live.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  findOneAndUpdate: vi.fn(),
  deleteOne: vi.fn(),
}));

vi.mock('./push-device.model.js', () => ({
  PushDevice: {
    find: mocks.find,
    findOneAndUpdate: mocks.findOneAndUpdate,
    deleteOne: mocks.deleteOne,
  },
}));

const {
  disablePushDevice,
  findPushDevicesForUser,
  registerPushDevice,
  removePushDevice,
} = await import('./push-device.repository.js');

const organizationId = 'org-1';
const userId = 'user-1';

const mockUpdate = (value: unknown = { _id: 'dev-1' }) => {
  const exec = vi.fn().mockResolvedValue(value);
  mocks.findOneAndUpdate.mockReturnValue({ exec });

  return exec;
};

const filterOf = () => mocks.findOneAndUpdate.mock.calls[0]?.[0] as Record<string, unknown>;
const setOf = () =>
  (mocks.findOneAndUpdate.mock.calls[0]?.[1] as { $set?: Record<string, unknown> })?.$set ?? {};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registering a handset', () => {
  it('upserts keyed on the token alone', async () => {
    // One token is one app install. Keying on anything else creates a second live row for the
    // same phone.
    mockUpdate();

    await registerPushDevice({ organizationId, userId, token: 'tok-a', platform: 'android' });

    expect(filterOf()).toEqual({ token: 'tok-a' });
    expect(mocks.findOneAndUpdate.mock.calls[0]?.[2]).toMatchObject({ upsert: true });
  });

  it('REASSIGNS the handset when a different user signs in on it', async () => {
    // The same phone, a new login. The reminders that follow must be the new user's - a row
    // left pointing at the previous one would keep delivering their organisation's reminders
    // to a handset that has moved on.
    mockUpdate();

    await registerPushDevice({
      organizationId: 'org-2',
      userId: 'user-2',
      token: 'tok-a',
      platform: 'android',
    });

    expect(setOf()).toMatchObject({ organizationId: 'org-2', userId: 'user-2' });
  });

  it('revives a token that was previously disabled', async () => {
    // A token FCM rejected yesterday and the app presented again today is, by definition,
    // alive.
    mockUpdate();

    await registerPushDevice({ organizationId, userId, token: 'tok-a', platform: 'android' });

    expect(setOf()).toMatchObject({ disabledAt: null, disabledReason: null });
  });

  it('refreshes lastSeenAt', async () => {
    const now = new Date('2026-10-23T10:00:00.000Z');
    mockUpdate();

    await registerPushDevice({
      organizationId,
      userId,
      token: 'tok-a',
      platform: 'android',
      now,
    });

    expect(setOf()).toMatchObject({ lastSeenAt: now });
  });
});

describe('finding a user’s handsets', () => {
  it('is scoped to the organization AND the user', async () => {
    const exec = vi.fn().mockResolvedValue([]);
    const lean = vi.fn().mockReturnValue({ exec });
    const limit = vi.fn().mockReturnValue({ lean });
    const sort = vi.fn().mockReturnValue({ limit });
    mocks.find.mockReturnValue({ sort });

    await findPushDevicesForUser({ organizationId, userId });

    expect(mocks.find).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId, userId }),
    );
  });

  it('excludes handsets FCM has retired', async () => {
    const exec = vi.fn().mockResolvedValue([]);
    const lean = vi.fn().mockReturnValue({ exec });
    const limit = vi.fn().mockReturnValue({ lean });
    const sort = vi.fn().mockReturnValue({ limit });
    mocks.find.mockReturnValue({ sort });

    await findPushDevicesForUser({ organizationId, userId });

    expect(mocks.find).toHaveBeenCalledWith(expect.objectContaining({ disabledAt: null }));
  });
});

describe('removing a handset', () => {
  it('REQUIRES the caller to own it', async () => {
    // The security property of the delete endpoint: the filter pairs the token with the
    // organization and the user, so knowing somebody else's token is not enough to silence
    // their phone.
    mocks.deleteOne.mockReturnValue({ exec: vi.fn().mockResolvedValue({ deletedCount: 1 }) });

    await removePushDevice({ organizationId, userId, token: 'tok-a' });

    expect(mocks.deleteOne).toHaveBeenCalledWith({ organizationId, userId, token: 'tok-a' });
  });

  it('cannot be narrowed to the token alone', async () => {
    mocks.deleteOne.mockReturnValue({ exec: vi.fn().mockResolvedValue({ deletedCount: 0 }) });

    await removePushDevice({ organizationId, userId, token: 'tok-a' });

    const filter = mocks.deleteOne.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(Object.keys(filter).sort()).toEqual(['organizationId', 'token', 'userId']);
  });
});

describe('retiring a dead token', () => {
  it('is keyed on the token alone, deliberately', async () => {
    // This is the DELIVERY path reacting to the transport, not a user acting on their own
    // data. Scoping it to an organization would leave a dead token alive because the caller
    // happened to be sweeping a different one.
    mockUpdate();

    await disablePushDevice({ token: 'tok-a', reason: 'UNREGISTERED' });

    expect(filterOf()).toEqual({ token: 'tok-a' });
  });

  it('records when and why, rather than deleting the row', async () => {
    const now = new Date('2026-10-23T10:00:00.000Z');
    mockUpdate();

    await disablePushDevice({ token: 'tok-a', reason: 'UNREGISTERED', now });

    expect(setOf()).toMatchObject({ disabledAt: now, disabledReason: 'UNREGISTERED' });
  });

  it('truncates an over-long reason', async () => {
    mockUpdate();

    await disablePushDevice({ token: 'tok-a', reason: 'x'.repeat(900) });

    expect((setOf().disabledReason as string).length).toBe(300);
  });
});
