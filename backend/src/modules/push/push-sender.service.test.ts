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

const config = (overrides: Record<string, unknown> = {}) =>
  ({
    PUSH_ENABLED: true,
    FIREBASE_PROJECT_ID: 'vistaar-test',
    FIREBASE_CLIENT_EMAIL: 'sa@vistaar-test.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
    ...overrides,
  }) as never;

const payload = { title: 'Vistaar reminder', body: 'Call Rahul back', data: { type: 'reminder' } };

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
      android: { priority: 'high', notification: { channelId: 'vistaar-reminders' } },
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
