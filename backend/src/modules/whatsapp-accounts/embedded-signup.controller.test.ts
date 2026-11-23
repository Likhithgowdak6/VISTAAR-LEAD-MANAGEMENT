import express, { type ErrorRequestHandler } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../config/env.js', () => ({ env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' } }));
vi.mock('./whatsapp-account.repository.js', () => ({ findAccountById: vi.fn() }));
vi.mock('./whatsapp-account.service.js', () => ({ connectCloudAccountForActor: vi.fn() }));
vi.mock('./whatsapp-account.controller.js', () => ({ mapAccountError: (err: unknown) => { throw err; } }));
vi.mock('../whatsapp/cloud/embedded-signup.client.js', () => ({
  SIGNUP_GRAPH_VERSION: 'v27.0', signupConfiguration: vi.fn(),
}));
vi.mock('../whatsapp/cloud/embedded-signup.service.js', () => ({
  embeddedSignupSessions: { start: vi.fn(), exchange: vi.fn(), consume: vi.fn() },
}));
import { requireAccountsManage, requirePasswordChanged } from '../../middleware/auth.middleware.js';
import { findAccountById } from './whatsapp-account.repository.js';
import { connectCloudAccountForActor } from './whatsapp-account.service.js';
import { signupConfiguration } from '../whatsapp/cloud/embedded-signup.client.js';
import { embeddedSignupSessions } from '../whatsapp/cloud/embedded-signup.service.js';
import { getEmbeddedSignupConfig, startEmbeddedSignup, exchangeEmbeddedSignup, completeEmbeddedSignup } from './embedded-signup.controller.js';

const accountId = 'a'.repeat(24);
const base = `/accounts/${accountId}/cloud/signup`;
const state = 'b'.repeat(64);
const configured = { available: true, appId: '123456', configId: '654321', appSecret: 'never-return-this' };
const application = (role: 'admin' | 'staff' | 'anonymous' = 'admin', mustChangePassword = false) => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    if (role !== 'anonymous') req.auth = { organization: { _id: 'tenant-1' }, user: { _id: 'user-1', role, mustChangePassword } } as unknown as Express.AuthContext;
    next();
  });
  const guards = [requirePasswordChanged, requireAccountsManage];
  app.get('/accounts/:accountId/cloud/signup', ...guards, getEmbeddedSignupConfig);
  app.post('/accounts/:accountId/cloud/signup/start', ...guards, startEmbeddedSignup);
  app.post('/accounts/:accountId/cloud/signup/exchange', ...guards, exchangeEmbeddedSignup);
  app.post('/accounts/:accountId/cloud/signup/complete', ...guards, completeEmbeddedSignup);
  const errors: ErrorRequestHandler = (err, _req, res, _next) => {
    res.status(err.statusCode ?? 500).json({ error: { code: err.code, message: err.message } });
  };
  app.use(errors); return app;
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(findAccountById).mockResolvedValue({ provider: 'cloud', status: 'disconnected' } as never);
  vi.mocked(signupConfiguration).mockReturnValue(configured);
  vi.mocked(embeddedSignupSessions.start).mockResolvedValue(state);
  vi.mocked(embeddedSignupSessions.consume).mockResolvedValue('encrypted-at-rest-business-token');
  vi.mocked(connectCloudAccountForActor).mockResolvedValue({ id: accountId } as never);
});
describe('Embedded Signup HTTP boundary', () => {
  it.each(['', '/start', '/exchange', '/complete'])('requires management permission for %s', async (suffix) => {
    const app = application('staff');
    const result = suffix ? await request(app).post(base + suffix).send({}) : await request(app).get(base);
    expect(result.status).toBe(403);
    expect(findAccountById).not.toHaveBeenCalled();
    expect(embeddedSignupSessions.exchange).not.toHaveBeenCalled();
  });
  it('requires sign-in and completed password setup', async () => {
    expect((await request(application('anonymous')).get(base)).status).toBe(401);
    expect((await request(application('admin', true)).get(base)).status).toBe(403);
  });
  it('returns public configuration only and disables caching', async () => {
    const result = await request(application()).get(base);
    expect(result.status).toBe(200);
    expect(result.body.data).toEqual({ available: true, appId: '123456', configId: '654321', graphVersion: 'v27.0' });
    expect(result.text).not.toContain('never-return-this');
    expect(result.headers['cache-control']).toBe('no-store');
  });
  it('looks up the account in the authenticated organization and rejects missing / removed accounts', async () => {
    for (const account of [null, { provider: 'cloud', status: 'removed' }]) {
      vi.mocked(findAccountById).mockResolvedValue(account as never);
      expect((await request(application()).post(base + '/start')).status).toBe(404);
    }
    expect(findAccountById).toHaveBeenCalledWith({ accountId, organizationId: 'tenant-1' });
    expect(embeddedSignupSessions.start).not.toHaveBeenCalled();
  });
  it('does not alter QR accounts or start when platform configuration is missing', async () => {
    vi.mocked(findAccountById).mockResolvedValue({ provider: 'baileys' } as never);
    expect((await request(application()).post(base + '/start')).status).toBe(409);
    vi.mocked(findAccountById).mockResolvedValue({ provider: 'cloud' } as never);
    vi.mocked(signupConfiguration).mockReturnValue({ ...configured, available: false });
    expect((await request(application()).get(base)).body.data).toEqual({ available: false });
    expect((await request(application()).post(base + '/start')).status).toBe(503);
    expect(embeddedSignupSessions.start).not.toHaveBeenCalled();
  });
  it('rejects invalid IDs, missing codes and invalid PINs before spending a session', async () => {
    const app = application();
    expect((await request(app).post(base + '/exchange').send({ state })).status).toBe(400);
    expect((await request(app).post(base + '/complete').send({ state, phoneNumberId: '../other', wabaId: '123456', pin: '123456' })).status).toBe(400);
    expect((await request(app).post(base + '/complete').send({ state, phoneNumberId: '654321', wabaId: '123456', pin: '123' })).status).toBe(400);
    expect(embeddedSignupSessions.exchange).not.toHaveBeenCalled();
    expect(embeddedSignupSessions.consume).not.toHaveBeenCalled();
  });
  it('keeps exchanged tokens on the server and binds completion to the actor', async () => {
    const app = application();
    expect((await request(app).post(base + '/start')).body.data).toEqual({ state });
    const exchanged = await request(app).post(base + '/exchange').send({ state, code: 'one-time-code' });
    expect(exchanged.body).toEqual({ data: { exchanged: true } });
    expect(embeddedSignupSessions.exchange).toHaveBeenCalledWith({ organizationId: 'tenant-1', actorId: 'user-1', accountId }, state, 'one-time-code');
    const result = await request(app).post(base + '/complete').send({ state, phoneNumberId: '654321', wabaId: '123456', pin: '123456' });
    expect(result.status).toBe(200);
    expect(result.text).not.toContain('business-token');
    expect(connectCloudAccountForActor).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'tenant-1', accountId, phoneNumberId: '654321', wabaId: '123456', registrationPin: '123456' }));
  });
});
