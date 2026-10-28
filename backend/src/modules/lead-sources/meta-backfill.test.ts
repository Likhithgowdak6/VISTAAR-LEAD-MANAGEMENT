/**
 * Reading a form's whole history without losing the oldest half of it.
 *
 * THE BUG THESE EXIST FOR. Meta serves `/{form-id}/leads` NEWEST-FIRST. The fetch stopped after
 * 200 leads and threw away the `truncated` flag that said there was more; the importer then set
 * the forward watermark to the newest lead it had seen - which, on page one, is the newest lead
 * in the entire form. Every subsequent poll asked for leads newer than that, so on a form with
 * 500 submissions the oldest 300 became permanently unreachable. `lastSyncStatus` stayed `ok`
 * and nothing was logged. Not proven to have happened in production, where the form held two
 * leads, but the code did it unconditionally.
 *
 * THE RULE THE FIX ENFORCES: the forward watermark is never written while any history remains
 * unread. A backfill resumes by cursor and only sets the watermark on the tick where Meta says
 * it has no more pages.
 *
 * WHAT IS NOT ASSUMED. Only `GREATER_THAN` on `time_created` appears anywhere in this codebase,
 * so nothing here relies on a descending time filter existing. Resumption uses Meta's opaque
 * `paging.cursors.after` - never its `paging.next` URL, which carries the access token and must
 * not be persisted.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', META_LEAD_ADS_ENABLED: true },
}));

const { createMetaLeadImportService, resolveMetaBackfillState } = await import(
  './meta-lead-import.service.js'
);

const EPOCH = new Date(0);
const FORM_ID = 'form-1';

/** A Meta source, by default mid-backfill with nothing read yet. */
const source = (overrides: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) =>
  ({
    _id: 'source-1',
    organizationId: 'org-1',
    kind: 'meta_lead_ads',
    importFromTime: EPOCH,
    columnMapping: null,
    encryptedMetaAccessToken: 'encrypted',
    meta: {
      formId: FORM_ID,
      formName: 'Wedding enquiries',
      pageId: 'page-1',
      lastLeadCreatedAt: null,
      backfillCursor: null,
      backfillNewestSeenAt: null,
      backfillCompletedFormIds: [],
      ...meta,
    },
    ...overrides,
  }) as never;

const lead = (id: string, isoDate: string) => ({
  id,
  created_time: isoDate,
  form_id: FORM_ID,
  field_data: [{ name: 'phone_number', values: [`+9198765${id.padStart(5, '0')}`] }],
});

const createHarness = ({
  pages = [] as { leads: ReturnType<typeof lead>[]; truncated: boolean; nextAfter: string | null }[],
  newestSubmittedAt = null as Date | null,
  failed = 0,
} = {}) => {
  let call = 0;

  const fetchMetaFormLeads = vi.fn(async (_opts: Record<string, unknown>) => {
    const page = pages[call] ?? { leads: [], truncated: false, nextAfter: null };
    call += 1;

    return page;
  });

  const recordMetaLeadWatermark = vi.fn(async (_p: unknown) => undefined);
  const recordMetaBackfillProgress = vi.fn(async (_p: unknown) => undefined);

  const importLeads = vi.fn(async ({
    leads,
  }: {
    leads: readonly { submittedAt: Date | null; externalId: string }[];
  }) => ({
    counts: { imported: leads.length, duplicates: 0, skipped: 0, failed },
    newestSubmittedAt:
      newestSubmittedAt ??
      leads.reduce<Date | null>(
        (newest, l) =>
          l.submittedAt && (newest === null || l.submittedAt > newest) ? l.submittedAt : newest,
        null,
      ),
  }));

  const service = createMetaLeadImportService({
    config: { META_LEAD_ADS_ENABLED: true, LEAD_IMPORT_MAX_ROWS_PER_TICK: 200 } as never,
    pipeline: { importLeads } as never,
    fetchMetaFormLeads: fetchMetaFormLeads as never,
    listMetaLeadForms: vi.fn(async () => [{ id: FORM_ID, name: 'Wedding enquiries' }]) as never,
    decryptMetaAccessToken: vi.fn(() => 'token') as never,
    leadSourceRepository: { recordMetaLeadWatermark, recordMetaBackfillProgress },
    logger: { warn: vi.fn(), error: vi.fn() },
  });

  return { service, fetchMetaFormLeads, recordMetaLeadWatermark, recordMetaBackfillProgress, importLeads };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('deciding whether a source is still reading history', () => {
  it('backfills a source asked for history that has read nothing', () => {
    expect(resolveMetaBackfillState(source())).toEqual({ backfilling: true, cursor: null });
  });

  it('resumes from a stored cursor', () => {
    expect(resolveMetaBackfillState(source({}, { backfillCursor: 'CURSOR_A' }))).toEqual({
      backfilling: true,
      cursor: 'CURSOR_A',
    });
  });

  it('stops once the backfill is marked complete', () => {
    expect(
      resolveMetaBackfillState(source({}, { backfillComplete: true, backfillCursor: null })),
    ).toEqual({ backfilling: false, cursor: null });
  });

  it('never backfills a source that did not ask for history', () => {
    expect(resolveMetaBackfillState(source({ importFromTime: new Date('2026-10-27') }))).toEqual({
      backfilling: false,
      cursor: null,
    });
  });

  it('TREATS A LEGACY SOURCE AS ALREADY INCREMENTAL', () => {
    /*
     * The compatibility rule, and the one that protects live sources. Every source created
     * before this feature has a watermark and NO `backfillComplete` flag. Reading `undefined`
     * as "unfinished" would restart a full historical walk on all of them the moment this
     * deploys, pushing weeks-old leads into inboxes as if they were new.
     */
    const legacy = source({}, { lastLeadCreatedAt: new Date('2026-10-28T01:54:22Z') });
    // No `backfillComplete` key at all.
    delete (legacy as unknown as { meta: Record<string, unknown> }).meta.backfillComplete;

    expect(resolveMetaBackfillState(legacy)).toEqual({ backfilling: false, cursor: null });
  });
});

describe('a form with more than 200 leads', () => {
  const page1 = {
    leads: Array.from({ length: 200 }, (_, i) => lead(String(i), `2026-10-${10 + (i % 20)}T10:00:00+0000`)),
    truncated: true,
    nextAfter: 'CURSOR_PAGE_2',
  };

  it('DOES NOT SET THE FORWARD WATERMARK while pages remain', async () => {
    // The exact regression: setting it here is what made the older 300 unreachable.
    const h = createHarness({ pages: [page1] });

    await h.service.importFromSource(source());

    expect(h.recordMetaLeadWatermark).not.toHaveBeenCalled();
  });

  it('stores the cursor to resume from', async () => {
    const h = createHarness({ pages: [page1] });

    await h.service.importFromSource(source());

    expect(h.recordMetaBackfillProgress).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: 'CURSOR_PAGE_2' }),
    );
  });

  it('does not mark the backfill complete', async () => {
    const h = createHarness({ pages: [page1] });

    await h.service.importFromSource(source());

    const call = h.recordMetaBackfillProgress.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.complete).toBeUndefined();
  });

  it('remembers the newest lead seen, for use when the backfill finishes', async () => {
    const h = createHarness({ pages: [page1], newestSubmittedAt: new Date('2026-10-29T10:00:00Z') });

    await h.service.importFromSource(source());

    expect(h.recordMetaBackfillProgress).toHaveBeenCalledWith(
      expect.objectContaining({ newestSeenAt: new Date('2026-10-29T10:00:00Z') }),
    );
  });

  it('records when it was truncated, so an admin can see the backfill is unfinished', async () => {
    const h = createHarness({ pages: [page1] });

    await h.service.importFromSource(source());

    const call = h.recordMetaBackfillProgress.mock.calls[0]![0] as { truncatedAt: Date };
    expect(call.truncatedAt).toBeInstanceOf(Date);
  });
});

describe('resuming an interrupted backfill', () => {
  it('SENDS THE STORED CURSOR and no time filter', async () => {
    const h = createHarness({
      pages: [{ leads: [lead('900', '2026-09-01T10:00:00+0000')], truncated: false, nextAfter: null }],
    });

    await h.service.importFromSource(source({}, { backfillCursor: 'CURSOR_PAGE_2' }));

    const opts = h.fetchMetaFormLeads.mock.calls[0]![0] as { after: string | null; since: Date | null };
    expect(opts.after).toBe('CURSOR_PAGE_2');
    // A time filter during a backfill would exclude exactly the old leads it exists to reach.
    expect(opts.since).toBeNull();
  });

  it('finishes when Meta runs out of pages, and only then sets the watermark', async () => {
    const h = createHarness({
      pages: [{ leads: [lead('900', '2026-09-01T10:00:00+0000')], truncated: false, nextAfter: null }],
    });

    await h.service.importFromSource(
      source({}, { backfillCursor: 'CURSOR_PAGE_2', backfillNewestSeenAt: new Date('2026-10-29T10:00:00Z') }),
    );

    expect(h.recordMetaBackfillProgress).toHaveBeenCalledWith(
      expect.objectContaining({ complete: true, cursor: null }),
    );
    expect(h.recordMetaLeadWatermark).toHaveBeenCalledWith(
      expect.objectContaining({ lastLeadCreatedAt: new Date('2026-10-29T10:00:00Z') }),
    );
  });

  it('carries the newest instant from EARLIER ticks, not just the last page', async () => {
    // The last page holds the OLDEST leads, so taking its newest would set the watermark far in
    // the past and re-import the whole form on the next poll.
    const h = createHarness({
      pages: [{ leads: [lead('900', '2026-09-01T10:00:00+0000')], truncated: false, nextAfter: null }],
    });

    await h.service.importFromSource(
      source({}, { backfillCursor: 'C', backfillNewestSeenAt: new Date('2026-10-29T10:00:00Z') }),
    );

    expect(h.recordMetaLeadWatermark).toHaveBeenCalledWith(
      expect.objectContaining({ lastLeadCreatedAt: new Date('2026-10-29T10:00:00Z') }),
    );
  });
});

describe('failures and retries', () => {
  it('RECORDS NOTHING when a lead failed, so the same page is retried', async () => {
    // A failed lead was not written. Stepping the cursor past it would lose it for good.
    const h = createHarness({
      pages: [{ leads: [lead('1', '2026-10-01T10:00:00+0000')], truncated: true, nextAfter: 'C2' }],
      failed: 1,
    });

    await h.service.importFromSource(source());

    expect(h.recordMetaBackfillProgress).not.toHaveBeenCalled();
    expect(h.recordMetaLeadWatermark).not.toHaveBeenCalled();
  });

  it('survives a progress write that throws, without failing the import', async () => {
    const h = createHarness({
      pages: [{ leads: [lead('1', '2026-10-01T10:00:00+0000')], truncated: true, nextAfter: 'C2' }],
    });
    h.recordMetaBackfillProgress.mockRejectedValue(new Error('mongo down'));

    await expect(h.service.importFromSource(source())).resolves.toBeDefined();
  });

  it('re-reading a page creates no duplicates - the ledger is still the guard', async () => {
    // The pipeline is untouched by this change: `importLeads` keeps its unique-index dedup, so a
    // retried page is refused there rather than here.
    const samePage = {
      leads: [lead('1', '2026-10-01T10:00:00+0000')],
      truncated: false,
      nextAfter: null,
    };
    // The same page served twice: a retry re-reads it, exactly as a real resume would.
    const h = createHarness({ pages: [samePage, samePage] });

    await h.service.importFromSource(source());
    await h.service.importFromSource(source());

    expect(h.importLeads).toHaveBeenCalledTimes(2);
    // Both ticks handed the pipeline the same lead; dedup is its job, unchanged.
    expect(h.importLeads.mock.calls[0]![0].leads[0]?.externalId).toBe(
      h.importLeads.mock.calls[1]![0].leads[0]?.externalId,
    );
  });
});

describe('the transition to incremental', () => {
  it('a completed source asks Meta only for what is new', async () => {
    const h = createHarness({
      pages: [{ leads: [], truncated: false, nextAfter: null }],
    });

    await h.service.importFromSource(
      source(
        {},
        {
          backfillComplete: true,
          lastLeadCreatedAt: new Date('2026-10-28T01:54:22Z'),
        },
      ),
    );

    const opts = h.fetchMetaFormLeads.mock.calls[0]![0] as { since: Date | null; after: string | null };
    // Watermark + the one-second nudge, and no cursor: history is done.
    expect(opts.since).toEqual(new Date('2026-10-28T01:54:23Z'));
    expect(opts.after).toBeNull();
  });

  it('advances the watermark normally once incremental', async () => {
    const h = createHarness({
      pages: [{ leads: [lead('5', '2026-10-29T12:00:00+0000')], truncated: false, nextAfter: null }],
    });

    await h.service.importFromSource(
      source({}, { backfillComplete: true, lastLeadCreatedAt: new Date('2026-10-28T01:54:22Z') }),
    );

    expect(h.recordMetaLeadWatermark).toHaveBeenCalledTimes(1);
    expect(h.recordMetaBackfillProgress).not.toHaveBeenCalled();
  });
});
