/**
 * The lead-import leg of the test-number allowlist.
 *
 * Inbound WhatsApp has refused messages from numbers that are not on
 * `WHATSAPP_TEST_ALLOWED_NUMBERS` since the gate existed; a Google Sheet or a Meta form used to
 * walk straight past it and create contacts and conversations for anyone. These tests pin the
 * gate to the same matcher, in the same direction (fail closed), before anything is written.
 *
 * Everything is injected, so nothing here touches a database.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', WHATSAPP_TEST_ALLOWED_NUMBERS: '' },
}));

const { createLeadPipeline } = await import('./lead-pipeline.service.js');

type LeadSourceArg = Parameters<ReturnType<typeof createLeadPipeline>['importLead']>[0]['leadSource'];
type LeadArg = Parameters<ReturnType<typeof createLeadPipeline>['importLead']>[0]['lead'];
type PipelineOptions = Parameters<typeof createLeadPipeline>[0];

const ORG_ID = '65b0f0f0f0f0f0f0f0f0f0f1';
const ACCOUNT_ID = '65b0f0f0f0f0f0f0f0f0f0f0';
const SOURCE_ID = '65b0f0f0f0f0f0f0f0f0f0f2';

/** The owner's one test number, and a number that is emphatically not it. */
const ALLOWED_PHONE = '918183003081';
const BLOCKED_PHONE = '919876500011';

const leadSource = {
  _id: SOURCE_ID,
  organizationId: ORG_ID,
  whatsappAccountId: ACCOUNT_ID,
  name: 'Wedding enquiries',
  defaultCountryCode: '91',
  aiContextEnabled: false,
  importFromTime: new Date(0),
} as unknown as LeadSourceArg;

const makeLead = (phone: string, externalId = 'row-1'): LeadArg =>
  ({
    externalId,
    submittedAt: new Date('2026-01-01T00:00:00.000Z'),
    displayName: 'Riya',
    fullName: 'Riya',
    phone,
    email: null,
    inboxUrl: null,
    leadStatus: null,
    platform: 'fb',
    isOrganic: false,
    campaignId: null,
    campaignName: null,
    adId: null,
    adName: null,
    adsetId: null,
    adsetName: null,
    formId: null,
    formName: null,
    customFields: [],
    canonicalFacts: {},
    category: 'unknown',
    raw: {},
  }) as unknown as LeadArg;

const buildHarness = (allowedNumbers: string) => {
  const findOrCreateContactByProviderKey = vi.fn(async () => ({
    contact: { _id: 'contact-1', leadId: 'L-0001', displayName: 'Riya' },
    created: true,
  }));
  const upsertConversationForContact = vi.fn(async () => ({
    _id: 'conversation-1',
    whatsappAccountId: ACCOUNT_ID,
    displayName: 'Riya',
    assignedTo: null,
  }));
  const createLeadSubmission = vi.fn(async () => ({}));
  const logger = { warn: vi.fn(), error: vi.fn() };

  const options = {
    config: {
      WHATSAPP_TEST_ALLOWED_NUMBERS: allowedNumbers,
      LEAD_IMPORT_MAX_ROWS_PER_TICK: 200,
    },
    contactRepository: {
      findOrCreateContactByProviderKey,
      attachContactPhoneIfMissing: vi.fn(async () => null),
      attachContactEmailIfMissing: vi.fn(async () => null),
    },
    conversationRepository: {
      upsertConversationForContact,
      touchConversation: vi.fn(async () => null),
      mergeConversationAiContext: vi.fn(async () => null),
    },
    leadSubmissionRepository: {
      createLeadSubmission,
      findImportedExternalIds: vi.fn(async () => new Set<string>()),
      countLeadSubmissionsForConversation: vi.fn(async () => 0),
    },
    createActivity: vi.fn(async () => ({})),
    sendNewLeadAlert: vi.fn(async () => undefined),
    recomputeLeadScore: vi.fn(async () => undefined),
    publishEvent: vi.fn(async () => undefined),
    computeContactProviderKeyFromPhone: vi.fn((phone: unknown) => `key:${String(phone)}`),
    normalizePhoneNumber: vi.fn((phone: unknown) => {
      const digits = String(phone ?? '').replace(/\D/g, '');

      return digits === '' ? null : digits;
    }),
    logger,
  } as unknown as PipelineOptions;

  return {
    pipeline: createLeadPipeline(options),
    findOrCreateContactByProviderKey,
    upsertConversationForContact,
    createLeadSubmission,
    logger,
  };
};

describe('lead import: the test-number allowlist', () => {
  it('refuses a lead whose phone is not allowed, before any contact or conversation exists', async () => {
    const harness = buildHarness(ALLOWED_PHONE);

    const outcome = await harness.pipeline.importLead({
      leadSource,
      lead: makeLead(BLOCKED_PHONE),
    });

    expect(outcome).toBe('skipped');
    expect(harness.findOrCreateContactByProviderKey).not.toHaveBeenCalled();
    expect(harness.upsertConversationForContact).not.toHaveBeenCalled();
  });

  it('imports a lead whose phone is on the allowlist, exactly as before', async () => {
    const harness = buildHarness(ALLOWED_PHONE);

    const outcome = await harness.pipeline.importLead({
      leadSource,
      lead: makeLead(ALLOWED_PHONE),
    });

    expect(outcome).toBe('imported');
    expect(harness.findOrCreateContactByProviderKey).toHaveBeenCalledTimes(1);
    expect(harness.upsertConversationForContact).toHaveBeenCalledTimes(1);
  });

  it('is unrestricted when WHATSAPP_TEST_ALLOWED_NUMBERS is empty, which is production', async () => {
    const harness = buildHarness('');

    await expect(
      harness.pipeline.importLead({ leadSource, lead: makeLead(BLOCKED_PHONE) }),
    ).resolves.toBe('imported');
  });

  it('reuses the shared matcher, so a saved local number still matches the delivered one', async () => {
    // '8183003081' saved without the country code must match the '918183003081' on the row -
    // the trailing-digit rule lives in allowlist.ts and is not reimplemented here.
    const harness = buildHarness('8183003081');

    await expect(
      harness.pipeline.importLead({ leadSource, lead: makeLead('918183003081') }),
    ).resolves.toBe('imported');
  });

  it('fails closed: a row with no readable phone is refused rather than let through', async () => {
    const harness = buildHarness(ALLOWED_PHONE);

    // No phone at all is already a skip; the point here is that it is never an import.
    await expect(harness.pipeline.importLead({ leadSource, lead: makeLead('') })).resolves.toBe(
      'skipped',
    );
    expect(harness.findOrCreateContactByProviderKey).not.toHaveBeenCalled();
  });

  it('logs the refusal, masked, and never silently', async () => {
    const harness = buildHarness(ALLOWED_PHONE);

    await harness.pipeline.importLead({ leadSource, lead: makeLead(BLOCKED_PHONE) });

    expect(harness.logger.warn).toHaveBeenCalledTimes(1);

    const [context, message] = harness.logger.warn.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];

    expect(String(message)).toContain('WHATSAPP_TEST_ALLOWED_NUMBERS');
    expect(context.phone).toBe('919***011');
    expect(JSON.stringify(context)).not.toContain(BLOCKED_PHONE);
  });

  it('writes nothing to the import ledger, so the lead arrives once the gate is lifted', async () => {
    const gated = buildHarness(ALLOWED_PHONE);

    await gated.pipeline.importLead({ leadSource, lead: makeLead(BLOCKED_PHONE) });

    // A ledger row would mark the lead processed forever - `findImportedExternalIds` matches on
    // any status - so clearing the allowlist for production would leave it unimported for good.
    expect(gated.createLeadSubmission).not.toHaveBeenCalled();

    const cleared = buildHarness('');

    await expect(
      cleared.pipeline.importLead({ leadSource, lead: makeLead(BLOCKED_PHONE) }),
    ).resolves.toBe('imported');
    expect(cleared.createLeadSubmission).toHaveBeenCalledTimes(1);
  });

  it('counts a refusal as skipped, not as a duplicate and not as a failure', async () => {
    const harness = buildHarness(ALLOWED_PHONE);

    const { counts } = await harness.pipeline.importLeads({
      leadSource,
      leads: [makeLead(ALLOWED_PHONE, 'row-1'), makeLead(BLOCKED_PHONE, 'row-2')],
    });

    // `failed` would flip the source's badge to FAILED and write a lastError, and this is not a
    // failure - it is the gate doing its job. `duplicates` would claim the lead is already in
    // the CRM, which is the opposite of true.
    expect(counts).toEqual({ imported: 1, duplicates: 0, skipped: 1, failed: 0 });
  });
});
