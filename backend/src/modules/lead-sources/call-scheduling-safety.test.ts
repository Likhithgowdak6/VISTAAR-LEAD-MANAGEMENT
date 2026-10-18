/**
 * The safety claims the call-scheduling workflow makes about its SECOND message.
 *
 * The chase sends an unsolicited WhatsApp to someone who already did not answer the first one.
 * Two of its header comments make load-bearing promises about that message that nothing else
 * tests, because each promise is kept in a different file:
 *
 *   1. "Through the existing outbound queue, so opt-out, manual takeover, the allowlist, quiet
 *      hours and session availability all apply unchanged" - which is true only because the
 *      sweep queues it `authoredBy: 'ai'`. Flip that one field to 'human' and every one of those
 *      gates is skipped at delivery, the sweep's own tests still pass, and the first person to
 *      find out is a lead who said STOP and got chased anyway.
 *
 *   2. "Whether they named a time is a separate matter handled by commitment extraction" - the
 *      chase asks only whether the person is there.
 *
 * So the delivery service here is the REAL one, driven with the REAL follow-up body, and the
 * gates are asserted on that message rather than on a generic one. Collaborators are injected,
 * no Mongo, in this codebase's usual style.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WHATSAPP_OUTBOUND_MAX_ATTEMPTS: 3,
    WHATSAPP_OUTBOUND_LEASE_MS: 120_000,
    WHATSAPP_MAX_OUTBOUND_PER_MINUTE: 5,
    WHATSAPP_SEND_TEXT_POC_ENABLED: true,
    WHATSAPP_TEST_ALLOWED_NUMBERS: '',
    WHATSAPP_QUIET_HOURS_START: 0,
    WHATSAPP_QUIET_HOURS_END: 0,
    WHATSAPP_BUSINESS_TIMEZONE: 'Asia/Kolkata',
    NURTURE_STALE_AFTER_MS: 1_800_000,
  },
}));

vi.mock('../../config/redis.js', () => ({ getRedisClient: vi.fn() }));

vi.mock('../whatsapp/automation/quiet-hours.js', () => ({
  isWithinQuietHours: vi.fn(() => false),
  nextAllowedSendTime: vi.fn(() => new Date('2026-10-17T02:30:00.000Z')),
}));

const { NO_RESPONSE_FOLLOW_UP_BODY, followUpIdempotencyKey, createCallSchedulingSweepService } =
  await import('./call-scheduling-sweep.service.js');
const { createCallSchedulingService, isAutoGreetMessage, AUTO_GREET_KEY_PREFIX } = await import(
  './call-scheduling.service.js'
);
const { createOutboundDeliveryService } = await import(
  '../whatsapp/delivery/outbound-delivery.service.js'
);
const quietHours = await import('../whatsapp/automation/quiet-hours.js');

const NOW = new Date('2026-10-17T11:00:00.000Z');

/** The follow-up exactly as the sweep queues it, down to the key and the authorship. */
const followUpMessage = (overrides: Record<string, unknown> = {}) => ({
  _id: 'msg-followup',
  organizationId: 'org-1',
  whatsappAccountId: 'account-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  body: NO_RESPONSE_FOLLOW_UP_BODY,
  authoredBy: 'ai',
  idempotencyKey: followUpIdempotencyKey('msg-greeting'),
  deliveryAttempts: 1,
  scheduledAt: NOW,
  ...overrides,
});

const createDeliveryHarness = ({
  conversation = { aiAutomationEnabled: true, assignedTo: null },
  message = followUpMessage(),
}: { conversation?: Record<string, unknown> | null; message?: Record<string, unknown> } = {}) => {
  const messageRepository = {
    claimNextOutboundMessage: vi.fn().mockResolvedValue(message),
    markOutboundMessageSent: vi.fn(),
    markOutboundMessageFailed: vi.fn(),
    rescheduleOutboundMessage: vi.fn(),
  };
  const sessionService = {
    sendTextMessage: vi.fn().mockResolvedValue({ providerMessageId: 'wamid-followup' }),
  };
  const onOutboundMessageSent = vi.fn().mockResolvedValue(undefined);

  const service = createOutboundDeliveryService({
    sessionService,
    messageRepository: messageRepository as never,
    contactRepository: {
      findContactPrivatePiiForInternalUse: vi.fn().mockResolvedValue({ phone: '919999900001' }),
    } as never,
    findConversationById: vi.fn().mockResolvedValue(conversation),
    publishEvent: vi.fn().mockResolvedValue(true),
    echoGuardService: { remember: vi.fn(), isOwnMessage: vi.fn() } as never,
    confirmLeadQualification: vi.fn().mockResolvedValue(null) as never,
    onOutboundMessageSent,
    now: () => NOW,
    logger: { error: vi.fn() },
  } as never);

  return { service, messageRepository, sessionService, onOutboundMessageSent };
};

const deliver = (harness: ReturnType<typeof createDeliveryHarness>) =>
  harness.service.deliverNext({ organizationId: 'org-1', whatsappAccountId: 'account-1' });

/** What the failure row actually recorded, which is the auditable half of a refusal. */
const refusalReason = (harness: ReturnType<typeof createDeliveryHarness>) =>
  (harness.messageRepository.markOutboundMessageFailed.mock.calls.at(-1)?.[0] ?? {}) as {
    error?: string;
    permanent?: boolean;
  };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(quietHours.isWithinQuietHours).mockReturnValue(false);
});

describe('what the chase is allowed to say', () => {
  it('promises a call today and names no time', () => {
    // The whole point of the workflow is that no time was ever agreed. A follow-up that invented
    // one - "we will call you at 4" - would commit the owner to an appointment nobody made.
    expect(NO_RESPONSE_FOLLOW_UP_BODY).toContain('call you today');
    expect(NO_RESPONSE_FOLLOW_UP_BODY).not.toMatch(/\b\d{1,2}\s*(am|pm)\b/i);
    expect(NO_RESPONSE_FOLLOW_UP_BODY).not.toMatch(/\b\d{1,2}:\d{2}\b/);
    expect(NO_RESPONSE_FOLLOW_UP_BODY).not.toMatch(/\b(tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  });

  it('quotes no price, no package and no link', () => {
    // It was given none of those, here or anywhere. The greeting is held to the same rule by its
    // directive; this message is fixed text, so the rule is enforced by reading it.
    expect(NO_RESPONSE_FOLLOW_UP_BODY).not.toMatch(/₹|\$|\brs\.?\s*\d/i);
    expect(NO_RESPONSE_FOLLOW_UP_BODY).not.toMatch(/https?:\/\//);
    expect(NO_RESPONSE_FOLLOW_UP_BODY).not.toMatch(/\b(package|offer|discount|deal)\b/i);
  });

  it('says it once', () => {
    // One sentence, and one chase. Anything longer invites a second paragraph, and a second
    // paragraph on an unanswered thread is what a spam report looks like.
    expect(NO_RESPONSE_FOLLOW_UP_BODY.split(/[.!?]+\s/).filter(Boolean)).toHaveLength(1);
  });
});

describe('the chase inherits every send-time gate, because it is AI-authored', () => {
  it('is dropped, not sent, to a lead who asked us to stop', async () => {
    const harness = createDeliveryHarness({
      conversation: { aiAutomationEnabled: true, optedOutAt: new Date('2026-10-17T10:30:00.000Z') },
    });

    const result = await deliver(harness);

    expect(harness.sessionService.sendTextMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ delivered: false, reason: 'recipient_opted_out' });
    // Permanent: an opt-out is not a transient condition and must never be retried.
    expect(refusalReason(harness)).toMatchObject({ error: 'recipient_opted_out', permanent: true });
  });

  it('is dropped when the owner took the conversation over', async () => {
    // The hour elapsed while the owner was mid-conversation by hand. The chase would talk over
    // them, and tell a lead they are being handled by a machine the owner just stepped in front of.
    const harness = createDeliveryHarness({
      conversation: { aiAutomationEnabled: false, aiAutomationPausedReason: 'owner_takeover' },
    });

    const result = await deliver(harness);

    expect(harness.sessionService.sendTextMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ reason: 'automation_paused_before_send' });
  });

  it('is held until morning rather than dropped when the hour runs out at midnight', async () => {
    vi.mocked(quietHours.isWithinQuietHours).mockReturnValue(true);

    const harness = createDeliveryHarness();
    const result = await deliver(harness);

    expect(harness.sessionService.sendTextMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ rescheduled: true, reason: 'quiet_hours' });
    // Rescheduled, not failed: the chase is late, not cancelled.
    expect(harness.messageRepository.markOutboundMessageFailed).not.toHaveBeenCalled();
    expect(harness.messageRepository.rescheduleOutboundMessage).toHaveBeenCalled();
  });

  it('is dropped if it sat in the queue past the staleness window', async () => {
    // "We have not heard from you, we will call today" sent a day late is worse than silence.
    const harness = createDeliveryHarness({
      message: followUpMessage({ scheduledAt: new Date(NOW.getTime() - 7_200_000) }),
    });

    const result = await deliver(harness);

    expect(harness.sessionService.sendTextMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({ reason: 'stale_ai_message_dropped' });
  });

  it('goes out when nothing refuses it', async () => {
    const harness = createDeliveryHarness();

    await expect(deliver(harness)).resolves.toMatchObject({ delivered: true });
    expect(harness.sessionService.sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: NO_RESPONSE_FOLLOW_UP_BODY }),
    );
  });

  it('would skip all of them if the sweep ever queued it as human-authored', async () => {
    // THE REASON THE GATES ABOVE HOLD. Every one of them lives inside
    // `if (message.authoredBy === AI)`. This is the mutation that silently removes the lot, and
    // it is what the sweep-side assertion further down is guarding against.
    const harness = createDeliveryHarness({
      message: followUpMessage({ authoredBy: 'human' }),
      conversation: { aiAutomationEnabled: false, optedOutAt: new Date('2026-10-17T10:30:00.000Z') },
    });

    await expect(deliver(harness)).resolves.toMatchObject({ delivered: true });
  });
});

describe('the chase cannot chase itself', () => {
  it('the follow-up is not an auto-greet, so delivering it arms nothing', () => {
    // Both messages are AI-authored and both reach the same successful-send hook. The only thing
    // standing between them is the key prefix - if the follow-up matched it, every delivered
    // chase would register a fresh one-hour attempt and the lead would be messaged hourly.
    expect(isAutoGreetMessage(followUpMessage())).toBe(false);
    expect(followUpIdempotencyKey('msg-greeting')).not.toContain(AUTO_GREET_KEY_PREFIX);
  });

  it('the registration hook does nothing for a delivered follow-up', async () => {
    const findLeadSubmissionsForConversation = vi.fn();
    const registerCallSchedulingAttempt = vi.fn();

    await createCallSchedulingService({
      findLeadSubmissionsForConversation: findLeadSubmissionsForConversation as never,
      registerCallSchedulingAttempt: registerCallSchedulingAttempt as never,
      logger: { info: vi.fn(), error: vi.fn() },
    }).onOutboundMessageSent({
      message: followUpMessage() as never,
      organizationId: 'org-1',
      sentAt: NOW,
    });

    expect(registerCallSchedulingAttempt).not.toHaveBeenCalled();
    // Not even a lookup: the prefix check is a string comparison and must short-circuit before
    // the database is touched, because this hook runs on EVERY outbound message in the system.
    expect(findLeadSubmissionsForConversation).not.toHaveBeenCalled();
  });

  it('the real delivery path passes the follow-up to the hook unchanged', async () => {
    // Proves the two halves above meet: the hook really is called for this message, and it is
    // the hook's own prefix check - not some filter in delivery - that makes it a no-op.
    const harness = createDeliveryHarness();

    await deliver(harness);

    expect(harness.onOutboundMessageSent).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ idempotencyKey: followUpIdempotencyKey('msg-greeting') }),
      }),
    );
  });
});

describe('the sweep queues it the way the gates require', () => {
  const runSweep = async ({ attempt }: { attempt: Record<string, unknown> }) => {
    const enqueueOutboundMessage = vi.fn().mockResolvedValue({ _id: 'msg-followup' });
    const createFollowUpTask = vi.fn().mockResolvedValue({ _id: 'task-1' });
    let claimed = false;

    await createCallSchedulingSweepService({
      claimDueCallSchedulingAttempt: vi.fn(async () => {
        if (claimed) return null;
        claimed = true;
        return attempt;
      }) as never,
      claimFollowUpSend: vi.fn().mockResolvedValue({ _id: 'attempt-1' }) as never,
      releaseFollowUpSendClaim: vi.fn() as never,
      recordCallSchedulingAction: vi.fn() as never,
      settleCallSchedulingAttempt: vi.fn() as never,
      releaseCallSchedulingClaim: vi.fn() as never,
      findConversationById: vi.fn().mockResolvedValue({ _id: 'conv-1', lastInboundAt: null }) as never,
      createFollowUpTask: createFollowUpTask as never,
      getOwnerActor: vi.fn().mockResolvedValue({ actor: { _id: 'owner-1' } }) as never,
      getAiSystemUser: vi.fn().mockResolvedValue({ _id: 'ai-user' }) as never,
      enqueueOutboundMessage: enqueueOutboundMessage as never,
      now: () => NOW,
      logger: { info: vi.fn(), error: vi.fn() },
    }).sweepOnce({ limit: 1 });

    return {
      queued: (enqueueOutboundMessage.mock.calls.at(0)?.[0] ?? {}) as Record<string, unknown>,
      task: (createFollowUpTask.mock.calls.at(0)?.[0] ?? {}) as Record<string, unknown>,
    };
  };

  const dueAttempt = {
    _id: 'attempt-1',
    organizationId: 'org-1',
    whatsappAccountId: 'account-1',
    conversationId: 'conv-1',
    initialMessageId: 'msg-greeting',
    sentAt: new Date(NOW.getTime() - 3_600_000),
    attempts: 1,
    claimToken: 'token-1',
  };

  it('authors the follow-up as the AI, which is what subjects it to every gate above', async () => {
    const { queued } = await runSweep({ attempt: dueAttempt });

    expect(queued.authoredBy).toBe('ai');
    expect(queued.body).toBe(NO_RESPONSE_FOLLOW_UP_BODY);
  });

  it('tells the owner to agree a time rather than claiming one was agreed', async () => {
    const { task } = await runSweep({ attempt: dueAttempt });

    // The reminder is the owner's side of the same honesty rule the customer message follows:
    // nobody has named a time, so nothing may say one has been.
    expect(String(task.sourceQuote)).toContain('No reply within an hour');
    expect(String(task.sourceQuote)).toContain('agree a time');
    expect(String(task.title)).toBe('Call the customer today');
    expect(String(task.sourceQuote)).not.toMatch(/\b\d{1,2}\s*(am|pm)\b/i);
  });
});

describe('cancelling the chase is independent of commitment extraction', () => {
  const cancelOn = async (receivedAt: Date) => {
    const markCallSchedulingReplied = vi.fn().mockResolvedValue({ _id: 'attempt-1' });

    await createCallSchedulingService({
      markCallSchedulingReplied: markCallSchedulingReplied as never,
      logger: { info: vi.fn(), error: vi.fn() },
    }).onInboundMessage({ organizationId: 'org-1', conversationId: 'conv-1', receivedAt });

    return markCallSchedulingReplied;
  };

  it('cancels on a reply that names no time at all', async () => {
    // The chase asked one question - "are you there" - and a thumbs-up answers it. Whether they
    // named a TIME is commitment extraction's job, and it runs separately on the same message.
    const marked = await cancelOn(NOW);

    expect(marked).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', repliedAt: NOW }),
    );
  });

  it('is not given the message text, so it cannot be reading it for a time', async () => {
    // Structural, and the reason the two stay independent: this hook receives a conversation and
    // a timestamp. There is no body here to parse, so no future change can quietly make the
    // cancellation conditional on what the customer said.
    const marked = await cancelOn(NOW);

    const call = marked.mock.calls.at(0)?.[0] as Record<string, unknown>;
    expect(Object.keys(call).sort()).toEqual(['conversationId', 'organizationId', 'repliedAt']);
  });
});
