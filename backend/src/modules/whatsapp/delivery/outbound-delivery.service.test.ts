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
  const confirmLeadQualification = vi.fn().mockResolvedValue({ _id: 'conv-1' });

  const service = createOutboundDeliveryService({
    sessionService,
    messageRepository: messageRepository as never,
    contactRepository: contactRepository as never,
    findConversationById,
    publishEvent,
    echoGuardService: echoGuardService as never,
    confirmLeadQualification: confirmLeadQualification as never,
    now: () => new Date('2026-08-25T10:00:00.000Z'),
    logger: { error: vi.fn() },
    ...overrides,
  } as never);

  return { service, messageRepository, contactRepository, sessionService, findConversationById, publishEvent, echoGuardService, confirmLeadQualification };
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

  it('asks the window about the configured hours and timezone, not hard-coded ones', async () => {
    // The window itself is proven in automation/quiet-hours.test.ts. What this pins is the
    // wiring: a deployment that sets 21/9 must have 21/9 reach the check. With the values
    // mocked to a constant everywhere else, nothing else would notice them being dropped.
    vi.mocked(quietHours.isWithinQuietHours).mockReturnValue(true);
    const { service, messageRepository } = createHarness({
      config: {
        WHATSAPP_OUTBOUND_MAX_ATTEMPTS: 3,
        WHATSAPP_OUTBOUND_LEASE_MS: 120000,
        WHATSAPP_MAX_OUTBOUND_PER_MINUTE: 5,
        WHATSAPP_SEND_TEXT_POC_ENABLED: true,
        WHATSAPP_TEST_ALLOWED_NUMBERS: '',
        WHATSAPP_QUIET_HOURS_START: 21,
        WHATSAPP_QUIET_HOURS_END: 9,
        WHATSAPP_BUSINESS_TIMEZONE: 'Asia/Kolkata',
        NURTURE_STALE_AFTER_MS: 1_800_000,
      },
    });
    messageRepository.claimNextOutboundMessage.mockResolvedValue(baseMessage({ authoredBy: 'ai' }));

    await service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    expect(quietHours.isWithinQuietHours).toHaveBeenCalledWith(
      new Date('2026-08-25T10:00:00.000Z'),
      21,
      9,
      'Asia/Kolkata',
    );
    // The reschedule target is the END of the window, never the start - aiming at the start
    // would land back inside it and re-queue forever.
    expect(quietHours.nextAllowedSendTime).toHaveBeenCalledWith(
      new Date('2026-08-25T10:00:00.000Z'),
      9,
      'Asia/Kolkata',
    );
  });

  it('holds the message for the exact time the window says, without touching attempts', async () => {
    vi.mocked(quietHours.isWithinQuietHours).mockReturnValue(true);
    vi.mocked(quietHours.nextAllowedSendTime).mockReturnValue(
      new Date('2026-08-26T03:30:00.000Z'), // 09:00 IST
    );
    const { service, messageRepository } = createHarness();
    messageRepository.claimNextOutboundMessage.mockResolvedValue(baseMessage({ authoredBy: 'ai' }));

    await service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    expect(messageRepository.rescheduleOutboundMessage).toHaveBeenCalledWith(
      expect.objectContaining({ scheduledAt: new Date('2026-08-26T03:30:00.000Z') }),
    );
    // Held, not failed: the reply survives the night and nothing counts against its retries.
    expect(messageRepository.markOutboundMessageFailed).not.toHaveBeenCalled();
    expect(messageRepository.markOutboundMessageSent).not.toHaveBeenCalled();
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

describe('confirming a lead once its reply has actually gone out', () => {
  it('confirms the conversation after an AI reply is sent', async () => {
    const { service, messageRepository, confirmLeadQualification } = createHarness();
    messageRepository.claimNextOutboundMessage.mockResolvedValue(
      baseMessage({ authoredBy: 'ai', conversationId: 'conv-7' }),
    );

    await service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    // THIS is the moment a conversation becomes an established lead: not when a classifier
    // guessed, and not when a draft was queued, but when the message reached WhatsApp.
    expect(confirmLeadQualification).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-7', organizationId: 'org-1' }),
    );
  });

  it('does NOT confirm when the owner sent the message by hand', async () => {
    const { service, messageRepository, confirmLeadQualification } = createHarness();
    messageRepository.claimNextOutboundMessage.mockResolvedValue(baseMessage({ authoredBy: 'human' }));

    await service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    // An owner typing to a stranger is not the AI qualifying anyone. Confirming here would let
    // one manual reply widen the gate for that number forever.
    expect(confirmLeadQualification).not.toHaveBeenCalled();
  });

  it('does NOT confirm when the send fails', async () => {
    const { service, messageRepository, sessionService, confirmLeadQualification } = createHarness();
    messageRepository.claimNextOutboundMessage.mockResolvedValue(baseMessage({ authoredBy: 'ai' }));
    sessionService.sendTextMessage.mockRejectedValue(new Error('socket down'));

    await service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    // A reply nobody received is not evidence of anything. Confirming on a failed send is how a
    // conversation gets permanently treated as qualified without the customer ever hearing from
    // the business.
    expect(confirmLeadQualification).not.toHaveBeenCalled();
  });

  it('does NOT confirm when quiet hours held the message back', async () => {
    vi.mocked(quietHours.isWithinQuietHours).mockReturnValue(true);
    const { service, messageRepository, confirmLeadQualification } = createHarness();
    messageRepository.claimNextOutboundMessage.mockResolvedValue(baseMessage({ authoredBy: 'ai' }));

    await service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    expect(confirmLeadQualification).not.toHaveBeenCalled();
  });

  it('still reports the message as delivered when confirmation fails', async () => {
    const { service, messageRepository, confirmLeadQualification } = createHarness();
    messageRepository.claimNextOutboundMessage.mockResolvedValue(baseMessage({ authoredBy: 'ai' }));
    confirmLeadQualification.mockRejectedValue(new Error('mongo down'));

    const result = await service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    // Failure-isolated. The message WAS sent; turning that into a failed delivery would resend
    // it, and the customer would get the same reply twice because of a bookkeeping error.
    expect(result).toMatchObject({ delivered: true });
    expect(messageRepository.markOutboundMessageSent).toHaveBeenCalled();
  });
});

/**
 * Decision 3: a reply drafted and queued in the seconds before the lead said no.
 *
 * THE QUEUE IS THE ONE PLACE A MESSAGE CAN OUTLIVE THE DECISION THAT SHOULD HAVE STOPPED IT.
 * Ingestion turns automation off the moment the rejection is read, and both sweeps skip the
 * thread from then on - but a message already claimed-or-queued has passed all of those. This
 * gate is the last thing standing between "we booked another photographer" and a cheerful
 * follow-up landing ten seconds later.
 */
describe('deliverNext sales-rejection gate', () => {
  const rejectedConversation = {
    aiAutomationEnabled: false,
    optedOutAt: null,
    salesRejectedAt: new Date('2026-08-24T09:00:00.000Z'),
    aiAutomationPausedReason: 'This lead said they are no longer going ahead — automated follow-ups stopped.',
    assignedTo: null,
  };

  it('permanently fails a queued AI message when the lead rejected us first', async () => {
    const { service, messageRepository, sessionService, findConversationById } = createHarness();
    findConversationById.mockResolvedValue(rejectedConversation);
    messageRepository.claimNextOutboundMessage.mockResolvedValue(
      baseMessage({ authoredBy: 'ai' }),
    );

    const result = await service.deliverNext({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
    });

    expect(sessionService.sendTextMessage).not.toHaveBeenCalled();
    expect(messageRepository.markOutboundMessageFailed).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'lead_rejected_service', permanent: true }),
    );
    expect(result).toMatchObject({
      delivered: false,
      failed: true,
      permanent: true,
      reason: 'lead_rejected_service',
    });
  });

  it('records the rejection, not the automation pause, as the reason', async () => {
    // A rejected conversation always has automation off too, and "automation_paused_before_send"
    // would hide the one fact anybody auditing a complaint needs to see.
    const { service, messageRepository, findConversationById } = createHarness();
    findConversationById.mockResolvedValue(rejectedConversation);
    messageRepository.claimNextOutboundMessage.mockResolvedValue(
      baseMessage({ authoredBy: 'ai' }),
    );

    await service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    expect(messageRepository.markOutboundMessageFailed).not.toHaveBeenCalledWith(
      expect.objectContaining({ error: 'automation_paused_before_send' }),
    );
  });

  it('leaves the opt-out reason alone when the lead did BOTH', async () => {
    // Opt-out is checked first and stays the recorded reason: it is the stronger statement and
    // the one a WhatsApp complaint would be about.
    const { service, messageRepository, findConversationById } = createHarness();
    findConversationById.mockResolvedValue({
      ...rejectedConversation,
      optedOutAt: new Date('2026-08-24T10:00:00.000Z'),
    });
    messageRepository.claimNextOutboundMessage.mockResolvedValue(
      baseMessage({ authoredBy: 'ai' }),
    );

    const result = await service.deliverNext({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
    });

    expect(result).toMatchObject({ reason: 'recipient_opted_out' });
  });

  it('does NOT block a human-authored message to a rejected lead', async () => {
    // The owner may well want to reply personally - "no problem, all the best". A service
    // rejection stops the ROBOT, not the business. This is the difference from an opt-out.
    const { service, sessionService, messageRepository, findConversationById } = createHarness();
    findConversationById.mockResolvedValue(rejectedConversation);
    messageRepository.claimNextOutboundMessage.mockResolvedValue(
      baseMessage({ authoredBy: 'human' }),
    );

    const result = await service.deliverNext({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
    });

    expect(sessionService.sendTextMessage).toHaveBeenCalled();
    expect(result).toMatchObject({ delivered: true });
  });

  it('does not fire for a lead who has not rejected us', async () => {
    // The positive control for this gate specifically: an AI message to an ordinary active
    // conversation must not be touched by it. Asserted on the reason rather than on delivery,
    // so this test stays about the rejection gate and not about quiet hours or the allowlist.
    const { service, messageRepository, findConversationById } = createHarness();
    findConversationById.mockResolvedValue({
      aiAutomationEnabled: true,
      optedOutAt: null,
      salesRejectedAt: null,
      assignedTo: null,
    });
    messageRepository.claimNextOutboundMessage.mockResolvedValue(
      baseMessage({ authoredBy: 'ai' }),
    );

    const result = await service.deliverNext({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
    });

    expect(messageRepository.markOutboundMessageFailed).not.toHaveBeenCalledWith(
      expect.objectContaining({ error: 'lead_rejected_service' }),
    );
    expect(result).not.toMatchObject({ reason: 'lead_rejected_service' });
  });
});

/**
 * The allowlist as the safety net for a CONTROLLED nurture test.
 *
 * Before NURTURE_ENABLED is turned on in production, the plan is to restrict sending to one
 * test handset and watch a single conversation. That plan is only worth anything if a nurture
 * message to anybody else is stopped BEFORE it reaches the socket - not logged, not retried,
 * not queued for later. These pin exactly that, on an AI-authored message, which is what the
 * nurture sweep produces.
 */
describe('the test allowlist during a controlled nurture rollout', () => {
  const allowlisted = (numbers: string) => ({
    config: {
      WHATSAPP_OUTBOUND_MAX_ATTEMPTS: 3,
      WHATSAPP_OUTBOUND_LEASE_MS: 120000,
      WHATSAPP_MAX_OUTBOUND_PER_MINUTE: 5,
      WHATSAPP_SEND_TEXT_POC_ENABLED: true,
      WHATSAPP_TEST_ALLOWED_NUMBERS: numbers,
      WHATSAPP_QUIET_HOURS_START: 0,
      WHATSAPP_QUIET_HOURS_END: 0,
      WHATSAPP_BUSINESS_TIMEZONE: 'Asia/Kolkata',
    },
  });

  it('a nurture message to a NON-test recipient never reaches the socket', async () => {
    // The harness's contact is 919999999999; the allowlist names only the test handset.
    const { service, sessionService, messageRepository } = createHarness(
      allowlisted('911111111111'),
    );
    messageRepository.claimNextOutboundMessage.mockResolvedValue(
      baseMessage({ authoredBy: 'ai' }),
    );

    const result = await service.deliverNext({
      organizationId: 'org-1',
      whatsappAccountId: 'account-1',
    });

    // The assertion that makes a controlled rollout safe: the send function was never called.
    expect(sessionService.sendTextMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      reason: 'blocked_by_test_allowlist',
      permanent: true,
    });
  });

  it('is PERMANENT, so a blocked message is not retried all night', async () => {
    const { service, messageRepository } = createHarness(allowlisted('911111111111'));
    messageRepository.claimNextOutboundMessage.mockResolvedValue(
      baseMessage({ authoredBy: 'ai' }),
    );

    await service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    expect(messageRepository.markOutboundMessageFailed).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'blocked_by_test_allowlist', permanent: true }),
    );
  });

  it('blocks when the allowlist names other numbers entirely', async () => {
    // The shape of the real risk: the allowlist is set, but to somebody else's numbers. The
    // harness's own contact is 919999999999, so neither of these can match it - including on
    // the trailing-digit rule the matcher uses.
    const { service, sessionService, messageRepository } = createHarness(
      allowlisted('917777777777,916666666666'),
    );
    messageRepository.claimNextOutboundMessage.mockResolvedValue(
      baseMessage({ authoredBy: 'ai' }),
    );

    await service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    expect(sessionService.sendTextMessage).not.toHaveBeenCalled();
  });

  it('the TEST handset itself still receives, which is what makes the test possible', async () => {
    // The positive control. An allowlist that blocked everything would pass every test above
    // and make the controlled rollout useless.
    const { service, sessionService, messageRepository } = createHarness(
      allowlisted('919999999999'),
    );
    messageRepository.claimNextOutboundMessage.mockResolvedValue(
      baseMessage({ authoredBy: 'ai' }),
    );

    await service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    expect(sessionService.sendTextMessage).toHaveBeenCalledTimes(1);
  });

  it('an EMPTY allowlist allows everyone - which is why it must be set before a rollout', async () => {
    // Stated as a test because it is the failure mode of forgetting: empty does not mean
    // "block everything", it means "no restriction".
    const { service, sessionService, messageRepository } = createHarness(allowlisted(''));
    messageRepository.claimNextOutboundMessage.mockResolvedValue(
      baseMessage({ authoredBy: 'ai' }),
    );

    await service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

    expect(sessionService.sendTextMessage).toHaveBeenCalled();
  });
});
