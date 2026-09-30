/**
 * Activation: the step that turns a chosen Page and form into a working source.
 *
 * The behaviour worth pinning is what happens when Meta says no. A source created ACTIVE with a
 * failed subscription is the worst outcome available here - it reads as healthy while silently
 * depending on the ten-minute poll, and nothing anywhere says the webhook never attached. So the
 * order is: create paused, subscribe, activate only on a confirmed subscription.
 *
 * Every collaborator is injected; no Mongo, no network, no encryption keyring.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', META_GRAPH_TIMEOUT_MS: 15_000 },
}));

vi.mock('./lead-source.serializer.js', () => ({
  serializeLeadSource: (value: unknown) => value,
}));

const { createMetaActivationService } = await import('./meta-activation.service.js');

const ORG = 'org-1';
const PAGE = { id: '464675790673972', name: 'Wedding Genie', accessToken: 'page-tok', pictureUrl: null };
const FORM = { id: '2166324230964931', name: 'wedding/Birthday Sept- dec', status: 'ACTIVE' };

const createHarness = (overrides: Record<string, unknown> = {}) => {
  const findMetaConnectionWithSecrets = vi
    .fn()
    .mockResolvedValue({ status: 'active', encryptedUserAccessToken: { ciphertext: 'x' } });
  const markMetaConnectionStatus = vi.fn().mockResolvedValue(undefined);
  const listMetaPagesWithTokens = vi.fn().mockResolvedValue([PAGE]);
  const listMetaLeadForms = vi.fn().mockResolvedValue([FORM]);
  const subscribePageToLeadgen = vi.fn().mockResolvedValue(true);
  const unsubscribePageFromLeadgen = vi.fn().mockResolvedValue(true);
  const fetchPageSubscribedApps = vi
    .fn()
    .mockResolvedValue([{ id: 'app-1', name: 'Vistaar', subscribedFields: ['leadgen'] }]);
  const createLeadSource = vi
    .fn()
    .mockResolvedValue({ _id: 'src-1', status: 'paused', meta: { pageId: PAGE.id } });
  const recordMetaWebhookSubscription = vi
    .fn()
    .mockImplementation(({ subscribed }: { subscribed: boolean }) =>
      Promise.resolve({ _id: 'src-1', status: subscribed ? 'active' : 'paused' }),
    );
  const logger = { info: vi.fn(), error: vi.fn() };

  const service = createMetaActivationService({
    config: { META_GRAPH_TIMEOUT_MS: 15_000 } as never,
    findMetaConnectionWithSecrets: findMetaConnectionWithSecrets as never,
    markMetaConnectionStatus: markMetaConnectionStatus as never,
    // Mirrors the real helper's one meaningful behaviour: absent credential decrypts to null.
    decryptMetaAccessTokenFromStorage: ((field: unknown) => (field ? 'user-tok' : null)) as never,
    listMetaPagesWithTokens: listMetaPagesWithTokens as never,
    listMetaLeadForms: listMetaLeadForms as never,
    subscribePageToLeadgen: subscribePageToLeadgen as never,
    unsubscribePageFromLeadgen: unsubscribePageFromLeadgen as never,
    fetchPageSubscribedApps: fetchPageSubscribedApps as never,
    createLeadSource: createLeadSource as never,
    recordMetaWebhookSubscription: recordMetaWebhookSubscription as never,
    logger,
    ...overrides,
  });

  return {
    service,
    findMetaConnectionWithSecrets,
    markMetaConnectionStatus,
    listMetaPagesWithTokens,
    listMetaLeadForms,
    subscribePageToLeadgen,
    unsubscribePageFromLeadgen,
    fetchPageSubscribedApps,
    createLeadSource,
    recordMetaWebhookSubscription,
    logger,
  };
};

const activateParams = {
  organizationId: ORG,
  actorId: 'user-1',
  name: 'Wedding Genie - Meta',
  pageId: PAGE.id,
  formId: FORM.id,
  whatsappAccountId: 'acct-1',
  defaultCountryCode: '91',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('activateMetaLeadSource - the happy path', () => {
  it('creates the source PAUSED, subscribes, then activates', async () => {
    const h = createHarness();

    const result = await h.service.activateMetaLeadSource(activateParams);

    // Created paused: a source that is active before the subscription is confirmed reads as
    // healthy while depending on the poll, with nothing saying the webhook never attached.
    expect(h.createLeadSource).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'paused' }),
    );
    expect(h.subscribePageToLeadgen).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: PAGE.id, accessToken: 'page-tok' }),
    );
    expect(h.recordMetaWebhookSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ subscribed: true, error: null }),
    );
    expect(result.webhookSubscribed).toBe(true);
  });

  it('stores the Page token minted through OAuth, never a pasted one', async () => {
    const h = createHarness();

    await h.service.activateMetaLeadSource(activateParams);

    expect(h.createLeadSource).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: expect.objectContaining({ pageId: PAGE.id, accessToken: 'page-tok' }),
      }),
    );
  });

  it('carries the field mappings and defaults onto the source', async () => {
    const h = createHarness();

    await h.service.activateMetaLeadSource({
      ...activateParams,
      fieldMappings: [{ metaKey: 'venue', metaLabel: 'Venue', factKey: 'city' }],
      defaultStage: 'contacted',
      defaultTagIds: ['tag-1'],
      defaultAssigneeId: 'user-2',
    });

    expect(h.createLeadSource).toHaveBeenCalledWith(
      expect.objectContaining({
        fieldMappings: [{ metaKey: 'venue', metaLabel: 'Venue', factKey: 'city' }],
        defaultStage: 'contacted',
        defaultTagIds: ['tag-1'],
        defaultAssigneeId: 'user-2',
      }),
    );
  });

  it('skips the subscription when the owner asked for poll-only', async () => {
    const h = createHarness();

    const result = await h.service.activateMetaLeadSource({
      ...activateParams,
      subscribeWebhook: false,
    });

    expect(h.subscribePageToLeadgen).not.toHaveBeenCalled();
    expect(result.webhookSubscribed).toBe(false);
    expect(result.webhookError).toBeNull();
  });
});

describe('activateMetaLeadSource - when Meta says no', () => {
  it('keeps the source paused and retryable when the subscription fails', async () => {
    // The source is KEPT, not deleted. The owner's mapping and defaults are worth more than the
    // tidiness of removing it, and the poller still imports from it once they activate.
    const h = createHarness();
    h.subscribePageToLeadgen.mockRejectedValue(new Error('(#200) Requires pages_manage_metadata'));

    const result = await h.service.activateMetaLeadSource(activateParams);

    expect(result.webhookSubscribed).toBe(false);
    expect(result.webhookError).toContain('pages_manage_metadata');
    expect(h.recordMetaWebhookSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ subscribed: false }),
    );
    expect(h.logger.error).toHaveBeenCalled();
  });

  it('treats an unconfirmed subscription as a failure, not a success', async () => {
    // Meta answering 200 without success:true is not a subscription. Reading it as one would
    // activate a source whose webhook silently never fires.
    const h = createHarness();
    h.subscribePageToLeadgen.mockResolvedValue(false);

    const result = await h.service.activateMetaLeadSource(activateParams);

    expect(result.webhookSubscribed).toBe(false);
    expect(result.webhookError).toMatch(/did not confirm/i);
  });

  it('refuses a page this Facebook account does not manage', async () => {
    // A page id is a public number; possessing one proves nothing. Asking Meta which pages the
    // authorisation actually manages is the ownership check.
    const h = createHarness();
    h.listMetaPagesWithTokens.mockResolvedValue([]);

    await expect(h.service.activateMetaLeadSource(activateParams)).rejects.toMatchObject({
      code: 'META_PAGE_NOT_ACCESSIBLE',
    });
    expect(h.createLeadSource).not.toHaveBeenCalled();
  });

  it('refuses a form that is not on the selected page', async () => {
    const h = createHarness();
    h.listMetaLeadForms.mockResolvedValue([{ id: 'another-form', name: 'Other', status: 'ACTIVE' }]);

    await expect(h.service.activateMetaLeadSource(activateParams)).rejects.toMatchObject({
      code: 'META_FORM_NOT_FOUND',
    });
    expect(h.createLeadSource).not.toHaveBeenCalled();
  });

  it('asks for a reconnect when no account is connected', async () => {
    const h = createHarness();
    h.findMetaConnectionWithSecrets.mockResolvedValue(null);

    await expect(h.service.activateMetaLeadSource(activateParams)).rejects.toMatchObject({
      code: 'META_NOT_CONNECTED',
    });
  });

  it('asks for a reconnect when the stored credential is gone', async () => {
    const h = createHarness();
    h.findMetaConnectionWithSecrets.mockResolvedValue({
      status: 'active',
      encryptedUserAccessToken: null,
    });

    await expect(h.service.activateMetaLeadSource(activateParams)).rejects.toMatchObject({
      code: 'META_NEEDS_RECONNECT',
    });
  });

  it('records the revocation once when Meta rejects the user token', async () => {
    // Otherwise every source rediscovers the same 190 independently, ten minutes apart, and the
    // log fills with identical errors that bury anything real.
    const h = createHarness();
    h.listMetaPagesWithTokens.mockRejectedValue(new Error('OAuthException 190: token expired'));

    await expect(h.service.activateMetaLeadSource(activateParams)).rejects.toMatchObject({
      code: 'META_NEEDS_RECONNECT',
    });

    expect(h.markMetaConnectionStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'needs_attention' }),
    );
  });
});

describe('retryWebhookSubscription', () => {
  it('re-subscribes without rebuilding the configuration', async () => {
    const h = createHarness();

    const result = await h.service.retryWebhookSubscription({
      organizationId: ORG,
      leadSource: { _id: 'src-1', meta: { pageId: PAGE.id } },
    });

    expect(h.createLeadSource).not.toHaveBeenCalled();
    expect(result.webhookSubscribed).toBe(true);
  });

  it('is idempotent - re-subscribing an already-subscribed page still succeeds', async () => {
    // Meta returns success for a duplicate subscribe, so a retry after a half-failed activation
    // does not have to know whether it has run before.
    const h = createHarness();

    await h.service.retryWebhookSubscription({
      organizationId: ORG,
      leadSource: { _id: 'src-1', meta: { pageId: PAGE.id } },
    });
    const second = await h.service.retryWebhookSubscription({
      organizationId: ORG,
      leadSource: { _id: 'src-1', meta: { pageId: PAGE.id } },
    });

    expect(second.webhookSubscribed).toBe(true);
  });

  it('refuses a source with no page', async () => {
    const h = createHarness();

    await expect(
      h.service.retryWebhookSubscription({
        organizationId: ORG,
        leadSource: { _id: 'src-1', meta: {} },
      }),
    ).rejects.toMatchObject({ code: 'META_PAGE_MISSING' });
  });
});

describe('unsubscribePageForSource', () => {
  it('unsubscribes the page', async () => {
    const h = createHarness();

    await expect(
      h.service.unsubscribePageForSource({ organizationId: ORG, pageId: PAGE.id }),
    ).resolves.toBe(true);
    expect(h.unsubscribePageFromLeadgen).toHaveBeenCalledWith(
      expect.objectContaining({ pageId: PAGE.id }),
    );
  });

  it('never throws when Meta is unreachable', async () => {
    // Refusing to let someone delete a source because Meta is briefly down would be worse than
    // leaving a subscription behind - the webhook drops events with no configured source anyway.
    const h = createHarness();
    h.unsubscribePageFromLeadgen.mockRejectedValue(new Error('network'));

    await expect(
      h.service.unsubscribePageForSource({ organizationId: ORG, pageId: PAGE.id }),
    ).resolves.toBe(false);
  });

  it('does nothing without a page id', async () => {
    const h = createHarness();

    await expect(
      h.service.unsubscribePageForSource({ organizationId: ORG, pageId: null }),
    ).resolves.toBe(false);
    expect(h.unsubscribePageFromLeadgen).not.toHaveBeenCalled();
  });
});

describe('diagnoseMetaLeadSource', () => {
  it('reports every check passing', async () => {
    const h = createHarness();

    const result = await h.service.diagnoseMetaLeadSource({
      organizationId: ORG,
      pageId: PAGE.id,
      formId: FORM.id,
    });

    expect(result.ok).toBe(true);
    expect(result.checks.map((check) => check.key)).toEqual([
      'connection',
      'page_access',
      'form_access',
      'webhook',
    ]);
  });

  it('separates "token works but page is not subscribed" from "token is dead"', async () => {
    // These need completely different actions - subscribe versus reconnect - and a single
    // pass/fail cannot tell them apart.
    const h = createHarness();
    h.fetchPageSubscribedApps.mockResolvedValue([
      { id: 'app-1', name: 'Vistaar', subscribedFields: ['feed'] },
    ]);

    const result = await h.service.diagnoseMetaLeadSource({
      organizationId: ORG,
      pageId: PAGE.id,
      formId: FORM.id,
    });

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.key === 'connection')?.ok).toBe(true);
    expect(result.checks.find((check) => check.key === 'webhook')?.ok).toBe(false);
    // And says the poller still covers it, so the owner knows leads are not being lost.
    expect(result.checks.find((check) => check.key === 'webhook')?.detail).toMatch(/poll/i);
  });

  it('stops after the connection fails, and says so rather than reporting false failures', async () => {
    const h = createHarness();
    h.findMetaConnectionWithSecrets.mockResolvedValue(null);

    const result = await h.service.diagnoseMetaLeadSource({
      organizationId: ORG,
      pageId: PAGE.id,
      formId: FORM.id,
    });

    expect(result.ok).toBe(false);
    expect(result.checks.find((check) => check.key === 'connection')?.ok).toBe(false);
    expect(result.checks.find((check) => check.key === 'form_access')?.detail).toMatch(/not checked/i);
  });

  it('reports a missing form without failing the whole diagnosis', async () => {
    const h = createHarness();
    h.listMetaLeadForms.mockResolvedValue([]);

    const result = await h.service.diagnoseMetaLeadSource({
      organizationId: ORG,
      pageId: PAGE.id,
      formId: FORM.id,
    });

    expect(result.checks.find((check) => check.key === 'form_access')?.ok).toBe(false);
    // The webhook check still ran - each step is independent on purpose.
    expect(result.checks.find((check) => check.key === 'webhook')?.ok).toBe(true);
  });
});
