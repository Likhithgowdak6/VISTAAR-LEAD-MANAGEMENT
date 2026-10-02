/**
 * The webhook door into the lead pipeline.
 *
 * Two things are load-bearing and both are easy to get wrong invisibly:
 *
 *  - A webhook must never be able to create a lead for a page nobody configured. There is no
 *    session on this request, so the page id IS the tenancy check.
 *  - It must go through the SAME importLead the poller uses, so that a lead delivered twice -
 *    which Meta does routinely, since it retries anything not acknowledged fast enough - produces
 *    one conversation, not two.
 *
 * Every collaborator is injected; no Mongo, no network.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', META_GRAPH_TIMEOUT_MS: 15_000 },
}));

// createMetaWebhookService's default leadPipeline reaches the real pipeline, which pulls in
// Mongoose models. Every test injects one, but the module-level default still has to resolve.
vi.mock('./lead-pipeline.service.js', () => ({
  createLeadPipeline: () => ({ importLead: vi.fn() }),
}));

const { createMetaWebhookService, extractLeadgenEvents, fieldKeyOverridesFor } = await import(
  './meta-webhook.service.js'
);

const leadgenBody = (overrides: Record<string, unknown> = {}) => ({
  object: 'page',
  entry: [
    {
      id: '464675790673972',
      time: 1790000000,
      changes: [
        {
          field: 'leadgen',
          value: {
            leadgen_id: '1802669104075658',
            page_id: '464675790673972',
            form_id: '2166324230964931',
            created_time: 1790000000,
            ...overrides,
          },
        },
      ],
    },
  ],
});

const leadSource = {
  _id: 'src-1',
  organizationId: 'org-1',
  columnMapping: {},
  meta: { formName: 'wedding/Birthday Sept- dec' },
  fieldMappings: [],
  encryptedMetaAccessToken: { ciphertext: 'x' },
};

const createHarness = (overrides: Record<string, unknown> = {}) => {
  const findLeadSourceForMetaForm = vi.fn().mockResolvedValue(leadSource);
  const fetchMetaLeadById = vi.fn().mockResolvedValue({
    id: '1802669104075658',
    created_time: '2026-09-29T10:23:00+0000',
    field_data: [{ name: 'full_name', values: ['Likhith'] }],
  });
  const importLead = vi.fn().mockResolvedValue('imported');
  const countLeadSourceImport = vi.fn().mockResolvedValue(null);
  const logger = { info: vi.fn(), error: vi.fn() };

  const service = createMetaWebhookService({
    config: { META_GRAPH_TIMEOUT_MS: 15_000 } as never,
    findLeadSourceForMetaForm: findLeadSourceForMetaForm as never,
    fetchMetaLeadById: fetchMetaLeadById as never,
    // The real one reaches the encryption keyring. Mirrors its one meaningful behaviour: an
    // absent credential decrypts to null, which is what the no_token branch turns on.
    decryptMetaAccessTokenFromStorage: ((field: unknown) =>
      field ? 'page-token' : null) as never,
    leadPipeline: { importLead } as never,
    countLeadSourceImport: countLeadSourceImport as never,
    logger,
    ...overrides,
  });

  return {
    service,
    findLeadSourceForMetaForm,
    fetchMetaLeadById,
    importLead,
    countLeadSourceImport,
    logger,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('extractLeadgenEvents', () => {
  it('pulls the leadgen id, page and form out of a real envelope', () => {
    expect(extractLeadgenEvents(leadgenBody())).toEqual([
      {
        leadgenId: '1802669104075658',
        pageId: '464675790673972',
        formId: '2166324230964931',
        createdTime: 1790000000,
      },
    ]);
  });

  it('ignores changes that are not leadgen', () => {
    // A Page subscribed by another app for another reason still delivers here. That is not an
    // error and must not be logged as one.
    const body = leadgenBody();
    body.entry[0]!.changes[0]!.field = 'feed';

    expect(extractLeadgenEvents(body)).toEqual([]);
  });

  it('drops an event with no page id, rather than guessing which source it belongs to', () => {
    expect(extractLeadgenEvents(leadgenBody({ page_id: undefined }))).toEqual([]);
  });

  it('drops an event with no leadgen id', () => {
    expect(extractLeadgenEvents(leadgenBody({ leadgen_id: '' }))).toEqual([]);
  });

  it('accepts a numeric page id, which Meta sometimes sends', () => {
    const events = extractLeadgenEvents(leadgenBody({ page_id: 464675790673972 }));

    expect(events[0]?.pageId).toBe('464675790673972');
  });

  it.each([null, undefined, {}, [], 'string', 42, { object: 'user', entry: [] }, { object: 'page' }])(
    'returns [] for the malformed body %p rather than throwing',
    (body) => {
      // Throwing here would be a 500, which Meta reads as "retry" - turning a parse bug into an
      // infinite redelivery loop.
      expect(extractLeadgenEvents(body as never)).toEqual([]);
    },
  );
});

describe('fieldKeyOverridesFor', () => {
  it('turns stored mappings into the shape parseFormFields wants', () => {
    expect(
      fieldKeyOverridesFor({
        fieldMappings: [
          { metaKey: 'venue', factKey: 'city' },
          { metaKey: 'internal_note', factKey: null },
        ],
      }),
    ).toEqual({ venue: 'city', internal_note: null });
  });

  it('treats an empty string as "drop it", not as a fact key', () => {
    expect(fieldKeyOverridesFor({ fieldMappings: [{ metaKey: 'x', factKey: '' }] })).toEqual({
      x: null,
    });
  });

  it.each([null, undefined, []])('returns {} for %p mappings', (fieldMappings) => {
    expect(fieldKeyOverridesFor({ fieldMappings: fieldMappings as never })).toEqual({});
  });
});

describe('handleLeadgenEvent', () => {
  it('fetches the lead and hands it to the existing importLead', async () => {
    const h = createHarness();

    const outcome = await h.service.handleLeadgenEvent({
      leadgenId: '1802669104075658',
      pageId: '464675790673972',
      formId: '2166324230964931',
      createdTime: null,
    });

    expect(outcome).toBe('imported');
    expect(h.fetchMetaLeadById).toHaveBeenCalledWith(
      expect.objectContaining({ leadgenId: '1802669104075658' }),
    );
    // The SAME call the poller makes - dedup, the ledger, the allowlist and the auto-greet are
    // all whatever importLead already does, not reimplemented here.
    expect(h.importLead).toHaveBeenCalledWith(
      expect.objectContaining({ leadSource, lead: expect.objectContaining({ externalId: expect.any(String) }) }),
    );
  });

  it('reports a duplicate rather than creating a second lead', async () => {
    // Meta redelivers anything it does not get a fast 200 for. LeadSubmission's unique index is
    // what stops that becoming two conversations; importLead returns 'duplicate' on it.
    const h = createHarness();
    h.importLead.mockResolvedValue('duplicate');

    await expect(
      h.service.handleLeadgenEvent({
        leadgenId: '1802669104075658',
        pageId: '464675790673972',
        formId: null,
        createdTime: null,
      }),
    ).resolves.toBe('duplicate');

    expect(h.importLead).toHaveBeenCalledTimes(1);
  });

  it('refuses an event for a page nobody configured, without calling Meta', async () => {
    // The forged-webhook defence. With no session on this request, the page id is the tenancy
    // check - an unknown page must not cause a Graph call, let alone a lead.
    const h = createHarness();
    h.findLeadSourceForMetaForm.mockResolvedValue(null);

    await expect(
      h.service.handleLeadgenEvent({
        leadgenId: 'whatever',
        pageId: 'not-a-page-we-know',
        formId: null,
        createdTime: null,
      }),
    ).resolves.toBe('no_source');

    expect(h.fetchMetaLeadById).not.toHaveBeenCalled();
    expect(h.importLead).not.toHaveBeenCalled();
  });

  it('passes the source\'s field overrides into the mapper', async () => {
    const h = createHarness();
    h.findLeadSourceForMetaForm.mockResolvedValue({
      ...leadSource,
      fieldMappings: [{ metaKey: 'full_name', factKey: null }],
    });

    await h.service.handleLeadgenEvent({
      leadgenId: '1',
      pageId: '464675790673972',
      formId: null,
      createdTime: null,
    });

    // full_name was mapped to null, so the lead should carry no name fact from it.
    const lead = h.importLead.mock.calls[0]?.[0]?.lead;
    expect(lead?.canonicalFacts?.name).toBeUndefined();
  });

  it('never throws when Meta fails, so the delivery is still acknowledged', async () => {
    // A non-2xx tells Meta to retry. For a failure retrying cannot fix - a revoked token, a form
    // nobody configured - that means days of redelivery. The poller is the real safety net.
    const h = createHarness();
    h.fetchMetaLeadById.mockRejectedValue(new Error('OAuthException 190'));

    await expect(
      h.service.handleLeadgenEvent({
        leadgenId: '1',
        pageId: '464675790673972',
        formId: null,
        createdTime: null,
      }),
    ).resolves.toBe('failed');

    expect(h.logger.error).toHaveBeenCalled();
  });

  it('reports no_token when the source has no usable credential', async () => {
    const h = createHarness();
    h.findLeadSourceForMetaForm.mockResolvedValue({
      ...leadSource,
      encryptedMetaAccessToken: null,
    });

    await expect(
      h.service.handleLeadgenEvent({
        leadgenId: '1',
        pageId: '464675790673972',
        formId: null,
        createdTime: null,
      }),
    ).resolves.toBe('no_token');

    expect(h.fetchMetaLeadById).not.toHaveBeenCalled();
  });
});

describe('handleWebhookBody', () => {
  it('processes every leadgen event in one delivery', async () => {
    const h = createHarness();
    const body = leadgenBody();
    body.entry[0]!.changes.push({
      field: 'leadgen',
      value: {
        leadgen_id: '2',
        page_id: '464675790673972',
        form_id: '2166324230964931',
        created_time: 1790000001,
      },
    });

    await expect(h.service.handleWebhookBody(body)).resolves.toMatchObject({
      received: 2,
      outcomes: ['imported', 'imported'],
    });
  });

  it('reports zero received for an envelope with nothing in it', async () => {
    const h = createHarness();

    await expect(h.service.handleWebhookBody({ object: 'page', entry: [] })).resolves.toEqual({
      received: 0,
      outcomes: [],
    });
    expect(h.importLead).not.toHaveBeenCalled();
  });
});

/** The single event the counter tests drive, matching the envelope fixture above. */
const EVENT = {
  leadgenId: '1802669104075658',
  pageId: '464675790673972',
  formId: '2166324230964931',
  createdTime: null,
};

describe('the source import counter', () => {
  it('counts a genuinely new lead', async () => {
    // Found in production: the webhook calls importLead directly and so never passed through
    // the poller's recordLeadSourceSync, which is what maintains totalImported. A source fed
    // entirely by webhook sat at "0 leads imported" however many it had actually brought in.
    const h = createHarness();

    await expect(h.service.handleLeadgenEvent(EVENT)).resolves.toBe('imported');

    expect(h.countLeadSourceImport).toHaveBeenCalledTimes(1);
    expect(h.countLeadSourceImport).toHaveBeenCalledWith({ leadSourceId: 'src-1' });
  });

  it('does NOT count a redelivery', async () => {
    // Meta retries anything it thinks was not acknowledged, and we replay deliveries ourselves
    // when testing. Counting a duplicate would inflate the figure every time the same lead
    // arrived twice - which is precisely when the number matters.
    const h = createHarness();
    h.importLead.mockResolvedValue('duplicate');

    await expect(h.service.handleLeadgenEvent(EVENT)).resolves.toBe('duplicate');

    expect(h.countLeadSourceImport).not.toHaveBeenCalled();
  });

  it.each(['skipped', 'failed'])('does NOT count a %s lead', async (outcome) => {
    const h = createHarness();
    h.importLead.mockResolvedValue(outcome);

    await h.service.handleLeadgenEvent(EVENT);

    expect(h.countLeadSourceImport).not.toHaveBeenCalled();
  });

  it('does not count anything when no source matched', async () => {
    const h = createHarness();
    h.findLeadSourceForMetaForm.mockResolvedValue(null);

    await expect(h.service.handleLeadgenEvent(EVENT)).resolves.toBe('no_source');

    expect(h.countLeadSourceImport).not.toHaveBeenCalled();
  });

  it('still reports the lead as imported when the counter write fails', async () => {
    // The lead is already saved by this point. A wrong number on a dashboard is worth far less
    // than a redelivery storm, which is what returning anything other than 'imported' would
    // cause - Meta retries whatever it is not told succeeded.
    const h = createHarness();
    h.countLeadSourceImport.mockRejectedValue(new Error('mongo is down'));

    await expect(h.service.handleLeadgenEvent(EVENT)).resolves.toBe('imported');

    expect(h.logger.error).toHaveBeenCalled();
  });

  it('counts once per new lead across a multi-event delivery', async () => {
    const h = createHarness();
    h.importLead.mockResolvedValueOnce('imported').mockResolvedValueOnce('duplicate');

    const body = leadgenBody();
    body.entry[0]!.changes.push({
      field: 'leadgen',
      value: {
        leadgen_id: '1802669104075659',
        page_id: '464675790673972',
        form_id: '2166324230964931',
        created_time: 1790000001,
      },
    });

    await expect(h.service.handleWebhookBody(body)).resolves.toMatchObject({
      outcomes: ['imported', 'duplicate'],
    });
    expect(h.countLeadSourceImport).toHaveBeenCalledTimes(1);
  });
});
