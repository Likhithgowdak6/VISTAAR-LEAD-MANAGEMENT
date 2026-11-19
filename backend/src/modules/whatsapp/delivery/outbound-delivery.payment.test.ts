import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../config/env.js', () => ({ env: { NODE_ENV: 'test', LOG_LEVEL: 'silent',
  WHATSAPP_SEND_TEXT_POC_ENABLED: true, WHATSAPP_OUTBOUND_MAX_ATTEMPTS: 3,
  WHATSAPP_OUTBOUND_LEASE_MS: 120000, WHATSAPP_TEST_ALLOWED_NUMBERS: '',
  WHATSAPP_QUIET_HOURS_START: 0, WHATSAPP_QUIET_HOURS_END: 0, WHATSAPP_BUSINESS_TIMEZONE: 'UTC' } }));
vi.mock('./payment-message.guard.js', () => ({ paymentMessageStopReason: vi.fn() }));
vi.mock('../automation/quiet-hours.js', () => ({
  isWithinQuietHours: vi.fn(() => false), nextAllowedSendTime: vi.fn(),
}));
const { paymentMessageStopReason } = await import('./payment-message.guard.js');
const { createOutboundDeliveryService } = await import('./outbound-delivery.service.js');
describe('payment cancellation at the real outbound boundary', () => {
  it('checks again immediately before calling WhatsApp', async () => {
    vi.mocked(paymentMessageStopReason).mockResolvedValueOnce(null).mockResolvedValue('payment_balance_changed');
    const msg = { _id: 'message', organizationId: 'org', conversationId: 'conv', contactId: 'contact',
      whatsappAccountId: 'account', authoredBy: 'ai', body: 'synthetic invoice reminder',
      paymentContext: { invoiceId: 'invoice' }, createdAt: new Date('2026-11-20T12:00:00Z') };
    const messageRepository = { claimNextOutboundMessage: vi.fn().mockResolvedValue(msg),
      markOutboundMessageFailed: vi.fn().mockResolvedValue(null), markOutboundMessageSent: vi.fn(),
      rescheduleOutboundMessage: vi.fn() };
    const sessionService = { sendTextMessage: vi.fn() };
    const service = createOutboundDeliveryService({
      messageRepository, sessionService,
      contactRepository: { findContactPrivatePiiForInternalUse: vi.fn().mockResolvedValue({ phone: '919999999999' }) },
      findConversationById: vi.fn().mockResolvedValue({ aiAutomationEnabled: true }),
      publishEvent: vi.fn().mockResolvedValue(null),
      now: () => new Date('2026-11-20T12:00:00Z'),
    } as never);
    expect(await service.deliverNext({ organizationId: 'org', whatsappAccountId: 'account' }))
      .toMatchObject({ reason: 'payment_balance_changed', permanent: true });
    expect(paymentMessageStopReason).toHaveBeenCalledTimes(2);
    expect(sessionService.sendTextMessage).not.toHaveBeenCalled();
    expect(messageRepository.markOutboundMessageFailed).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'payment_balance_changed', permanent: true }));
  });
});
