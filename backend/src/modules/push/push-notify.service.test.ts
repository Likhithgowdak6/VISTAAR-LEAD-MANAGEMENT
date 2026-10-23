/**
 * Pushing a due reminder to the owner's handsets.
 *
 * WHY THIS EXISTS. The phone alarm is armed by the APP, through local notifications, on
 * startup and on foreground - so a handset whose owner has not opened Vistaar since the
 * reminder was created never rings. That is what a local notification IS, not a bug in it.
 * Only the OS can wake a closed app, which on Android means FCM.
 *
 * THE RULES THAT MATTER MOST HERE ARE THE ONES ABOUT NOT SENDING, and about not taking the
 * WhatsApp reminder down with it. The WhatsApp channel is the one proven in production; this
 * one is new, talks to a third party, and must be incapable of affecting it.
 *
 * No Firebase, no credentials and no network: the sender is injected everywhere below.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', PUSH_ENABLED: true },
}));

vi.mock('../../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Mocked so the service's OWN default for `markPushed` is observable. Every other test here
// injects a fake, which is exactly how the missing default survived review once already.
const repositoryMocks = vi.hoisted(() => ({ markReminderPushed: vi.fn(async () => null) }));

vi.mock('../followups/followup-task.repository.js', () => ({
  markReminderPushed: repositoryMocks.markReminderPushed,
}));

const { buildPushBody, createPushNotifyService } = await import('./push-notify.service.js');

const organizationId = 'org-1';
const userId = 'owner-1';

const task = (overrides: Record<string, unknown> = {}) => ({
  _id: 'task-1',
  organizationId,
  assignedTo: userId,
  conversationId: 'conv-1',
  title: 'Call Rahul back',
  pushNotifiedAt: null,
  ...overrides,
});

const createHarness = ({
  devices = [{ token: 'tok-a' }, { token: 'tok-b' }],
  usable = true,
}: { devices?: { token: string }[]; usable?: boolean } = {}) => {
  const sendToToken = vi.fn(async (_token: string, _payload: unknown) => ({
    ok: true as const,
    messageId: 'fcm-1' as string | null,
  }));
  const findPushDevicesForUser = vi.fn(async (_p?: Record<string, unknown>) => devices);
  const disablePushDevice = vi.fn(async (_p?: Record<string, unknown>) => null);
  const markPushed = vi.fn(async (_p?: Record<string, unknown>) => null);
  const logger = { info: vi.fn(), error: vi.fn() };

  const service = createPushNotifyService({
    findPushDevicesForUser: findPushDevicesForUser as never,
    disablePushDevice: disablePushDevice as never,
    sender: { sendToToken, usable, report: { enabled: true, configured: usable, missing: [] } } as never,
    markPushed: markPushed as never,
    logger,
  });

  return { service, sendToToken, findPushDevicesForUser, disablePushDevice, markPushed, logger };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('dispatching a due reminder', () => {
  it('pushes every live handset the owner has', async () => {
    const h = createHarness();

    const result = await h.service.notifyReminderDue(task());

    expect(h.sendToToken).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ sent: 2, failed: 0 });
  });

  it('asks only for the devices of the assigned owner, in their organization', async () => {
    // Organisation isolation at the query. A reminder must never push a handset belonging to
    // another tenant, however the task was claimed.
    const h = createHarness();

    await h.service.notifyReminderDue(task());

    expect(h.findPushDevicesForUser).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId, userId }),
    );
  });

  it('carries ids for the tap, and nothing else', async () => {
    const h = createHarness();

    await h.service.notifyReminderDue(task());

    const [, payload] = h.sendToToken.mock.calls[0]!;

    expect((payload as { data: Record<string, string> }).data).toEqual({
      type: 'reminder',
      taskId: 'task-1',
      conversationId: 'conv-1',
    });
  });

  it('stamps the task once at least one handset has heard it', async () => {
    const h = createHarness();

    await h.service.notifyReminderDue(task());

    expect(h.markPushed).toHaveBeenCalledWith(expect.objectContaining({ taskId: 'task-1' }));
  });
});

describe('what a lock screen is allowed to say', () => {
  it('uses a fixed, neutral title', async () => {
    const h = createHarness();

    await h.service.notifyReminderDue(task());

    expect((h.sendToToken.mock.calls[0]![1] as { title: string }).title).toBe('Vistaar reminder');
  });

  it('never carries the lead’s number or message', async () => {
    // The notification is visible to whoever is holding the phone.
    const h = createHarness();

    await h.service.notifyReminderDue(
      task({ title: 'Call Rahul back', conversationId: 'conv-9' }),
    );

    const sent = JSON.stringify(h.sendToToken.mock.calls);

    expect(sent).not.toContain('9876543210');
    expect(sent).not.toContain('wedding');
  });

  it('falls back to a generic line when the reminder has no title', async () => {
    expect(buildPushBody(null)).toBe('A follow-up is due now.');
    expect(buildPushBody('   ')).toBe('A follow-up is due now.');
  });

  it('truncates a long title rather than letting the OS cut it mid-word', async () => {
    const body = buildPushBody('x'.repeat(400));

    expect(body.length).toBeLessThanOrEqual(120);
    expect(body.endsWith('…')).toBe(true);
  });
});

describe('not sending', () => {
  it('does nothing when push is not configured', async () => {
    const h = createHarness({ usable: false });

    const result = await h.service.notifyReminderDue(task());

    expect(h.findPushDevicesForUser).not.toHaveBeenCalled();
    expect(result.skipped).toBe('not_configured');
  });

  it('does nothing when the owner has no registered handset', async () => {
    const h = createHarness({ devices: [] });

    const result = await h.service.notifyReminderDue(task());

    expect(h.sendToToken).not.toHaveBeenCalled();
    expect(result.skipped).toBe('no_devices');
  });

  it('DOES NOT PUSH TWICE for the same reminder', async () => {
    // The idempotency rule. WhatsApp may still be retrying - that is its business and must
    // not cost the owner a second buzz.
    const h = createHarness();

    const result = await h.service.notifyReminderDue(task({ pushNotifiedAt: new Date() }));

    expect(h.sendToToken).not.toHaveBeenCalled();
    expect(result.skipped).toBe('already_pushed');
  });

  it('withholds the stamp when every device failed, so the next sweep retries', async () => {
    const h = createHarness();
    h.sendToToken.mockResolvedValue({ ok: false, deadToken: false, error: 'timeout' } as never);

    const result = await h.service.notifyReminderDue(task());

    expect(result).toMatchObject({ sent: 0, failed: 2 });
    expect(h.markPushed).not.toHaveBeenCalled();
  });
});

describe('dead tokens', () => {
  it('retires a token FCM says is unregistered', async () => {
    const h = createHarness();
    h.sendToToken.mockResolvedValue({
      ok: false,
      deadToken: true,
      error: 'messaging/registration-token-not-registered',
    } as never);

    const result = await h.service.notifyReminderDue(task());

    expect(h.disablePushDevice).toHaveBeenCalledTimes(2);
    expect(result.disabled).toBe(2);
  });

  it('does NOT retire a handset over a transient failure', async () => {
    // A quota error or a 503 is a bad afternoon at Google. Un-registering a team's phones
    // over one is the expensive way to find that out.
    const h = createHarness();
    h.sendToToken.mockResolvedValue({
      ok: false,
      deadToken: false,
      error: 'messaging/server-unavailable',
    } as never);

    await h.service.notifyReminderDue(task());

    expect(h.disablePushDevice).not.toHaveBeenCalled();
  });

  it('keeps pushing the other handsets when one is dead', async () => {
    const h = createHarness();
    h.sendToToken
      .mockResolvedValueOnce({ ok: false, deadToken: true, error: 'UNREGISTERED' } as never)
      .mockResolvedValueOnce({ ok: true, messageId: 'fcm-2' } as never);

    const result = await h.service.notifyReminderDue(task());

    expect(result).toMatchObject({ sent: 1, disabled: 1 });
    expect(h.markPushed).toHaveBeenCalled();
  });
});

describe('it can never take the WhatsApp reminder down with it', () => {
  it('never throws, whatever the transport does', async () => {
    const h = createHarness();
    h.sendToToken.mockRejectedValue(new Error('firebase exploded'));

    await expect(h.service.notifyReminderDueQuietly(task())).resolves.toMatchObject({
      sent: 0,
      failed: 1,
    });
  });

  it('never throws when the device lookup itself fails', async () => {
    const h = createHarness();
    h.findPushDevicesForUser.mockRejectedValue(new Error('mongo blew up'));

    await expect(h.service.notifyReminderDueQuietly(task())).resolves.toBeTruthy();
  });

  it('logs ids only when it fails', async () => {
    const h = createHarness();
    h.findPushDevicesForUser.mockRejectedValue(new Error('mongo blew up'));

    await h.service.notifyReminderDueQuietly(task({ title: 'Call Rahul on 9876543210' }));

    const logged = JSON.stringify(h.logger.error.mock.calls);

    expect(logged).toContain('task-1');
    expect(logged).not.toContain('9876543210');
  });
});


/**
 * The idempotency stamp, through the service's own default rather than an injected fake.
 *
 * THE BUG THIS CAUGHT. `markPushed` was once an optional dependency with no default, so the
 * production service built itself without one: `pushNotifiedAt` was never written, and every
 * WhatsApp retry re-pushed the owner's handset. All eighteen tests above passed, because each
 * of them supplied its own. An optional dependency with no default is a feature that works in
 * tests and nowhere else - so this suite now exercises the wiring, not just the logic.
 */
describe('the default wiring, not the injected one', () => {
  it('stamps pushNotifiedAt through the real repository function', async () => {
    const sendToToken = vi.fn(async (_token: string, _payload: unknown) => ({
      ok: true as const,
      messageId: 'fcm-1' as string | null,
    }));

    // Note what is NOT passed: markPushed.
    const service = createPushNotifyService({
      findPushDevicesForUser: (async () => [{ token: 'tok-a' }]) as never,
      disablePushDevice: (async () => null) as never,
      sender: { sendToToken, usable: true, report: { enabled: true, configured: true, missing: [] } } as never,
      logger: { info: vi.fn(), error: vi.fn() },
    });

    await service.notifyReminderDue(task());

    expect(repositoryMocks.markReminderPushed).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-1' }),
    );
  });

  it('does not stamp when nothing was delivered', async () => {
    repositoryMocks.markReminderPushed.mockClear();

    const service = createPushNotifyService({
      findPushDevicesForUser: (async () => [{ token: 'tok-a' }]) as never,
      disablePushDevice: (async () => null) as never,
      sender: {
        sendToToken: async () => ({ ok: false, deadToken: false, error: 'timeout' }),
        usable: true,
        report: { enabled: true, configured: true, missing: [] },
      } as never,
      logger: { info: vi.fn(), error: vi.fn() },
    });

    await service.notifyReminderDue(task());

    expect(repositoryMocks.markReminderPushed).not.toHaveBeenCalled();
  });
});
