/**
 * The endpoints behind "Connect Facebook".
 *
 * THE CALLBACK IS THE ODD ONE OUT. Every other route here is authenticated normally. The callback
 * cannot be: Meta redirects the owner's BROWSER to it, and this app's access token lives in
 * memory rather than a cookie, so there is no Authorization header on that request and never will
 * be. Its identity comes entirely from the signed `state` - which is why the organisation and
 * user are inside the signature and never read from a query parameter.
 */
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { createHttpError } from '../../utils/http-error.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';
import { requireAuthContext } from '../../middleware/auth.middleware.js';
import {
  fetchMetaFormQuestions,
  listMetaLeadForms,
  listMetaPagesWithTokens,
} from './meta-graph.client.js';
import { keyForLabel } from './lead-field-rules.js';
import {
  assertMetaOauthConfigured,
  buildMetaAuthorizeUrl,
  exchangeCodeForUserToken,
  extendUserToken,
  fetchMetaAuthorizedUser,
  metaOauthScopeList,
  MetaOauthError,
  signMetaOauthState,
  verifyMetaOauthState,
} from './meta-oauth.service.js';
import {
  disconnectMetaConnection,
  findMetaConnection,
  findMetaConnectionWithSecrets,
  saveMetaConnection,
  serializeMetaConnection,
} from './meta-connection.repository.js';
import { decryptMetaAccessTokenFromStorage } from './meta-credentials.service.js';
import { META_CONNECTION_STATUSES } from './meta-connection.model.js';
import {
  createMetaOauthLeadSourceBodySchema,
  leadSourceIdParamsSchema,
  metaDiagnosticsQuerySchema,
  metaFormFieldsParamsSchema,
  metaOauthCallbackQuerySchema,
  metaPageFormsParamsSchema,
} from './lead-source.validation.js';
import { createMetaActivationService } from './meta-activation.service.js';
import { findLeadSourceById } from './lead-source.repository.js';

/** Where the browser lands after the callback, with a result the wizard can act on. */
const buildReturnUrl = (params: Record<string, string>): string => {
  // The first configured front end is the dashboard's own origin; the callback has no Referer
  // worth trusting and must not bounce the browser somewhere a query parameter chose.
  const origin = String(env.FRONTEND_ORIGIN ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '' && entry !== 'https://localhost')[0];

  const url = new URL('/', origin || 'https://localhost');
  url.searchParams.set('metaConnect', '1');

  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

  return url.toString();
};

/**
 * Loads the organisation's user token, or explains why it cannot.
 *
 * Every discovery endpoint needs it, and every one of them should fail the same recognisable way
 * when the authorisation has lapsed - so the wizard can show "Reconnect" rather than a generic
 * error the owner cannot act on.
 */
const requireUserAccessToken = async (organizationId: unknown): Promise<string> => {
  const connection = await findMetaConnectionWithSecrets({ organizationId: organizationId as never });

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

  return token;
};

/** GET /meta/oauth/start — hands the browser the Facebook URL to visit. */
export const startMetaOauth = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);

  try {
    assertMetaOauthConfigured();
  } catch (error: unknown) {
    if (error instanceof MetaOauthError) {
      throw createHttpError({ statusCode: 503, message: error.message, code: error.code });
    }

    throw error;
  }

  // The organisation and user are signed INTO the state. The callback reads them from there and
  // from nowhere else, which is what stops a captured callback URL being replayed against a
  // different tenant.
  const state = signMetaOauthState({
    organizationId: auth.organization._id.toString(),
    userId: auth.user._id.toString(),
  });

  res.status(200).json({
    data: {
      authorizeUrl: buildMetaAuthorizeUrl({ state }),
      scopes: metaOauthScopeList().split(','),
    },
  });
});

/**
 * GET /meta/oauth/callback — Meta sends the browser here.
 *
 * Unauthenticated by necessity (see the file header). Always REDIRECTS rather than returning
 * JSON, because a human is looking at this in a browser tab: a raw error object is not an answer
 * they can do anything with.
 */
export const completeMetaOauth = asyncHandler(async (req, res) => {
  const query = parseWithSchema({
    schema: metaOauthCallbackQuerySchema,
    value: req.query,
    source: 'Query',
  });

  // The owner pressed Cancel on Facebook's consent screen. Not an error worth a stack trace.
  if (query.error) {
    res.redirect(
      buildReturnUrl({
        metaConnectResult: 'cancelled',
        metaConnectMessage: query.error_description ?? 'Facebook sign-in was cancelled.',
      }),
    );

    return;
  }

  try {
    const state = verifyMetaOauthState(query.state);

    if (!query.code) {
      throw new MetaOauthError('Facebook returned no authorization code.', 'META_OAUTH_NO_CODE');
    }

    // The order here is the whole thing - see meta-oauth.service.ts. Extend BEFORE any Page token
    // is minted, or every Page token dies within the hour.
    const shortLived = await exchangeCodeForUserToken(query.code);
    const longLived = await extendUserToken(shortLived.accessToken);
    const identity = await fetchMetaAuthorizedUser(longLived.accessToken);

    await saveMetaConnection({
      organizationId: state.organizationId,
      metaUserId: identity.id,
      metaUserName: identity.name,
      accessToken: longLived.accessToken,
      accessTokenExpiresAt: longLived.expiresAt,
      grantedScopes: metaOauthScopeList().split(','),
      connectedBy: state.userId,
    });

    res.redirect(buildReturnUrl({ metaConnectResult: 'connected' }));
  } catch (error: unknown) {
    const err = error as { code?: unknown; message?: unknown };

    // Never the token, never the code - only our own classification of what went wrong.
    logger.error(
      { code: err?.code },
      'Facebook sign-in callback failed; the owner was returned to the dashboard.',
    );

    res.redirect(
      buildReturnUrl({
        metaConnectResult: 'failed',
        metaConnectMessage:
          error instanceof MetaOauthError
            ? error.message
            : 'Facebook sign-in could not be completed. Try again.',
      }),
    );
  }
});

/** GET /meta/connection — what the Integrations page renders. */
export const getMetaConnection = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);

  const connection = await findMetaConnection({ organizationId: auth.organization._id });

  res.status(200).json({
    data: {
      connection: serializeMetaConnection(connection),
      // So the page can show "Connect Facebook" as unavailable, with a reason, rather than
      // offering a button that fails at Meta.
      configured: Boolean(env.META_APP_ID && env.META_APP_SECRET && env.META_REDIRECT_URI),
    },
  });
});

/** DELETE /meta/connection — destroys the credential, keeps the record. */
export const removeMetaConnection = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);

  const connection = await disconnectMetaConnection({ organizationId: auth.organization._id });

  res.status(200).json({ data: serializeMetaConnection(connection) });
});

/** GET /meta/pages — the Pages this account manages. Page tokens are NEVER returned. */
export const listConnectedMetaPages = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const token = await requireUserAccessToken(auth.organization._id);

  const pages = await listMetaPagesWithTokens({
    accessToken: token,
    timeoutMs: Number(env.META_GRAPH_TIMEOUT_MS ?? 15_000),
  });

  res.status(200).json({
    data: pages.map((page) => ({ id: page.id, name: page.name, pictureUrl: page.pictureUrl })),
  });
});

/**
 * GET /meta/pages/:pageId/forms — the lead forms on one Page.
 *
 * Uses the PAGE token minted for that page, not the user token: Meta puts `leadgen_forms` behind
 * page-scoped access, and a user token returns an empty list rather than an error, which reads as
 * "this page has no forms" and sends people hunting in the wrong place.
 */
export const listConnectedMetaForms = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: metaPageFormsParamsSchema,
    value: req.params,
    source: 'Params',
  });

  const token = await requireUserAccessToken(auth.organization._id);

  const pages = await listMetaPagesWithTokens({
    accessToken: token,
    timeoutMs: Number(env.META_GRAPH_TIMEOUT_MS ?? 15_000),
  });

  const page = pages.find((entry) => entry.id === params.pageId);

  // Not 404: the page may exist and simply not belong to this authorisation. Saying so is both
  // more accurate and the thing that tells the owner to check which account they signed in with.
  if (!page) {
    throw createHttpError({
      statusCode: 403,
      message: 'That page is not one this Facebook account manages.',
      code: 'META_PAGE_NOT_ACCESSIBLE',
    });
  }

  const forms = await listMetaLeadForms({
    pageId: page.id,
    accessToken: page.accessToken,
    timeoutMs: Number(env.META_GRAPH_TIMEOUT_MS ?? 15_000),
  });

  res.status(200).json({ data: forms });
});

/**
 * GET /meta/pages/:pageId/forms/:formId/fields — the form's questions, each with the mapping the
 * automatic rules would choose.
 *
 * Returning the suggestion alongside the question is what makes the mapping step a REVIEW rather
 * than data entry. LABEL_RULES already gets most forms right; the owner should be confirming, not
 * building the mapping from nothing.
 */
export const listConnectedMetaFormFields = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: metaFormFieldsParamsSchema,
    value: req.params,
    source: 'Params',
  });

  const token = await requireUserAccessToken(auth.organization._id);

  const pages = await listMetaPagesWithTokens({
    accessToken: token,
    timeoutMs: Number(env.META_GRAPH_TIMEOUT_MS ?? 15_000),
  });

  const page = pages.find((entry) => entry.id === params.pageId);

  if (!page) {
    throw createHttpError({
      statusCode: 403,
      message: 'That page is not one this Facebook account manages.',
      code: 'META_PAGE_NOT_ACCESSIBLE',
    });
  }

  const questions = await fetchMetaFormQuestions({
    formId: params.formId,
    accessToken: page.accessToken,
    timeoutMs: Number(env.META_GRAPH_TIMEOUT_MS ?? 15_000),
  });

  res.status(200).json({
    data: questions.map((question) => ({
      ...question,
      // What the importer would do with this question today, with no configuration at all.
      suggestedFactKey: keyForLabel(question.label) ?? keyForLabel(question.key) ?? null,
    })),
  });
});

const activationService = createMetaActivationService();

/**
 * POST /meta/sources — the wizard's Activate button.
 *
 * Creates the source from the connected account, subscribes the Page, and activates. No token in
 * the body: the Page token is minted server-side from the stored user token, which is the whole
 * point of the OAuth flow.
 *
 * Returns 201 either way when the source was created. A failed webhook subscription is NOT an
 * error response - the source exists, is configured, and the poller will import from it; the
 * body carries `webhookSubscribed: false` and the reason so the wizard can offer Retry rather
 * than making the owner rebuild a mapping they already did.
 */
export const createMetaOauthLeadSource = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const body = parseWithSchema({
    schema: createMetaOauthLeadSourceBodySchema,
    value: req.body,
    source: 'Body',
  });

  const result = await activationService.activateMetaLeadSource({
    organizationId: auth.organization._id,
    actorId: auth.user._id,
    name: body.name,
    pageId: body.pageId,
    formId: body.formId,
    formName: body.formName ?? null,
    whatsappAccountId: body.whatsappAccountId,
    defaultCountryCode: body.defaultCountryCode,
    aiContextEnabled: body.aiContextEnabled,
    autoGreetEnabled: body.autoGreetEnabled,
    importExisting: body.importExisting,
    fieldMappings: body.fieldMappings as never,
    defaultStage: body.defaultStage ?? null,
    defaultTagIds: body.defaultTagIds,
    defaultAssigneeId: body.defaultAssigneeId ?? null,
    subscribeWebhook: body.subscribeWebhook,
  });

  res.status(201).json({ data: result });
});

/** POST /meta/sources/:leadSourceId/subscribe — retry a subscription that failed. */
export const retryMetaWebhookSubscription = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: leadSourceIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  const leadSource = await findLeadSourceById({
    leadSourceId: params.leadSourceId,
    organizationId: auth.organization._id,
  });

  if (!leadSource) {
    throw createHttpError({
      statusCode: 404,
      message: 'Lead source not found.',
      code: 'LEAD_SOURCE_NOT_FOUND',
    });
  }

  const result = await activationService.retryWebhookSubscription({
    organizationId: auth.organization._id,
    leadSource: leadSource as never,
  });

  res.status(200).json({ data: result });
});

/**
 * GET /meta/diagnostics — every check the owner would otherwise make by reading logs.
 *
 * Takes the page and form as query parameters so it can be run BEFORE a source exists, during the
 * wizard, as well as against a configured one.
 */
export const runMetaDiagnostics = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const query = parseWithSchema({
    schema: metaDiagnosticsQuerySchema,
    value: req.query,
    source: 'Query',
  });

  const result = await activationService.diagnoseMetaLeadSource({
    organizationId: auth.organization._id,
    pageId: query.pageId,
    formId: query.formId ?? null,
  });

  res.status(200).json({ data: result });
});
