/**
 * The FCM transport. The only thing in this codebase that talks to Firebase.
 *
 * FAILS SAFELY AND SAYS WHAT IS MISSING. Push is off by default, and a half-configuration -
 * `PUSH_ENABLED=true` with no private key - is a misconfiguration, not a reason to crash the
 * server or to retry forever against nothing. `describeConfiguration()` names the absent
 * variables so the answer to "why is my phone not ringing" is one log line rather than an
 * afternoon.
 *
 * NOTHING HERE DECIDES WHETHER TO SEND. It is handed a token and a payload and reports what
 * happened. Whether a reminder deserves a push, whether it has already been pushed, and what
 * a dead token means are all the caller's business - see push-notify.service.ts.
 *
 * THE CREDENTIALS NEVER LEAVE THE SERVER. Three environment variables, read here, never
 * logged, never serialised, never returned by an API. The APK contains `google-services.json`,
 * which is a client identifier and carries no authority to send.
 */
import { env, type Env } from '../../config/env.js';
import { logger as defaultLogger } from '../../config/logger.js';
import { PUSH_DEAD_TOKEN_CODES } from '../../constants/push.js';

export interface PushPayload {
  title: string;
  body: string;
  /**
   * Opaque key/value pairs the app reads on tap. Strings only - FCM's own constraint - and
   * never anything about a lead beyond the ids needed to navigate.
   */
  data: Record<string, string>;
}

export type PushSendOutcome =
  | { ok: true; messageId: string | null }
  | { ok: false; deadToken: true; error: string }
  | { ok: false; deadToken: false; error: string };

export interface PushConfigurationReport {
  enabled: boolean;
  configured: boolean;
  /** Names only. Never values. */
  missing: string[];
}

/** Which required values are absent, by name. */
export const describeConfiguration = (config: Env = env): PushConfigurationReport => {
  const missing: string[] = [];

  if (!config.FIREBASE_PROJECT_ID) {
    missing.push('FIREBASE_PROJECT_ID');
  }

  if (!config.FIREBASE_CLIENT_EMAIL) {
    missing.push('FIREBASE_CLIENT_EMAIL');
  }

  if (!config.FIREBASE_PRIVATE_KEY) {
    missing.push('FIREBASE_PRIVATE_KEY');
  }

  return {
    enabled: config.PUSH_ENABLED === true,
    configured: missing.length === 0,
    missing,
  };
};

/**
 * Secret stores and `.env` files both hand back a PEM with its newlines escaped. Firebase
 * needs them real, and the failure if they are not is an opaque crypto error a long way from
 * here.
 */
export const normalizePrivateKey = (raw: string): string => raw.replace(/\\n/g, '\n');

type FirebaseMessaging = {
  send: (message: unknown) => Promise<string>;
};

export interface CreatePushSenderOptions {
  config?: Env;
  logger?: { info?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
  /**
   * The Firebase messaging handle. Injected so every test in this codebase runs without the
   * SDK, without credentials and without a network - and so the dependency is loaded lazily,
   * at first use, rather than at import time on a server that may never push.
   */
  loadMessaging?: (config: Env) => Promise<FirebaseMessaging>;
}

/**
 * Builds the handle lazily via `firebase-admin`, which is an optional dependency in practice:
 * a deployment with push switched off never reaches this line.
 */
const defaultLoadMessaging = async (config: Env): Promise<FirebaseMessaging> => {
  // Modular subpath imports, and dynamic so a deployment with push switched off never loads
  // the SDK at all. Named `vistaar-push` rather than using the default app: initialising the
  // default twice throws, and this process may one day hold another Firebase client.
  const { cert, getApps, initializeApp } = await import('firebase-admin/app');
  const { getMessaging } = await import('firebase-admin/messaging');

  const app =
    getApps().find((candidate) => candidate.name === 'vistaar-push') ??
    initializeApp(
      {
        credential: cert({
          projectId: config.FIREBASE_PROJECT_ID,
          clientEmail: config.FIREBASE_CLIENT_EMAIL,
          privateKey: normalizePrivateKey(config.FIREBASE_PRIVATE_KEY),
        }),
      },
      'vistaar-push',
    );

  // Cast at the adapter boundary. `FirebaseMessaging` above is deliberately the narrowest
  // shape this module uses, so that every test can supply a two-line fake instead of the
  // SDK's `Message` union; the cast is the one place those two descriptions meet.
  return getMessaging(app) as unknown as FirebaseMessaging;
};

export const createPushSender = ({
  config = env,
  logger = defaultLogger,
  loadMessaging = defaultLoadMessaging,
}: CreatePushSenderOptions = {}) => {
  const report = describeConfiguration(config);
  const usable = report.enabled && report.configured;

  let messaging: FirebaseMessaging | null = null;
  let warned = false;

  const warnOnce = () => {
    if (warned) {
      return;
    }

    warned = true;

    if (!report.enabled) {
      logger?.info?.('Push notifications are switched off (PUSH_ENABLED is false).');

      return;
    }

    logger?.error?.(
      { missing: report.missing },
      'PUSH_ENABLED is true but Firebase is not configured; no push will be sent.',
    );
  };

  /**
   * Sends one notification.
   *
   * NEVER THROWS. Its caller is a reminder sweep whose other channel is a WhatsApp message
   * that must go out regardless - an exception escaping here would turn a missing Firebase key
   * into a missed reminder.
   */
  const sendToToken = async (token: string, payload: PushPayload): Promise<PushSendOutcome> => {
    if (!usable) {
      warnOnce();

      return {
        ok: false,
        deadToken: false,
        error: report.enabled ? `firebase not configured: ${report.missing.join(', ')}` : 'push disabled',
      };
    }

    try {
      messaging ??= await loadMessaging(config);

      const messageId = await messaging.send({
        token,
        notification: { title: payload.title, body: payload.body },
        data: payload.data,
        android: {
          priority: 'high',
          notification: {
            // A reminder is time-critical and the phone is usually locked when it fires.
            channelId: 'vistaar-reminders',
            sound: 'default',
          },
        },
      });

      return { ok: true, messageId: messageId ?? null };
    } catch (error: unknown) {
      const err = error as { code?: unknown; message?: unknown };
      const code = String(err?.code ?? '');
      const message = String(err?.message ?? err?.code ?? 'push send failed');

      return {
        ok: false,
        // The one distinction that matters: a dead token is retired, everything else is a bad
        // afternoon at Google and must not un-register anybody's phone.
        deadToken: PUSH_DEAD_TOKEN_CODES.some((dead) => code.includes(dead)),
        error: message.slice(0, 300),
      };
    }
  };

  return { sendToToken, usable, report };
};

export type PushSender = ReturnType<typeof createPushSender>;
