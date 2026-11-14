import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../config/env.js', () => ({ env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' } }));
const { createGatewayRouter } = await import('./gateway.routes.js');
const { errorHandler } = await import('../../middleware/error.middleware.js');
const body = { organizationId: '507f1f77bcf86cd799439011', accountId: '507f1f77bcf86cd799439012', text: 'Approval needed' };
const findAccount = vi.fn();
const notifyOwner = vi.fn();
const app = (serviceKey = 'test-service-key') => {
  const server = express();
  server.use(express.json());
  server.use('/internal/v1/whatsapp', createGatewayRouter({ serviceKey, findAccount, notifyOwner }));
  server.use(errorHandler);
  return server;
};
beforeEach(() => {
  vi.clearAllMocks();
  findAccount.mockResolvedValue({ _id: body.accountId, organizationId: body.organizationId });
  notifyOwner.mockResolvedValue({ providerMessageId: 'sent-by-baileys' });
});
describe('internal Baileys owner-notification gateway', () => {
  it('requires a configured, correct service key', async () => {
    expect((await request(app('')).post('/internal/v1/whatsapp/owner-notify').send(body)).status).toBe(503);
    expect((await request(app()).post('/internal/v1/whatsapp/owner-notify').send(body)).status).toBe(401);
    expect((await request(app()).post('/internal/v1/whatsapp/owner-notify').set('X-Service-Key', 'wrong').send(body)).status).toBe(401);
    expect(notifyOwner).not.toHaveBeenCalled();
  });
  it('refuses an account belonging to another organization', async () => {
    findAccount.mockResolvedValue(null);
    const response = await request(app()).post('/internal/v1/whatsapp/owner-notify')
      .set('X-Service-Key', 'test-service-key').send(body);
    expect(response.status).toBe(404);
    expect(findAccount).toHaveBeenCalledWith({ organizationId: body.organizationId, accountId: body.accountId });
    expect(notifyOwner).not.toHaveBeenCalled();
  });
  it('delivers through the tenant-aware Baileys notifier', async () => {
    const response = await request(app()).post('/internal/v1/whatsapp/owner-notify')
      .set('X-Service-Key', 'test-service-key').send(body);
    expect(response.status).toBe(200);
    expect(response.body.data.providerMessageId).toBe('sent-by-baileys');
    expect(notifyOwner).toHaveBeenCalledWith(body);
  });
  it('does not accept an arbitrary recipient from the caller', async () => {
    const response = await request(app()).post('/internal/v1/whatsapp/owner-notify')
      .set('X-Service-Key', 'test-service-key').send({ ...body, to: 'foreign-number' });
    expect(response.status).toBe(400);
    expect(notifyOwner).not.toHaveBeenCalled();
  });
});
