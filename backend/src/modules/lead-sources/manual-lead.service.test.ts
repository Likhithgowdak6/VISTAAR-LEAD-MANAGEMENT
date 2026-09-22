/**
 * Exercises adding a lead by hand: phone normalisation into the blind-index format, the allowlist
 * gate refusing before anything is written, duplicate detection ahead of the $setOnInsert upsert,
 * and - the one that matters most - that an opening message is only ever scheduled on an explicit
 * yes. Every collaborator is injected, following this codebase's DI test style; no real Mongo.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { LOG_LEVEL: 'silent', NODE_ENV: 'test' },
}));

const { createManualLeadService, ManualLeadError, MANUAL_CONTACT_SOURCE } = await import(
  './manual-lead.service.js'
);

const NOW = new Date('2026-09-21T10:00:00.000Z');

const createHarness = (overrides: Record<string, unknown> = {}) => {
  const contact = {
    _id: 'contact-1',
    leadId: 'LEAD-20260921-ABC123',
    displayName: 'Priya',
  };

  const conversation = {
    _id: 'conv-1',
    organizationId: 'org-1',
    whatsappAccountId: 'account-1',
    assignedTo: null,
  };

  const findOrCreateContactByProviderKey = vi.fn().mockResolvedValue({ contact, created: true });
  const attachContactPhoneIfMissing = vi.fn().mockResolvedValue(undefined);
  const findConversationByAccountAndContact = vi.fn().mockResolvedValue(null);
  const upsertConversationForContact = vi.fn().mockResolvedValue(conversation);
  const mergeConversationAiContext = vi.fn().mockResolvedValue(undefined);
  const approveManualOutreach = vi.fn().mockResolvedValue(undefined);
  const scheduleAutoGreet = vi.fn().mockResolvedValue(undefined);
  const recomputeLeadScore = vi.fn().mockResolvedValue(undefined);
  const createActivity = vi.fn().mockResolvedValue(undefined);
  const publishConversationChanged = vi.fn().mockResolvedValue(undefined);
  const logger = { warn: vi.fn(), error: vi.fn() };

  const service = createManualLeadService({
    config: {
      WHATSAPP_TEST_ALLOWED_NUMBERS: '',
      MANUAL_LEAD_DEFAULT_COUNTRY_CODE: '91',
      LEAD_AUTO_GREET_DELAY_MS: 300000,
    } as never,
    // The real one hashes through the encryption keyring. The VALUE is irrelevant here - what the
    // tests below actually pin is the phone string it is handed, since that is the thing that has
    // to match what inbound WhatsApp derives.
    computeContactProviderKeyFromPhone: vi.fn((phone: unknown) => `key:${String(phone)}`),
    findOrCreateContactByProviderKey,
    attachContactPhoneIfMissing,
    findConversationByAccountAndContact,
    upsertConversationForContact,
    mergeConversationAiContext,
    approveManualOutreach,
    scheduleAutoGreet,
    recomputeLeadScore,
    createActivity,
    publishConversationChanged,
    logger,
    now: () => NOW,
    ...overrides,
  });

  return {
    service,
    contact,
    conversation,
    findOrCreateContactByProviderKey,
    attachContactPhoneIfMissing,
    findConversationByAccountAndContact,
    upsertConversationForContact,
    mergeConversationAiContext,
    approveManualOutreach,
    scheduleAutoGreet,
    recomputeLeadScore,
    createActivity,
    publishConversationChanged,
    logger,
  };
};

const baseParams = {
  organizationId: 'org-1',
  whatsappAccountId: 'account-1',
  actorId: 'user-1',
  phone: '9876543210',
};

describe('createManualLead — cold outbound is opt-in', () => {
  it('schedules NOTHING when greetNow is not asked for', async () => {
    const { service, scheduleAutoGreet, approveManualOutreach } = createHarness();

    await service.createManualLead(baseParams);

    expect(scheduleAutoGreet).not.toHaveBeenCalled();
    expect(approveManualOutreach).not.toHaveBeenCalled();
  });

  it('defaults to not messaging even when greetNow is omitted entirely', async () => {
    const { service, scheduleAutoGreet } = createHarness();

    await service.createManualLead({ ...baseParams, greetNow: undefined });

    expect(scheduleAutoGreet).not.toHaveBeenCalled();
  });

  it('records the approval AND schedules the greet on an explicit yes', async () => {
    const { service, scheduleAutoGreet, approveManualOutreach } = createHarness();

    await service.createManualLead({ ...baseParams, greetNow: true });

    // Both, not either: the sweep re-reads the approval at send time and refuses without it, so a
    // scheduled greet with no approval would silently never go out.
    expect(approveManualOutreach).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1' }),
    );
    expect(scheduleAutoGreet).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conv-1',
        dueAt: new Date(NOW.getTime() + 300000),
      }),
    );
  });

  it('still saves the lead when scheduling the greet throws', async () => {
    const { service, scheduleAutoGreet, publishConversationChanged } = createHarness();
    scheduleAutoGreet.mockRejectedValue(new Error('mongo is down'));

    const result = await service.createManualLead({ ...baseParams, greetNow: true });

    expect(result.outcome).toBe('created');
    expect(publishConversationChanged).toHaveBeenCalled();
  });
});

describe('createManualLead — phone handling', () => {
  it('prefixes the default country code so the blind index matches inbound WhatsApp', async () => {
    const { service, findOrCreateContactByProviderKey } = createHarness();

    await service.createManualLead(baseParams);

    expect(findOrCreateContactByProviderKey).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: '919876543210',
        providerJids: ['919876543210@s.whatsapp.net'],
        source: MANUAL_CONTACT_SOURCE,
      }),
    );
  });

  it.each([
    ['+91 98765-43210', '919876543210'],
    ['98765 43210', '919876543210'],
    ['919876543210', '919876543210'],
  ])('normalises %s to %s', async (input, expected) => {
    const { service, findOrCreateContactByProviderKey } = createHarness();

    await service.createManualLead({ ...baseParams, phone: input });

    expect(findOrCreateContactByProviderKey).toHaveBeenCalledWith(
      expect.objectContaining({ phone: expected }),
    );
  });

  it('refuses an unreadable number before writing anything', async () => {
    const { service, findOrCreateContactByProviderKey } = createHarness();

    await expect(service.createManualLead({ ...baseParams, phone: '++--' })).rejects.toThrow(
      ManualLeadError,
    );
    expect(findOrCreateContactByProviderKey).not.toHaveBeenCalled();
  });

  it('refuses a number the test allowlist excludes, creating no contact', async () => {
    const { service, findOrCreateContactByProviderKey, upsertConversationForContact } =
      createHarness({
        config: {
          WHATSAPP_TEST_ALLOWED_NUMBERS: '919999999999',
          MANUAL_LEAD_DEFAULT_COUNTRY_CODE: '91',
        } as never,
      });

    await expect(service.createManualLead(baseParams)).rejects.toMatchObject({
      code: 'PHONE_NOT_ALLOWED',
    });
    expect(findOrCreateContactByProviderKey).not.toHaveBeenCalled();
    expect(upsertConversationForContact).not.toHaveBeenCalled();
  });
});

describe('createManualLead — duplicates', () => {
  it('reports an existing conversation instead of silently discarding the form', async () => {
    const existing = { _id: 'conv-existing', organizationId: 'org-1', assignedTo: null };
    const { service, findConversationByAccountAndContact, upsertConversationForContact } =
      createHarness();
    findConversationByAccountAndContact.mockResolvedValue(existing);

    const result = await service.createManualLead({
      ...baseParams,
      aiCategory: 'wedding',
      greetNow: true,
    });

    expect(result.outcome).toBe('existing');
    expect(result.conversation).toBe(existing);
    // The upsert is $setOnInsert-only, so calling it here would return the old row unchanged and
    // report success having written nothing.
    expect(upsertConversationForContact).not.toHaveBeenCalled();
  });

  it('never greets a number that already had a conversation', async () => {
    const { service, findConversationByAccountAndContact, scheduleAutoGreet } = createHarness();
    findConversationByAccountAndContact.mockResolvedValue({ _id: 'conv-existing' });

    await service.createManualLead({ ...baseParams, greetNow: true });

    expect(scheduleAutoGreet).not.toHaveBeenCalled();
  });
});

describe('createManualLead — what the AI is told', () => {
  it('writes the owner-chosen service so the first message asks the right questions', async () => {
    const { service, mergeConversationAiContext } = createHarness();

    await service.createManualLead({ ...baseParams, aiCategory: 'wedding' });

    expect(mergeConversationAiContext).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'wedding' }),
    );
  });

  it('falls back to unknown for a service with no playbook, rather than storing it', async () => {
    const { service, mergeConversationAiContext, createActivity } = createHarness();

    await service.createManualLead({ ...baseParams, aiCategory: 'underwater_basket_weaving' });

    expect(mergeConversationAiContext).not.toHaveBeenCalled();
    expect(createActivity).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ aiCategory: 'unknown' }) }),
    );
  });

  it('puts the event date through aiFacts, the only route that reaches the eventDate column', async () => {
    const { service, mergeConversationAiContext } = createHarness();

    await service.createManualLead({ ...baseParams, eventDate: '12 Dec 2026' });

    expect(mergeConversationAiContext).toHaveBeenCalledWith(
      expect.objectContaining({ facts: { event_date: '12 Dec 2026' } }),
    );
  });

  it('stores the origin note on the conversation for the opening line', async () => {
    const { service, upsertConversationForContact } = createHarness();

    await service.createManualLead({ ...baseParams, originNote: 'met at the wedding expo' });

    expect(upsertConversationForContact).toHaveBeenCalledWith(
      expect.objectContaining({
        defaults: expect.objectContaining({ manualOriginNote: 'met at the wedding expo' }),
      }),
    );
  });

  it('leaves automation on so the AI answers when they reply', async () => {
    const { service, upsertConversationForContact } = createHarness();

    await service.createManualLead(baseParams);

    expect(upsertConversationForContact).toHaveBeenCalledWith(
      expect.objectContaining({
        defaults: expect.objectContaining({ aiAutomationEnabled: true }),
      }),
    );
  });
});
