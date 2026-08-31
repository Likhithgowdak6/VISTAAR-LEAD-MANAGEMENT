/**
 * `drain()` is now the fork in the road: a sheet source goes down the CSV path, a Meta source down
 * the Graph path, and both land on the same pipeline. What is asserted here is that the fork is
 * made on the source's kind and nothing else, that a source with no kind at all — every source in
 * the live database before this feature — still goes to the sheet importer, and that a dead Meta
 * token is recorded as needing a human rather than as one more failed sync.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', LEAD_IMPORT_MAX_ROWS_PER_TICK: 200 },
}));

const { createLeadImportService } = await import('./lead-import.service.js');
const { LeadSheetFetchError, META_GRAPH_FAILURE_KINDS, MetaGraphError } = await import(
  './lead-source.errors.js'
);

const SHEET_CSV = 'id,created_time,full_name,phone_number\nl:1,2026-08-25T09:00:00Z,Riya,p:+919876543210\n';

const source = (overrides: Record<string, unknown> = {}) => ({
  _id: { toString: () => 'source-1' },
  organizationId: 'org-1',
  whatsappAccountId: 'account-1',
  name: 'A source',
  defaultCountryCode: '91',
  aiContextEnabled: false,
  importFromTime: new Date('2026-01-01T00:00:00.000Z'),
  columnMapping: {},
  sheetUrl: 'https://docs.google.com/spreadsheets/d/abc/edit#gid=0',
  sheetId: 'abc',
  gid: '0',
  ...overrides,
});

const createHarness = ({ leadSources = [source()] as unknown[] } = {}) => {
  const fetchSheetCsv = vi.fn().mockResolvedValue(SHEET_CSV);
  const recordLeadSourceSync = vi.fn().mockResolvedValue(null);
  const metaImportFromSource = vi
    .fn()
    .mockResolvedValue({ counts: { imported: 2, duplicates: 0, skipped: 0, failed: 0 } });
  const importLeads = vi
    .fn()
    .mockResolvedValue({ counts: { imported: 1, duplicates: 0, skipped: 0, failed: 0 }, newestSubmittedAt: null });

  const service = createLeadImportService({
    config: { LEAD_IMPORT_MAX_ROWS_PER_TICK: 200 } as never,
    fetchSheetCsv: fetchSheetCsv as never,
    pipeline: { importLeads, importLead: vi.fn(), recordSkippedLead: vi.fn() } as never,
    metaImportService: { importFromSource: metaImportFromSource } as never,
    leadSourceRepository: {
      findActiveLeadSources: vi.fn().mockResolvedValue(leadSources),
      recordLeadSourceSync,
    } as never,
    logger: { error: vi.fn(), warn: vi.fn() },
    now: () => new Date('2026-08-26T00:00:00.000Z'),
  });

  return { service, fetchSheetCsv, metaImportFromSource, recordLeadSourceSync, importLeads };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('drain - dispatch by source kind', () => {
  it('sends a Meta source to the Graph importer and never touches the sheet client', async () => {
    const h = createHarness({ leadSources: [source({ kind: 'meta_lead_ads' })] });

    await expect(h.service.drain()).resolves.toMatchObject({ imported: 2 });

    expect(h.metaImportFromSource).toHaveBeenCalledTimes(1);
    expect(h.fetchSheetCsv).not.toHaveBeenCalled();
  });

  it('sends an explicit google_sheet source down the CSV path', async () => {
    const h = createHarness({ leadSources: [source({ kind: 'google_sheet' })] });

    await expect(h.service.drain()).resolves.toMatchObject({ imported: 1 });

    expect(h.fetchSheetCsv).toHaveBeenCalledTimes(1);
    expect(h.metaImportFromSource).not.toHaveBeenCalled();
  });

  it('sends a source with no kind at all down the CSV path - every existing row in production', async () => {
    const h = createHarness({ leadSources: [source()] });

    await h.service.drain();

    expect(h.fetchSheetCsv).toHaveBeenCalledWith({
      sheetRef: { sheetId: 'abc', gid: '0', published: false },
    });
    expect(h.metaImportFromSource).not.toHaveBeenCalled();
  });

  it('drains both kinds in one tick, and one broken source does not stop the other', async () => {
    const h = createHarness({
      leadSources: [source({ kind: 'meta_lead_ads' }), source({ _id: { toString: () => 'source-2' } })],
    });
    h.metaImportFromSource.mockRejectedValue(new MetaGraphError('down', {}));

    await expect(h.service.drain()).resolves.toMatchObject({ imported: 1 });

    expect(h.fetchSheetCsv).toHaveBeenCalledTimes(1);
  });
});

describe('syncSource - how a failure is recorded', () => {
  it('marks a source with a dead token as needing attention, not merely failed', async () => {
    const h = createHarness();

    h.metaImportFromSource.mockRejectedValue(
      new MetaGraphError('The Meta access token has expired or was revoked.', {
        code: 'META_TOKEN_EXPIRED',
        failureKind: META_GRAPH_FAILURE_KINDS.NEEDS_ATTENTION,
      }),
    );

    await expect(h.service.syncSource(source({ kind: 'meta_lead_ads' }) as never)).rejects.toBeInstanceOf(
      MetaGraphError,
    );

    expect(h.recordLeadSourceSync).toHaveBeenCalledWith(
      expect.objectContaining({
        syncStatus: 'needs_attention',
        lastError: 'The Meta access token has expired or was revoked.',
      }),
    );
  });

  it('records a rate limit as an ordinary failed sync the next tick will retry', async () => {
    const h = createHarness();

    h.metaImportFromSource.mockRejectedValue(
      new MetaGraphError('Meta is rate limiting this app. The next scheduled poll will try again.', {
        code: 'META_RATE_LIMITED',
        failureKind: META_GRAPH_FAILURE_KINDS.RATE_LIMITED,
      }),
    );

    await h.service.syncSource(source({ kind: 'meta_lead_ads' }) as never).catch(() => {});

    expect(h.recordLeadSourceSync).toHaveBeenCalledWith(
      expect.objectContaining({ syncStatus: 'failed' }),
    );
  });

  it('leaves the sheet importer’s failure handling exactly as it was', async () => {
    const h = createHarness();
    h.fetchSheetCsv.mockRejectedValue(
      new LeadSheetFetchError('The sheet is not link-shared. Set it to "anyone with the link can view".'),
    );

    await h.service.syncSource(source() as never).catch(() => {});

    expect(h.recordLeadSourceSync).toHaveBeenCalledWith(
      expect.objectContaining({
        syncStatus: 'failed',
        lastError: 'The sheet is not link-shared. Set it to "anyone with the link can view".',
      }),
    );
  });
});
