/**
 * The reminder as the owner reads it on their phone.
 *
 * THE COMPLAINT THIS ANSWERS. The notification said "Task: Check if they messaged you back" and
 * nothing else that mattered - not who, not their number, not what they wanted. An hour later
 * that is a riddle: the owner has to open the CRM, find the thread and read it back before they
 * can do the one thing the reminder was for. Every assertion below is about a field that turns
 * the message into something you can act on from the notification shade.
 *
 * Until now this file did not exist, which is why rewriting the whole format broke no tests.
 *
 * THE TWO SHAPES ARE TESTED SEPARATELY ON PURPOSE. A lead follow-up must name a customer; a
 * personal reminder must never invent one. Those are opposite failures and a single fixture
 * would hide one of them.
 */
import { describe, expect, it } from 'vitest';

import { buildReminderMessage, formatReminderTime } from './reminder-message.js';

/** Noon IST on 11 October 2026, so "today"/"tomorrow" are stable. */
const NOW = new Date('2026-10-11T06:30:00.000Z');

const leadTask = (overrides: Record<string, unknown> = {}) =>
  ({
    _id: 'task-1',
    organizationId: 'org-1',
    whatsappAccountId: 'account-1',
    conversationId: 'conv-1',
    status: 'pending',
    dueAt: new Date('2026-10-11T11:30:00.000Z'),
    title: 'Check whether the customer has sent the details',
    note: null,
    timezone: 'Asia/Kolkata',
    source: 'lead_commitment',
    sourceQuote: 'I will message you after 5 min',
    ...overrides,
  }) as never;

const personalTask = (overrides: Record<string, unknown> = {}) =>
  ({
    _id: 'task-2',
    organizationId: 'org-1',
    whatsappAccountId: null,
    conversationId: null,
    status: 'pending',
    dueAt: new Date('2026-10-11T11:30:00.000Z'),
    title: 'Review the campaign',
    note: null,
    timezone: 'Asia/Kolkata',
    source: 'manual',
    sourceQuote: null,
    ...overrides,
  }) as never;

const lead = {
  displayName: 'Rahul',
  phone: '+919876543210',
  requirement: 'Looking for wedding photography; needs to confirm the shoot details.',
};

const render = (task: never, leadContext: unknown = lead) =>
  buildReminderMessage(task, { now: NOW, lead: leadContext as never });

describe('a lead follow-up names the customer', () => {
  it('carries the name, the number, the requirement, the task and the reason', () => {
    const message = render(leadTask());

    expect(message).toContain('👤 Lead: Rahul');
    expect(message).toContain('📞 Phone: +919876543210');
    expect(message).toContain(
      '📌 Requirement: Looking for wedding photography; needs to confirm the shoot details.',
    );
    expect(message).toContain('✅ Task: Check whether the customer has sent the details');
    expect(message).toContain('💬 Reason: "I will message you after 5 min"');
    expect(message).toContain('🕒 Reminder Time: 5:00 PM today');
  });

  it('keeps the customer\'s own words as the reason, not the task description', () => {
    const message = render(
      leadTask({
        title: 'Check if they messaged you back',
        sourceQuote: 'I will message you after 5 min',
      }),
    );

    // THE SPECIFIC COMPLAINT. The generic task told the owner nothing; the quote is what makes
    // the ping make sense. Both appear, and the quote is not overwritten by the task.
    expect(message).toContain('✅ Task: Check if they messaged you back');
    expect(message).toContain('💬 Reason: "I will message you after 5 min"');
  });

  it('says "Unknown customer" rather than leaving a blank', () => {
    const message = render(leadTask(), { ...lead, displayName: null });

    // A missing name must read as "we never learned it", not as a broken message.
    expect(message).toContain('👤 Lead: Unknown customer');
  });

  it.each([null, undefined, '   '])('treats %j as an unknown name', (displayName) => {
    expect(render(leadTask(), { ...lead, displayName })).toContain('👤 Lead: Unknown customer');
  });

  it('omits the phone line entirely when there is no number', () => {
    const message = render(leadTask(), { ...lead, phone: null });

    // Not "Phone: -" and not "Phone: unknown". The owner taps that line to call somebody, and
    // a placeholder is a wasted tap. Everything else still renders.
    expect(message).not.toContain('📞');
    expect(message).toContain('👤 Lead: Rahul');
    expect(message).toContain('📌 Requirement:');
  });

  it('says the requirement is not yet clear rather than inventing one', () => {
    const message = render(leadTask(), { ...lead, requirement: null });

    expect(message).toContain('📌 Requirement: Requirement not yet clear');
  });

  it('renders with no lead context at all', () => {
    // The lookup failed, or the conversation was deleted. The reminder must still fire and
    // still be readable - being late is the one thing it may not be.
    const message = render(leadTask(), null);

    expect(message).toContain('⏰ *Lead Follow-up Reminder*');
    expect(message).toContain('👤 Lead: Unknown customer');
    expect(message).toContain('📌 Requirement: Requirement not yet clear');
    expect(message).toContain('🕒 Reminder Time: 5:00 PM today');
  });

  it('omits the reason when the reminder has no quote behind it', () => {
    const message = render(leadTask({ sourceQuote: null }));

    expect(message).not.toContain('💬');
    expect(message).toContain('✅ Task:');
  });

  it('falls back to the note, then to "Follow up", for the task line', () => {
    expect(render(leadTask({ title: null, note: 'Ring them back' }))).toContain(
      '✅ Task: Ring them back',
    );
    expect(render(leadTask({ title: null, note: null }))).toContain('✅ Task: Follow up');
  });
});

describe('long text is cut, not wrapped into a wall', () => {
  it('truncates a rambling quote', () => {
    const rambling = `I will message you after five minutes ${'because '.repeat(60)}okay`;

    const message = render(leadTask({ sourceQuote: rambling }));
    const reasonLine = message.split('\n').find((line) => line.startsWith('💬')) ?? '';

    // A reminder nobody reads is a reminder that did not work.
    expect(reasonLine.length).toBeLessThan(230);
    expect(reasonLine).toContain('…');
  });

  it('collapses newlines in a quote so one line stays one line', () => {
    const message = render(leadTask({ sourceQuote: 'call me\n\nafter 5 min' }));

    expect(message).toContain('💬 Reason: "call me after 5 min"');
  });

  it('leaves a short quote exactly as it was said', () => {
    const message = render(leadTask({ sourceQuote: 'call me at 4 pm' }));

    expect(message).toContain('💬 Reason: "call me at 4 pm"');
    expect(message).not.toContain('…');
  });
});

describe('a personal reminder has no customer and must not invent one', () => {
  it('names no lead, no phone and no requirement', () => {
    const message = buildReminderMessage(personalTask(), { now: NOW, lead: null });

    expect(message).toContain('⏰ *Personal Reminder*');
    expect(message).toContain('✅ Task: Review the campaign');
    expect(message).toContain('🕒 Reminder Time: 5:00 PM today');
    expect(message).not.toContain('👤');
    expect(message).not.toContain('📞');
    expect(message).not.toContain('📌');
  });

  it('refuses lead details even if a caller passes them', () => {
    // Belt and braces: a personal reminder is identified by having no conversation, and no
    // amount of context handed in may attach a customer to it.
    const message = buildReminderMessage(personalTask(), { now: NOW, lead });

    expect(message).not.toContain('Rahul');
    expect(message).not.toContain('+919876543210');
  });

  it('still shows the reason when the owner gave one', () => {
    // An owner-command reminder - "remind me to call the bank after 2 hours" - carries their
    // own words, and those are as worth keeping as a lead's.
    const message = buildReminderMessage(
      personalTask({ sourceQuote: 'remind me to call the bank after 2 hours' }),
      { now: NOW, lead: null },
    );

    expect(message).toContain('💬 Reason: "remind me to call the bank after 2 hours"');
  });
});

describe('the time is the one the lead asked for', () => {
  it('formats in the reminder\'s own timezone, not the server\'s', () => {
    expect(formatReminderTime(new Date('2026-10-11T11:30:00.000Z'), 'Asia/Kolkata')).toBe(
      '5:00 PM',
    );
  });

  it('says tomorrow when it is tomorrow', () => {
    const message = render(leadTask({ dueAt: new Date('2026-10-12T04:30:00.000Z') }));

    expect(message).toContain('🕒 Reminder Time: 10:00 AM tomorrow');
  });
});
