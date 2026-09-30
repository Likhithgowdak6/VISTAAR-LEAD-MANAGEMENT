/**
 * Facebook Login, so nobody has to visit Graph API Explorer.
 *
 * THE ORDER OF THE TOKEN DANCE IS THE WHOLE THING, and getting it wrong produces an integration
 * that works for an hour and then dies with a 190 at 3am:
 *
 *   1. Meta redirects back with a short-lived CODE.
 *   2. Exchange the code for a short-lived USER token (~1 hour).
 *   3. Extend that into a long-lived USER token (~60 days).           <- must happen before 4
 *   4. Call /me/accounts to mint PAGE tokens.
 *
 * Page tokens inherit the lifetime of the user token they were minted from. Do step 4 before step
 * 3 and every Page token expires within the hour. The existing importer stores a Page token per
 * LeadSource and never re-mints it, so a short-lived one is not something it can recover from.
 *
 * WHAT THIS DOES NOT DO. It does not grant access to anyone else's Page. Until the Meta app has
 * Advanced Access (App Review plus Business Verification), Facebook only returns Pages belonging
 * to people with a role on the app - which is correct and sufficient for a studio connecting its
 * own Page, and insufficient for onboarding a client. The flow is identical either way; only
 * Meta's answer changes, so nothing here has to be rewritten when review completes.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { env, type Env } from '../../config/env.js';
import { META_GRAPH_API_VERSION } from './meta-graph.client.js';
import { MetaGraphError } from './lead-source.errors.js';

/**
 * Why each permission is asked for. Kept as data rather than a string literal so the consent
 * screen, the docs and App Review submission cannot drift apart.
 *
 * Deliberately minimal: every extra scope is another thing App Review will ask us to justify,
 * and another thing a cautious business owner sees on the consent screen and hesitates over.
 */
export const META_OAUTH_SCOPES = Object.freeze([
  {
    scope: 'pages_show_list',
    why: 'List the Pages you manage, so you can pick one instead of typing an id.',
  },
  {
    scope: 'pages_read_engagement',
    why: 'Read the Page itself - its name, and that our access to it is still valid.',
  },
  {
    scope: 'leads_retrieval',
    why: 'Read the answers people submit to your lead forms. Without it there are no leads.',
  },
  {
    scope: 'pages_manage_ads',
    why: 'List the lead forms attached to a Page. Meta puts form discovery behind this scope.',
  },
  {
    scope: 'pages_manage_metadata',
    why: 'Subscribe the Page to leadgen webhooks, so leads arrive instantly instead of on a poll.',
  },
  {
    scope: 'business_management',
    why: 'Required when the Page is owned by a Business rather than a person, which most are.',
  },
] as const);

export const metaOauthScopeList = (): string =>
  META_OAUTH_SCOPES.map((entry) => entry.scope).join(',');

export class MetaOauthError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'MetaOauthError';
    this.code = code;
  }
}

/**
 * Fails loudly at the start of the flow rather than at Meta's redirect.
 *
 * A missing app id surfaces at Facebook as "Invalid App ID" on a page the owner cannot debug; a
 * missing redirect URI surfaces as a mismatch error that names nothing useful. Checking here
 * means the error says which variable is empty.
 */
export const assertMetaOauthConfigured = (config: Env = env): void => {
  const missing = (
    [
      ['META_APP_ID', config.META_APP_ID],
      ['META_APP_SECRET', config.META_APP_SECRET],
      ['META_REDIRECT_URI', config.META_REDIRECT_URI],
    ] as const
  )
    .filter(([, value]) => !value || String(value).trim() === '')
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new MetaOauthError(
      `Facebook login is not configured on the server: ${missing.join(', ')} is not set.`,
      'META_OAUTH_NOT_CONFIGURED',
    );
  }
};

export interface MetaOauthStatePayload {
  organizationId: string;
  userId: string;
  issuedAt: number;
  nonce: string;
}

/**
 * The CSRF guard, as a signed value rather than a database row.
 *
 * SIGNED, NOT LOOKED UP, on purpose: the callback arrives on a different request with no session
 * cookie worth trusting, and a stateless token means the handshake survives a restart or a second
 * server. The organization and user are INSIDE the signature - the callback never takes either
 * from a query parameter, which is the hole this exists to close. Anyone can replay a state they
 * captured; they cannot forge one for a different organisation without the app secret.
 */
export const signMetaOauthState = (
  payload: Omit<MetaOauthStatePayload, 'issuedAt' | 'nonce'>,
  config: Env = env,
): string => {
  const body: MetaOauthStatePayload = {
    ...payload,
    issuedAt: Date.now(),
    nonce: randomBytes(12).toString('hex'),
  };

  const encoded = Buffer.from(JSON.stringify(body), 'utf8').toString('base64url');
  const signature = createHmac('sha256', String(config.META_APP_SECRET))
    .update(encoded)
    .digest('base64url');

  return `${encoded}.${signature}`;
};

export const verifyMetaOauthState = (
  state: unknown,
  config: Env = env,
): MetaOauthStatePayload => {
  if (typeof state !== 'string' || !state.includes('.')) {
    throw new MetaOauthError('The Facebook sign-in could not be verified.', 'META_OAUTH_STATE_BAD');
  }

  const [encoded = '', signature = ''] = state.split('.');

  const expected = createHmac('sha256', String(config.META_APP_SECRET))
    .update(encoded)
    .digest('base64url');

  const given = Buffer.from(signature);
  const want = Buffer.from(expected);

  // Length-check first: timingSafeEqual throws on a length mismatch rather than returning false.
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    throw new MetaOauthError('The Facebook sign-in could not be verified.', 'META_OAUTH_STATE_BAD');
  }

  let payload: MetaOauthStatePayload;

  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new MetaOauthError('The Facebook sign-in could not be verified.', 'META_OAUTH_STATE_BAD');
  }

  const ttl = Number(config.META_OAUTH_STATE_TTL_MS ?? 600_000);

  if (!Number.isFinite(payload.issuedAt) || Date.now() - payload.issuedAt > ttl) {
    throw new MetaOauthError(
      'That Facebook sign-in took too long. Start again.',
      'META_OAUTH_STATE_EXPIRED',
    );
  }

  if (!payload.organizationId || !payload.userId) {
    throw new MetaOauthError('The Facebook sign-in could not be verified.', 'META_OAUTH_STATE_BAD');
  }

  return payload;
};

export const buildMetaAuthorizeUrl = ({
  state,
  config = env,
}: {
  state: string;
  config?: Env;
}): string => {
  const url = new URL(`https://www.facebook.com/${META_GRAPH_API_VERSION}/dialog/oauth`);

  url.searchParams.set('client_id', String(config.META_APP_ID));
  url.searchParams.set('redirect_uri', String(config.META_REDIRECT_URI));
  url.searchParams.set('state', state);
  url.searchParams.set('scope', metaOauthScopeList());
  url.searchParams.set('response_type', 'code');

  return url.toString();
};

interface TokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
  error?: { message?: unknown; code?: unknown };
}

export interface MetaTokenResult {
  accessToken: string;
  /** Null when Meta reports no expiry, which it does for some Business-derived tokens. */
  expiresAt: Date | null;
}

const readTokenResponse = (body: TokenResponse, label: string): MetaTokenResult => {
  if (typeof body.access_token !== 'string' || body.access_token === '') {
    const message =
      typeof body.error?.message === 'string' ? body.error.message : 'Meta returned no token.';

    throw new MetaOauthError(`${label}: ${message}`, 'META_OAUTH_TOKEN_FAILED');
  }

  const expiresIn = Number(body.expires_in);

  return {
    accessToken: body.access_token,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null,
  };
};

const postToGraph = async (url: string, fetchFn: typeof fetch, timeoutMs: number) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(url, { signal: controller.signal });
    const body = (await response.json().catch(() => ({}))) as TokenResponse;

    return body;
  } catch (error: unknown) {
    throw new MetaGraphError('Could not reach Facebook to complete sign-in.', {
      code: 'META_OAUTH_UNREACHABLE',
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
};

export interface ExchangeOptions {
  fetchFn?: typeof fetch;
  config?: Env;
}

/** Step 2: the authorization code becomes a SHORT-LIVED user token. */
export const exchangeCodeForUserToken = async (
  code: string,
  { fetchFn = fetch, config = env }: ExchangeOptions = {},
): Promise<MetaTokenResult> => {
  const url = new URL(
    `https://graph.facebook.com/${META_GRAPH_API_VERSION}/oauth/access_token`,
  );

  url.searchParams.set('client_id', String(config.META_APP_ID));
  url.searchParams.set('client_secret', String(config.META_APP_SECRET));
  url.searchParams.set('redirect_uri', String(config.META_REDIRECT_URI));
  url.searchParams.set('code', code);

  const body = await postToGraph(
    url.toString(),
    fetchFn,
    Number(config.META_GRAPH_TIMEOUT_MS ?? 15_000),
  );

  return readTokenResponse(body, 'Facebook sign-in failed');
};

/**
 * Step 3: SHORT-LIVED user token becomes LONG-LIVED (~60 days).
 *
 * Never skip this to save a round trip. Page tokens minted from a short-lived user token expire
 * with it, and the importer has no way to re-mint them.
 */
export const extendUserToken = async (
  shortLivedToken: string,
  { fetchFn = fetch, config = env }: ExchangeOptions = {},
): Promise<MetaTokenResult> => {
  const url = new URL(
    `https://graph.facebook.com/${META_GRAPH_API_VERSION}/oauth/access_token`,
  );

  url.searchParams.set('grant_type', 'fb_exchange_token');
  url.searchParams.set('client_id', String(config.META_APP_ID));
  url.searchParams.set('client_secret', String(config.META_APP_SECRET));
  url.searchParams.set('fb_exchange_token', shortLivedToken);

  const body = await postToGraph(
    url.toString(),
    fetchFn,
    Number(config.META_GRAPH_TIMEOUT_MS ?? 15_000),
  );

  return readTokenResponse(body, 'Could not extend the Facebook session');
};

export interface MetaAuthorizedUser {
  id: string;
  name: string | null;
}

/** Who authorised us. Stored so the dashboard can say "connected as ..." and so a different
 *  account reconnecting is visible rather than silent. */
export const fetchMetaAuthorizedUser = async (
  accessToken: string,
  { fetchFn = fetch, config = env }: ExchangeOptions = {},
): Promise<MetaAuthorizedUser> => {
  const url = new URL(`https://graph.facebook.com/${META_GRAPH_API_VERSION}/me`);
  url.searchParams.set('access_token', accessToken);
  url.searchParams.set('fields', 'id,name');

  const body = (await postToGraph(
    url.toString(),
    fetchFn,
    Number(config.META_GRAPH_TIMEOUT_MS ?? 15_000),
  )) as { id?: unknown; name?: unknown };

  if (typeof body.id !== 'string' || body.id === '') {
    throw new MetaOauthError('Facebook did not say who signed in.', 'META_OAUTH_IDENTITY_MISSING');
  }

  return { id: body.id, name: typeof body.name === 'string' ? body.name : null };
};

/**
 * Meta's webhook signature over the RAW body.
 *
 * Must be computed on the exact bytes received - re-serializing the parsed JSON changes key order
 * and whitespace and the digest stops matching. See the raw-body capture in app.ts.
 */
export const verifyMetaWebhookSignature = ({
  rawBody,
  signatureHeader,
  config = env,
}: {
  rawBody: Buffer | string | undefined;
  signatureHeader: unknown;
  config?: Env;
}): boolean => {
  if (!rawBody || typeof signatureHeader !== 'string' || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const expected = createHmac('sha256', String(config.META_APP_SECRET))
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest('hex');

  const given = Buffer.from(signatureHeader.slice('sha256='.length), 'utf8');
  const want = Buffer.from(expected, 'utf8');

  if (given.length !== want.length) {
    return false;
  }

  return timingSafeEqual(given, want);
};
