import { describe, expect, it, vi } from 'vitest';
vi.mock('../../../config/env.js', () => ({ env: { NODE_ENV: 'test', LOG_LEVEL: 'silent',
  WHATSAPP_SEND_TEXT_POC_ENABLED: true, WHATSAPP_OUTBOUND_MAX_ATTEMPTS: 3,
  WHATSAPP_OUTBOUND_LEASE_MS: 120000, WHATSAPP_TEST_ALLOWED_NUMBERS: '',
  WHATSAPP_QUIET_HOURS_START: 0, WHATSAPP_QUIET_HOURS_END: 0, WHATSAPP_BUSINESS_TIMEZONE: 'UTC' } }));
vi.mock('../automation/quiet-hours.js', () => ({
  isWithinQuietHours: vi.fn(() => false), nextAllowedSendTime: vi.fn(),
}));
const { createOutboundDeliveryService } = await import('./outbound-delivery.service.js');

describe('a reply superseding a silence follow-up', () => {
  it.each([false, true])('blocks old-cycle send; reply arrives during delivery=%s', async duringDelivery => {
    const now = new Date('2026-11-19T12:00:00Z');
    const oldAnchor = new Date(now.getTime()-3600000*5);
    const old = { aiAutomationEnabled: true, lastInboundAt: oldAnchor };
    const current = { ...old, lastInboundAt: new Date(now.getTime()-60000) };
    const find = vi.fn();
    if (duringDelivery) find.mockResolvedValueOnce(old).mockResolvedValue(current);
    else find.mockResolvedValue(current);
    const msg = { _id: 'message', organizationId: 'org', conversationId: 'conv', contactId: 'contact',
      whatsappAccountId: 'account', authoredBy: 'ai', body: 'Synthetic old-cycle follow-up',
      idempotencyKey: `nurture:conv:${oldAnchor.getTime()}:5`, createdAt: now };
    const messageRepository = { claimNextOutboundMessage: vi.fn().mockResolvedValue(msg),
      markOutboundMessageFailed: vi.fn().mockResolvedValue(null), markOutboundMessageSent: vi.fn(),
      rescheduleOutboundMessage: vi.fn() };
    const sessionService = { sendTextMessage: vi.fn() };
    const service = createOutboundDeliveryService({ messageRepository, sessionService,
      contactRepository: { findContactPrivatePiiForInternalUse: vi.fn().mockResolvedValue({ phone: '919999999999' }) },
      findConversationById: find, publishEvent: vi.fn().mockResolvedValue(null), now: () => now,
    } as never);
    expect(await service.deliverNext({ organizationId: 'org', whatsappAccountId: 'account' }))
      .toMatchObject({ reason: 'superseded_by_inbound', permanent: true });
    expect(sessionService.sendTextMessage).not.toHaveBeenCalled();
    expect(messageRepository.markOutboundMessageFailed).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'superseded_by_inbound', permanent: true }));
  });
});
