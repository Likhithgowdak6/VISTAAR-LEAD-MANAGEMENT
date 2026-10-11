/**
 * Arming the handset's alarms without ever arming one twice.
 *
 * THE FAILURE THIS GUARDS AGAINST. `schedule()` is not defined to replace an already-pending
 * notification with the same id, so the naive loop - sync, then schedule everything returned -
 * stacks alarms. The owner's phone rings once after the first sync, twice after the second,
 * three times after the third. Every test below is ultimately about that: read what is pending,
 * act on the difference, and use `version` to decide what actually changed.
 *
 * The plugin is a double and the clock is fixed, so none of this needs a handset. What it
 * CANNOT cover is whether Android actually delivers on time - that is a device question, and
 * the module's header is honest about it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureReminderChannel,
  notificationIdFor,
  reconcileReminderAlarms,
  requestReminderPermission,
  type DeviceReminder,
} from '../lib/reminder-alarms';

const NOW = new Date('2026-10-11T06:30:00.000Z');

const reminder = (overrides: Partial<DeviceReminder> = {}): DeviceReminder => ({
  id: 'task-1',
  version: 1,
  title: 'Call Rahul',
  dueAt: '2026-10-11T11:30:00.000Z',
  timezone: 'Asia/Kolkata',
  status: 'pending',
  conversationId: 'conv-1',
  schedulable: true,
  ...overrides,
});

const createPlugin = ({
  permission = 'granted',
  pendingIds = [] as number[],
} = {}) => ({
  checkPermissions: vi.fn(async () => ({ display: permission })),
  requestPermissions: vi.fn(async () => ({ display: permission })),
  getPending: vi.fn(async () => ({ notifications: pendingIds.map((id) => ({ id })) })),
  // Argument types spelled out so `.mock.calls` stays typed - vi.fn(async () => …) infers a
  // zero-argument signature and every later inspection of what was passed becomes `never`.
  schedule: vi.fn(
    async (_options: {
      notifications: {
        id: number;
        title: string;
        body: string;
        channelId?: string;
        schedule: { at: Date; allowWhileIdle?: boolean };
        extra: unknown;
      }[];
    }) => undefined,
  ),
  cancel: vi.fn(async (_options: { notifications: { id: number }[] }) => undefined),
  createChannel: vi.fn(async (_options: Record<string, unknown>) => undefined),
});

const run = (
  reminders: DeviceReminder[],
  plugin: ReturnType<typeof createPlugin>,
  armedVersions: Record<string, number> = {},
) =>
  reconcileReminderAlarms(reminders, {
    armedVersions,
    now: NOW,
    plugin: plugin as never,
    platform: () => 'android',
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('notificationIdFor', () => {
  it('is stable for the same reminder', () => {
    // Stability is what lets a later pass find and replace an alarm rather than add one.
    expect(notificationIdFor('68f1a2b3c4d5e6f708192a3b')).toBe(
      notificationIdFor('68f1a2b3c4d5e6f708192a3b'),
    );
  });

  it('differs between reminders', () => {
    expect(notificationIdFor('task-a')).not.toBe(notificationIdFor('task-b'));
  });

  it('stays inside Java\'s signed int range', () => {
    const id = notificationIdFor('68f1a2b3c4d5e6f708192a3b');

    expect(id).toBeGreaterThanOrEqual(0);
    expect(id).toBeLessThan(2_147_483_647);
  });
});

describe('scheduling', () => {
  it('arms a reminder the device has never seen', async () => {
    const plugin = createPlugin();

    const result = await run([reminder()], plugin);

    expect(plugin.schedule).toHaveBeenCalledTimes(1);
    expect(result.scheduled).toEqual(['task-1']);
  });

  it('sends the absolute instant the server resolved, not a re-interpretation', async () => {
    const plugin = createPlugin();

    await run([reminder()], plugin);

    const [[payload]] = plugin.schedule.mock.calls;
    // The server already resolved "5 PM" against the business timezone. The handset must fire
    // at that instant wherever it happens to be.
    expect(payload!.notifications[0]!.schedule.at.toISOString()).toBe('2026-10-11T11:30:00.000Z');
  });

  it('carries the ids a tap needs to open the right lead', async () => {
    const plugin = createPlugin();

    await run([reminder()], plugin);

    const [[payload]] = plugin.schedule.mock.calls;
    expect(payload!.notifications[0]!.extra).toEqual({
      reminderId: 'task-1',
      conversationId: 'conv-1',
    });
  });
});

describe('never arming the same reminder twice', () => {
  it('leaves an unchanged, already-armed reminder completely alone', async () => {
    const id = notificationIdFor('task-1');
    const plugin = createPlugin({ pendingIds: [id] });

    const result = await run([reminder({ version: 3 })], plugin, { 'task-1': 3 });

    // THE CORE ASSERTION. Re-scheduling here is exactly what stacks duplicate alarms.
    expect(plugin.schedule).not.toHaveBeenCalled();
    expect(plugin.cancel).not.toHaveBeenCalled();
    expect(result.armed).toEqual(['task-1']);
  });

  it('is idempotent across repeated syncs', async () => {
    const id = notificationIdFor('task-1');
    const plugin = createPlugin({ pendingIds: [id] });

    await run([reminder({ version: 1 })], plugin, { 'task-1': 1 });
    await run([reminder({ version: 1 })], plugin, { 'task-1': 1 });
    await run([reminder({ version: 1 })], plugin, { 'task-1': 1 });

    expect(plugin.schedule).not.toHaveBeenCalled();
  });

  it('cancels before re-arming when the version rose', async () => {
    const id = notificationIdFor('task-1');
    const plugin = createPlugin({ pendingIds: [id] });

    const result = await run(
      [reminder({ version: 2, dueAt: '2026-10-11T13:30:00.000Z' })],
      plugin,
      { 'task-1': 1 },
    );

    // Cancel-then-schedule, because the plugin does not promise that scheduling an existing id
    // replaces it. Skipping the cancel is how a rescheduled reminder rings at BOTH times.
    expect(plugin.cancel).toHaveBeenCalledWith({ notifications: [{ id }] });
    expect(plugin.schedule).toHaveBeenCalledTimes(1);
    expect(result.scheduled).toEqual(['task-1']);
  });

  it('arms a reminder the device thinks it has but the OS does not', async () => {
    // Pending is empty - the user cleared the app's data, or the OS dropped it. Trust the OS.
    const plugin = createPlugin({ pendingIds: [] });

    await run([reminder({ version: 1 })], plugin, { 'task-1': 1 });

    expect(plugin.schedule).toHaveBeenCalledTimes(1);
  });
});

describe('cancelling', () => {
  it.each(['cancelled', 'completed'])('cancels a %s reminder that was armed', async (status) => {
    const id = notificationIdFor('task-1');
    const plugin = createPlugin({ pendingIds: [id] });

    const result = await run(
      [reminder({ status, schedulable: false })],
      plugin,
      { 'task-1': 1 },
    );

    // The only way a reminder cancelled on the dashboard stops ringing on the phone.
    expect(plugin.cancel).toHaveBeenCalledWith({ notifications: [{ id }] });
    expect(plugin.schedule).not.toHaveBeenCalled();
    expect(result.cancelled).toEqual(['task-1']);
  });

  it('does not try to cancel something that was never armed', async () => {
    const plugin = createPlugin({ pendingIds: [] });

    const result = await run([reminder({ status: 'cancelled', schedulable: false })], plugin);

    expect(plugin.cancel).not.toHaveBeenCalled();
    expect(result.cancelled).toEqual([]);
  });

  it('never arms a reminder whose time has already passed', async () => {
    const plugin = createPlugin();

    const result = await run(
      [reminder({ dueAt: '2026-10-11T05:00:00.000Z', schedulable: true })],
      plugin,
    );

    // Even if the server said schedulable, a past instant cannot be armed. The backend's
    // WhatsApp sweep is what covers an overdue reminder.
    expect(plugin.schedule).not.toHaveBeenCalled();
    expect(result.scheduled).toEqual([]);
  });

  it('ignores an unparseable due date rather than throwing', async () => {
    const plugin = createPlugin();

    const result = await run([reminder({ dueAt: 'not-a-date' })], plugin);

    expect(plugin.schedule).not.toHaveBeenCalled();
    expect(result.scheduled).toEqual([]);
  });
});

describe('permissions and platform', () => {
  it('does nothing and says why when permission is denied', async () => {
    const plugin = createPlugin({ permission: 'denied' });

    const result = await run([reminder()], plugin);

    // A denied permission must leave the rest of the CRM working, and the caller needs to be
    // able to TELL the owner why their reminders will not ring.
    expect(result.skipped).toBe('permission-denied');
    expect(plugin.schedule).not.toHaveBeenCalled();
  });

  it('does not prompt during a background sync', async () => {
    const plugin = createPlugin({ permission: 'denied' });

    await run([reminder()], plugin);

    // A permission dialog belongs to a deliberate user action, not to a sync.
    expect(plugin.requestPermissions).not.toHaveBeenCalled();
  });

  it('is a no-op in the browser build', async () => {
    const plugin = createPlugin();

    const result = await reconcileReminderAlarms([reminder()], {
      armedVersions: {},
      now: NOW,
      plugin: plugin as never,
      platform: () => 'web',
    });

    // The same dashboard code runs on the web, where local notifications do not exist.
    expect(result.skipped).toBe('unsupported-platform');
    expect(plugin.checkPermissions).not.toHaveBeenCalled();
  });

  it('asks the OS when permission has not been decided yet', async () => {
    const plugin = createPlugin({ permission: 'prompt' });

    const outcome = await requestReminderPermission(plugin as never, () => 'android');

    expect(plugin.requestPermissions).toHaveBeenCalled();
    expect(outcome).toBe('prompt');
  });

  it('does NOT re-ask once the owner has denied it', async () => {
    const plugin = createPlugin({ permission: 'denied' });

    const outcome = await requestReminderPermission(plugin as never, () => 'android');

    // Android resolves a standing denial straight back to denied without showing a dialog, so
    // calling requestPermissions again is a button that visibly does nothing. The UI shows
    // directions to the settings screen instead.
    expect(plugin.requestPermissions).not.toHaveBeenCalled();
    expect(outcome).toBe('denied');
  });

  it('does not re-ask once granted', async () => {
    const plugin = createPlugin({ permission: 'granted' });

    const outcome = await requestReminderPermission(plugin as never, () => 'android');

    expect(plugin.requestPermissions).not.toHaveBeenCalled();
    expect(outcome).toBe('granted');
  });
});

describe('the notification channel', () => {
  it('is created at high importance so reminders make a sound', async () => {
    const plugin = createPlugin();

    await ensureReminderChannel(plugin as never, () => 'android');

    // Android 8+ takes sound and importance from the CHANNEL, and channel settings are
    // immutable once the user has seen them - a channel created at default importance can
    // never be made audible later.
    expect(plugin.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'vistaar-reminders', importance: 4 }),
    );
  });

  it('is skipped off Android', async () => {
    const plugin = createPlugin();

    const created = await ensureReminderChannel(plugin as never, () => 'web');

    expect(created).toBe(false);
    expect(plugin.createChannel).not.toHaveBeenCalled();
  });
});

describe('a mixed batch', () => {
  it('arms, re-arms and cancels in one pass', async () => {
    const armedId = notificationIdFor('keep');
    const staleId = notificationIdFor('moved');
    const deadId = notificationIdFor('gone');
    const plugin = createPlugin({ pendingIds: [armedId, staleId, deadId] });

    const result = await run(
      [
        reminder({ id: 'keep', version: 1 }),
        reminder({ id: 'moved', version: 2, dueAt: '2026-10-11T14:00:00.000Z' }),
        reminder({ id: 'gone', status: 'cancelled', schedulable: false }),
        reminder({ id: 'new', version: 1 }),
      ],
      plugin,
      { keep: 1, moved: 1, gone: 1 },
    );

    expect(result.scheduled.sort()).toEqual(['moved', 'new']);
    expect(result.cancelled).toEqual(['gone']);
    expect(result.armed.sort()).toEqual(['keep', 'moved', 'new']);
  });
});
