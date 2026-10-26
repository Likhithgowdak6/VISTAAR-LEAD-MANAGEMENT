/**
 * Asking a closed handset to create a real alarm in the phone's Clock app.
 *
 * WHAT MAKES THIS DIFFERENT FROM EVERY OTHER SEND HERE, and what most of these tests are about:
 * the platform can CREATE a Clock alarm and cannot DELETE one. A duplicate reminder push costs
 * a second buzz; a duplicate clock-arm costs an alarm in the owner's Clock app that no code in
 * this system can ever remove. So the claim is taken BEFORE the send, which is the opposite of
 * the reminder push, and losing an alarm to a transient error is deliberately preferred to
 * risking two.
 *
 * THE OTHER HALF IS THE 24-HOUR WINDOW. ACTION_SET_ALARM carries an hour and a minute and no
 * date, so the Clock app rings at the next occurrence of that time. Arm a reminder two days out
 * and it rings tomorrow - a day early, for a call that has not happened. The window is checked
 * in the query AND again per task, and both are pinned below.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createClockAlarmPushService, CLOCK_ALARM_WINDOW_MS } = await import(
  './clock-alarm-push.service.js'
);

const NOW = new Date('2026-10-26T09:00:00.000Z');

const task = (overrides: Record<string, unknown> = {}) => ({
  _id: 'task-1',
  organizationId: 'org-1',
  assignedTo: 'user-1',
  dueAt: new Date(NOW.getTime() + 60 * 60 * 1000),
  title: 'Call Rahul back',
  clockAlarmArmedAt: null,
  ...overrides,
});

const createHarness = ({
  devices = [{ token: 'token-a' }],
  usable = true,
  claimed = true as boolean,
  sendResult = { ok: true, messageId: 'm-1' } as Record<string, unknown>,
  tasks = [] as unknown[],
} = {}) => {
  const sendDataToToken = vi.fn(async (_token: string, _data: Record<string, string>) => sendResult);
  const sendToToken = vi.fn(async () => ({ ok: true, messageId: 'm-1' }));
  const markClockAlarmArmed = vi.fn(async (_params: unknown) => (claimed ? { _id: 'task-1' } : null));
  const disablePushDevice = vi.fn(async (_params: unknown) => undefined);
  const findPushDevicesForUser = vi.fn(async (_params: unknown) => devices);
  const findRemindersNeedingClockAlarm = vi.fn(async (_params: unknown) => tasks);

  const service = createClockAlarmPushService({
    findPushDevicesForUser: findPushDevicesForUser as never,
    disablePushDevice: disablePushDevice as never,
    findRemindersNeedingClockAlarm: findRemindersNeedingClockAlarm as never,
    markClockAlarmArmed: markClockAlarmArmed as never,
    sender: { sendToToken, sendDataToToken, usable, report: { enabled: true, configured: true, missing: [] } } as never,
    now: () => NOW,
  });

  return {
    service,
    sendDataToToken,
    markClockAlarmArmed,
    disablePushDevice,
    findPushDevicesForUser,
    findRemindersNeedingClockAlarm,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the message that reaches a closed phone', () => {
  it('is data-only, so the messaging service runs instead of a notification appearing', async () => {
    const harness = createHarness();

    await harness.service.armOne(task() as never);

    const [, data] = harness.sendDataToToken.mock.calls[0]!;

    expect(data.type).toBe('clock-alarm');
    // A `notification` block would be rendered by the system and handed to the app only on
    // tap - which on a closed phone means the alarm is never created at all.
    expect(data).not.toHaveProperty('notification');
  });

  it('carries the due time as an absolute instant, not an hour and a minute', async () => {
    const harness = createHarness();
    const due = new Date(NOW.getTime() + 3 * 60 * 60 * 1000);

    await harness.service.armOne(task({ dueAt: due }) as never);

    const [, data] = harness.sendDataToToken.mock.calls[0]!;

    // The HANDSET converts to local hour and minute, in its own zone. Sending a pre-computed
    // hour would ring at the wrong moment on a phone that has changed timezone.
    expect(data.dueAtMillis).toBe(String(due.getTime()));
  });

  it('carries the reminder title and nothing else about the lead', async () => {
    const harness = createHarness();

    await harness.service.armOne(task({ title: 'Call Rahul back' }) as never);

    const [, data] = harness.sendDataToToken.mock.calls[0]!;

    expect(data.label).toBe('Call Rahul back');
    expect(Object.keys(data).sort()).toEqual(['dueAtMillis', 'label', 'taskId', 'type']);
  });
});

describe('never creating two alarms for one reminder', () => {
  it('CLAIMS BEFORE IT SENDS', async () => {
    const harness = createHarness();

    await harness.service.armOne(task() as never);

    // The ordering IS the guarantee. Sent-then-stamped would, on a crash in between, re-send
    // on the next sweep and leave a second undeletable alarm in the owner's Clock app.
    const claimOrder = harness.markClockAlarmArmed.mock.invocationCallOrder[0]!;
    const sendOrder = harness.sendDataToToken.mock.invocationCallOrder[0]!;

    expect(claimOrder).toBeLessThan(sendOrder);
  });

  it('sends nothing when another pass already claimed it', async () => {
    const harness = createHarness({ claimed: false });

    const result = await harness.service.armOne(task() as never);

    expect(result.skipped).toBe('already_armed');
    expect(harness.sendDataToToken).not.toHaveBeenCalled();
  });
});

describe('the 24-hour window', () => {
  it('arms a reminder just inside it', async () => {
    const harness = createHarness();
    const due = new Date(NOW.getTime() + CLOCK_ALARM_WINDOW_MS - 60_000);

    const result = await harness.service.armOne(task({ dueAt: due }) as never);

    expect(result.sent).toBe(1);
  });

  it('REFUSES one past it, which would ring a day early', async () => {
    const harness = createHarness();
    const due = new Date(NOW.getTime() + CLOCK_ALARM_WINDOW_MS + 60_000);

    const result = await harness.service.armOne(task({ dueAt: due }) as never);

    expect(result.skipped).toBe('out_of_window');
    expect(harness.sendDataToToken).not.toHaveBeenCalled();
    // And it must stay claimable, so a later sweep arms it once it comes inside the window.
    expect(harness.markClockAlarmArmed).not.toHaveBeenCalled();
  });

  it('refuses one already due, which wants the reminder push instead', async () => {
    const harness = createHarness();

    const result = await harness.service.armOne(
      task({ dueAt: new Date(NOW.getTime() - 1000) }) as never,
    );

    expect(result.skipped).toBe('out_of_window');
    expect(harness.sendDataToToken).not.toHaveBeenCalled();
  });

  it('refuses an unparseable due date rather than arming something wrong', async () => {
    const harness = createHarness();

    const result = await harness.service.armOne(task({ dueAt: new Date('nonsense') }) as never);

    expect(result.skipped).toBe('out_of_window');
    expect(harness.sendDataToToken).not.toHaveBeenCalled();
  });
});

describe('devices', () => {
  it('does not claim a reminder when the owner has no handset registered', async () => {
    const harness = createHarness({ devices: [] });

    const result = await harness.service.armOne(task() as never);

    expect(result.skipped).toBe('no_devices');
    // Unclaimed deliberately: the owner may register a phone before this falls due, and a task
    // stamped against nobody would never be offered again.
    expect(harness.markClockAlarmArmed).not.toHaveBeenCalled();
  });

  it('retires a token FCM has declared dead', async () => {
    const harness = createHarness({
      sendResult: { ok: false, deadToken: true, error: 'messaging/registration-token-not-registered' },
    });

    const result = await harness.service.armOne(task() as never);

    expect(result.disabled).toBe(1);
    expect(harness.disablePushDevice).toHaveBeenCalledTimes(1);
  });

  it('leaves a handset registered after a transient failure', async () => {
    const harness = createHarness({
      sendResult: { ok: false, deadToken: false, error: 'messaging/server-unavailable' },
    });

    const result = await harness.service.armOne(task() as never);

    expect(result.failed).toBe(1);
    expect(harness.disablePushDevice).not.toHaveBeenCalled();
  });
});

describe('when push is not configured', () => {
  it('does nothing at all', async () => {
    const harness = createHarness({ usable: false });

    const result = await harness.service.armOne(task() as never);

    expect(result.skipped).toBe('not_configured');
    expect(harness.markClockAlarmArmed).not.toHaveBeenCalled();
    expect(harness.sendDataToToken).not.toHaveBeenCalled();
  });

  it('does not even query for candidates during a sweep', async () => {
    const harness = createHarness({ usable: false });

    await harness.service.sweepOnce({});

    expect(harness.findRemindersNeedingClockAlarm).not.toHaveBeenCalled();
  });
});

describe('a sweep', () => {
  it('asks for candidates inside the window', async () => {
    const harness = createHarness();

    await harness.service.sweepOnce({});

    expect(harness.findRemindersNeedingClockAlarm).toHaveBeenCalledWith(
      expect.objectContaining({ now: NOW, windowMs: CLOCK_ALARM_WINDOW_MS }),
    );
  });

  it('keeps going when one reminder fails', async () => {
    const harness = createHarness({
      tasks: [task({ _id: 'task-1' }), task({ _id: 'task-2' })],
    });

    harness.markClockAlarmArmed.mockRejectedValueOnce(new Error('mongo blew up'));

    const summary = await harness.service.sweepOnce({});

    // One died, the other still got its alarm. A single bad reminder must not cost the batch.
    expect(summary).toEqual({ considered: 2, armed: 1, failed: 1 });
  });
});
