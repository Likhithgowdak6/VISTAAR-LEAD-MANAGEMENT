import { describe, expect, it, vi } from 'vitest';
vi.mock('../../config/env.js', () => ({ env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', WHATSAPP_GATEWAY_ONLY: true } }));
const { forwardOwnerPaymentReply } = await import('./payment-followup.client.js');
const { createPaymentFollowUpService } = await import('./payment-followup.service.js');
const config = { WHATSAPP_GATEWAY_SERVICE_KEY: 'synthetic-internal-key', CRM_API_URL: 'http://127.0.0.1:5002' };

describe('owner payment reply bridge', () => {
  it('forwards a trusted owner reply with service authentication', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { handled: true } }) });
    expect(await forwardOwnerPaymentReply({ organizationId: 'tenant', text: 'B4 pending' }, { fetchFn, config: config as never })).toBe(true);
    const [url, options] = fetchFn.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:5002/internal/v1/payments/owner-reply');
    expect(options.headers['X-Service-Key']).toBe(config.WHATSAPP_GATEWAY_SERVICE_KEY);
    expect(JSON.parse(options.body)).toEqual({ organizationId: 'tenant', text: 'B4 pending' });
    expect(url).not.toContain(config.WHATSAPP_GATEWAY_SERVICE_KEY);
  });
  it('fails closed on an unavailable Python service', async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false });
    await expect(forwardOwnerPaymentReply({ organizationId: 'tenant', text: 'B4 pending' },
      { fetchFn, config: config as never })).rejects.toThrow('PAYMENT_GATEWAY_UNAVAILABLE');
  });
  it('does not call the old sender after a forwarded reply', async () => {
    const sendToClient = vi.fn(); const forward = vi.fn().mockResolvedValue(true);
    const service = createPaymentFollowUpService({ sendToClient, gatewayOnly: true, forwardPaymentReply: forward } as never);
    expect(await service.handleOwnerReply({ organizationId: 'tenant', text: 'B4 pending' })).toBe(true);
    expect(forward).toHaveBeenCalledOnce();
    expect(sendToClient).not.toHaveBeenCalled();
  });
  it('asks for a retry instead of falling back to a duplicate workflow', async () => {
    const sendToClient = vi.fn(); const forward = vi.fn().mockRejectedValue(new Error('synthetic failure'));
    const notifyOwner = vi.fn().mockResolvedValue(null);
    const service = createPaymentFollowUpService({ sendToClient, notifyOwner, gatewayOnly: true, forwardPaymentReply: forward } as never);
    expect(await service.handleOwnerReply({ organizationId: 'tenant', text: 'B4 collected' })).toBe(true);
    expect(notifyOwner).toHaveBeenCalledOnce();
    expect(sendToClient).not.toHaveBeenCalled();
  });
  it('does not forward ordinary approval or sales text', async () => {
    const forward = vi.fn();
    const service = createPaymentFollowUpService({ sendToClient: vi.fn(), gatewayOnly: true, forwardPaymentReply: forward } as never);
    expect(await service.handleOwnerReply({ organizationId: 'tenant', text: 'B4 1' })).toBe(false);
    expect(forward).not.toHaveBeenCalled();
  });
});
