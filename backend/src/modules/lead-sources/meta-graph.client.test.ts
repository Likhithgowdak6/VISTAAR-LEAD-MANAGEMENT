/**
 * The Graph API client, exercised entirely against a stubbed `fetch` — nothing here talks to
 * Meta, and there is no code path in this file that could.
 *
 * What is actually being pinned down: the version is in the URL (an unpinned Graph call breaks
 * silently the day Meta retires a version), the `time_created` filter is what keeps a steady poll
 * cheap, cursor pages are followed but capped, and Meta's error envelope is collapsed into the
 * four reactions the importer has — because "expired token" and "rate limited" must not be
 * treated the same way.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const {
  META_GRAPH_API_VERSION,
  buildMetaGraphUrl,
  fetchMetaFormLeads,
  listMetaLeadForms,
  testMetaConnection,
} = await import('./meta-graph.client.js');
const { META_GRAPH_FAILURE_KINDS, MetaGraphError } = await import('./lead-source.errors.js');

const TOKEN = 'test-token-not-a-real-credential';

const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: () => Promise.resolve(JSON.stringify(body)),
});

const metaError = (error: Record<string, unknown>, status = 400) => jsonResponse({ error }, status);

const lead = (id: string, createdTime = '2026-08-25T09:00:00+0000') => ({
  id,
  created_time: createdTime,
  field_data: [{ name: 'full_name', values: ['Riya Sharma'] }],
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildMetaGraphUrl', () => {
  it('pins the API version in the path so a retired version fails loudly, not silently', () => {
    const url = buildMetaGraphUrl({ path: '123/leads', params: { fields: 'id' } });

    expect(url).toContain(`/${META_GRAPH_API_VERSION}/123/leads`);
    expect(META_GRAPH_API_VERSION).toMatch(/^v\d+\.\d+$/);
  });

  it('leaves out parameters that were not supplied rather than sending "undefined"', () => {
    const url = buildMetaGraphUrl({ path: 'me', params: { fields: 'id', filtering: undefined } });

    expect(url).not.toContain('filtering');
  });
});

describe('fetchMetaFormLeads', () => {
  it('asks only for leads newer than the watermark, in whole seconds', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: [lead('l1')] }));

    await fetchMetaFormLeads({
      accessToken: TOKEN,
      formId: '99887766',
      since: new Date('2026-08-25T09:00:00.000Z'),
      fetchFn: fetchFn as never,
    });

    const url = new URL((fetchFn.mock.calls[0] as [string])[0]);

    expect(url.pathname).toBe(`/${META_GRAPH_API_VERSION}/99887766/leads`);
    expect(url.searchParams.get('access_token')).toBe(TOKEN);
    expect(JSON.parse(url.searchParams.get('filtering') ?? '[]')).toEqual([
      {
        field: 'time_created',
        operator: 'GREATER_THAN',
        value: Math.floor(new Date('2026-08-25T09:00:00.000Z').getTime() / 1000),
      },
    ]);
    // The mapper needs the answers, not just the identifiers.
    expect(url.searchParams.get('fields')).toContain('field_data');
  });

  it('sends no filter at all on a first, unbounded sync', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));

    await fetchMetaFormLeads({ accessToken: TOKEN, formId: '1', since: null, fetchFn: fetchFn as never });

    expect(new URL((fetchFn.mock.calls[0] as [string])[0]).searchParams.has('filtering')).toBe(false);
  });

  it('follows paging.next until Meta runs out of cursors', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ data: [lead('l1')], paging: { next: 'https://graph.facebook.com/next-1' } }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [lead('l2')] }));

    const { leads, truncated } = await fetchMetaFormLeads({
      accessToken: TOKEN,
      formId: '1',
      fetchFn: fetchFn as never,
    });

    expect(leads.map((entry) => entry.id)).toEqual(['l1', 'l2']);
    expect(truncated).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('stops at the page cap so one source cannot monopolise a tick', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ data: [lead('l1')], paging: { next: 'https://graph.facebook.com/next' } }),
    );

    const { leads, truncated } = await fetchMetaFormLeads({
      accessToken: TOKEN,
      formId: '1',
      maxPages: 3,
      fetchFn: fetchFn as never,
    });

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(leads).toHaveLength(3);
    // Meta still had more; the next tick picks up from the advanced watermark.
    expect(truncated).toBe(true);
  });

  it('stops at the lead cap mid-page', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: [lead('l1'), lead('l2'), lead('l3')] }));

    const { leads } = await fetchMetaFormLeads({
      accessToken: TOKEN,
      formId: '1',
      maxLeads: 2,
      fetchFn: fetchFn as never,
    });

    expect(leads.map((entry) => entry.id)).toEqual(['l1', 'l2']);
  });

  it('refuses to call Meta at all without a token', async () => {
    const fetchFn = vi.fn();

    await expect(
      fetchMetaFormLeads({ accessToken: '  ', formId: '1', fetchFn: fetchFn as never }),
    ).rejects.toMatchObject({ code: 'META_TOKEN_MISSING' });

    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('gives up on a request that hangs instead of wedging the import tick', async () => {
    const fetchFn = vi.fn(
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );

    await expect(
      fetchMetaFormLeads({
        accessToken: TOKEN,
        formId: '1',
        timeoutMs: 5,
        fetchFn: fetchFn as never,
      }),
    ).rejects.toMatchObject({
      code: 'META_NETWORK_ERROR',
      failureKind: META_GRAPH_FAILURE_KINDS.TRANSIENT,
    });
  });
});

describe('fetchMetaFormLeads - Meta error envelopes', () => {
  const call = (fetchFn: unknown) =>
    fetchMetaFormLeads({ accessToken: TOKEN, formId: '1', fetchFn: fetchFn as never });

  it('treats an OAuth 190 as something only a human can fix', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(metaError({ code: 190, error_subcode: 463, type: 'OAuthException' }, 401));

    const error = await call(fetchFn).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(MetaGraphError);
    expect(error).toMatchObject({
      code: 'META_TOKEN_EXPIRED',
      failureKind: META_GRAPH_FAILURE_KINDS.NEEDS_ATTENTION,
      metaCode: 190,
      metaSubcode: 463,
    });
    expect((error as Error).message).toMatch(/expired or was revoked/i);
  });

  it('separates a missing permission from a dead token - both need a human, differently', async () => {
    const fetchFn = vi.fn().mockResolvedValue(metaError({ code: 200, type: 'OAuthException' }, 403));

    await expect(call(fetchFn)).rejects.toMatchObject({
      code: 'META_PERMISSION_DENIED',
      failureKind: META_GRAPH_FAILURE_KINDS.NEEDS_ATTENTION,
    });
  });

  it('marks a throttle as retryable so the next tick simply tries again', async () => {
    const fetchFn = vi.fn().mockResolvedValue(metaError({ code: 80004, type: 'OAuthException' }, 400));

    await expect(call(fetchFn)).rejects.toMatchObject({
      code: 'META_RATE_LIMITED',
      failureKind: META_GRAPH_FAILURE_KINDS.RATE_LIMITED,
    });
  });

  it('treats a bare 5xx as transient rather than as a configuration problem', async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: () => Promise.resolve('<html>upstream</html>'),
    });

    await expect(call(fetchFn)).rejects.toMatchObject({
      code: 'META_TRANSIENT_ERROR',
      failureKind: META_GRAPH_FAILURE_KINDS.TRANSIENT,
      httpStatus: 503,
    });
  });

  it('does not let a 200 carrying an error envelope through as data', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ error: { code: 190 } }, 200));

    await expect(call(fetchFn)).rejects.toMatchObject({ code: 'META_TOKEN_EXPIRED' });
  });

  it('never repeats Meta’s own prose, which is the string most likely to quote the URL back', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      metaError(
        {
          code: 190,
          message: `Invalid OAuth token for https://graph.facebook.com/v25.0/1/leads?access_token=${TOKEN}`,
        },
        401,
      ),
    );

    const error = (await call(fetchFn).catch((thrown: unknown) => thrown)) as Error;

    expect(error.message).not.toContain(TOKEN);
    expect(error.message).not.toContain('graph.facebook.com');
  });
});

describe('testMetaConnection', () => {
  it('reports the pages a user token administers', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: '555', name: 'Riya Kapoor' }))
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: '777', name: 'Vistaar Studio' }] }));

    await expect(testMetaConnection({ accessToken: TOKEN, fetchFn: fetchFn as never })).resolves.toEqual({
      identity: { id: '555', name: 'Riya Kapoor' },
      pages: [{ id: '777', name: 'Vistaar Studio' }],
      pageScoped: false,
    });
  });

  it('falls back to the page itself when /me/accounts is refused - the normal answer for a Page token', async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ id: '777', name: 'Vistaar Studio' }))
      .mockResolvedValueOnce(metaError({ code: 100, type: 'GraphMethodException' }, 400));

    await expect(testMetaConnection({ accessToken: TOKEN, fetchFn: fetchFn as never })).resolves.toEqual({
      identity: { id: '777', name: 'Vistaar Studio' },
      pages: [{ id: '777', name: 'Vistaar Studio' }],
      pageScoped: true,
    });
  });

  it('fails when /me itself is refused - that token is not usable for anything', async () => {
    const fetchFn = vi.fn().mockResolvedValue(metaError({ code: 190 }, 401));

    await expect(
      testMetaConnection({ accessToken: TOKEN, fetchFn: fetchFn as never }),
    ).rejects.toMatchObject({ code: 'META_TOKEN_EXPIRED' });
  });
});

describe('listMetaLeadForms', () => {
  it('returns the page’s forms so the admin picks one instead of typing an id', async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          { id: '111', name: 'Wedding enquiry', status: 'ACTIVE' },
          { id: '222', name: 'Event enquiry', status: 'ARCHIVED' },
          { name: 'Broken row with no id' },
        ],
      }),
    );

    await expect(
      listMetaLeadForms({ accessToken: TOKEN, pageId: '777', fetchFn: fetchFn as never }),
    ).resolves.toEqual([
      { id: '111', name: 'Wedding enquiry', status: 'ACTIVE' },
      { id: '222', name: 'Event enquiry', status: 'ARCHIVED' },
    ]);

    expect(new URL((fetchFn.mock.calls[0] as [string])[0]).pathname).toBe(
      `/${META_GRAPH_API_VERSION}/777/leadgen_forms`,
    );
  });
});
