/**
 * The FCM transport, and above all what it does when Firebase is NOT configured.
 *
 * A half-configuration - PUSH_ENABLED true, no private key - is the state a deployment will
 * actually be in between someone enabling the flag and someone pasting the service account.
 * It must be inert, must say which variable is missing, and must never throw: its caller is a
 * reminder sweep whose other channel is a WhatsApp message that has to go out regardless.
 *
 * Nothing here loads firebase-admin. `loadMessaging` is injected throughout.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

vi.mock('../../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { createPushSender, describeConfiguration, normalizePrivateKey } = await import(
  './push-sender.service.js'
);
const { PUSH_REMINDER_CHANNEL_ID } = await import('../../constants/push.js');

const config = (overrides: Record<string, unknown> = {}) =>
  ({
    PUSH_ENABLED: true,
    FIREBASE_PROJECT_ID: 'vistaar-test',
    FIREBASE_CLIENT_EMAIL: 'sa@vistaar-test.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
    ...overrides,
  }) as never;

const payload = { title: 'Vistaar reminder', body: 'Call Rahul back', data: { type: 'reminder' } };

/** A messaging handle whose send is observable. */
const messagingWith = (send: ReturnType<typeof vi.fn>) =>
  vi.fn(async () => ({ send })) as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('configuration reporting', () => {
  it('reports a complete configuration as usable', () => {
    const report = describeConfiguration(config());

    expect(report).toEqual({ enabled: true, configured: true, missing: [] });
  });

  it('NAMES the variables that are missing', () => {
    // The whole point: "why is my phone not ringing" should be one log line, not an afternoon.
    const report = describeConfiguration(
      config({ FIREBASE_PRIVATE_KEY: '', FIREBASE_CLIENT_EMAIL: '' }),
    );

    expect(report.configured).toBe(false);
    expect(report.missing).toEqual(['FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY']);
  });

  it('reports the flag separately from the credentials', () => {
    // Switched off with everything configured is a deliberate state, not a mistake, and the
    // two must be distinguishable.
    const report = describeConfiguration(config({ PUSH_ENABLED: false }));

    expect(report).toMatchObject({ enabled: false, configured: true });
  });

  it('never puts a credential VALUE in the report', () => {
    const report = describeConfiguration(config());

    expect(JSON.stringify(report)).not.toContain('BEGIN PRIVATE KEY');
    expect(JSON.stringify(report)).not.toContain('gserviceaccount');
  });
});

describe('when Firebase is not configured', () => {
  it('refuses to send, and says why', async () => {
    const loadMessaging = vi.fn();
    const sender = createPushSender({
      config: config({ FIREBASE_PRIVATE_KEY: '' }),
      loadMessaging: loadMessaging as never,
    });

    const outcome = await sender.sendToToken('tok-a', payload);

    expect(sender.usable).toBe(false);
    expect(outcome.ok).toBe(false);
    expect(outcome).toMatchObject({ error: expect.stringContaining('FIREBASE_PRIVATE_KEY') });
    // NEVER LOADED. A misconfigured deployment must not be reaching for the SDK on every
    // reminder.
    expect(loadMessaging).not.toHaveBeenCalled();
  });

  it('refuses to send when the flag is off, without calling it an error', async () => {
    const sender = createPushSender({
      config: config({ PUSH_ENABLED: false }),
      loadMessaging: vi.fn() as never,
    });

    const outcome = await sender.sendToToken('tok-a', payload);

    expect(outcome).toMatchObject({ ok: false, error: 'push disabled' });
  });

  it('complains once, not once per reminder', async () => {
    const logger = { info: vi.fn(), error: vi.fn() };
    const sender = createPushSender({
      config: config({ FIREBASE_PROJECT_ID: '' }),
      logger,
      loadMessaging: vi.fn() as never,
    });

    await sender.sendToToken('tok-a', payload);
    await sender.sendToToken('tok-b', payload);
    await sender.sendToToken('tok-c', payload);

    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('never throws, so a missing key cannot become a missed WhatsApp reminder', async () => {
    const sender = createPushSender({
      config: config({ FIREBASE_PRIVATE_KEY: '' }),
      loadMessaging: vi.fn() as never,
    });

    await expect(sender.sendToToken('tok-a', payload)).resolves.toBeTruthy();
  });
});

describe('sending', () => {
  const messaging = (send: ReturnType<typeof vi.fn>) => vi.fn(async () => ({ send }));

  it('sends to the token and returns the message id', async () => {
    const send = vi.fn(async (_message: unknown) => 'projects/x/messages/1');
    const sender = createPushSender({ config: config(), loadMessaging: messaging(send) as never });

    const outcome = await sender.sendToToken('tok-a', payload);

    expect(outcome).toEqual({ ok: true, messageId: 'projects/x/messages/1' });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ token: 'tok-a' }));
  });

  it('sends reminders at high priority on its own channel', async () => {
    // The phone is usually locked when a reminder fires; normal priority is allowed to wait.
    const send = vi.fn(async (_message: unknown) => 'id');
    const sender = createPushSender({ config: config(), loadMessaging: messaging(send) as never });

    await sender.sendToToken('tok-a', payload);

    expect(send.mock.calls[0]![0]).toMatchObject({
      android: {
        priority: 'high',
        notification: { channelId: PUSH_REMINDER_CHANNEL_ID },
      },
    });
  });

  it('builds the SDK handle once, not per message', async () => {
    const send = vi.fn(async (_message: unknown) => 'id');
    const loadMessaging = messaging(send);
    const sender = createPushSender({ config: config(), loadMessaging: loadMessaging as never });

    await sender.sendToToken('tok-a', payload);
    await sender.sendToToken('tok-b', payload);

    expect(loadMessaging).toHaveBeenCalledTimes(1);
  });
});

describe('classifying failures', () => {
  const failingWith = (code: string) =>
    vi.fn(async () => ({
      send: vi.fn(async () => {
        throw Object.assign(new Error('nope'), { code });
      }),
    }));

  it('marks an unregistered token as dead', async () => {
    const sender = createPushSender({
      config: config(),
      loadMessaging: failingWith('messaging/registration-token-not-registered') as never,
    });

    expect(await sender.sendToToken('tok-a', payload)).toMatchObject({
      ok: false,
      deadToken: true,
    });
  });

  it('does NOT mark a server error as dead', async () => {
    const sender = createPushSender({
      config: config(),
      loadMessaging: failingWith('messaging/server-unavailable') as never,
    });

    expect(await sender.sendToToken('tok-a', payload)).toMatchObject({
      ok: false,
      deadToken: false,
    });
  });

  it('does not throw when the SDK itself fails to load', async () => {
    const sender = createPushSender({
      config: config(),
      loadMessaging: vi.fn(async () => {
        throw new Error('firebase-admin is not installed');
      }) as never,
    });

    await expect(sender.sendToToken('tok-a', payload)).resolves.toMatchObject({ ok: false });
  });
});

describe('the private key', () => {
  it('unescapes newlines, which every secret store escapes', () => {
    // Without this the PEM is one line and the failure is an opaque crypto error a long way
    // from the cause.
    expect(normalizePrivateKey('a\\nb\\nc')).toBe('a\nb\nc');
  });

  it('leaves a key that already has real newlines alone', () => {
    expect(normalizePrivateKey('a\nb')).toBe('a\nb');
  });
});

/**
 * The notification channel, which is the whole difference between a chime and an alarm.
 *
 * WHY THIS NEEDS TESTS AT ALL. Sending to a channel id that does not exist on the handset is
 * NOT an error: Android falls back to the app's default channel and the notification arrives,
 * just quietly. So a typo here produces a push that works, looks fine in every log, and simply
 * never wakes anybody - the hardest kind of bug to notice. The id is a named constant with a
 * test on each side for that reason.
 *
 * The matching assertions live in frontend/src/tests/reminder-alarms.test.ts and in
 * ReminderChannel.java; this is one of three copies of one string, in three languages.
 */
describe('the reminder channel', () => {
  it('is the alarm-stream channel, not the old notification one', async () => {
    const send = vi.fn(async (_message: unknown) => 'id');
    const sender = createPushSender({ config: config(), loadMessaging: messagingWith(send) });

    await sender.sendToToken('tok-a', payload);

    expect(send.mock.calls[0]![0]).toMatchObject({
      android: { notification: { channelId: 'vistaar-reminders-alarm' } },
    });
  });

  it('uses the shared constant rather than a literal', () => {
    // A literal in the sender is how the three copies drift apart.
    expect(PUSH_REMINDER_CHANNEL_ID).toBe('vistaar-reminders-alarm');
  });

  it('is NOT the pre-alarm id, which is immutable on handsets that already have it', () => {
    // Re-creating `vistaar-reminders` with better settings is silently ignored by Android, so
    // reverting to it would ship a change that does nothing.
    expect(PUSH_REMINDER_CHANNEL_ID).not.toBe('vistaar-reminders');
  });
});

/**
 * The silent message that reaches a closed phone.
 *
 * THE DISTINCTION THESE PIN, and it is the whole reason the method exists: a message carrying
 * a `notification` block is rendered by the system and handed to the app only when the owner
 * taps it. A data-only message is delivered to the app's FirebaseMessagingService instead,
 * which is the only code path that exists on a phone whose owner has not opened Vistaar. Add a
 * notification block here and the Clock alarm is never created - the thing it was sent to do.
 */
describe('data-only sends', () => {
  it('carries NO notification block, so the app is woken rather than the owner', async () => {
    const send = vi.fn(async (_message: unknown) => 'id');
    const sender = createPushSender({ config: config(), loadMessaging: messagingWith(send) });

    await sender.sendDataToToken('tok-a', { type: 'clock-alarm', dueAtMillis: '123' });

    const message = send.mock.calls[0]![0] as Record<string, unknown>;

    expect(message).not.toHaveProperty('notification');
    expect(message.data).toEqual({ type: 'clock-alarm', dueAtMillis: '123' });
  });

  it('is high priority, or Doze holds it until after the alarm should have rung', async () => {
    const send = vi.fn(async (_message: unknown) => 'id');
    const sender = createPushSender({ config: config(), loadMessaging: messagingWith(send) });

    await sender.sendDataToToken('tok-a', { type: 'clock-alarm' });

    expect(send.mock.calls[0]![0]).toMatchObject({ android: { priority: 'high' } });
  });

  it('reports a dead token the same way the notification path does', async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error('gone'), {
        code: 'messaging/registration-token-not-registered',
      });
    });
    const sender = createPushSender({ config: config(), loadMessaging: messagingWith(send) });

    const outcome = await sender.sendDataToToken('tok-a', { type: 'clock-alarm' });

    expect(outcome).toMatchObject({ ok: false, deadToken: true });
  });

  it('never throws when Firebase is not configured', async () => {
    const sender = createPushSender({ config: config({ FIREBASE_PRIVATE_KEY: '' }) });

    const outcome = await sender.sendDataToToken('tok-a', { type: 'clock-alarm' });

    expect(outcome.ok).toBe(false);
    expect((outcome as { error: string }).error).toContain('FIREBASE_PRIVATE_KEY');
  });
});
