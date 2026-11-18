import { createHmac } from 'node:crypto';
import express, { type ErrorRequestHandler } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../config/env.js', () => ({ env: { LOG_LEVEL: 'silent', NODE_ENV: 'test', WHATSAPP_CLOUD_APP_SECRET: 'synthetic-secret', WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN: 'synthetic-verify' } }));
vi.mock('./cloud-webhook.inbox.js', () => ({ cloudWebhookInbox: { persist: vi.fn(), drain: vi.fn() } }));
import { cloudWebhookInbox } from './cloud-webhook.inbox.js';
import cloudPublicRouter from './cloud-public.routes.js';

beforeEach(() => { vi.mocked(cloudWebhookInbox.persist).mockReset().mockResolvedValue('event'); vi.mocked(cloudWebhookInbox.drain).mockReset().mockResolvedValue(undefined); });
const app = () => {
  const server = express();
  server.use(express.json({ limit: '3mb', verify: (req, _res, body) => { (req as unknown as {rawBody: Buffer}).rawBody = body; } }));
  server.use('/api/v1/whatsapp/cloud', cloudPublicRouter);
  const fail: ErrorRequestHandler = (_error, _req, res, _next) => { res.status(503).json({ error: 'unavailable' }); };
  server.use(fail);
  return server;
};
const post = (body: string, signature?: string) => request(app()).post('/api/v1/whatsapp/cloud/webhook').set('Content-Type', 'application/json')
  .set('x-hub-signature-256', signature ?? `sha256=${createHmac('sha256', 'synthetic-secret').update(body).digest('hex')}`).send(body);

describe('webhook acknowledgement boundary', () => {
  it('rejects forged payloads without persisting or processing them', async () => {
    expect((await post('{}', 'sha256=wrong')).status).toBe(403);
    expect(cloudWebhookInbox.persist).not.toHaveBeenCalled();
  });
  it('does not acknowledge a request when durable persistence fails', async () => {
    vi.mocked(cloudWebhookInbox.persist).mockRejectedValue(new Error('offline'));
    expect((await post('{}')).status).toBe(503);
    expect(cloudWebhookInbox.drain).not.toHaveBeenCalled();
  });
  it('persists before accepting a signed batch and accepts payloads above the old 1MB limit', async () => {
    const payload = JSON.stringify({ object: 'whatsapp_business_account', example: 'x'.repeat(1_100_000) });
    let persisted = false;
    vi.mocked(cloudWebhookInbox.persist).mockImplementation(async () => { persisted = true; return 'event'; });
    vi.mocked(cloudWebhookInbox.drain).mockImplementation(async () => { expect(persisted).toBe(true); });
    expect((await post(payload)).status).toBe(200);
    expect(cloudWebhookInbox.persist).toHaveBeenCalledTimes(1);
  });
});
