/**
 * Looking up who a reminder is about.
 *
 * THE RISK THIS FILE GUARDS. This module puts a customer's phone number into a message. Getting
 * the wrong one is not a cosmetic bug - it is the owner ringing the wrong person about somebody
 * else's wedding, and it is the reason the lookup is keyed on the reminder's own conversation
 * id and scoped to its organization rather than matched on a name. Two leads called "Rahul" is
 * not a hypothetical.
 *
 * The second theme is that none of this may be load-bearing. A reminder that fires thin beats
 * one that does not fire, so every failure path here returns what it has and carries on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const { describeRequirement, formatPhone, loadReminderLeadContext, truncate } = await import(
  './reminder-lead-context.js'
);

const silentLogger = { error: vi.fn() };

const createHarness = ({
  conversation = {} as Record<string, unknown> | null,
  pii = { phone: '919876543210' } as Record<string, unknown> | null,
} = {}) => {
  const findConversationById = vi.fn(
    async (_params?: { conversationId?: unknown; organizationId?: unknown }) =>
      conversation === null
        ? null
        : { displayName: 'Rahul', contactId: 'contact-1', ...conversation },
  );
  const findContactPii = vi.fn(
    async (_params?: { contactId?: unknown; organizationId?: unknown }) => pii,
  );

  const load = (task: Record<string, unknown> = {}) =>
    loadReminderLeadContext(
      { organizationId: 'org-1', conversationId: 'conv-1', ...task } as never,
      {
        findConversationById: findConversationById as never,
        findContactPii: findContactPii as never,
        logger: silentLogger,
      },
    );

  return { load, findConversationById, findContactPii };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the lookup can never fetch the wrong customer', () => {
  it('reads the conversation the reminder was created for, by id', async () => {
    const h = createHarness();

    await h.load({ conversationId: 'conv-42' });

    // By ID, never by name. A name match is how one reminder ends up carrying another
    // customer's number.
    expect(h.findConversationById).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-42' }),
    );
  });

  it('scopes both reads to the reminder\'s own organization', async () => {
    const h = createHarness();

    await h.load({ organizationId: 'org-7' });

    expect(h.findConversationById).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-7' }),
    );
    expect(h.findContactPii).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-7' }),
    );
  });

  it('takes the phone from the contact on THAT conversation', async () => {
    const h = createHarness({ conversation: { contactId: 'contact-99' } });

    await h.load();

    expect(h.findContactPii).toHaveBeenCalledWith(
      expect.objectContaining({ contactId: 'contact-99' }),
    );
  });

  it('asks for no contact at all when the conversation has none', async () => {
    const h = createHarness({ conversation: { contactId: null } });

    const context = await h.load();

    expect(h.findContactPii).not.toHaveBeenCalled();
    expect(context.phone).toBeNull();
  });
});

describe('a personal reminder gets nothing', () => {
  it('returns empty context and touches no database', async () => {
    const h = createHarness();

    const context = await h.load({ conversationId: null });

    // No conversation means no customer. Inventing one is the failure mode here.
    expect(context).toEqual({ displayName: null, phone: null, requirement: null });
    expect(h.findConversationById).not.toHaveBeenCalled();
    expect(h.findContactPii).not.toHaveBeenCalled();
  });
});

describe('nothing here may stop a reminder firing', () => {
  it('survives a conversation that no longer exists', async () => {
    const h = createHarness({ conversation: null });

    await expect(h.load()).resolves.toEqual({
      displayName: null,
      phone: null,
      requirement: null,
    });
  });

  it('survives the conversation lookup throwing', async () => {
    const h = createHarness();
    h.findConversationById.mockRejectedValue(new Error('mongo down'));

    await expect(h.load()).resolves.toEqual({
      displayName: null,
      phone: null,
      requirement: null,
    });
  });

  it('keeps the name and requirement when only the phone lookup fails', async () => {
    const h = createHarness({ conversation: { summary: 'Wants a wedding shoot' } });
    h.findContactPii.mockRejectedValue(new Error('decrypt failed'));

    const context = await h.load();

    // A contact row that cannot be decrypted must not cost the owner everything else.
    expect(context.displayName).toBe('Rahul');
    expect(context.requirement).toBe('Wants a wedding shoot');
    expect(context.phone).toBeNull();
  });

  it('handles a contact with no stored number', async () => {
    const h = createHarness({ pii: { phone: null } });

    expect((await h.load()).phone).toBeNull();
  });
});

describe('formatPhone', () => {
  it('renders a stored number in international form', () => {
    expect(formatPhone('919876543210')).toBe('+919876543210');
  });

  it.each([
    ['+91 98765 43210', '+919876543210'],
    ['91-98765-43210', '+919876543210'],
  ])('normalises %j', (input, expected) => {
    expect(formatPhone(input)).toBe(expected);
  });

  it.each([null, undefined, '', '12345', 'not a phone', 1234567890])(
    'returns null for %j rather than a mangled string',
    (value) => {
      // The owner taps this to call somebody. Half a number is worse than no number.
      expect(formatPhone(value as never)).toBeNull();
    },
  );

  it('rejects something far too long to be a number', () => {
    expect(formatPhone('1'.repeat(20))).toBeNull();
  });
});

describe('describeRequirement reads what is already known', () => {
  it('prefers the hand-written CRM note', async () => {
    const result = describeRequirement({
      summary: 'Wants a 2BHK in Indiranagar, budget not confirmed',
      aiSummary: { headline: 'Something the model wrote' },
    });

    // A person decided this was worth typing. That outranks anything generated.
    expect(result).toBe('Wants a 2BHK in Indiranagar, budget not confirmed');
  });

  it('falls back to the AI catch-up headline', () => {
    const result = describeRequirement({
      summary: null,
      aiSummary: { headline: 'Wedding photography for 15-16 Oct, Bangalore' },
    });

    expect(result).toBe('Wedding photography for 15-16 Oct, Bangalore');
  });

  it('builds one from the imported form facts', () => {
    // The common case for a lead-ad submission nobody has chatted to yet - exactly the rows
    // that used to arrive with no context at all.
    const result = describeRequirement({
      aiCategory: 'birthday',
      aiFacts: {
        event_type: 'birthday/ private event',
        event_date: '10th Nov',
        city: 'Rajajinagar',
      },
    });

    expect(result).toBe('birthday/ private event — 10th Nov, Rajajinagar');
  });

  it('uses the category when there is no explicit service', () => {
    const result = describeRequirement({
      aiCategory: 'wedding_photography',
      aiFacts: { event_date: '12 Dec' },
    });

    expect(result).toBe('wedding photography — 12 Dec');
  });

  it('ignores the placeholder category', () => {
    const result = describeRequirement({ aiCategory: 'unknown', aiFacts: {} });

    expect(result).toBeNull();
  });

  it('NEVER quotes the conversation preview', () => {
    // THE DEFECT THIS PINS. `lastMessagePreview` holds the last message in either direction -
    // outbound-message.service.ts writes it on every send - and carries no flag saying which.
    // Using it printed our own AI's line back at the owner labelled as the customer's
    // requirement. There is no safe way to read it, so it is not read.
    const result = describeRequirement({
      aiFacts: {},
      lastMessagePreview: 'Yes, we do wedding shoots - which date is it?',
    } as never);

    expect(result).toBeNull();
  });

  it('returns null when nothing at all is known', () => {
    // The caller turns this into "Requirement not yet clear". Guessing what somebody wants is
    // worse than admitting we do not know.
    expect(describeRequirement({ aiFacts: {} })).toBeNull();
    expect(describeRequirement(null)).toBeNull();
  });

  it('truncates a long CRM note', () => {
    const result = describeRequirement({ summary: 'x'.repeat(500) }) ?? '';

    expect(result.length).toBeLessThanOrEqual(180);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('short enough', 50)).toBe('short enough');
  });

  it('collapses runs of whitespace', () => {
    expect(truncate('too    many\n\nspaces', 50)).toBe('too many spaces');
  });

  it('breaks on a word where it can', () => {
    const result = truncate('alpha beta gamma delta epsilon zeta', 20);

    expect(result.endsWith('…')).toBe(true);
    expect(result.length).toBeLessThanOrEqual(20);
  });
});
