/**
 * The hook that keeps a handset's alarms in step with the server.
 *
 * What is worth asserting here is lifecycle, not scheduling - reconciliation already has its
 * own tests. The failures this guards against are the ones that only show up on a real phone
 * being picked up and put down all day:
 *
 *  - two syncs overlapping and both arming the same alarm;
 *  - a visibility listener added on every render until twenty of them fire at once;
 *  - syncing for the PREVIOUS owner after a logout;
 *  - a dead network throwing out of a background effect.
 *
 * Capacitor is mocked at the module boundary, the way the rest of this suite mocks the API.
 */
import { act, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  syncReminders: vi.fn(),
  reconcileReminderAlarms: vi.fn(),
  ensureReminderChannel: vi.fn(),
  checkReminderPermission: vi.fn(),
  requestReminderPermission: vi.fn(),
  checkExactAlarmSetting: vi.fn(),
  requestExactAlarmSetting: vi.fn(),
  addListener: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('../api/endpoints', () => ({
  syncReminders: mocks.syncReminders,
}));

vi.mock('../lib/reminder-alarms', () => ({
  reconcileReminderAlarms: mocks.reconcileReminderAlarms,
  ensureReminderChannel: mocks.ensureReminderChannel,
  checkReminderPermission: mocks.checkReminderPermission,
  requestReminderPermission: mocks.requestReminderPermission,
  // Exact alarms are a SECOND permission, read alongside the first on startup and on resume.
  // Leaving these out of the mock makes the startup chain reject on an undefined call, which
  // surfaces as every lifecycle test failing at once rather than as anything about alarms.
  checkExactAlarmSetting: mocks.checkExactAlarmSetting,
  requestExactAlarmSetting: mocks.requestExactAlarmSetting,
}));

vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    addListener: mocks.addListener,
  },
}));

const { useReminderAlarms } = await import('../hooks/useReminderAlarms');

const reminder = (overrides: Record<string, unknown> = {}) => ({
  id: 'task-1',
  version: 1,
  title: 'Call Rahul',
  dueAt: '2026-10-12T11:30:00.000Z',
  timezone: 'Asia/Kolkata',
  status: 'pending',
  conversationId: 'conv-1',
  schedulable: true,
  ...overrides,
});

const Harness = ({
  enabled = true,
  onOpenReminder,
  onReady,
}: {
  enabled?: boolean;
  onOpenReminder?: (t: { reminderId: string; conversationId: string | null }) => void;
  /** Hands the hook's own return value out, for tests that need to call into it. */
  onReady?: (value: ReturnType<typeof useReminderAlarms>) => void;
}) => {
  const value = useReminderAlarms({
    authedRequest: (makeRequest) => makeRequest('token-1'),
    enabled,
    onOpenReminder,
  });

  onReady?.(value);

  return null;
};

/** Fires the notification-tap listener the hook registered. */
const tapNotification = (extra: unknown) => {
  const entry = mocks.addListener.mock.calls.find(
    ([event]) => event === 'localNotificationActionPerformed',
  );
  const handler = entry?.[1] as ((action: unknown) => void) | undefined;

  handler?.({ notification: { extra } });
};

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mocks.syncReminders.mockResolvedValue({
    data: { reminders: [reminder()], syncedAt: '2026-10-11T06:30:00.000Z' },
  });
  mocks.reconcileReminderAlarms.mockResolvedValue({
    scheduled: ['task-1'],
    cancelled: [],
    armed: ['task-1'],
    skipped: null,
  });
  mocks.ensureReminderChannel.mockResolvedValue(true);
  mocks.checkReminderPermission.mockResolvedValue('granted');
  mocks.requestReminderPermission.mockResolvedValue('granted');
  mocks.checkExactAlarmSetting.mockResolvedValue('granted');
  mocks.requestExactAlarmSetting.mockResolvedValue('granted');
  mocks.addListener.mockResolvedValue({ remove: mocks.removeListener });
});

describe('startup', () => {
  it('creates the channel and syncs once', async () => {
    render(<Harness />);

    await waitFor(() => expect(mocks.syncReminders).toHaveBeenCalledTimes(1));
    expect(mocks.ensureReminderChannel).toHaveBeenCalledTimes(1);
    expect(mocks.reconcileReminderAlarms).toHaveBeenCalledTimes(1);
  });

  it('does not sync while signed out', async () => {
    render(<Harness enabled={false} />);

    await act(async () => {
      await Promise.resolve();
    });

    // Nothing for a previous owner after a logout, and nothing before a login.
    expect(mocks.syncReminders).not.toHaveBeenCalled();
    expect(mocks.ensureReminderChannel).not.toHaveBeenCalled();
  });

  it('remembers what it armed, so the next pass can tell changed from unchanged', async () => {
    render(<Harness />);

    await waitFor(() => expect(mocks.reconcileReminderAlarms).toHaveBeenCalled());

    expect(window.localStorage.getItem('vistaar.reminders.armed')).toContain('task-1');
    expect(window.localStorage.getItem('vistaar.reminders.syncedAt')).toContain('2026-10-11');
  });

  it('passes the stored cursor back for an incremental pull', async () => {
    window.localStorage.setItem(
      'vistaar.reminders.syncedAt',
      JSON.stringify('2026-10-01T00:00:00.000Z'),
    );

    render(<Harness />);

    await waitFor(() =>
      expect(mocks.syncReminders).toHaveBeenCalledWith(
        expect.objectContaining({ since: '2026-10-01T00:00:00.000Z' }),
      ),
    );
  });
});

describe('resume', () => {
  it('syncs again when the app becomes visible', async () => {
    render(<Harness />);
    await waitFor(() => expect(mocks.syncReminders).toHaveBeenCalledTimes(1));

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    await waitFor(() => expect(mocks.syncReminders).toHaveBeenCalledTimes(2));
  });

  it('does not stack listeners across re-renders', async () => {
    const { rerender } = render(<Harness />);
    await waitFor(() => expect(mocks.syncReminders).toHaveBeenCalledTimes(1));

    rerender(<Harness />);
    rerender(<Harness />);

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    // One listener, so one extra sync - not one per render.
    await waitFor(() => expect(mocks.syncReminders).toHaveBeenCalledTimes(2));
  });

  it('removes the listener on unmount', async () => {
    const { unmount } = render(<Harness />);
    await waitFor(() => expect(mocks.syncReminders).toHaveBeenCalledTimes(1));

    unmount();

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    expect(mocks.syncReminders).toHaveBeenCalledTimes(1);
  });

  it('does not run two syncs at once', async () => {
    let release: (() => void) | undefined;
    mocks.syncReminders.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ data: { reminders: [], syncedAt: '2026-10-11T06:30:00.000Z' } });
        }),
    );

    render(<Harness />);
    await waitFor(() => expect(mocks.syncReminders).toHaveBeenCalledTimes(1));

    // A resume landing mid-sync must not start a second pass - both would read the same
    // pending list and both would arm the same alarm.
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    expect(mocks.syncReminders).toHaveBeenCalledTimes(1);

    await act(async () => {
      release?.();
      await Promise.resolve();
    });
  });
});

describe('failures are survivable', () => {
  it('swallows an offline sync', async () => {
    mocks.syncReminders.mockRejectedValue(new Error('Failed to fetch'));

    render(<Harness />);

    // Alarms already armed still fire; the next resume tries again. A toast every time a phone
    // goes through a lift would be worse than the problem.
    await waitFor(() => expect(mocks.syncReminders).toHaveBeenCalled());
    expect(mocks.reconcileReminderAlarms).not.toHaveBeenCalled();
  });

  it('retries on the next resume after a failure', async () => {
    mocks.syncReminders.mockRejectedValueOnce(new Error('offline'));

    render(<Harness />);
    await waitFor(() => expect(mocks.syncReminders).toHaveBeenCalledTimes(1));

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });

    await waitFor(() => expect(mocks.reconcileReminderAlarms).toHaveBeenCalled());
  });

  it('does not record anything as armed when permission was denied', async () => {
    mocks.reconcileReminderAlarms.mockResolvedValue({
      scheduled: [],
      cancelled: [],
      armed: [],
      skipped: 'permission-denied',
    });

    render(<Harness />);

    await waitFor(() => expect(mocks.reconcileReminderAlarms).toHaveBeenCalled());
    // Nothing was armed, so nothing is remembered as armed - otherwise a later grant would
    // think the alarms already exist.
    expect(window.localStorage.getItem('vistaar.reminders.armed')).toBeNull();
  });

  it('survives a corrupted local cache', async () => {
    window.localStorage.setItem('vistaar.reminders.armed', '{not json');

    render(<Harness />);

    await waitFor(() => expect(mocks.syncReminders).toHaveBeenCalled());
  });
});

describe('notification taps', () => {
  it('opens the lead for a reminder that has one', async () => {
    const onOpenReminder = vi.fn();
    render(<Harness onOpenReminder={onOpenReminder} />);
    await waitFor(() => expect(mocks.addListener).toHaveBeenCalled());

    tapNotification({ reminderId: 'task-1', conversationId: 'conv-9' });

    expect(onOpenReminder).toHaveBeenCalledWith({
      reminderId: 'task-1',
      conversationId: 'conv-9',
    });
  });

  it('reports a null conversation for a personal reminder', async () => {
    const onOpenReminder = vi.fn();
    render(<Harness onOpenReminder={onOpenReminder} />);
    await waitFor(() => expect(mocks.addListener).toHaveBeenCalled());

    tapNotification({ reminderId: 'task-2', conversationId: null });

    // The shell sends this to the reminders list rather than a dead conversation.
    expect(onOpenReminder).toHaveBeenCalledWith({ reminderId: 'task-2', conversationId: null });
  });

  it('ignores a tap carrying no reminder id', async () => {
    const onOpenReminder = vi.fn();
    render(<Harness onOpenReminder={onOpenReminder} />);
    await waitFor(() => expect(mocks.addListener).toHaveBeenCalled());

    tapNotification(undefined);
    tapNotification({});

    expect(onOpenReminder).not.toHaveBeenCalled();
  });

  it('registers the tap listener exactly once', async () => {
    const { rerender } = render(<Harness />);
    await waitFor(() => expect(mocks.addListener).toHaveBeenCalled());

    rerender(<Harness />);
    rerender(<Harness />);

    const taps = mocks.addListener.mock.calls.filter(
      ([event]) => event === 'localNotificationActionPerformed',
    );
    expect(taps).toHaveLength(1);
  });
});

describe('the exact-alarm setting', () => {
  it('is read on startup alongside the notification permission', async () => {
    render(<Harness />);

    await waitFor(() => expect(mocks.checkExactAlarmSetting).toHaveBeenCalledTimes(1));
  });

  it('is re-read on resume, which is how granting it is ever noticed', async () => {
    render(<Harness />);

    await waitFor(() => expect(mocks.checkExactAlarmSetting).toHaveBeenCalledTimes(1));

    // Granting happens in Android's settings, outside this app. Coming back is the only moment
    // the app can learn it succeeded - without this re-read the screen warns forever.
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => expect(mocks.checkExactAlarmSetting).toHaveBeenCalledTimes(2));
  });

  it('does not sync a second time after opening settings', async () => {
    const seen: { requestExactAlarm?: () => Promise<unknown> } = {};

    render(<Harness onReady={(value) => Object.assign(seen, value)} />);

    await waitFor(() => expect(mocks.syncReminders).toHaveBeenCalledTimes(1));

    await act(async () => {
      await seen.requestExactAlarm?.();
    });

    // The resume listener already re-syncs on the way back. Syncing here too would be a second
    // pass over the same reminders for no gain.
    expect(mocks.syncReminders).toHaveBeenCalledTimes(1);
  });
});
