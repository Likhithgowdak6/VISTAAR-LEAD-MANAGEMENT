/**
 * The Meta importer's own responsibilities: what it asks Meta for, in what order it hands leads
 * to the shared pipeline, and when it is allowed to move the watermark.
 *
 * The pipeline itself is stubbed here — it has its own tests, and the point of this file is the
 * two things only this importer does. `fetch` never appears: the Graph client is injected.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const { createMetaLeadImportService, isMetaLeadSource, resolveMetaSince, syncStatusForMetaError } =
  await import('./meta-lead-import.service.js');
const { META_GRAPH_FAILURE_KINDS, MetaGraphError, MetaLeadSourceNotConfiguredError } = await import(
  './lead-source.errors.js'
);

const CONFIG = {
  META_LEAD_ADS_ENABLED: true,
  LEAD_IMPORT_MAX_ROWS_PER_TICK: 200,
  META_GRAPH_MAX_PAGES_PER_TICK: 10,
  META_GRAPH_TIMEOUT_MS: 15_000,
} as never;

const graphLead = (id: string, createdTime: string) => ({
  id,
  created_time: createdTime,
  field_data: [{ name: 'phone_number', values: ['+919876543210'] }],
});

const createHarness = ({
  leads = [graphLead('l1', '2026-08-25T09:00:00+0000')],
  formId = '4001' as string | null,
  lastLeadCreatedAt = null as Date | null,
  importFromTime = new Date('2026-08-01T00:00:00.000Z'),
  counts = { imported: 1, duplicates: 0, skipped: 0, failed: 0 },
  config = CONFIG as never,
} = {}) => {
  const fetchMetaFormLeads = vi.fn().mockResolvedValue({ leads, truncated: false });
  const listMetaLeadForms = vi
    .fn()
    .mockResolvedValue([{ id: '4001', name: 'Wedding enquiry', status: 'ACTIVE' }]);
  const recordMetaLeadWatermark = vi.fn().mockResolvedValue(null);
  const importLeads = vi.fn().mockImplementation(({ leads: mapped }: { leads: { submittedAt: Date | null }[] }) => ({
    counts,
    newestSubmittedAt: mapped.reduce<Date | null>(
      (newest, lead) =>
        lead.submittedAt !== null && (newest === null || lead.submittedAt > newest)
          ? lead.submittedAt
          : newest,
      null,
    ),
  }));

  const service = createMetaLeadImportService({
    config,
    pipeline: { importLeads, importLead: vi.fn(), recordSkippedLead: vi.fn() } as never,
    fetchMetaFormLeads: fetchMetaFormLeads as never,
    listMetaLeadForms: listMetaLeadForms as never,
    decryptMetaAccessToken: (() => 'decrypted-token') as never,
    leadSourceRepository: { recordMetaLeadWatermark },
    logger: { error: vi.fn(), warn: vi.fn() },
  });

  const leadSource = {
    _id: { toString: () => 'source-1' },
    organizationId: 'org-1',
    whatsappAccountId: 'account-1',
    name: 'Meta - Wedding form',
    kind: 'meta_lead_ads',
    defaultCountryCode: '91',
    aiContextEnabled: false,
    importFromTime,
    columnMapping: {},
    encryptedMetaAccessToken: { ciphertext: 'x' },
    meta: {
      pageId: '777',
      pageName: 'Vistaar Studio',
      formId,
      formName: 'Wedding enquiry',
      accessTokenLast4: 'abcd',
      accessTokenSetAt: new Date('2026-08-01T00:00:00.000Z'),
      lastLeadCreatedAt,
    },
  };

  return {
    fetchMetaFormLeads,
    listMetaLeadForms,
    recordMetaLeadWatermark,
    importLeads,
    run: () => service.importFromSource(leadSource as never),
  };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveMetaSince', () => {
  it('asks from the watermark, nudged past it so a boundary lead is not re-fetched forever', () => {
    const since = resolveMetaSince({
      importFromTime: new Date('2026-08-01T00:00:00.000Z'),
      meta: { lastLeadCreatedAt: new Date('2026-08-25T09:00:00.000Z') },
    } as never);

    expect(since?.toISOString()).toBe('2026-08-25T09:00:01.000Z');
  });

  it('falls back to importFromTime before the first successful tick', () => {
    const since = resolveMetaSince({
      importFromTime: new Date('2026-08-01T00:00:00.000Z'),
      meta: { lastLeadCreatedAt: null },
    } as never);

    expect(since?.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('sends no filter for a source created with "import everything"', () => {
    expect(
      resolveMetaSince({ importFromTime: new Date(0), meta: { lastLeadCreatedAt: null } } as never),
    ).toBeNull();
  });
});

describe('importFromSource', () => {
  it('fetches the configured form only, from the watermark', async () => {
    const h = createHarness({ lastLeadCreatedAt: new Date('2026-08-25T09:00:00.000Z') });

    await h.run();

    expect(h.listMetaLeadForms).not.toHaveBeenCalled();
    expect(h.fetchMetaFormLeads).toHaveBeenCalledTimes(1);
    expect(h.fetchMetaFormLeads.mock.calls[0]?.[0]).toMatchObject({
      formId: '4001',
      accessToken: 'decrypted-token',
      maxLeads: 200,
      maxPages: 10,
    });
    expect(
      (h.fetchMetaFormLeads.mock.calls[0]?.[0] as { since: Date }).since.toISOString(),
    ).toBe('2026-08-25T09:00:01.000Z');
  });

  it('resolves every form on the page when the source was set to "all forms"', async () => {
    const h = createHarness({ formId: null });

    await h.run();

    expect(h.listMetaLeadForms).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: '777', accessToken: 'decrypted-token' }),
    );
    expect(h.fetchMetaFormLeads.mock.calls[0]?.[0]).toMatchObject({ formId: '4001' });
  });

  it('hands leads to the pipeline oldest first, so the per-tick cap never strands the rest', async () => {
    const h = createHarness({
      leads: [
        graphLead('newest', '2026-08-25T12:00:00+0000'),
        graphLead('oldest', '2026-08-25T08:00:00+0000'),
        graphLead('middle', '2026-08-25T10:00:00+0000'),
      ],
    });

    await h.run();

    const handed = (h.importLeads.mock.calls[0]?.[0] as { leads: { externalId: string }[] }).leads;

    expect(handed.map((lead) => lead.externalId)).toEqual(['oldest', 'middle', 'newest']);
  });

  it('advances the watermark to the newest lead it carried through', async () => {
    const h = createHarness({
      leads: [
        graphLead('a', '2026-08-25T08:00:00+0000'),
        graphLead('b', '2026-08-25T12:00:00+0000'),
      ],
    });

    await h.run();

    expect(h.recordMetaLeadWatermark).toHaveBeenCalledTimes(1);
    expect(
      (h.recordMetaLeadWatermark.mock.calls[0]?.[0] as { lastLeadCreatedAt: Date }).lastLeadCreatedAt.toISOString(),
    ).toBe('2026-08-25T12:00:00.000Z');
  });

  it('leaves the watermark alone when a lead failed, so the failure is retried, not skipped', async () => {
    const h = createHarness({ counts: { imported: 1, duplicates: 0, skipped: 0, failed: 1 } });

    await h.run();

    expect(h.recordMetaLeadWatermark).not.toHaveBeenCalled();
  });

  it('refuses to reach out to Meta while the feature flag is off', async () => {
    const h = createHarness({
      config: { ...(CONFIG as unknown as Record<string, unknown>), META_LEAD_ADS_ENABLED: false } as never,
    });

    await expect(h.run()).rejects.toBeInstanceOf(MetaLeadSourceNotConfiguredError);
    expect(h.fetchMetaFormLeads).not.toHaveBeenCalled();
  });

  it('refuses when the token could not be decrypted or was never loaded', async () => {
    const service = createMetaLeadImportService({
      config: CONFIG,
      pipeline: { importLeads: vi.fn(), importLead: vi.fn(), recordSkippedLead: vi.fn() } as never,
      fetchMetaFormLeads: vi.fn() as never,
      decryptMetaAccessToken: (() => null) as never,
    });

    await expect(
      service.importFromSource({ meta: { pageId: '777', formId: '1' } } as never),
    ).rejects.toBeInstanceOf(MetaLeadSourceNotConfiguredError);
  });
});

describe('the connection-date floor', () => {
  it('drops a lead older than importFromTime even when Meta returns it anyway', async () => {
    const h = createHarness({
      importFromTime: new Date('2026-09-11T00:00:00.000Z'),
      leads: [
        graphLead('old', '2026-07-01T09:00:00+0000'),
        graphLead('new', '2026-09-12T09:00:00+0000'),
      ],
    });

    await h.run();

    // `since` is only a request filter; a boundary tie, a revised created_time or a reset
    // watermark can all put an old lead in the response. For an events business that is a message
    // to someone whose wedding has already happened, so it is refused here regardless.
    const { leads } = h.importLeads.mock.calls[0][0];
    expect(leads).toHaveLength(1);
    expect(leads[0].externalId).toBe('new');
  });

  it('keeps a lead submitted exactly on the floor', async () => {
    const h = createHarness({
      importFromTime: new Date('2026-09-11T00:00:00.000Z'),
      leads: [graphLead('boundary', '2026-09-11T00:00:00+0000')],
    });

    await h.run();

    expect(h.importLeads.mock.calls[0][0].leads).toHaveLength(1);
  });

  it('imports the whole history when backfill was deliberately asked for', async () => {
    const h = createHarness({
      importFromTime: new Date(0),
      leads: [graphLead('ancient', '2021-01-01T09:00:00+0000')],
    });

    await h.run();

    // The epoch is how "import everything" is expressed, and reaching into the past is the point.
    expect(h.importLeads.mock.calls[0][0].leads).toHaveLength(1);
  });
});

describe('syncStatusForMetaError', () => {
  it('flags a dead token for a human instead of logging another red "sync failed"', () => {
    expect(
      syncStatusForMetaError(
        new MetaGraphError('expired', {
          code: 'META_TOKEN_EXPIRED',
          failureKind: META_GRAPH_FAILURE_KINDS.NEEDS_ATTENTION,
        }),
      ),
    ).toBe('needs_attention');
  });

  it('leaves a throttle as an ordinary failed sync the next tick retries', () => {
    expect(
      syncStatusForMetaError(
        new MetaGraphError('slow down', {
          code: 'META_RATE_LIMITED',
          failureKind: META_GRAPH_FAILURE_KINDS.RATE_LIMITED,
        }),
      ),
    ).toBe('failed');
  });

  it('treats an unconfigured source as needing attention', () => {
    expect(syncStatusForMetaError(new MetaLeadSourceNotConfiguredError())).toBe('needs_attention');
  });
});

describe('isMetaLeadSource', () => {
  it('reads a source with no kind at all as the Google Sheet it has always been', () => {
    expect(isMetaLeadSource({} as never)).toBe(false);
    expect(isMetaLeadSource({ kind: 'google_sheet' } as never)).toBe(false);
    expect(isMetaLeadSource({ kind: 'meta_lead_ads' } as never)).toBe(true);
  });
});
