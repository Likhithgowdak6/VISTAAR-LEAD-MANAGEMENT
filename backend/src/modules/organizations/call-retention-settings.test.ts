/**
 * Reading and writing an organisation's call-retention policy.
 *
 * THE VALIDATION IS THE SAFETY FEATURE HERE, not a formality. A retention period is a number
 * that causes irreversible deletion of recorded conversations with real customers, and two
 * values are particularly dangerous:
 *
 *   ZERO, because it means "cutoff = now", which deletes the entire history on the next sweep.
 *   A COERCED STRING, because `z.coerce.number()` turns "" and "abc" into 0 and NaN - and the
 *   first of those is the same catastrophe arriving through a type conversion nobody looked at.
 *
 * So the schema is strict rather than coercing, and both are refused at the edge as well as
 * ignored by the engine. Two layers, because this one cannot be undone.
 *
 * NULL IS A FIRST-CLASS VALUE, not an absence. It means "keep forever" and it has to be
 * writable - an owner who sets 90 days and changes their mind must be able to turn it back off.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', WHATSAPP_OWNER_NUMBER: '' },
}));

const { updateCallRetentionBodySchema } = await import('./organization-settings.validation.js');
const { createOrganizationSettingsService } = await import('./organization-settings.service.js');

const ORG = '6ab4c2037469f65204cfe999';
const OTHER_ORG = '6ab4c2037469f65204cfe888';

const parse = (body: unknown) => updateCallRetentionBodySchema.safeParse(body);

const policy = (overrides: Record<string, unknown> = {}) => ({
  recordingDays: null,
  transcriptDays: null,
  summaryDays: null,
  ...overrides,
});

describe('validating a policy', () => {
  it('accepts whole days', () => {
    expect(parse(policy({ recordingDays: 90, transcriptDays: 365, summaryDays: 30 })).success).toBe(
      true,
    );
  });

  it('ACCEPTS NULL as keep-forever', () => {
    expect(parse(policy()).success).toBe(true);
  });

  it('REFUSES ZERO, which would mean delete everything', () => {
    // A cutoff of "now". The single most dangerous value this field can hold.
    expect(parse(policy({ recordingDays: 0 })).success).toBe(false);
  });

  it('refuses a negative period', () => {
    expect(parse(policy({ transcriptDays: -1 })).success).toBe(false);
  });

  it('refuses a fraction', () => {
    expect(parse(policy({ summaryDays: 1.5 })).success).toBe(false);
  });

  it('refuses an excessively large period', () => {
    expect(parse(policy({ recordingDays: 100_000 })).success).toBe(false);
    expect(parse(policy({ recordingDays: 3650 })).success).toBe(true);
  });

  it('DOES NOT COERCE A STRING, so "0" cannot become zero', () => {
    // The schema is deliberately not `z.coerce.number()`. Coercion would turn "" into 0, and 0
    // is delete-everything.
    expect(parse(policy({ recordingDays: '90' })).success).toBe(false);
    expect(parse(policy({ recordingDays: '' })).success).toBe(false);
    expect(parse(policy({ recordingDays: 'abc' })).success).toBe(false);
  });

  it('REQUIRES ALL THREE FIELDS, so a save always states the whole policy', () => {
    // With null meaning keep-forever, an omitted field would be indistinguishable from "turn
    // this one off" and the UI could never clear a setting it had saved.
    expect(parse({ recordingDays: 90 }).success).toBe(false);
  });
});

describe('the service', () => {
  const build = (stored: unknown = undefined) => {
    const repository = {
      findOrganizationById: vi.fn().mockResolvedValue(
        stored === undefined ? { ownerWhatsappNumber: null } : { ownerWhatsappNumber: null, callRetention: stored },
      ),
      updateOrganizationSettings: vi.fn(),
      updateCallRetention: vi
        .fn()
        .mockImplementation((params: Record<string, unknown>) =>
          Promise.resolve({ ownerWhatsappNumber: null, callRetention: params }),
        ),
    };

    return {
      repository,
      service: createOrganizationSettingsService({
        repository: repository as never,
        config: { WHATSAPP_OWNER_NUMBER: '' } as never,
        logger: { error: vi.fn() },
      }),
    };
  };

  it('DEFAULTS EVERY FIELD TO NULL for an organisation that predates the setting', async () => {
    // The state of every existing studio. It must read as keep-forever, not as some assumed
    // period that the sweep would then act on.
    const { service } = build();

    const settings = await service.getOrganizationSettings({ organizationId: ORG });

    expect(settings.callRetention).toEqual({
      recordingDays: null,
      transcriptDays: null,
      summaryDays: null,
    });
  });

  it('reads back a stored policy', async () => {
    const { service } = build({ recordingDays: 90, transcriptDays: 365, summaryDays: 30 });

    const settings = await service.getOrganizationSettings({ organizationId: ORG });

    expect(settings.callRetention.recordingDays).toBe(90);
    expect(settings.callRetention.summaryDays).toBe(30);
  });

  it('treats a null subdocument as keep-forever rather than throwing', async () => {
    const { service } = build(null);

    const settings = await service.getOrganizationSettings({ organizationId: ORG });

    expect(settings.callRetention.recordingDays).toBeNull();
  });

  it('WRITES NULLS, so a policy can be turned back off', async () => {
    const { repository, service } = build({ recordingDays: 90 });

    await service.setCallRetention({
      organizationId: ORG,
      recordingDays: null,
      transcriptDays: null,
      summaryDays: null,
    });

    expect(repository.updateCallRetention).toHaveBeenCalledWith(
      expect.objectContaining({ recordingDays: null, transcriptDays: null, summaryDays: null }),
    );
  });

  it('WRITES ONLY THE CALLER’S OWN ORGANISATION', async () => {
    // The id comes from the session in the controller; nothing in the body can redirect it.
    const { repository, service } = build();

    await service.setCallRetention({
      organizationId: ORG,
      recordingDays: 90,
      transcriptDays: null,
      summaryDays: null,
    });

    const written = repository.updateCallRetention.mock.calls[0]![0] as { organizationId: string };

    expect(written.organizationId).toBe(ORG);
    expect(written.organizationId).not.toBe(OTHER_ORG);
  });

  it('reports a missing organisation rather than silently succeeding', async () => {
    const { repository, service } = build();
    repository.updateCallRetention.mockResolvedValue(null);

    await expect(
      service.setCallRetention({
        organizationId: ORG,
        recordingDays: 90,
        transcriptDays: null,
        summaryDays: null,
      }),
    ).rejects.toThrow('ORGANIZATION_NOT_FOUND');
  });

  it('DOES NOT TOUCH THE OWNER PHONE NUMBER', async () => {
    // The reason this is its own endpoint: the settings PATCH `$set`s the phone number
    // unconditionally, so routing retention through it would rewrite - or clear - the number.
    const { repository, service } = build();

    await service.setCallRetention({
      organizationId: ORG,
      recordingDays: 90,
      transcriptDays: null,
      summaryDays: null,
    });

    expect(repository.updateOrganizationSettings).not.toHaveBeenCalled();
  });
});
