/**
 * What the Android app is allowed to pull down.
 *
 * THE SECURITY PROPERTY IS THE POINT. Reminders are personal - one owner's "call the bank about
 * the overdraft" must never land on another owner's lock screen. So the assertions below are
 * mostly about what the queries are SCOPED by: organisation and the authenticated user's own
 * id, never anything the device sent. The device supplies a cursor and a list of ids, and even
 * the ids are re-scoped before they are written.
 *
 * The second theme is the four distinct states - persisted, synced, scheduled, WhatsApp-sent -
 * and that syncing never touches the other three.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const { createReminderSyncService } = await import('./reminder-sync.service.js');

const NOW = new Date('2026-10-11T06:30:00.000Z');
const organizationId = 'org-1';
const userId = 'owner-1';

const task = (overrides: Record<string, unknown> = {}) => ({
  _id: 'task-1',
  version: 1,
  title: 'Call Rahul',
  note: null,
  dueAt: new Date('2026-10-11T11:30:00.000Z'),
  timezone: 'Asia/Kolkata',
  status: 'pending',
  conversationId: 'conv-1',
  sourceQuote: 'contact me tomorrow at 5',
  ...overrides,
});

const createHarness = ({ tasks = [task()] }: { tasks?: Record<string, unknown>[] } = {}) => {
  const findRemindersForDeviceSync = vi.fn(async (_p?: Record<string, unknown>) => tasks);
  const markRemindersSynced = vi.fn(async (_p?: Record<string, unknown>) => ({ modifiedCount: 0 }));

  const service = createReminderSyncService({
    findRemindersForDeviceSync: findRemindersForDeviceSync as never,
    markRemindersSynced: markRemindersSynced as never,
    now: () => NOW,
  });

  return { service, findRemindersForDeviceSync, markRemindersSynced };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('owner and organization isolation', () => {
  it('scopes the query by BOTH organisation and the authenticated user', async () => {
    const h = createHarness();

    await h.service.syncRemindersForDevice({ organizationId, userId });

    // Not by anything the device sent - this is what stops one owner reading another's.
    expect(h.findRemindersForDeviceSync).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId, assignedTo: userId }),
    );
  });

  it('re-scopes acknowledged ids before stamping them', async () => {
    const h = createHarness();

    await h.service.syncRemindersForDevice({
      organizationId,
      userId,
      acknowledgedIds: ['task-1', 'someone-elses-task'],
    });

    // The ids come from the device and are therefore untrusted. Scoping the UPDATE by
    // organisation and assignee is what makes a forged id a no-op rather than a write.
    expect(h.markRemindersSynced).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId, assignedTo: userId }),
    );
  });

  it('does not touch anything when the device acknowledges nothing', async () => {
    const h = createHarness();

    await h.service.syncRemindersForDevice({ organizationId, userId, acknowledgedIds: [] });

    expect(h.markRemindersSynced).not.toHaveBeenCalled();
  });
});

describe('what the device receives', () => {
  it('sends the fields a notification needs and nothing more', async () => {
    const h = createHarness();

    const result = await h.service.syncRemindersForDevice({ organizationId, userId });

    expect(result.reminders[0]).toEqual({
      id: 'task-1',
      version: 1,
      title: 'Call Rahul',
      dueAt: '2026-10-11T11:30:00.000Z',
      timezone: 'Asia/Kolkata',
      status: 'pending',
      conversationId: 'conv-1',
      schedulable: true,
    });
  });

  it('never sends the lead\'s own words to the handset', async () => {
    const h = createHarness();

    const result = await h.service.syncRemindersForDevice({ organizationId, userId });

    // sourceQuote is private correspondence and would sit on a lock screen. The title and the
    // conversation link are enough to act on.
    expect(JSON.stringify(result.reminders[0])).not.toContain('contact me tomorrow');
  });

  it('returns a cursor the device passes back next time', async () => {
    const h = createHarness();

    const result = await h.service.syncRemindersForDevice({ organizationId, userId });

    expect(result.syncedAt).toBe(NOW.toISOString());
  });

  it('passes the incremental cursor through', async () => {
    const h = createHarness();
    const since = new Date('2026-10-10T00:00:00.000Z');

    await h.service.syncRemindersForDevice({ organizationId, userId, since });

    expect(h.findRemindersForDeviceSync).toHaveBeenCalledWith(expect.objectContaining({ since }));
  });
});

describe('schedulable tells the device what to arm', () => {
  it('marks a future pending reminder schedulable', async () => {
    const h = createHarness();

    const result = await h.service.syncRemindersForDevice({ organizationId, userId });

    expect(result.reminders[0]!.schedulable).toBe(true);
  });

  it.each(['cancelled', 'completed', 'missed'])(
    'returns a %s reminder but marks it not schedulable',
    async (status) => {
      const h = createHarness({ tasks: [task({ status })] });

      const result = await h.service.syncRemindersForDevice({ organizationId, userId });

      // It MUST still come back: the handset has an alarm armed and can only learn to cancel
      // it from a row that is still returned. Filtering these out is how a cancelled reminder
      // rings anyway.
      expect(result.reminders).toHaveLength(1);
      expect(result.reminders[0]!.schedulable).toBe(false);
    },
  );

  it('marks an overdue reminder not schedulable', async () => {
    const h = createHarness({
      tasks: [task({ dueAt: new Date('2026-10-11T05:00:00.000Z') })],
    });

    const result = await h.service.syncRemindersForDevice({ organizationId, userId });

    // A device cannot arm an alarm for a moment that has passed; the backend's WhatsApp sweep
    // is what covers an overdue reminder.
    expect(result.reminders[0]!.schedulable).toBe(false);
  });

  it('carries the version, which is how the device avoids duplicate alarms', async () => {
    const h = createHarness({ tasks: [task({ version: 7 })] });

    const result = await h.service.syncRemindersForDevice({ organizationId, userId });

    expect(result.reminders[0]!.version).toBe(7);
  });
});

describe('syncing changes nothing else', () => {
  it('does not record WhatsApp or Android DELIVERY, only that a sync happened', async () => {
    const h = createHarness();

    await h.service.syncRemindersForDevice({
      organizationId,
      userId,
      acknowledgedIds: ['task-1'],
    });

    // Four distinct states - persisted, synced, scheduled, WhatsApp-delivered. A device saying
    // "I have it" moves exactly one of them, and `markRemindersSynced` only writes syncedAt.
    expect(h.markRemindersSynced).toHaveBeenCalledTimes(1);
    const [[params]] = h.markRemindersSynced.mock.calls;
    expect(Object.keys(params!)).toEqual(
      expect.arrayContaining(['taskIds', 'organizationId', 'assignedTo']),
    );
  });

  it('copes with an empty result', async () => {
    const h = createHarness({ tasks: [] });

    const result = await h.service.syncRemindersForDevice({ organizationId, userId });

    expect(result.reminders).toEqual([]);
    expect(result.syncedAt).toBe(NOW.toISOString());
  });

  it('falls back to the note when a reminder has no title', async () => {
    const h = createHarness({ tasks: [task({ title: null, note: 'Ring the venue' })] });

    const result = await h.service.syncRemindersForDevice({ organizationId, userId });

    expect(result.reminders[0]!.title).toBe('Ring the venue');
  });

  it('sends a null conversation for a personal reminder', async () => {
    const h = createHarness({ tasks: [task({ conversationId: null })] });

    const result = await h.service.syncRemindersForDevice({ organizationId, userId });

    expect(result.reminders[0]!.conversationId).toBeNull();
  });
});
