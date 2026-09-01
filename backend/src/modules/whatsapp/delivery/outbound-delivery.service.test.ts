/**
 * Exercises the send-time guard stack added to deliverNext: the test-allowlist, the AI-authored
 * automation re-check, quiet hours, and the echo-guard remember() call after a successful send.
 * Every collaborator is injected directly (no real Mongo/Redis), following this codebase's DI
 * test style.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../config/env.js', () => ({
  env: {
    WHATSAPP_OUTBOUND_MAX_ATTEMPTS: 3,
    WHATSAPP_OUTBOUND_LEASE_MS: 120000,
    WHATSAPP_MAX_OUTBOUND_PER_MINUTE: 5,
    WHATSAPP_SEND_TEXT_POC_ENABLED: true,
    WHATSAPP_TEST_ALLOWED_NUMBERS: '',
    WHATSAPP_QUIET_HOURS_START: 0,
    WHATSAPP_QUIET_HOURS_END: 0,
    WHATSAPP_BUSINESS_TIMEZONE: 'Asia/Kolkata',
    NURTURE_STALE_AFTER_MS: 1_800_000,
  },
}));

vi.mock('../../../config/redis.js', () => ({
  getRedisClient: vi.fn(),
}));

vi.mock('../automation/quiet-hours.js', () => ({
  isWithinQuietHours: vi.fn(() => false),
  nextAllowedSendTime: vi.fn(() => new Date('2026-08-26T02:00:00.000Z')),
}));

const { createOutboundDeliveryService } = await import('./outbound-delivery.service.js');
const quietHours = await import('../automation/quiet-hours.js');
const { createPipelineTrace, deriveTraceId } = await import(
  '../../../observability/pipeline-trace.js'
);

const baseMessage = (overrides: Record<string, unknown> = {}) => ({
  _id: 'message-1',
  organizationId: 'org-1',
  whatsappAccountId: 'account-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  body: 'hello there',
  deliveryAttempts: 1,
  authoredBy: 'human',
  ...overrides,
});

const createHarness = (overrides: Record<string, unknown> = {}) => {
  const messageRepository = {
    claimNextOutboundMessage: vi.fn(),
    markOutboundMessageSent: vi.fn(),
    markOutboundMessageFailed: vi.fn(),
    rescheduleOutboundMessage: vi.fn(),
  };
  const contactRepository = {
    findContactPrivatePiiForInternalUse: vi.fn().mockResolvedValue({ phone: '919999999999' }),
  };
  const sessionService = {
    sendTextMessage: vi.fn().mockResolvedValue({ providerMessageId: 'wamid-1' }),
  };
  const findConversationById = vi.fn().mockResolvedValue({
    aiAutomationEnabled: true,
    assignedTo: null,
  });
  const publishEvent = vi.fn().mockResolvedValue(true);
  const echoGuardService = { remember: vi.fn(), isOwnMessage: vi.fn() };

  const service = createOutboundDeliveryService({
    sessionService,
    messageRepository: messageRepository as never,
    contactRepository: contactRepository as never,
    findConversationById,
    publishEvent,
    echoGuardService: echoGuardService as never,
    now: () => new Date('2026-08-25T10:00:00.000Z'),
    logger: { error: vi.fn() },
    ...overrides,
  } as never);

  return { service, messageRepository, contactRepository, sessionService, findConversationById, publishEvent, echoGuardService };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(quietHours.isWithinQuietHours).mockReturnValue(false);
});

describe('deliverNext allowlist', () => {
  it('passes through when the allowlist is empty', async () => {
    const { service, messageRepository, sessionService } = createHarness();
    messageRepository.claimNextOutboundMessage.mockResolvedValue(baseMessage());

    const result = await service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    expect(sessionService.sendTextMessage).toHaveBeenCalled();
    expect(result).toMatchObject({ delivered: true });
  });

  it('blocks a disallowed recipient when the allowlist is non-empty', async () => {
    const { service, messageRepository, sessionService } = createHarness({
      config: {
        WHATSAPP_OUTBOUND_MAX_ATTEMPTS: 3,
        WHATSAPP_OUTBOUND_LEASE_MS: 120000,
        WHATSAPP_MAX_OUTBOUND_PER_MINUTE: 5,
        WHATSAPP_SEND_TEXT_POC_ENABLED: true,
        WHATSAPP_TEST_ALLOWED_NUMBERS: '911111111111',
        WHATSAPP_QUIET_HOURS_START: 0,
        WHATSAPP_QUIET_HOURS_END: 0,
        WHATSAPP_BUSINESS_TIMEZONE: 'Asia/Kolkata',
      },
    });
    messageRepository.claimNextOutboundMessage.mockResolvedValue(baseMessage());

    const result = await service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    expect(sessionService.sendTextMessage).not.toHaveBeenCalled();
    expect(messageRepository.markOutboundMessageFailed).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'blocked_by_test_allowlist', permanent: true }),
    );
    expect(result).toMatchObject({
      delivered: false,
      failed: true,
      permanent: true,
      reason: 'blocked_by_test_allowlist',
    });
  });
});

describe('deliverNext AI-authored automation re-check', () => {
  it('drops an AI-authored message permanently when automation is off at send time', async () => {
    const { service, messageRepository, sessionService, findConversationById } = createHarness();
    findConversationById.mockResolvedValue({ aiAutomationEnabled: false, assignedTo: null });
    messageRepository.claimNextOutboundMessage.mockResolvedValue(baseMessage({ authoredBy: 'ai' }));

    const result = await service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    expect(sessionService.sendTextMessage).not.toHaveBeenCalled();
    expect(messageRepository.markOutboundMessageFailed).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'automation_paused_before_send', permanent: true }),
    );
    expect(result).toMatchObject({
      delivered: false,
      failed: true,
      permanent: true,
      reason: 'automation_paused_before_send',
    });
  });

  it('sends a human-authored message even when automation is off (not gated)', async () => {
    const { service, messageRepository, sessionService, findConversationById } = createHarness();
    findConversationById.mockResolvedValue({ aiAutomationEnabled: false, assignedTo: null });
    messageRepository.claimNextOutboundMessage.mockResolvedValue(baseMessage({ authoredBy: 'human' }));

    const result = await service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    expect(sessionService.sendTextMessage).toHaveBeenCalled();
    expect(messageRepository.markOutboundMessageFailed).not.toHaveBeenCalled();
    expect(result).toMatchObject({ delivered: true });
  });
});

describe('deliverNext opt-out gate', () => {
  const optedOutConversation = {
    aiAutomationEnabled: false,
    optedOutAt: new Date('2026-08-24T09:00:00.000Z'),
    assignedTo: null,
  };

  it('permanently fails an AI-authored message to a lead who opted out', async () => {
    const { service, messageRepository, sessionService, findConversationById } = createHarness();
    findConversationById.mockResolvedValue(optedOutConversation);
    messageRepository.claimNextOutboundMessage.mockResolvedValue(
      baseMessage({ authoredBy: 'ai' }),
    );

    const result = await service.deliverNext({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
    });

    expect(sessionService.sendTextMessage).not.toHaveBeenCalled();
    expect(messageRepository.markOutboundMessageFailed).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'recipient_opted_out', permanent: true }),
    );
    expect(result).toMatchObject({
      delivered: false,
      failed: true,
      permanent: true,
      reason: 'recipient_opted_out',
    });
  });

  it('records the opt-out, not the automation pause, as the reason', async () => {
    const { service, messageRepository, findConversationById } = createHarness();
    // An opted-out conversation always has automation off too; the recorded reason must be the
    // one an audit of a complaint actually needs to see.
    findConversationById.mockResolvedValue(optedOutConversation);
    messageRepository.claimNextOutboundMessage.mockResolvedValue(
      baseMessage({ authoredBy: 'ai' }),
    );

    await service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    expect(messageRepository.markOutboundMessageFailed).not.toHaveBeenCalledWith(
      expect.objectContaining({ error: 'automation_paused_before_send' }),
    );
  });

  it('still sends a human-authored message - they opted out of automation, not of the owner', async () => {
    const { service, messageRepository, sessionService, findConversationById } = createHarness();
    findConversationById.mockResolvedValue(optedOutConversation);
    messageRepository.claimNextOutboundMessage.mockResolvedValue(
      baseMessage({ authoredBy: 'human' }),
    );

    const result = await service.deliverNext({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
    });

    expect(sessionService.sendTextMessage).toHaveBeenCalled();
    expect(messageRepository.markOutboundMessageFailed).not.toHaveBeenCalled();
    expect(result).toMatchObject({ delivered: true });
  });
});

describe('deliverNext quiet hours', () => {
  it('reschedules rather than fails an AI-authored message during quiet hours', async () => {
    vi.mocked(quietHours.isWithinQuietHours).mockReturnValue(true);
    const { service, messageRepository, sessionService } = createHarness();
    messageRepository.claimNextOutboundMessage.mockResolvedValue(baseMessage({ authoredBy: 'ai' }));

    const result = await service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    expect(sessionService.sendTextMessage).not.toHaveBeenCalled();
    expect(messageRepository.markOutboundMessageFailed).not.toHaveBeenCalled();
    expect(messageRepository.rescheduleOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'message-1', organizationId: 'org-1' }),
    );
    expect(result).toMatchObject({ delivered: false, rescheduled: true, reason: 'quiet_hours' });
  });

  it('does not apply quiet hours to a human-authored message', async () => {
    vi.mocked(quietHours.isWithinQuietHours).mockReturnValue(true);
    const { service, messageRepository, sessionService } = createHarness();
    messageRepository.claimNextOutboundMessage.mockResolvedValue(baseMessage({ authoredBy: 'human' }));

    const result = await service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    expect(sessionService.sendTextMessage).toHaveBeenCalled();
    expect(messageRepository.rescheduleOutboundMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ delivered: true });
  });
});

describe('deliverNext stale-message guard', () => {
  it('drops an AI-authored message whose scheduledAt is more than NURTURE_STALE_AFTER_MS in the past', async () => {
    const { service, messageRepository, sessionService } = createHarness();
    messageRepository.claimNextOutboundMessage.mockResolvedValue(
      baseMessage({
        authoredBy: 'ai',
        // now() is 2026-08-25T10:00:00.000Z; 31 minutes stale against a 30-minute limit.
        scheduledAt: new Date('2026-08-25T09:29:00.000Z'),
      }),
    );

    const result = await service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    expect(sessionService.sendTextMessage).not.toHaveBeenCalled();
    expect(messageRepository.markOutboundMessageFailed).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'stale_ai_message_dropped', permanent: true }),
    );
    expect(result).toMatchObject({
      delivered: false,
      failed: true,
      permanent: true,
      reason: 'stale_ai_message_dropped',
    });
  });

  it('does not drop an AI-authored message still within the staleness window', async () => {
    const { service, messageRepository, sessionService } = createHarness();
    messageRepository.claimNextOutboundMessage.mockResolvedValue(
      baseMessage({
        authoredBy: 'ai',
        // Only 5 minutes stale - well inside the 30-minute limit.
        scheduledAt: new Date('2026-08-25T09:55:00.000Z'),
      }),
    );

    const result = await service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    expect(sessionService.sendTextMessage).toHaveBeenCalled();
    expect(messageRepository.markOutboundMessageFailed).not.toHaveBeenCalled();
    expect(result).toMatchObject({ delivered: true });
  });

  it('never drops a human-authored message for staleness, even with an old scheduledAt', async () => {
    const { service, messageRepository, sessionService } = createHarness();
    messageRepository.claimNextOutboundMessage.mockResolvedValue(
      baseMessage({
        authoredBy: 'human',
        // Human-authored messages always carry scheduledAt: null in this codebase, but the
        // guard itself is scoped to authoredBy === 'ai' - verify that scoping directly too.
        scheduledAt: new Date('2020-01-01T00:00:00.000Z'),
      }),
    );

    const result = await service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    expect(sessionService.sendTextMessage).toHaveBeenCalled();
    expect(messageRepository.markOutboundMessageFailed).not.toHaveBeenCalled();
    expect(result).toMatchObject({ delivered: true });
  });
});

describe('deliverNext echo guard', () => {
  it('calls remember() after a successful send', async () => {
    const { service, messageRepository, echoGuardService } = createHarness();
    messageRepository.claimNextOutboundMessage.mockResolvedValue(baseMessage());

    await service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    expect(echoGuardService.remember).toHaveBeenCalledWith({
      accountId: 'account-1',
      providerMessageId: 'wamid-1',
    });
  });
});

describe('deliverNext - the pipeline trace (stage 13)', () => {
  const createTracingHarness = (overrides: Record<string, unknown> = {}) => {
    const lines: string[] = [];
    const harness = createHarness({
      createTrace: ({ seed }: { seed?: unknown }) =>
        createPipelineTrace({
          seed,
          config: { WHATSAPP_TRACE_ENABLED: true },
          write: (line) => lines.push(line),
        }),
      ...overrides,
    });

    return { ...harness, lines };
  };

  it('prints claimed, allowlist and sent for a successful delivery', async () => {
    const h = createTracingHarness();
    h.messageRepository.claimNextOutboundMessage.mockResolvedValue(
      baseMessage({ idempotencyKey: 'ai-brain-asked:msg-1' }),
    );

    await h.service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    expect(h.lines).toHaveLength(3);
    expect(h.lines[0]).toContain('step=claimed');
    expect(h.lines[1]).toContain('step=allowlist');
    expect(h.lines[2]).toContain('step=sent');
    expect(h.lines.every((line) => line.includes('13/13'))).toBe(true);
  });

  it('reuses the idempotency key as the seed, so it matches the queued line printed earlier', async () => {
    const h = createTracingHarness();
    h.messageRepository.claimNextOutboundMessage.mockResolvedValue(
      baseMessage({ idempotencyKey: 'ai-brain-asked:msg-1' }),
    );

    await h.service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    expect(h.lines[0]).toContain(`[wa ${deriveTraceId('ai-brain-asked:msg-1')}]`);
  });

  it('says loudly why the outbound allowlist blocked a send', async () => {
    const h = createTracingHarness({
      config: {
        WHATSAPP_OUTBOUND_MAX_ATTEMPTS: 3,
        WHATSAPP_OUTBOUND_LEASE_MS: 120000,
        WHATSAPP_MAX_OUTBOUND_PER_MINUTE: 5,
        WHATSAPP_SEND_TEXT_POC_ENABLED: true,
        WHATSAPP_TEST_ALLOWED_NUMBERS: '8183003081',
        NURTURE_STALE_AFTER_MS: 1_800_000,
      },
    });
    h.messageRepository.claimNextOutboundMessage.mockResolvedValue(
      baseMessage({ idempotencyKey: 'k1' }),
    );

    await h.service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    const stops = h.lines.filter((line) => line.includes('STOPPED'));
    expect(h.sessionService.sendTextMessage).not.toHaveBeenCalled();
    expect(stops).toHaveLength(1);
    expect(stops[0]).toContain('!!!');
    expect(stops[0]).toContain('WHATSAPP_TEST_ALLOWED_NUMBERS');
  });

  it('reports a send failure with the reason instead of leaving the queue looking idle', async () => {
    const h = createTracingHarness();
    h.messageRepository.claimNextOutboundMessage.mockResolvedValue(
      baseMessage({ idempotencyKey: 'k2' }),
    );
    h.sessionService.sendTextMessage.mockRejectedValue(
      Object.assign(new Error('socket closed'), { code: 'ECONNRESET' }),
    );

    await h.service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    const failures = h.lines.filter((line) => line.includes('FAILED'));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('ECONNRESET');
    expect(failures[0]).toContain('step=send');
  });

  it('prints quiet hours as a hold with the time it will actually go out, not as a drop', async () => {
    vi.mocked(quietHours.isWithinQuietHours).mockReturnValue(true);
    const h = createTracingHarness();
    h.messageRepository.claimNextOutboundMessage.mockResolvedValue(
      baseMessage({ authoredBy: 'ai', idempotencyKey: 'k3', scheduledAt: null }),
    );

    await h.service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    const held = h.lines.filter((line) => line.includes('step=quiet-hours'));
    expect(held).toHaveLength(1);
    expect(held[0]).not.toContain('STOPPED');
    expect(held[0]).toContain('sendAt=');
  });

  it('never prints the recipient number in full', async () => {
    const h = createTracingHarness();
    h.messageRepository.claimNextOutboundMessage.mockResolvedValue(
      baseMessage({ idempotencyKey: 'k4' }),
    );

    await h.service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    expect(h.lines.join('\n')).not.toContain('919999999999');
    expect(h.lines.join('\n')).toContain('***');
  });

  it('writes nothing at all while WHATSAPP_TRACE_ENABLED is off', async () => {
    const write = vi.fn();
    const h = createHarness({
      createTrace: ({ seed }: { seed?: unknown }) =>
        createPipelineTrace({ seed, config: { WHATSAPP_TRACE_ENABLED: false }, write }),
    });
    h.messageRepository.claimNextOutboundMessage.mockResolvedValue(baseMessage());

    await h.service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    expect(write).not.toHaveBeenCalled();
  });
});
