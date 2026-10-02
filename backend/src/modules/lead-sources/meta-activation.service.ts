/**
 * Turning a chosen Page and form into a working lead source.
 *
 * The step the wizard's "Activate" button runs, and the only place the OAuth connection, the
 * existing LeadSource creation and Meta's webhook subscription meet:
 *
 *   connection -> page token -> create source (PAUSED) -> subscribe page -> ACTIVE
 *
 * CREATED PAUSED, ACTIVATED ONLY ON A CONFIRMED SUBSCRIPTION. The alternative - create it active
 * and subscribe afterwards - produces the worst failure available here: a source that reads as
 * healthy in the dashboard while quietly depending on the ten-minute poll, with nothing saying
 * the webhook never attached. Paused-with-an-error is visibly unfinished, and retrying is just
 * pressing the button again.
 *
 * THE POLLER IS NOT REPLACED BY ANY OF THIS. A subscribed Page delivers leads in seconds; the
 * poll catches whatever a missed delivery, a lapsed subscription or a brief outage loses. Both
 * doors call the same importLead, so a lead arriving through both produces one conversation.
 */
import { type Env, env } from '../../config/env.js';
import { logger as defaultLogger } from '../../config/logger.js';
import { type ObjectIdLike } from '../../types/common.js';
import { createHttpError } from '../../utils/http-error.js';
import { LEAD_SOURCE_KINDS } from '../../constants/lead-source-kinds.js';
import { LEAD_SOURCE_STATUSES } from '../../constants/lead-source-statuses.js';

/** A source that should import a form's whole history reaches back to the epoch. */
const BEGINNING_OF_TIME = new Date(0);
import {
  fetchPageSubscribedApps as defaultFetchPageSubscribedApps,
  listMetaLeadForms as defaultListMetaLeadForms,
  listMetaPagesWithTokens as defaultListMetaPagesWithTokens,
  subscribePageToLeadgen as defaultSubscribePageToLeadgen,
  unsubscribePageFromLeadgen as defaultUnsubscribePageFromLeadgen,
  META_LEADGEN_FIELD,
  type MetaPageWithToken,
} from './meta-graph.client.js';
import {
  findMetaConnectionWithSecrets as defaultFindMetaConnectionWithSecrets,
  markMetaConnectionStatus as defaultMarkMetaConnectionStatus,
} from './meta-connection.repository.js';
import { decryptMetaAccessTokenFromStorage as defaultDecrypt } from './meta-credentials.service.js';
import { META_CONNECTION_STATUSES } from './meta-connection.model.js';
import {
  createLeadSource as defaultCreateLeadSource,
  recordMetaWebhookSubscription as defaultRecordMetaWebhookSubscription,
} from './lead-source.repository.js';
import { serializeLeadSource } from './lead-source.serializer.js';
import { type LeadSourceFieldMapping } from './lead-source.model.js';

export interface ActivateMetaLeadSourceParams {
  organizationId: ObjectIdLike;
  actorId?: ObjectIdLike | null;
  name: string;
  pageId: string;
  formId: string;
  formName?: string | null;
  whatsappAccountId: ObjectIdLike;
  defaultCountryCode: string;
  aiContextEnabled?: boolean;
  autoGreetEnabled?: boolean;
  importExisting?: boolean;
  fieldMappings?: LeadSourceFieldMapping[];
  defaultStage?: string | null;
  defaultTagIds?: ObjectIdLike[];
  defaultAssigneeId?: ObjectIdLike | null;
  subscribeWebhook?: boolean;
}

export interface CreateMetaActivationServiceOptions {
  config?: Env;
  findMetaConnectionWithSecrets?: typeof defaultFindMetaConnectionWithSecrets;
  markMetaConnectionStatus?: typeof defaultMarkMetaConnectionStatus;
  decryptMetaAccessTokenFromStorage?: typeof defaultDecrypt;
  listMetaPagesWithTokens?: typeof defaultListMetaPagesWithTokens;
  listMetaLeadForms?: typeof defaultListMetaLeadForms;
  subscribePageToLeadgen?: typeof defaultSubscribePageToLeadgen;
  unsubscribePageFromLeadgen?: typeof defaultUnsubscribePageFromLeadgen;
  fetchPageSubscribedApps?: typeof defaultFetchPageSubscribedApps;
  createLeadSource?: typeof defaultCreateLeadSource;
  recordMetaWebhookSubscription?: typeof defaultRecordMetaWebhookSubscription;
  logger?: { info?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };
}

export const createMetaActivationService = ({
  config = env,
  findMetaConnectionWithSecrets = defaultFindMetaConnectionWithSecrets,
  markMetaConnectionStatus = defaultMarkMetaConnectionStatus,
  decryptMetaAccessTokenFromStorage = defaultDecrypt,
  listMetaPagesWithTokens = defaultListMetaPagesWithTokens,
  listMetaLeadForms = defaultListMetaLeadForms,
  subscribePageToLeadgen = defaultSubscribePageToLeadgen,
  unsubscribePageFromLeadgen = defaultUnsubscribePageFromLeadgen,
  fetchPageSubscribedApps = defaultFetchPageSubscribedApps,
  createLeadSource = defaultCreateLeadSource,
  recordMetaWebhookSubscription = defaultRecordMetaWebhookSubscription,
  logger = defaultLogger,
}: CreateMetaActivationServiceOptions = {}) => {
  const timeoutMs = Number(config.META_GRAPH_TIMEOUT_MS ?? 15_000);

  /**
   * The organisation's user token, or a 409 the wizard can turn into a Reconnect button.
   *
   * Also the place a revoked authorisation is recognised and RECORDED, so every source that
   * depends on it stops guessing independently ten minutes apart.
   */
  const requireUserToken = async (
    organizationId: ObjectIdLike,
  ): Promise<{ token: string; connectionId: ObjectIdLike | null }> => {
    const connection = await findMetaConnectionWithSecrets({ organizationId });

    if (!connection || connection.status === META_CONNECTION_STATUSES.DISCONNECTED) {
      throw createHttpError({
        statusCode: 409,
        message: 'Connect Facebook first.',
        code: 'META_NOT_CONNECTED',
      });
    }

    const token = decryptMetaAccessTokenFromStorage(connection.encryptedUserAccessToken);

    if (!token) {
      throw createHttpError({
        statusCode: 409,
        message: 'The Facebook connection needs attention. Reconnect to continue.',
        code: 'META_NEEDS_RECONNECT',
      });
    }

    // The id travels with the token because the source being created has to record WHICH
    // authorisation produced it. Returning only the token is what left `metaConnectionId` null on
    // every OAuth-created source, and with it `usesFacebookLogin` permanently false.
    return { token, connectionId: (connection as { _id?: ObjectIdLike })._id ?? null };
  };

  /**
   * The chosen Page, with its own token - and the ownership check in one step.
   *
   * Asking Meta which Pages this authorisation manages, rather than trusting the id in the
   * request, is what stops one organisation configuring a source against a Page it does not
   * control. A page id is a public number; possession of it proves nothing.
   */
  const requirePage = async (
    organizationId: ObjectIdLike,
    pageId: string,
    // Widened rather than changed: the three read-only callers keep ignoring the extra field,
    // and only activation — the one that persists a source — reads it.
  ): Promise<MetaPageWithToken & { connectionId: ObjectIdLike | null }> => {
    const { token: userToken, connectionId } = await requireUserToken(organizationId);

    let pages: MetaPageWithToken[];

    try {
      pages = await listMetaPagesWithTokens({ accessToken: userToken, timeoutMs });
    } catch (error: unknown) {
      // Meta refusing the user token IS the revocation signal - record it once, here, rather than
      // letting every source rediscover it.
      await markMetaConnectionStatus({
        organizationId,
        status: META_CONNECTION_STATUSES.NEEDS_ATTENTION,
        lastError: error instanceof Error ? error.message : 'Facebook rejected the connection.',
      }).catch(() => undefined);

      throw createHttpError({
        statusCode: 409,
        message: 'Facebook rejected the connection. Reconnect and try again.',
        code: 'META_NEEDS_RECONNECT',
      });
    }

    const page = pages.find((entry) => entry.id === pageId);

    if (!page) {
      throw createHttpError({
        statusCode: 403,
        message: 'That page is not one this Facebook account manages.',
        code: 'META_PAGE_NOT_ACCESSIBLE',
      });
    }

    return { ...page, connectionId };
  };

  /**
   * Subscribes a Page, and reports WHY it failed rather than just that it did.
   *
   * Never throws: the caller decides what a failure means, and for activation it means "leave the
   * source paused and retryable", not "lose the source the owner just configured".
   */
  const subscribePage = async (
    page: MetaPageWithToken,
  ): Promise<{ subscribed: boolean; error: string | null }> => {
    try {
      const subscribed = await subscribePageToLeadgen({
        pageId: page.id,
        accessToken: page.accessToken,
        timeoutMs,
      });

      return subscribed
        ? { subscribed: true, error: null }
        : { subscribed: false, error: 'Facebook did not confirm the webhook subscription.' };
    } catch (error: unknown) {
      return {
        subscribed: false,
        error:
          error instanceof Error
            ? error.message
            : 'Facebook refused the webhook subscription.',
      };
    }
  };

  /**
   * Create the source, subscribe the Page, activate.
   *
   * ROLLBACK IS DELIBERATELY NARROW. If the source cannot be created, nothing exists and there is
   * nothing to undo. If it is created and the subscription fails, the source is KEPT - paused,
   * with the reason on it - because the owner's configuration (the mapping, the defaults, the
   * form choice) is worth more than the tidiness of deleting it, and the poller will still import
   * from it the moment they activate. Deleting on a transient Meta error would throw away several
   * minutes of their work for something that fixes itself on retry.
   */
  const activateMetaLeadSource = async ({
    organizationId,
    actorId = null,
    name,
    pageId,
    formId,
    formName = null,
    whatsappAccountId,
    defaultCountryCode,
    aiContextEnabled = false,
    autoGreetEnabled = false,
    importExisting = false,
    fieldMappings = [],
    defaultStage = null,
    defaultTagIds = [],
    defaultAssigneeId = null,
    subscribeWebhook = true,
  }: ActivateMetaLeadSourceParams) => {
    const page = await requirePage(organizationId, pageId);

    // Confirms the form belongs to this Page before anything is written. A form id from another
    // page would otherwise create a source that imports nothing, with no visible reason.
    const forms = await listMetaLeadForms({
      pageId: page.id,
      accessToken: page.accessToken,
      timeoutMs,
    });

    const form = forms.find((entry) => entry.id === formId);

    if (!form) {
      throw createHttpError({
        statusCode: 404,
        message: 'That lead form is not on the selected page.',
        code: 'META_FORM_NOT_FOUND',
      });
    }

    const leadSource = await createLeadSource({
      organizationId,
      name,
      kind: LEAD_SOURCE_KINDS.META_LEAD_ADS,
      // The PAGE token, minted through OAuth - the owner never sees or handles it.
      meta: {
        pageId: page.id,
        pageName: page.name,
        formId: form.id,
        formName: formName ?? form.name,
        accessToken: page.accessToken,
      },
      // Which authorisation this source belongs to. Without it the dashboard cannot tell an
      // OAuth source from a pasted-token one, and the connection panel never appears.
      metaConnectionId: page.connectionId,
      whatsappAccountId,
      defaultCountryCode,
      aiContextEnabled,
      autoGreetEnabled,
      // Same rule the pasted-token path uses: importing existing leads means reaching back to
      // the beginning of time, otherwise only what arrives from now on.
      importFromTime: importExisting ? BEGINNING_OF_TIME : new Date(),
      createdBy: actorId,
      fieldMappings,
      defaultStage,
      defaultTagIds,
      defaultAssigneeId,
      // Paused until the subscription is confirmed. See the header on why this order matters.
      status: LEAD_SOURCE_STATUSES.PAUSED,
    });

    if (!leadSource) {
      throw createHttpError({
        statusCode: 500,
        message: 'The lead source could not be created.',
        code: 'LEAD_SOURCE_NOT_CREATED',
      });
    }

    // Poll-only by request: still a working source, just without the seconds-not-minutes path.
    if (!subscribeWebhook) {
      const activated = await recordMetaWebhookSubscription({
        leadSourceId: leadSource._id,
        organizationId,
        subscribed: false,
        error: null,
      });

      return {
        leadSource: serializeLeadSource(activated ?? leadSource),
        webhookSubscribed: false,
        webhookError: null,
      };
    }

    const { subscribed, error } = await subscribePage(page);

    const updated = await recordMetaWebhookSubscription({
      leadSourceId: leadSource._id,
      organizationId,
      subscribed,
      error,
    });

    if (!subscribed) {
      logger.error?.(
        { leadSourceId: leadSource._id?.toString?.(), pageId: page.id },
        'Meta webhook subscription failed; the lead source was kept paused so it can be retried.',
      );
    }

    return {
      leadSource: serializeLeadSource(updated ?? leadSource),
      webhookSubscribed: subscribed,
      webhookError: error,
    };
  };

  /** Retry for a source whose subscription failed, without rebuilding its configuration. */
  const retryWebhookSubscription = async ({
    organizationId,
    leadSource,
  }: {
    organizationId: ObjectIdLike;
    leadSource: { _id: ObjectIdLike; meta?: { pageId?: string | null } };
  }) => {
    const pageId = leadSource.meta?.pageId;

    if (!pageId) {
      throw createHttpError({
        statusCode: 400,
        message: 'That lead source has no Facebook page to subscribe.',
        code: 'META_PAGE_MISSING',
      });
    }

    const page = await requirePage(organizationId, pageId);
    const { subscribed, error } = await subscribePage(page);

    const updated = await recordMetaWebhookSubscription({
      leadSourceId: leadSource._id,
      organizationId,
      subscribed,
      error,
    });

    return {
      leadSource: updated ? serializeLeadSource(updated) : null,
      webhookSubscribed: subscribed,
      webhookError: error,
    };
  };

  /**
   * Best-effort unsubscribe when a source is removed.
   *
   * Never throws. A failure here leaves Meta posting events the webhook will drop for want of a
   * configured source - untidy, harmless - whereas refusing to let someone delete a source
   * because Meta is briefly unreachable is neither.
   */
  const unsubscribePageForSource = async ({
    organizationId,
    pageId,
  }: {
    organizationId: ObjectIdLike;
    pageId?: string | null;
  }): Promise<boolean> => {
    if (!pageId) {
      return false;
    }

    try {
      const page = await requirePage(organizationId, pageId);

      return await unsubscribePageFromLeadgen({
        pageId: page.id,
        accessToken: page.accessToken,
        timeoutMs,
      });
    } catch {
      logger.info?.(
        { pageId },
        'Could not unsubscribe the page from Meta webhooks; events for it will simply be ignored.',
      );

      return false;
    }
  };

  /**
   * Every check the owner would otherwise make by reading logs.
   *
   * Each step is reported independently rather than short-circuiting, because "the token works
   * but the page is not subscribed" and "the token is dead" need completely different actions and
   * a single pass/fail cannot tell them apart.
   */
  const diagnoseMetaLeadSource = async ({
    organizationId,
    pageId,
    formId,
  }: {
    organizationId: ObjectIdLike;
    pageId?: string | null;
    formId?: string | null;
  }) => {
    const checks: { key: string; ok: boolean; detail: string }[] = [];
    const add = (key: string, ok: boolean, detail: string) => checks.push({ key, ok, detail });

    let page: MetaPageWithToken;

    try {
      page = await requirePage(organizationId, String(pageId ?? ''));
      add('connection', true, 'Facebook account connected.');
      add('page_access', true, `Page access verified: ${page.name ?? page.id}.`);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Facebook access failed.';

      add('connection', false, message);
      add('page_access', false, 'Not checked - the connection failed first.');
      add('form_access', false, 'Not checked.');
      add('webhook', false, 'Not checked.');

      return { ok: false, checks };
    }

    try {
      const forms = await listMetaLeadForms({
        pageId: page.id,
        accessToken: page.accessToken,
        timeoutMs,
      });

      const form = formId ? forms.find((entry) => entry.id === formId) : forms[0];

      add(
        'form_access',
        Boolean(form),
        form
          ? `Lead form found: ${form.name ?? form.id}.`
          : 'That lead form was not found on this page.',
      );
    } catch (error: unknown) {
      add(
        'form_access',
        false,
        error instanceof Error ? error.message : 'Could not read the page lead forms.',
      );
    }

    try {
      const apps = await fetchPageSubscribedApps({
        pageId: page.id,
        accessToken: page.accessToken,
        timeoutMs,
      });

      const subscribed = apps.some((app) => app.subscribedFields.includes(META_LEADGEN_FIELD));

      add(
        'webhook',
        subscribed,
        subscribed
          ? 'Page is subscribed to leadgen webhooks.'
          : 'Page is not subscribed - leads will still arrive on the ten-minute poll.',
      );
    } catch (error: unknown) {
      add(
        'webhook',
        false,
        error instanceof Error ? error.message : 'Could not read the page subscriptions.',
      );
    }

    return { ok: checks.every((check) => check.ok), checks };
  };

  return {
    activateMetaLeadSource,
    retryWebhookSubscription,
    unsubscribePageForSource,
    diagnoseMetaLeadSource,
  };
};

export type MetaActivationService = ReturnType<typeof createMetaActivationService>;
