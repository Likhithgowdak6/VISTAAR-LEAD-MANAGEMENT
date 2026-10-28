/**
 * The links that take somebody from a WhatsApp notification to the record it is about.
 *
 * WHAT THESE GUARD. A notification link is read on a phone, usually in a hurry, and a wrong one
 * fails in ways that are hard to attribute: a `localhost` origin opens nothing, an http origin
 * cannot carry the app's Secure refresh cookie, and a malformed id produces a tap that lands on
 * an error screen reading as "the CRM is broken". So the builder returns NULL rather than
 * guessing, and the callers omit the line.
 *
 * AND NOTHING SENSITIVE TRAVELS IN THE URL. A record id and nothing else - no token, no session,
 * no phone number, no name. The id names a record; it does not authorise reading one.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', FRONTEND_ORIGIN: [] },
}));

const { buildConversationDeepLink, buildReminderDeepLink, resolvePublicAppOrigin } = await import(
  './deep-link.js'
);

const CONVERSATION_ID = '68f1a2b3c4d5e6f708192a3b';
const TASK_ID = '6adf2dd59f91cdd63f09e0f3';

/** A config shaped like `env`, carrying only what the builder reads. */
const config = (origins: string[]) => ({ FRONTEND_ORIGIN: origins }) as never;

const PROD = config(['https://vistaarcrm.duckdns.org', 'https://localhost']);

describe('choosing the public origin', () => {
  it('uses the real https origin, not the Capacitor one', () => {
    // `https://localhost` is in FRONTEND_ORIGIN because the Android WebView runs there. A link
    // to it opens nothing on a phone.
    expect(resolvePublicAppOrigin(PROD)).toBe('https://vistaarcrm.duckdns.org');
  });

  it('skips localhost even when it is listed first', () => {
    expect(resolvePublicAppOrigin(config(['https://localhost', 'https://crm.example.com']))).toBe(
      'https://crm.example.com',
    );
  });

  it.each([['127.0.0.1'], ['0.0.0.0']])('skips %s', (host: string) => {
    expect(resolvePublicAppOrigin(config([`https://${host}`, 'https://crm.example.com']))).toBe(
      'https://crm.example.com',
    );
  });

  it('REFUSES http, which cannot carry the app’s Secure cookie', () => {
    expect(resolvePublicAppOrigin(config(['http://crm.example.com']))).toBeNull();
  });

  it('returns null when nothing qualifies', () => {
    expect(resolvePublicAppOrigin(config([]))).toBeNull();
    expect(resolvePublicAppOrigin(config(['https://localhost']))).toBeNull();
    expect(resolvePublicAppOrigin(config(['not-a-url']))).toBeNull();
  });

  it('strips any path, keeping the origin only', () => {
    expect(resolvePublicAppOrigin(config(['https://crm.example.com/app/']))).toBe(
      'https://crm.example.com',
    );
  });
});

describe('the lead link', () => {
  it('points at the configured origin with the conversation id', () => {
    expect(buildConversationDeepLink(CONVERSATION_ID, { config: PROD })).toBe(
      `https://vistaarcrm.duckdns.org/?conversation=${CONVERSATION_ID}`,
    );
  });

  it('accepts an ObjectId-like object, as the models hand over', () => {
    const objectIdLike = { toString: () => CONVERSATION_ID };

    expect(buildConversationDeepLink(objectIdLike, { config: PROD })).toContain(CONVERSATION_ID);
  });

  it.each([
    ['empty', ''],
    ['null', null],
    ['undefined', undefined],
    ['too short', 'abc'],
    ['not hex', 'zzzzzzzzzzzzzzzzzzzzzzzz'],
    ['a name', 'MD Afjal'],
    ['a phone number', '+919876543210'],
  ])('REFUSES TO BUILD A MISLEADING LINK from %s', (_label: string, value: unknown) => {
    expect(buildConversationDeepLink(value, { config: PROD })).toBeNull();
  });

  it('returns null when no public origin is configured', () => {
    expect(buildConversationDeepLink(CONVERSATION_ID, { config: config([]) })).toBeNull();
  });

  it('CARRIES NOTHING SENSITIVE - an id and nothing else', () => {
    const link = buildConversationDeepLink(CONVERSATION_ID, { config: PROD })!;
    const url = new URL(link);

    expect([...url.searchParams.keys()]).toEqual(['conversation']);
    expect(link).not.toMatch(/token|secret|session|phone|auth/i);
  });
});

describe('the reminder link', () => {
  it('FALLS BACK TO THE CONVERSATION, because no reminder-detail route exists', () => {
    // Reminders render inside the lead panel, reached by opening the thread. RemindersPage.tsx
    // is mounted nowhere outside its own test.
    const link = buildReminderDeepLink(
      { taskId: TASK_ID, conversationId: CONVERSATION_ID },
      { config: PROD },
    );

    expect(link).toBe(
      `https://vistaarcrm.duckdns.org/?conversation=${CONVERSATION_ID}&reminder=${TASK_ID}`,
    );
  });

  it('still opens the lead when the task id is unusable', () => {
    expect(
      buildReminderDeepLink({ taskId: 'nonsense', conversationId: CONVERSATION_ID }, { config: PROD }),
    ).toBe(`https://vistaarcrm.duckdns.org/?conversation=${CONVERSATION_ID}`);
  });

  it('IS NULL FOR A PERSONAL REMINDER, which has no lead to open', () => {
    // Linking one to the inbox root would be a tap that answers nothing.
    expect(buildReminderDeepLink({ taskId: TASK_ID, conversationId: null }, { config: PROD })).toBeNull();
    expect(buildReminderDeepLink({ taskId: TASK_ID }, { config: PROD })).toBeNull();
  });

  it('is null for a deleted or malformed conversation reference', () => {
    expect(
      buildReminderDeepLink({ taskId: TASK_ID, conversationId: 'gone' }, { config: PROD }),
    ).toBeNull();
  });

  it('carries only the two ids', () => {
    const url = new URL(
      buildReminderDeepLink({ taskId: TASK_ID, conversationId: CONVERSATION_ID }, { config: PROD })!,
    );

    expect([...url.searchParams.keys()].sort()).toEqual(['conversation', 'reminder']);
  });
});
