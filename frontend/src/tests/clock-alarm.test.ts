/**
 * Handing reminders to the phone's Clock app.
 *
 * THE 24-HOUR BOUNDARY IS WHAT THESE TESTS ARE FOR. ACTION_SET_ALARM takes an hour and a minute
 * and fires at the NEXT occurrence of that time - it has no idea what day anything is. Inside a
 * day, "the next 14:20" and "the 14:20 this reminder is for" are the same instant and everything
 * is fine. A day or more out they are not, and the owner gets woken for a call that is not until
 * tomorrow. Nothing about that failure is visible in the code at the call site, so it is pinned
 * here instead.
 *
 * The second thing guarded here is creating twice. The platform offers no way to read back or
 * delete a Clock alarm, so a duplicate is permanent: two alarms for one reminder, and the owner
 * cannot tell which is the real one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CLOCK_ALARM_WINDOW_MS,
  syncClockAlarms,
  withinClockWindow,
  type ClockAlarmReminder,
} from '../lib/clock-alarm';

const NOW = new Date('2026-10-12T09:00:00.000Z');

const reminder = (overrides: Partial<ClockAlarmReminder> = {}): ClockAlarmReminder => ({
  id: 'task-1',
  title: 'Call Rahul',
  // Four hours out, comfortably inside the window.
  dueAt: new Date(NOW.getTime() + 4 * 60 * 60 * 1000).toISOString(),
  status: 'pending',
  schedulable: true,
  ...overrides,
});

const createPlugin = ({ available = true } = {}) => ({
  isAvailable: vi.fn(async () => ({ available })),
  set: vi.fn(
    async (_options: { hour: number; minute: number; label: string; skipUi?: boolean }) => ({
      created: true,
    }),
  ),
});

const run = (
  reminders: ClockAlarmReminder[],
  plugin: ReturnType<typeof createPlugin>,
  created: Record<string, true> = {},
) =>
  syncClockAlarms(reminders, {
    created,
    now: NOW,
    plugin: plugin as never,
    platform: () => 'android',
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the 24-hour window', () => {
  it('accepts a reminder inside the next day', () => {
    expect(withinClockWindow(new Date(NOW.getTime() + 60_000), NOW)).toBe(true);
  });

  it('rejects one exactly 24 hours out', () => {
    // THE BOUNDARY. At exactly 24 hours the hour:minute is the SAME as right now, so the Clock
    // app would ring immediately instead of tomorrow.
    expect(withinClockWindow(new Date(NOW.getTime() + CLOCK_ALARM_WINDOW_MS), NOW)).toBe(false);
  });

  it('rejects one just inside 24 hours from the far side', () => {
    expect(
      withinClockWindow(new Date(NOW.getTime() + CLOCK_ALARM_WINDOW_MS - 60_000), NOW),
    ).toBe(true);
  });

  it('rejects anything already past', () => {
    expect(withinClockWindow(new Date(NOW.getTime() - 1), NOW)).toBe(false);
  });
});

describe('creating alarms', () => {
  it('sends the local hour and minute of the due time', async () => {
    const plugin = createPlugin();
    const due = new Date(NOW.getTime() + 4 * 60 * 60 * 1000);

    await run([reminder()], plugin);

    // Local, not UTC: the Clock app schedules in the phone's own wall-clock time, so sending UTC
    // hours would be wrong by the timezone offset - five and a half hours, in Bangalore.
    expect(plugin.set).toHaveBeenCalledWith(
      expect.objectContaining({ hour: due.getHours(), minute: due.getMinutes() }),
    );
  });

  it('labels the alarm with the reminder, so it is identifiable in the Clock list', async () => {
    const plugin = createPlugin();

    await run([reminder({ title: 'Call the venue back' })], plugin);

    expect(plugin.set).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'Call the venue back' }),
    );
  });

  it('asks the clock app not to show its own screen', async () => {
    const plugin = createPlugin();

    await run([reminder()], plugin);

    expect(plugin.set).toHaveBeenCalledWith(expect.objectContaining({ skipUi: true }));
  });

  it('does not create one for a reminder more than a day out', async () => {
    const plugin = createPlugin();
    const far = new Date(NOW.getTime() + 36 * 60 * 60 * 1000).toISOString();

    const result = await run([reminder({ dueAt: far })], plugin);

    // This is the one that would ring a day early. It gets its alarm on a later sync.
    expect(plugin.set).not.toHaveBeenCalled();
    expect(result.remaining).toBe(1);
  });

  it('creates one for the same reminder once it comes inside the window', async () => {
    const plugin = createPlugin();
    const soon = new Date(NOW.getTime() + 2 * 60 * 60 * 1000).toISOString();

    const result = await run([reminder({ dueAt: soon })], plugin);

    expect(plugin.set).toHaveBeenCalledTimes(1);
    expect(result.created).toEqual(['task-1']);
    expect(result.remaining).toBe(0);
  });

  it('ignores an overdue reminder', async () => {
    const plugin = createPlugin();
    const past = new Date(NOW.getTime() - 60_000).toISOString();

    const result = await run([reminder({ dueAt: past })], plugin);

    // The backend's WhatsApp sweep is what covers an overdue reminder; an alarm for a time
    // already gone would ring 24 hours late.
    expect(plugin.set).not.toHaveBeenCalled();
    expect(result.remaining).toBe(0);
  });

  it.each(['completed', 'cancelled'])('ignores a %s reminder', async (status) => {
    const plugin = createPlugin();

    await run([reminder({ status, schedulable: false })], plugin);

    expect(plugin.set).not.toHaveBeenCalled();
  });

  it('ignores an unparseable due date rather than throwing', async () => {
    const plugin = createPlugin();

    const result = await run([reminder({ dueAt: 'not-a-date' })], plugin);

    expect(plugin.set).not.toHaveBeenCalled();
    expect(result.created).toEqual([]);
  });
});

describe('never creating two alarms for one reminder', () => {
  it('skips a reminder that already has one', async () => {
    const plugin = createPlugin();

    const result = await run([reminder()], plugin, { 'task-1': true });

    // THE CORE ASSERTION. A Clock alarm cannot be read back or deleted, so a duplicate is
    // permanent and the owner is rung twice with no way to tell which is current.
    expect(plugin.set).not.toHaveBeenCalled();
    expect(result.created).toEqual([]);
  });

  it('is idempotent across repeated syncs', async () => {
    const plugin = createPlugin();
    const created: Record<string, true> = {};

    for (let pass = 0; pass < 3; pass += 1) {
      // eslint-disable-next-line no-await-in-loop
      const result = await run([reminder()], plugin, created);
      result.created.forEach((id) => {
        created[id] = true;
      });
    }

    expect(plugin.set).toHaveBeenCalledTimes(1);
  });

  it('does not create a second alarm after a reschedule', async () => {
    const plugin = createPlugin();
    const moved = new Date(NOW.getTime() + 6 * 60 * 60 * 1000).toISOString();

    // Deliberate: the original alarm cannot be removed, so creating one for the new time would
    // leave the owner with two. Keyed on id alone rather than id+version for exactly this.
    const result = await run([reminder({ dueAt: moved })], plugin, { 'task-1': true });

    expect(plugin.set).not.toHaveBeenCalled();
    expect(result.created).toEqual([]);
  });
});

describe('when the Clock app cannot be used', () => {
  it('reports a handset with no clock app rather than failing', async () => {
    const plugin = createPlugin({ available: false });

    const result = await run([reminder()], plugin);

    expect(result.skipped).toBe('no-clock-app');
    expect(plugin.set).not.toHaveBeenCalled();
  });

  it('treats an unregistered plugin as no clock app', async () => {
    const plugin = createPlugin();
    plugin.isAvailable.mockRejectedValue(new Error('not implemented'));

    // An older install of the app, or a build where `cap sync` was not run. The notification
    // path is unaffected, so this must not throw.
    const result = await run([reminder()], plugin);

    expect(result.skipped).toBe('no-clock-app');
  });

  it('is a no-op in the browser build', async () => {
    const plugin = createPlugin();

    const result = await syncClockAlarms([reminder()], {
      created: {},
      now: NOW,
      plugin: plugin as never,
      platform: () => 'web',
    });

    expect(result.skipped).toBe('unsupported-platform');
    expect(plugin.isAvailable).not.toHaveBeenCalled();
  });

  it('lets the others through when one alarm is refused', async () => {
    const plugin = createPlugin();
    plugin.set.mockRejectedValueOnce(new Error('clock app said no'));

    const result = await run([reminder({ id: 'a' }), reminder({ id: 'b' })], plugin);

    // The refused one is left out of `created`, so the next sync tries it again rather than
    // recording an alarm that was never made.
    expect(result.created).toEqual(['b']);
  });

  it('does not even ask the plugin when there is nothing to create', async () => {
    const plugin = createPlugin();

    await run([reminder()], plugin, { 'task-1': true });

    // Asking would be a pointless bridge round trip on every single sync.
    expect(plugin.isAvailable).not.toHaveBeenCalled();
  });
});
