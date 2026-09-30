/**
 * The security-critical half of Facebook Login: the CSRF state and the webhook signature.
 *
 * Both are things whose failure is INVISIBLE. A state check that accepts anything still completes
 * the happy path, and a signature check that always returns true still receives real webhooks -
 * you only find out when someone forges one. So these are tested as adversarially as a unit test
 * can manage: tampered payloads, swapped signatures, wrong secret, expired windows.
 */
import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const {
  assertMetaOauthConfigured,
  buildMetaAuthorizeUrl,
  metaOauthScopeList,
  META_OAUTH_SCOPES,
  MetaOauthError,
  signMetaOauthState,
  verifyMetaOauthState,
  verifyMetaWebhookSignature,
} = await import('./meta-oauth.service.js');

/**
 * Only the keys these functions read. Typed as a partial rather than a whole Env so the test does
 * not have to invent sixty unrelated variables, and cast once here rather than at every call.
 */
type TestEnv = Parameters<typeof buildMetaAuthorizeUrl>[0]['config'];

const config = {
  META_APP_ID: '1767841351085994',
  META_APP_SECRET: 'test-app-secret-not-a-real-one',
  META_REDIRECT_URI: 'https://vistaarcrm.duckdns.org/api/v1/lead-sources/meta/oauth/callback',
  META_OAUTH_STATE_TTL_MS: 600_000,
  META_GRAPH_TIMEOUT_MS: 15_000,
} as unknown as NonNullable<TestEnv>;

const ORG = '6ab4c2037469f65204cfe999';
const USER = '6ab4c2037469f65204cfe99a';

describe('assertMetaOauthConfigured', () => {
  it('passes when all three are set', () => {
    expect(() => assertMetaOauthConfigured(config)).not.toThrow();
  });

  it.each(['META_APP_ID', 'META_APP_SECRET', 'META_REDIRECT_URI'])(
    'names %s when it is missing, rather than failing at Facebook',
    (missing) => {
      // The failure this prevents: an empty app id surfaces at Facebook as "Invalid App ID" on a
      // page the owner cannot debug, with nothing pointing back at the server's config.
      expect(() => assertMetaOauthConfigured({ ...config, [missing]: '' } as NonNullable<TestEnv>)).toThrow(
        new RegExp(missing),
      );
    },
  );
});

describe('the requested scopes', () => {
  it('asks for exactly what lead retrieval needs, and documents why', () => {
    expect(metaOauthScopeList().split(',')).toEqual([
      'pages_show_list',
      'pages_read_engagement',
      'leads_retrieval',
      'pages_manage_ads',
      'pages_manage_metadata',
      'business_management',
    ]);

    // Every scope carries its justification - App Review asks for one per permission, and a
    // reason written months later is a reason reconstructed rather than remembered.
    for (const entry of META_OAUTH_SCOPES) {
      expect(entry.why.length).toBeGreaterThan(20);
    }
  });
});

describe('buildMetaAuthorizeUrl', () => {
  it('sends the state and the exact registered redirect', () => {
    const url = new URL(buildMetaAuthorizeUrl({ state: 'signed-state', config }));

    expect(url.searchParams.get('client_id')).toBe(config.META_APP_ID);
    expect(url.searchParams.get('state')).toBe('signed-state');
    expect(url.searchParams.get('response_type')).toBe('code');
    // Meta compares the redirect as a whole string. A trailing slash is a different URI.
    expect(url.searchParams.get('redirect_uri')).toBe(config.META_REDIRECT_URI);
  });

  it('never carries the app secret', () => {
    expect(buildMetaAuthorizeUrl({ state: 's', config })).not.toContain(config.META_APP_SECRET);
  });
});

describe('the OAuth state — CSRF', () => {
  it('round-trips the organisation and user it was signed for', () => {
    const state = signMetaOauthState({ organizationId: ORG, userId: USER }, config);

    expect(verifyMetaOauthState(state, config)).toMatchObject({
      organizationId: ORG,
      userId: USER,
    });
  });

  it('is unique per call, so a captured state cannot be predicted', () => {
    const a = signMetaOauthState({ organizationId: ORG, userId: USER }, config);
    const b = signMetaOauthState({ organizationId: ORG, userId: USER }, config);

    expect(a).not.toBe(b);
  });

  it('rejects a payload edited to point at another organisation', () => {
    // The attack this closes: the callback must never read the organisation from the query
    // string. Swapping the org inside the payload invalidates the signature.
    const state = signMetaOauthState({ organizationId: ORG, userId: USER }, config);
    const [encoded, signature] = state.split('.');
    const payload = JSON.parse(Buffer.from(encoded!, 'base64url').toString('utf8'));
    payload.organizationId = '000000000000000000000000';
    const forged = `${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}.${signature}`;

    expect(() => verifyMetaOauthState(forged, config)).toThrow(MetaOauthError);
  });

  it('rejects a state signed with a different app secret', () => {
    const state = signMetaOauthState(
      { organizationId: ORG, userId: USER },
      { ...config, META_APP_SECRET: 'someone-elses-secret' } as NonNullable<TestEnv>,
    );

    expect(() => verifyMetaOauthState(state, config)).toThrow(MetaOauthError);
  });

  it.each([undefined, null, '', 'no-dot', 'a.b', 42, {}])('rejects %p', (state) => {
    expect(() => verifyMetaOauthState(state as never, config)).toThrow(MetaOauthError);
  });

  it('expires, so a stolen state has a short life', () => {
    const state = signMetaOauthState({ organizationId: ORG, userId: USER }, config);

    expect(() =>
      verifyMetaOauthState(state, { ...config, META_OAUTH_STATE_TTL_MS: 60_000 } as NonNullable<TestEnv>),
    ).not.toThrow();

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 700_000);

    try {
      expect(() => verifyMetaOauthState(state, config)).toThrow(/took too long/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the webhook signature', () => {
  const rawBody = Buffer.from(
    JSON.stringify({ object: 'page', entry: [{ id: '464675790673972' }] }),
    'utf8',
  );

  const sign = (body: Buffer, secret = config.META_APP_SECRET) =>
    `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

  it('accepts a body signed with the app secret', () => {
    expect(
      verifyMetaWebhookSignature({ rawBody, signatureHeader: sign(rawBody), config }),
    ).toBe(true);
  });

  it('rejects a body that was altered after signing', () => {
    // The whole point: without this, anyone who learns the endpoint can post a leadgen_id and
    // have the CRM fetch and create a lead from it.
    const tampered = Buffer.from(
      JSON.stringify({ object: 'page', entry: [{ id: 'not-your-page' }] }),
      'utf8',
    );

    expect(
      verifyMetaWebhookSignature({ rawBody: tampered, signatureHeader: sign(rawBody), config }),
    ).toBe(false);
  });

  it('rejects a signature made with the wrong secret', () => {
    expect(
      verifyMetaWebhookSignature({
        rawBody,
        signatureHeader: sign(rawBody, 'wrong-secret'),
        config,
      }),
    ).toBe(false);
  });

  it.each([undefined, null, '', 'deadbeef', 'sha1=abc', 42])(
    'rejects the malformed header %p',
    (signatureHeader) => {
      expect(
        verifyMetaWebhookSignature({ rawBody, signatureHeader: signatureHeader as never, config }),
      ).toBe(false);
    },
  );

  it('rejects when the raw body was never captured', () => {
    // Express's json() parser discards the raw bytes; re-serializing the parsed object changes
    // key order and whitespace and the digest stops matching. A missing raw body must fail
    // closed rather than silently skip verification.
    expect(
      verifyMetaWebhookSignature({ rawBody: undefined, signatureHeader: sign(rawBody), config }),
    ).toBe(false);
  });
});
