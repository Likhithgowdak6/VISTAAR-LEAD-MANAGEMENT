/**
 * The compatibility seam. Adding a second kind of lead source must not change what happens to the
 * first kind — not in the request body an existing dashboard sends, and not in a document already
 * sitting in the production database.
 *
 * Model validation runs offline here; nothing in this file needs a database connection.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const { LeadSource } = await import('./lead-source.model.js');
const { createLeadSourceBodySchema, updateLeadSourceBodySchema } = await import(
  './lead-source.validation.js'
);

const ACCOUNT_ID = '65b0f0f0f0f0f0f0f0f0f0f0';
const ORG_ID = '65b0f0f0f0f0f0f0f0f0f0f1';
const TOKEN = 'not-a-real-page-token-0123456789wxyz';

describe('createLeadSourceBodySchema', () => {
  it('still accepts the exact body the existing dashboard sends, with no kind at all', () => {
    const parsed = createLeadSourceBodySchema.parse({
      name: 'Meta wedding leads',
      sheetUrl: 'https://docs.google.com/spreadsheets/d/abc/edit#gid=0',
      whatsappAccountId: ACCOUNT_ID,
      defaultCountryCode: '91',
      aiContextEnabled: false,
      importExisting: false,
    });

    expect(parsed).toMatchObject({
      kind: 'google_sheet',
      sheetUrl: 'https://docs.google.com/spreadsheets/d/abc/edit#gid=0',
    });
  });

  it('accepts a Meta body with a page, a form and a token', () => {
    const parsed = createLeadSourceBodySchema.parse({
      kind: 'meta_lead_ads',
      name: 'Meta - Wedding form',
      accessToken: TOKEN,
      pageId: '777',
      pageName: 'Vistaar Studio',
      formId: '4001',
      formName: 'Wedding enquiry',
      whatsappAccountId: ACCOUNT_ID,
    });

    expect(parsed).toMatchObject({ kind: 'meta_lead_ads', pageId: '777', formId: '4001' });
    // Backfill stays opt-in for a Meta source too: a form with a year of history must not flood
    // the inbox the moment it is connected.
    expect(parsed).toMatchObject({ importExisting: false, aiContextEnabled: false });
  });

  it('treats an omitted form id as "every form on this page" rather than as a mistake', () => {
    const parsed = createLeadSourceBodySchema.parse({
      kind: 'meta_lead_ads',
      name: 'Meta - whole page',
      accessToken: TOKEN,
      pageId: '777',
      whatsappAccountId: ACCOUNT_ID,
    });

    expect((parsed as { formId?: string | null }).formId ?? null).toBeNull();
  });

  it('refuses a Meta body with no token, and a sheet body with no link', () => {
    expect(() =>
      createLeadSourceBodySchema.parse({
        kind: 'meta_lead_ads',
        name: 'No token',
        pageId: '777',
        whatsappAccountId: ACCOUNT_ID,
      }),
    ).toThrow();

    expect(() =>
      createLeadSourceBodySchema.parse({ name: 'No link', whatsappAccountId: ACCOUNT_ID }),
    ).toThrow();
  });

  it('refuses something that is obviously not a token', () => {
    expect(() =>
      createLeadSourceBodySchema.parse({
        kind: 'meta_lead_ads',
        name: 'Typo',
        accessToken: 'oops',
        pageId: '777',
        whatsappAccountId: ACCOUNT_ID,
      }),
    ).toThrow();
  });
});

describe('updateLeadSourceBodySchema', () => {
  it('accepts a token rotation on its own', () => {
    expect(updateLeadSourceBodySchema.parse({ accessToken: TOKEN })).toMatchObject({
      accessToken: TOKEN,
    });
  });

  it('has no way to change a source’s kind', () => {
    const parsed = updateLeadSourceBodySchema.parse({ name: 'Renamed', kind: 'meta_lead_ads' });

    expect(parsed).not.toHaveProperty('kind');
  });
});

describe('LeadSource model - the two kinds side by side', () => {
  it('defaults a document with no kind to the Google Sheet it has always been', async () => {
    const document = new LeadSource({
      organizationId: ORG_ID,
      name: 'Legacy sheet',
      sheetUrl: 'https://docs.google.com/spreadsheets/d/abc/edit#gid=0',
      sheetId: 'abc',
      gid: '0',
      whatsappAccountId: ACCOUNT_ID,
    });

    expect(document.kind).toBe('google_sheet');
    await expect(document.validate()).resolves.toBeUndefined();
  });

  it('still refuses a sheet source that is missing its sheet fields', async () => {
    const document = new LeadSource({
      organizationId: ORG_ID,
      name: 'Half a sheet',
      whatsappAccountId: ACCOUNT_ID,
    });

    await expect(document.validate()).rejects.toMatchObject({
      errors: expect.objectContaining({ sheetUrl: expect.anything() }),
    });
  });

  it('accepts a Meta source with no sheet fields whatsoever', async () => {
    const document = new LeadSource({
      organizationId: ORG_ID,
      name: 'Meta - Wedding form',
      kind: 'meta_lead_ads',
      meta: { pageId: '777', formId: '4001', accessTokenLast4: 'wxyz', accessTokenSetAt: new Date() },
      whatsappAccountId: ACCOUNT_ID,
    });

    await expect(document.validate()).resolves.toBeUndefined();
    expect(document.sheetUrl ?? null).toBeNull();
  });

  it('keeps the sheet uniqueness index out of Meta’s way, and gives Meta its own', () => {
    const indexes = LeadSource.schema.indexes();

    const sheetIndex = indexes.find(([keys]) => 'sheetId' in keys && 'gid' in keys);
    const metaIndex = indexes.find(([keys]) => 'meta.pageId' in keys);

    // Partial on the presence of a sheetId, so every pre-existing sheet source is still covered
    // and no two Meta sources collide on a shared all-null key.
    expect(sheetIndex?.[1]).toMatchObject({
      unique: true,
      partialFilterExpression: { sheetId: { $type: 'string' } },
    });
    expect(metaIndex?.[0]).toMatchObject({ organizationId: 1, 'meta.pageId': 1, 'meta.formId': 1 });
    expect(metaIndex?.[1]).toMatchObject({ unique: true });
  });

  it('keeps the access token out of a plain query by default', () => {
    expect(LeadSource.schema.path('encryptedMetaAccessToken').options.select).toBe(false);
  });
});
