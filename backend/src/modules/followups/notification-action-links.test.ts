/**
 * The action links as they actually appear in the two WhatsApp notifications.
 *
 * WHY THIS FILE EXISTS SEPARATELY from deep-link.test.ts: that one proves the builder makes a
 * correct URL, this one proves the URL reaches the message, in a form WhatsApp will linkify,
 * WITHOUT disturbing a single line that was already there. The second half is the risk - these
 * are the messages the owner reads all day, and a reformat is a regression even when the link
 * works.
 *
 * ORDINARY TEXT LINKS, NOT BUTTONS. The provider is Baileys, which sends `{ text }` and nothing
 * else (baileys.provider.ts). Native interactive buttons need the WhatsApp Business Cloud API,
 * approved templates and different credentials. These tests assert a bare https URL on its own
 * line, which is what WhatsApp clients turn into a tap - they do not assert a button, because
 * there is no button.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    FRONTEND_ORIGIN: ['https://vistaarcrm.duckdns.org', 'https://localhost'],
  },
}));

vi.mock('../../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { buildReminderMessage } = await import('./reminder-message.js');
const { buildNewLeadAlertText } = await import('../ai-brain/new-lead-alert.service.js');

const CONVERSATION_ID = '68f1a2b3c4d5e6f708192a3b';
const TASK_ID = '6adf2dd59f91cdd63f09e0f3';
const ORIGIN = 'https://vistaarcrm.duckdns.org';

const task = (overrides: Record<string, unknown> = {}) =>
  ({
    _id: TASK_ID,
    conversationId: CONVERSATION_ID,
    title: 'Follow-up call',
    note: null,
    sourceQuote: null,
    dueAt: new Date('2026-10-28T09:00:00.000Z'),
    timezone: 'Asia/Kolkata',
    ...overrides,
  }) as never;

const lead = { displayName: 'Vaishu', phone: '+919876543210', requirement: 'Wedding shoot' };

describe('the reminder notification', () => {
  it('carries a tappable link to the lead', () => {
    const text = buildReminderMessage(task(), { lead });

    expect(text).toContain(`View reminder: ${ORIGIN}/?conversation=${CONVERSATION_ID}`);
  });

  it('puts the URL on its own line, which is what WhatsApp linkifies', () => {
    const text = buildReminderMessage(task(), { lead });
    const line = text.split('\n').find((l) => l.startsWith('View reminder:'));

    expect(line).toBe(`View reminder: ${ORIGIN}/?conversation=${CONVERSATION_ID}&reminder=${TASK_ID}`);
  });

  it('KEEPS EVERY EXISTING LINE INTACT', () => {
    // The link is additive. If any of these moved or vanished, the change broke the message the
    // owner actually reads rather than extending it.
    const text = buildReminderMessage(task({ sourceQuote: 'call me after 5' }), { lead });

    expect(text).toContain('⏰ *Lead Follow-up Reminder*');
    expect(text).toContain('👤 Lead: Vaishu');
    expect(text).toContain('📞 Phone: +919876543210');
    expect(text).toContain('📌 Requirement: Wedding shoot');
    expect(text).toContain('✅ Task: Follow-up call');
    expect(text).toContain('💬 Reason: "call me after 5"');
    expect(text).toContain('🕒 Reminder Time:');
  });

  it('FALLS BACK TO THE OLD CLOSING LINE for a personal reminder', () => {
    // No lead, so no destination. The message keeps the sentence it has always ended with
    // rather than gaining a link that goes nowhere.
    const text = buildReminderMessage(task({ conversationId: null }), {});

    expect(text).toContain('⏰ *Personal Reminder*');
    expect(text).not.toContain('View reminder:');
  });

  it('falls back when the conversation reference is unusable', () => {
    const text = buildReminderMessage(task({ conversationId: 'deleted' }), { lead });

    expect(text).not.toContain('View reminder:');
    expect(text).toContain('Open Vistaar CRM to continue the conversation.');
  });

  it('NEVER PUTS THE LEAD’S PHONE OR NAME IN THE URL', () => {
    const text = buildReminderMessage(task(), { lead });
    const url = new URL(text.split('\n').find((l) => l.startsWith('View reminder:'))!.slice(16));

    expect([...url.searchParams.keys()].sort()).toEqual(['conversation', 'reminder']);
    expect(url.href).not.toContain('919876543210');
    expect(url.href).not.toContain('Vaishu');
  });
});

describe('the new lead alert', () => {
  it('carries a tappable link to the lead', () => {
    const text = buildNewLeadAlertText({
      leadDisplayName: 'MD Afjal',
      sourceLabel: 'Instagram Lead Ads',
      conversationId: CONVERSATION_ID,
    });

    expect(text).toContain(`View lead: ${ORIGIN}/?conversation=${CONVERSATION_ID}`);
  });

  it('KEEPS THE EXISTING ALERT CONTENT INTACT', () => {
    const text = buildNewLeadAlertText({
      leadDisplayName: 'MD Afjal',
      phone: '+919876543210',
      sourceLabel: 'Instagram Lead Ads',
      conversationId: CONVERSATION_ID,
    });

    expect(text.split('\n')[0]).toBe('🔔 New lead: MD Afjal (+919876543210)');
    expect(text).toContain('Instagram Lead Ads');
  });

  it('OMITS THE LINE rather than printing a dead link', () => {
    // An alert with no resolvable id still goes out - losing the notification would be worse
    // than losing the shortcut.
    const text = buildNewLeadAlertText({ leadDisplayName: 'MD Afjal', conversationId: 'nonsense' });

    expect(text).toContain('🔔 New lead: MD Afjal');
    expect(text).not.toContain('View lead:');
  });

  it('omits the line when no conversation is supplied at all', () => {
    // Every existing caller that predates this change passes nothing, and must be unaffected.
    const text = buildNewLeadAlertText({ leadDisplayName: 'MD Afjal' });

    expect(text).not.toContain('View lead:');
    expect(text).not.toContain('undefined');
  });

  it('never puts the lead’s phone in the URL even though the alert shows it', () => {
    const text = buildNewLeadAlertText({
      leadDisplayName: 'MD Afjal',
      phone: '+919876543210',
      conversationId: CONVERSATION_ID,
    });
    const url = new URL(text.split('\n').find((l) => l.startsWith('View lead:'))!.slice(11));

    expect([...url.searchParams.keys()]).toEqual(['conversation']);
    expect(url.href).not.toContain('919876543210');
  });
});

describe('both links', () => {
  it('use https, which the app’s Secure refresh cookie requires', () => {
    const reminder = buildReminderMessage(task(), { lead });
    const alert = buildNewLeadAlertText({
      leadDisplayName: 'MD Afjal',
      conversationId: CONVERSATION_ID,
    });

    expect(reminder).toContain('https://');
    expect(alert).toContain('https://');
    expect(reminder).not.toContain('http://');
    expect(alert).not.toContain('http://');
  });

  it('point at the configured origin, never a development host', () => {
    const alert = buildNewLeadAlertText({
      leadDisplayName: 'MD Afjal',
      conversationId: CONVERSATION_ID,
    });

    expect(alert).toContain(ORIGIN);
    expect(alert).not.toContain('localhost');
  });
});
