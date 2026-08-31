/**
 * The serializer is the last thing between the database and the browser, so the two properties
 * that matter here are: a Meta source's credential is not in the DTO under any name, and a source
 * written before the `kind` field existed still reads as the Google Sheet it is.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const { serializeLeadSource } = await import('./lead-source.serializer.js');
const { sanitizeLeadSourceErrorText } = await import('./lead-source.errors.js');

const TOKEN = 'not-a-real-page-token-0123456789wxyz';

describe('serializeLeadSource - a Meta source', () => {
  const serialized = serializeLeadSource({
    _id: 'source-1',
    organizationId: 'org-1',
    name: 'Meta - Wedding form',
    kind: 'meta_lead_ads',
    sheetUrl: null,
    gid: null,
    meta: {
      pageId: '777',
      pageName: 'Vistaar Studio',
      formId: '4001',
      formName: 'Wedding enquiry',
      accessTokenLast4: 'wxyz',
      accessTokenSetAt: new Date('2026-08-25T09:00:00.000Z'),
      lastLeadCreatedAt: new Date('2026-08-26T09:00:00.000Z'),
    },
    // Present here on purpose: the model marks it `select: false`, but the serializer must not
    // depend on that having been honoured.
    encryptedMetaAccessToken: { algorithm: 'aes-256-gcm', ciphertext: 'Y2lwaGVy', keyVersion: '1' },
    whatsappAccountId: 'account-1',
    defaultCountryCode: '91',
    status: 'active',
    aiContextEnabled: false,
    lastSyncStatus: 'needs_attention',
    lastError: 'The Meta access token has expired or was revoked.',
    totalImported: 12,
  });

  it('says a token is set and shows four characters of it, never the token', () => {
    expect(serialized?.meta).toMatchObject({
      pageId: '777',
      pageName: 'Vistaar Studio',
      formId: '4001',
      formName: 'Wedding enquiry',
      hasAccessToken: true,
      accessTokenLast4: 'wxyz',
    });
  });

  it('carries no ciphertext and no token-shaped field anywhere in the DTO', () => {
    const dto = JSON.stringify(serialized);

    expect(dto).not.toContain(TOKEN);
    expect(dto).not.toContain('Y2lwaGVy');
    expect(dto).not.toContain('encryptedMetaAccessToken');
    expect(dto).not.toMatch(/accessToken"\s*:/);
  });

  it('reports the needs-attention sync state so the dashboard can say so out loud', () => {
    expect(serialized?.lastSyncStatus).toBe('needs_attention');
  });
});

describe('serializeLeadSource - a sheet source written before Meta support existed', () => {
  it('reads as a Google Sheet with an empty meta block', () => {
    const serialized = serializeLeadSource({
      _id: 'source-2',
      organizationId: 'org-1',
      name: 'Meta wedding leads',
      sheetUrl: 'https://docs.google.com/spreadsheets/d/abc/edit#gid=0',
      gid: '0',
      whatsappAccountId: 'account-1',
      defaultCountryCode: '91',
      status: 'active',
      lastSyncStatus: 'ok',
      totalImported: 4,
    });

    expect(serialized?.kind).toBe('google_sheet');
    expect(serialized?.sheetUrl).toBe('https://docs.google.com/spreadsheets/d/abc/edit#gid=0');
    expect(serialized?.meta).toMatchObject({ pageId: null, formId: null, hasAccessToken: false });
  });
});

describe('sanitizeLeadSourceErrorText', () => {
  it('strips a Graph URL, which is where a token would ride into lastError', () => {
    const sanitized = sanitizeLeadSourceErrorText(
      `fetch failed for https://graph.facebook.com/v25.0/1/leads?access_token=${TOKEN}`,
    );

    expect(sanitized).not.toContain(TOKEN);
    expect(sanitized).not.toContain('graph.facebook.com');
    expect(sanitized).toContain('[url]');
  });

  it('strips a bare access_token parameter even without a URL around it', () => {
    expect(sanitizeLeadSourceErrorText(`access_token=${TOKEN} rejected`)).toBe(
      'access_token=[redacted] rejected',
    );
  });

  it('leaves the sheet importer’s own admin-facing messages exactly as written', () => {
    const message = 'The sheet is not link-shared. Set it to "anyone with the link can view".';

    expect(sanitizeLeadSourceErrorText(message)).toBe(message);
  });

  it('truncates to the column’s length so the write cannot be rejected', () => {
    expect(sanitizeLeadSourceErrorText('x'.repeat(900))).toHaveLength(300);
  });
});
