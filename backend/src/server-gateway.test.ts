import express from 'express';
import { describe, expect, it, vi } from 'vitest';
vi.mock('./config/env.js', () => ({ env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', FRONTEND_ORIGIN: ['http://localhost'] } }));
vi.mock('./modules/whatsapp/sessions/session-manager.instance.js', () => ({
  getSessionManager: () => ({ stopAll: vi.fn(), reconnectPersistedSessions: vi.fn() }),
}));
const { startServer, stopServer } = await import('./server-lifecycle.js');

describe('Baileys gateway-only process', () => {
  it('keeps delivery and sessions without starting duplicate business sweeps', async () => {
    const delivery = { start: vi.fn(() => true), stop: vi.fn() };
    const realtime = { start: vi.fn(() => true), stop: vi.fn() };
    const sweep = vi.fn(() => ({ start: vi.fn(() => true), stop: vi.fn() }));
    const noop = vi.fn(async () => undefined);
    const reconnect = vi.fn(async () => undefined);
    const server = await startServer({ appInstance: express(), port: 0, gatewayOnly: true,
      connectDatabaseFn: noop, connectRedisFn: noop, disconnectDatabaseFn: noop, disconnectRedisFn: noop,
      startRealtimeSubscriberFn: noop, stopRealtimeSubscriberFn: noop,
      createDeliveryRunnerFn: () => delivery, createRealtimeOutboxRunnerFn: () => realtime,
      createLeadImportRunnerFn: sweep, createNurtureRunnerFn: sweep, createPromiseFollowUpRunnerFn: sweep,
      createReminderRunnerFn: sweep, createMorningReadRunnerFn: sweep, createDigestRunnerFn: sweep,
      createBookingCountdownRunnerFn: sweep, createAutoGreetRunnerFn: sweep,
      createPaymentFollowUpRunnerFn: sweep, createEventReminderRunnerFn: sweep,
      createOwnerCallEscalationRunnerFn: sweep, reconnectSessionsFn: reconnect, stopSessionsFn: noop });
    try {
      expect(delivery.start).toHaveBeenCalledOnce();
      expect(realtime.start).toHaveBeenCalledOnce();
      expect(reconnect).toHaveBeenCalledOnce();
      expect(sweep).not.toHaveBeenCalled();
    } finally {
      await stopServer({ server, disconnectDatabaseFn: noop, disconnectRedisFn: noop, stopRealtimeSubscriberFn: noop });
    }
    expect(delivery.stop).toHaveBeenCalledOnce();
  });
});
