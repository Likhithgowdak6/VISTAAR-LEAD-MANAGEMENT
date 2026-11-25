/**
 * The internal bridge Python uses to send an Instagram DM.
 *
 * THIS ENDPOINT SPENDS A CREDENTIAL ON BEHALF OF A TENANT, which makes it the most dangerous
 * surface in the feature. Three things it must get right:
 *
 *   1. **Authentication.** Without a valid service key it does nothing — and with no key
 *      configured at all it refuses rather than opening up.
 *   2. **Tenant scope.** The caller supplies both an organisation and an account. Trusting only
 *      the account id would let a key holder send from any workspace by guessing an id.
 *   3. **The window.** Checked here as well as in Python, because an endpoint reachable by
 *      anything holding the key cannot rely on its caller to enforce Meta's rules.
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createInstagramGatewayRouter } from './instagram-gateway.routes.js';

const KEY = 'a-service-key';

const app = ({
  serviceKey = KEY,
  findAccount = async () => ({ pageId: 'PAGE', encryptedPageAccessToken: { ciphertext: 'x' } }),
  send = async () => ({ recipientId: 'IGSID', messageId: 'mid.1' }),
  // The real decrypt raises on a fake envelope, which is correct - so the fixture supplies a
  // stand-in rather than a plausible-looking ciphertext.
  decrypt = () => 'a-page-token',
}: Record<string, unknown> = {}) => {
  const instance = express();

  instance.use(express.json());
  instance.use(
    '/internal/v1/instagram',
    createInstagramGatewayRouter({ serviceKey, findAccount, send, decrypt } as never),
  );

  // Minimal error shaping, mirroring the real app's handler closely enough to read status codes.
  instance.use(
    (
      error: { statusCode?: number; code?: string; message?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(error.statusCode ?? 500).json({ error: { code: error.code, message: error.message } });
    },
  );

  return instance;
};

const body = (over: Record<string, unknown> = {}) => ({
  organizationId: '6b0551093af63f65c046820e',
  instagramAccountId: '6b0551093af63f65c046820f',
  recipientId: 'IGSID-CUSTOMER',
  text: 'On it — what date?',
  lastInboundAt: new Date().toISOString(),
  ...over,
});

describe('authentication', () => {
  it('refuses with no service key header', async () => {
    const response = await request(app()).post('/internal/v1/instagram/send').send(body());

    expect(response.status).toBe(401);
  });

  it('refuses a wrong service key', async () => {
    const response = await request(app())
      .post('/internal/v1/instagram/send')
      .set('X-Service-Key', 'not-the-key')
      .send(body());

    expect(response.status).toBe(401);
  });

  it('refuses a key of a different length without throwing', async () => {
    // timingSafeEqual throws on a length mismatch; comparing lengths first is what stops a 500.
    const response = await request(app())
      .post('/internal/v1/instagram/send')
      .set('X-Service-Key', 'short')
      .send(body());

    expect(response.status).toBe(401);
  });

  it('FAILS CLOSED when no key is configured at all', async () => {
    // An unconfigured bridge must not become an open one.
    const response = await request(app({ serviceKey: '' }))
      .post('/internal/v1/instagram/send')
      .set('X-Service-Key', '')
      .send(body());

    expect(response.status).toBe(503);
  });

  it('accepts the correct key', async () => {
    const response = await request(app())
      .post('/internal/v1/instagram/send')
      .set('X-Service-Key', KEY)
      .send(body());

    expect(response.status).toBe(200);
    expect(response.body.data.providerMessageId).toBe('mid.1');
  });
});

describe('tenant isolation', () => {
  it('looks the account up by organisation AND id, not by id alone', async () => {
    const findAccount = vi.fn(async () => ({ pageId: 'PAGE', encryptedPageAccessToken: {} }));

    await request(app({ findAccount }))
      .post('/internal/v1/instagram/send')
      .set('X-Service-Key', KEY)
      .send(body());

    // Trusting only the account id would let a key holder send from any tenant's account.
    expect(findAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        _id: '6b0551093af63f65c046820f',
        organizationId: '6b0551093af63f65c046820e',
      }),
    );
  });

  it('404s when the account does not belong to that workspace', async () => {
    const response = await request(app({ findAccount: async () => null }))
      .post('/internal/v1/instagram/send')
      .set('X-Service-Key', KEY)
      .send(body());

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('INSTAGRAM_ACCOUNT_NOT_FOUND');
  });

  it('rejects a malformed organisation id before touching the database', async () => {
    const findAccount = vi.fn();

    const response = await request(app({ findAccount }))
      .post('/internal/v1/instagram/send')
      .set('X-Service-Key', KEY)
      .send(body({ organizationId: 'not-an-object-id' }));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(findAccount).not.toHaveBeenCalled();
  });
});

describe('the messaging window', () => {
  it('refuses a reply more than seven days after the customer wrote', async () => {
    const send = vi.fn();

    const response = await request(app({ send }))
      .post('/internal/v1/instagram/send')
      .set('X-Service-Key', KEY)
      .send(body({ lastInboundAt: new Date(Date.now() - 8 * 24 * 3600_000).toISOString() }));

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('INSTAGRAM_WINDOW_CLOSED');
    // Refused here, not by Meta — a round trip saved and a clearer message.
    expect(send).not.toHaveBeenCalled();
  });

  it('allows six days, because a human agent gets seven', async () => {
    const response = await request(app())
      .post('/internal/v1/instagram/send')
      .set('X-Service-Key', KEY)
      .send(body({ lastInboundAt: new Date(Date.now() - 6 * 24 * 3600_000).toISOString() }));

    expect(response.status).toBe(200);
  });

  it('refuses when the customer has never written', async () => {
    // Instagram has no template to open a conversation with.
    const response = await request(app())
      .post('/internal/v1/instagram/send')
      .set('X-Service-Key', KEY)
      .send(body({ lastInboundAt: null }));

    expect(response.status).toBe(409);
  });

  it('declares the human agent tag, which is what buys the seven days', async () => {
    const send = vi.fn(async () => ({ recipientId: 'r', messageId: 'm' }));

    await request(app({ send }))
      .post('/internal/v1/instagram/send')
      .set('X-Service-Key', KEY)
      .send(body());

    // True here, and only here: a person is replying. Automation never comes through this path.
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ humanAgent: true }));
  });
});

describe('failures reach the composer intact', () => {
  it('passes a transient failure through as a 503', async () => {
    const { InstagramSendError } = await import('./instagram.client.js');

    const response = await request(
      app({
        send: async () => {
          throw new InstagramSendError({
            message: 'Instagram is rate limiting this account.',
            code: 'INSTAGRAM_RATE_LIMITED',
            failureKind: 'transient',
          });
        },
      }),
    )
      .post('/internal/v1/instagram/send')
      .set('X-Service-Key', KEY)
      .send(body());

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('INSTAGRAM_RATE_LIMITED');
  });

  it('passes a credential failure through as a 409, so the composer says reconnect', async () => {
    const { InstagramSendError } = await import('./instagram.client.js');

    const response = await request(
      app({
        send: async () => {
          throw new InstagramSendError({
            message: 'Instagram access has expired or was revoked.',
            code: 'INSTAGRAM_TOKEN_EXPIRED',
            failureKind: 'needs_attention',
          });
        },
      }),
    )
      .post('/internal/v1/instagram/send')
      .set('X-Service-Key', KEY)
      .send(body());

    expect(response.status).toBe(409);
    expect(response.body.error.message).toContain('expired or was revoked');
  });

  it('refuses an account with no stored credential rather than sending nothing silently', async () => {
    const response = await request(
      app({ findAccount: async () => ({ pageId: 'PAGE', encryptedPageAccessToken: null }), decrypt: () => null }),
    )
      .post('/internal/v1/instagram/send')
      .set('X-Service-Key', KEY)
      .send(body());

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('INSTAGRAM_NOT_CONNECTED');
  });

  it('refuses a message over the 1,000 character limit at the schema', async () => {
    const send = vi.fn();

    const response = await request(app({ send }))
      .post('/internal/v1/instagram/send')
      .set('X-Service-Key', KEY)
      .send(body({ text: 'a'.repeat(1001) }));

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(send).not.toHaveBeenCalled();
  });
});
