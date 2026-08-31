/**
 * What happens to a Meta lead-form row after the conversation exists: the canonical facts and
 * the guessed category are merged onto it (but only behind ADR-005's per-source AI toggle), and
 * the owner gets the same 🔔 ping an inbound lead would have triggered.
 *
 * The mapper is NOT stubbed here - the row below goes through the real `mapMetaLeadRow`, because
 * "the sheet's columns end up as facts the AI can read" is the whole feature and stubbing the
 * mapper would test the wiring against an invented shape instead of the real one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', LEAD_IMPORT_MAX_ROWS_PER_TICK: 200 },
}));

const { createLeadImportService } = await import('./lead-import.service.js');
const { mapMetaLeadRow } = await import('./meta-lead.mapper.js');

/** A real-shaped export row: Meta's standard columns plus this business's four questions. */
const SHEET_ROW: Record<string, string> = {
  id: 'l:1234567890',
  created_time: '2026-08-25T09:00:00.000Z',
  full_name: 'Riya Sharma',
  phone_number: 'p:+919876543210',
  email: 'riya@example.com',
  campaign_name: 'House Warming - Aug',
  form_name: 'Event Photography Enquiry',
  'how_would_you_describe_this_event?': 'house_warming',
  event_date: '12 January 2026',
  'location_/_area': 'Indiranagar, Bengaluru',
  'choose_your_candid_&_cinematic_p&v_pacakage': 'only_photography',
};

const createHarness = ({
  aiContextEnabled = true,
}: {
  aiContextEnabled?: boolean;
} = {}) => {
  const conversation = {
    _id: 'conv-1',
    organizationId: 'org-1',
    whatsappAccountId: 'account-1',
    displayName: 'Riya Sharma',
    assignedTo: null,
  };

  const mergeConversationAiContext = vi.fn().mockResolvedValue(conversation);
  const sendNewLeadAlert = vi.fn().mockResolvedValue({ sent: true });
  const recomputeLeadScore = vi.fn().mockResolvedValue(null);
  const createLeadSubmission = vi.fn().mockResolvedValue({ _id: 'sub-1' });
  const logger = { error: vi.fn(), warn: vi.fn() };

  const service = createLeadImportService({
    config: { LEAD_IMPORT_MAX_ROWS_PER_TICK: 200 } as never,
    contactRepository: {
      findOrCreateContactByProviderKey: vi.fn().mockResolvedValue({
        contact: {
          _id: 'contact-1',
          leadId: 'LEAD-20260825-ABC123',
          displayName: 'Riya Sharma',
        },
        created: true,
      }),
      attachContactPhoneIfMissing: vi.fn().mockResolvedValue(undefined),
      attachContactEmailIfMissing: vi.fn().mockResolvedValue(undefined),
    } as never,
    conversationRepository: {
      upsertConversationForContact: vi.fn().mockResolvedValue(conversation),
      touchConversation: vi.fn().mockResolvedValue(conversation),
      mergeConversationAiContext,
    } as never,
    leadSubmissionRepository: {
      createLeadSubmission,
      findImportedExternalIds: vi.fn().mockResolvedValue(new Set<string>()),
      countLeadSubmissionsForConversation: vi.fn().mockResolvedValue(0),
    } as never,
    createActivity: vi.fn().mockResolvedValue(undefined) as never,
    sendNewLeadAlert: sendNewLeadAlert as never,
    recomputeLeadScore: recomputeLeadScore as never,
    publishEvent: vi.fn().mockResolvedValue(undefined),
    computeContactProviderKeyFromPhone: (() => 'provider-key-1') as never,
    normalizePhoneNumber: ((phone: string | null) =>
      phone === null ? null : phone.replace(/\D/g, '')) as never,
    logger,
  });

  const leadSource = {
    _id: 'source-1',
    organizationId: 'org-1',
    whatsappAccountId: 'account-1',
    name: 'Meta - Event Photography',
    defaultCountryCode: '91',
    aiContextEnabled,
  };

  return {
    mergeConversationAiContext,
    recomputeLeadScore,
    sendNewLeadAlert,
    createLeadSubmission,
    logger,
    run: (row: Record<string, string> = SHEET_ROW) =>
      service.importLead({
        leadSource: leadSource as never,
        lead: mapMetaLeadRow({ row }),
      }),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('importLead - canonical facts on the conversation', () => {
  it('merges the form answers and the guessed category when the source opted in', async () => {
    const h = createHarness({ aiContextEnabled: true });

    await expect(h.run()).resolves.toBe('imported');

    expect(h.mergeConversationAiContext).toHaveBeenCalledTimes(1);

    const [call] = h.mergeConversationAiContext.mock.calls as [
      [{ conversationId: string; organizationId: string; facts: Record<string, string>; category: string }],
    ];

    expect(call[0]).toMatchObject({ conversationId: 'conv-1', organizationId: 'org-1' });
    expect(call[0].category).toBe('house_warming');
    expect(call[0].facts).toMatchObject({
      event_type: 'house warming',
      event_date: '12 January 2026',
      city: 'Indiranagar, Bengaluru',
      package_interest: 'only photography',
      // Derived, so the AI does not ask what the package answer already said.
      photo_or_video: 'photography only',
    });
  });

  it('never puts the lead\'s own name, email or phone into the AI\'s facts - ADR-005', async () => {
    const h = createHarness({ aiContextEnabled: true });

    await h.run();

    const facts = (h.mergeConversationAiContext.mock.calls[0]?.[0] as { facts: Record<string, string> })
      .facts;

    expect(facts.name).toBeUndefined();
    expect(facts.email).toBeUndefined();
    expect(facts.phone).toBeUndefined();
  });

  it('rescores the lead off the facts the form just contributed', async () => {
    const h = createHarness({ aiContextEnabled: true });

    await expect(h.run()).resolves.toBe('imported');

    expect(h.recomputeLeadScore).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org-1',
        conversationId: 'conv-1',
        whatsappAccountId: 'account-1',
      }),
    );
    expect(h.mergeConversationAiContext.mock.invocationCallOrder[0]).toBeLessThan(
      h.recomputeLeadScore.mock.invocationCallOrder[0]!,
    );
  });

  it('writes nothing to the conversation when the source has the AI toggle off', async () => {
    const h = createHarness({ aiContextEnabled: false });

    await expect(h.run()).resolves.toBe('imported');

    expect(h.mergeConversationAiContext).not.toHaveBeenCalled();
    // And nothing is scored either: with the toggle off `aiFacts` was never written, so a score
    // computed here would be a number nothing else on the dashboard agrees with.
    expect(h.recomputeLeadScore).not.toHaveBeenCalled();
    // The ledger still records every answer, exactly as before this existed.
    expect(h.createLeadSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          customFields: expect.arrayContaining([
            expect.objectContaining({ label: 'How would you describe this event?' }),
          ]),
        }),
      }),
    );
  });

  it('leaves the custom fields the ledger and the lead panel read exactly as they were', async () => {
    const h = createHarness();

    await h.run();

    const payload = (h.createLeadSubmission.mock.calls[0]?.[0] as {
      payload: { customFields: { key: string; label: string; value: string }[] };
    }).payload;

    expect(payload.customFields).toEqual([
      {
        key: 'how_would_you_describe_this_event?',
        label: 'How would you describe this event?',
        value: 'house warming',
      },
      { key: 'event_date', label: 'Event date', value: '12 January 2026' },
      { key: 'location_/_area', label: 'Location / area', value: 'Indiranagar, Bengaluru' },
      {
        key: 'choose_your_candid_&_cinematic_p&v_pacakage',
        label: 'Choose your candid & cinematic p&v pacakage',
        value: 'only photography',
      },
    ]);
  });
});

describe('importLead - the owner alert', () => {
  it('pings the owner about a lead who arrived off an ad, summarising the form', async () => {
    const h = createHarness();

    await h.run();

    expect(h.sendNewLeadAlert).toHaveBeenCalledTimes(1);

    const params = h.sendNewLeadAlert.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(params).toMatchObject({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
      conversationId: 'conv-1',
      leadDisplayName: 'Riya Sharma',
      phone: '919876543210',
      category: 'house_warming',
      sourceLabel: 'Meta - Event Photography',
    });
    // There is no first message to quote: this lead has not written in yet.
    expect(params.firstMessage).toBeUndefined();
    expect(params.facts).toMatchObject({ event_type: 'house warming' });
  });

  it('alerts even when the source keeps its answers away from the AI - the owner is not the AI', async () => {
    const h = createHarness({ aiContextEnabled: false });

    await h.run();

    expect(h.sendNewLeadAlert).toHaveBeenCalledTimes(1);
  });

  it('still imports the lead when the alert blows up unexpectedly', async () => {
    const h = createHarness();
    h.sendNewLeadAlert.mockRejectedValue(new Error('unexpected'));

    await expect(h.run()).resolves.toBe('imported');
    expect(h.logger.error).toHaveBeenCalled();
  });
});
