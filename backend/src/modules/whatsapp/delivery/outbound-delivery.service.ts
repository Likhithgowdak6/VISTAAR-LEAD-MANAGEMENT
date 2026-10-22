import { env, type Env } from '../../../config/env.js';
import { MESSAGE_AUTHORS } from '../../../constants/message-authors.js';
import {
  createPipelineTrace,
  maskJid as maskTraceJid,
  PIPELINE_STAGE,
  preview as tracePreview,
  type PipelineTrace,
} from '../../../observability/pipeline-trace.js';
import { type ObjectIdLike } from '../../../types/common.js';
import { findContactPrivatePiiForInternalUse as defaultFindContactPrivatePiiForInternalUse } from '../../contacts/contact.repository.js';
import { findConversationById as defaultFindConversationById } from '../../conversations/conversation.repository.js';
import { type MessageDocument } from '../../messages/message.model.js';
import {
  claimNextOutboundMessage as defaultClaimNextOutboundMessage,
  markOutboundMessageFailed as defaultMarkOutboundMessageFailed,
  markOutboundMessageSent as defaultMarkOutboundMessageSent,
  rescheduleOutboundMessage as defaultRescheduleOutboundMessage,
} from '../../messages/message.repository.js';
import { confirmLeadQualification as defaultConfirmLeadQualification } from '../../conversations/conversation.repository.js';
import { recordOutboundDeliveryOutcome as defaultRecordOutboundDeliveryOutcome } from '../../conversations/conversation.repository.js';
import {
  createCallSchedulingService,
  type CallSchedulingService,
} from '../../lead-sources/call-scheduling.service.js';
import { REALTIME_REASONS } from '../../realtime/realtime.events.js';
import { publishConversationChanged as defaultPublishConversationChanged } from '../../realtime/realtime.publisher.js';
import {
  type OutboundMediaKind,
  type SendMediaMessageOptions,
  type SendMediaMessageResult,
  type SendTextMessageResult,
} from '../providers/whatsapp-provider.interface.js';
import { mediaStorage as defaultMediaStorage } from '../../media/media-storage.service.js';
import { createOutboundAllowlist } from '../automation/allowlist.js';
import { createEchoGuardService, type EchoGuardService } from '../automation/echo-guard.service.js';
import { isWithinQuietHours, nextAllowedSendTime } from '../automation/quiet-hours.js';

const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 15 * 60_000;

const asBoolean = (value: unknown): boolean => value === true || value === 'true';

const defaultComputeBackoffMs = (attempts: number): number =>
  Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1));

/**
 * Keeps a safe, non-PII string for the stored delivery error. Provider error messages
 * can echo recipient identifiers, so only the code/name is retained.
 */
const sanitizeDeliveryError = (error: unknown): string => {
  const err = error as { code?: unknown; name?: unknown } | null | undefined;
  return (err?.code ?? err?.name ?? 'send_failed') as string;
};

export interface ContactPrivatePii {
  phone?: string | null;
  providerJids?: Array<string | null | undefined> | null;
}

export interface DeliverySessionService {
  sendTextMessage: (options: {
    to: string;
    text?: string | null;
  }) => Promise<SendTextMessageResult | { providerMessageId?: string | null }>;
  /**
   * Optional: a session wired before attachments existed, or a test double, simply does not have
   * it. A media message then fails permanently with `media_unsupported` rather than throwing
   * somewhere that would retry it forever.
   */
  sendMediaMessage?: (
    options: Omit<SendMediaMessageOptions, 'sessionHandle' | 'socket'>,
  ) => Promise<SendMediaMessageResult | { providerMessageId?: string | null }>;
}

export interface ContactRepositoryLike {
  findContactPrivatePiiForInternalUse: (options: {
    contactId?: ObjectIdLike;
    organizationId?: ObjectIdLike;
  }) => Promise<ContactPrivatePii | null>;
}

export interface MessageRepositoryLike {
  claimNextOutboundMessage: (options: {
    organizationId?: ObjectIdLike;
    whatsappAccountId?: ObjectIdLike;
    now?: Date;
    maxAttempts?: number;
    leaseMs?: number;
  }) => Promise<MessageDocument | null>;
  markOutboundMessageSent: (options: {
    messageId?: ObjectIdLike;
    organizationId?: ObjectIdLike;
    providerMessageId?: string | null;
    now?: Date;
  }) => Promise<unknown>;
  markOutboundMessageFailed: (options: {
    messageId?: ObjectIdLike;
    organizationId?: ObjectIdLike;
    error?: string;
    permanent?: boolean;
    nextAttemptAt?: Date | null;
    now?: Date;
  }) => Promise<unknown>;
  rescheduleOutboundMessage: (options: {
    messageId?: ObjectIdLike;
    organizationId?: ObjectIdLike;
    scheduledAt?: Date | null;
    now?: Date;
  }) => Promise<unknown>;
}

export interface CreateOutboundDeliveryServiceOptions {
  sessionService: DeliverySessionService;
  config?: Env;
  /**
   * Promotes the conversation to an established lead once an AI reply has actually been sent.
   * Injected so the delivery tests can assert it without a database.
   */
  confirmLeadQualification?: typeof defaultConfirmLeadQualification;
  /**
   * Starts the one-hour call-scheduling clock, but only for a delivered Meta-form greeting.
   * A no-op for every other message; see call-scheduling.service.ts.
   */
  onOutboundMessageSent?: CallSchedulingService['onOutboundMessageSent'];
  contactRepository?: ContactRepositoryLike;
  messageRepository?: MessageRepositoryLike;
  /** Injected so the tests can assert the media path without touching a filesystem. */
  mediaStorage?: { readMediaObject: (objectKey: string) => Promise<Buffer> };
  /** Stamps the delivered/failed timestamps the inbox and analytics read. */
  recordOutboundDeliveryOutcome?: typeof defaultRecordOutboundDeliveryOutcome;
  findConversationById?: typeof defaultFindConversationById;
  publishEvent?: (options: {
    organizationId?: ObjectIdLike;
    conversationId?: ObjectIdLike;
    assignedTo?: ObjectIdLike | null;
    reason?: string;
  }) => Promise<unknown>;
  computeBackoffMs?: (attempts: number) => number;
  now?: () => Date;
  logger?: { error?: (...args: unknown[]) => void };
  /**
   * The second half of pipeline stage 13: claimed, allowlist, then sent or failed. Seeded with
   * the claimed row's idempotency key, which is what makes these lines carry the same
   * correlation id as the "queued" line printed minutes earlier by outbound-message.service.
   */
  createTrace?: (options: { seed?: unknown }) => PipelineTrace;
  echoGuardService?: EchoGuardService;
}

export interface DeliverNextOptions {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike;
}

export interface DrainQueueOptions {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike;
  max?: number;
}

export interface PublishStatusChangeOptions {
  organizationId?: ObjectIdLike;
  message: Pick<MessageDocument, 'conversationId'>;
}

const resolveRecipient = (privatePii: ContactPrivatePii | null | undefined): string | null => {
  const providerJid = privatePii?.providerJids?.find(
    (jid) => typeof jid === 'string' && jid.trim() !== '',
  );

  if (providerJid) {
    return providerJid;
  }

  const phone = privatePii?.phone;

  return typeof phone === 'string' && phone.trim() !== '' ? phone.trim() : null;
};

/**
 * Drains queued outbound messages and delivers them through the running WhatsApp session.
 *
 * A message is claimed atomically (status -> sending) before sending so overlapping ticks
 * never double-send. On success the row becomes `sent` with the provider message id; on
 * failure it becomes `failed` with a backoff `nextAttemptAt`, or `failed_permanent` once
 * the attempt cap is reached.
 */
export const createOutboundDeliveryService = ({
  sessionService,
  config = env,
  contactRepository = {
    findContactPrivatePiiForInternalUse:
      defaultFindContactPrivatePiiForInternalUse as ContactRepositoryLike['findContactPrivatePiiForInternalUse'],
  },
  messageRepository = {
    claimNextOutboundMessage:
      defaultClaimNextOutboundMessage as MessageRepositoryLike['claimNextOutboundMessage'],
    markOutboundMessageSent:
      defaultMarkOutboundMessageSent as MessageRepositoryLike['markOutboundMessageSent'],
    markOutboundMessageFailed:
      defaultMarkOutboundMessageFailed as MessageRepositoryLike['markOutboundMessageFailed'],
    rescheduleOutboundMessage:
      defaultRescheduleOutboundMessage as MessageRepositoryLike['rescheduleOutboundMessage'],
  },
  mediaStorage = defaultMediaStorage,
  recordOutboundDeliveryOutcome = defaultRecordOutboundDeliveryOutcome,
  findConversationById = defaultFindConversationById,
  publishEvent = defaultPublishConversationChanged as CreateOutboundDeliveryServiceOptions['publishEvent'],
  computeBackoffMs = defaultComputeBackoffMs,
  now = () => new Date(),
  logger = console,
  createTrace = createPipelineTrace,
  echoGuardService = createEchoGuardService(),
  confirmLeadQualification = defaultConfirmLeadQualification,
  onOutboundMessageSent = createCallSchedulingService().onOutboundMessageSent,
}: CreateOutboundDeliveryServiceOptions) => {
  const maxAttempts = Number(config.WHATSAPP_OUTBOUND_MAX_ATTEMPTS ?? 3);
  const leaseMs = Number(config.WHATSAPP_OUTBOUND_LEASE_MS ?? 120_000);
  const maxPerMinute = Number(config.WHATSAPP_MAX_OUTBOUND_PER_MINUTE ?? 5);
  const sendEnabled = asBoolean(config.WHATSAPP_SEND_TEXT_POC_ENABLED);
  const allowlist = createOutboundAllowlist(config.WHATSAPP_TEST_ALLOWED_NUMBERS ?? '');

  const publishStatusChange = async ({ organizationId, message }: PublishStatusChangeOptions) => {
    const conversation = await findConversationById({
      conversationId: message.conversationId,
      organizationId,
    });

    await publishEvent?.({
      organizationId,
      conversationId: message.conversationId,
      assignedTo: conversation?.assignedTo ?? null,
      reason: REALTIME_REASONS.STATUS,
    });
  };

  /**
   * Ends a message that can never succeed: the file is gone, or this session cannot carry it.
   * Separate from the catch below because these are not transport failures - a retry would do
   * the same thing again in thirty seconds, forever.
   */
  const failPermanently = async ({
    organizationId,
    message,
    reason,
    trace,
  }: {
    organizationId?: ObjectIdLike;
    message: MessageDocument;
    reason: string;
    trace: PipelineTrace;
  }) => {
    trace.stop(
      PIPELINE_STAGE.OUTBOUND_DELIVERY,
      reason === 'media_missing'
        ? 'the attachment is recorded as stored but is not on disk, so there is nothing to send'
        : 'this WhatsApp session cannot send attachments',
      () => ({ step: 'media', message: message._id.toString() }),
    );

    await messageRepository.markOutboundMessageFailed({
      messageId: message._id,
      organizationId,
      error: reason,
      permanent: true,
      now: now(),
    });

    await publishStatusChange({ organizationId, message });
  };

  const deliverNext = async ({ organizationId, whatsappAccountId }: DeliverNextOptions = {}) => {
    if (!sendEnabled) {
      return {
        delivered: false,
        disabled: true,
      };
    }

    const message = await messageRepository.claimNextOutboundMessage({
      organizationId,
      whatsappAccountId,
      now: now(),
      maxAttempts,
      leaseMs,
    });

    if (!message) {
      return {
        delivered: false,
        empty: true,
      };
    }

    // Same seed as the "queued" line printed when this row was created, so the whole of stage 13
    // reads as one thread even though the two halves are minutes and a poll tick apart.
    const trace = createTrace({ seed: message.idempotencyKey ?? message._id.toString() });

    trace.pass(PIPELINE_STAGE.OUTBOUND_DELIVERY, () => ({
      step: 'claimed',
      message: message._id.toString(),
      conversation: message.conversationId?.toString(),
      author: message.authoredBy,
      attempt: message.deliveryAttempts,
    }));

    const privatePii = await contactRepository.findContactPrivatePiiForInternalUse({
      contactId: message.contactId,
      organizationId,
    });

    const recipient = resolveRecipient(privatePii);

    if (!recipient) {
      trace.stop(
        PIPELINE_STAGE.OUTBOUND_DELIVERY,
        'the contact has no phone number and no provider JID, so there is no address to send to',
        () => ({ step: 'recipient', message: message._id.toString() }),
      );

      await messageRepository.markOutboundMessageFailed({
        messageId: message._id,
        organizationId,
        error: 'no_recipient',
        permanent: true,
        now: now(),
      });

      await publishStatusChange({ organizationId, message });

      return {
        delivered: false,
        failed: true,
        permanent: true,
        reason: 'no_recipient',
      };
    }

    // (a) Test-phase allowlist: applies to every send, AI or human-authored, whenever
    // WHATSAPP_TEST_ALLOWED_NUMBERS is non-empty. The send address is often an opaque
    // `<id>@lid` carrying no phone, so the contact's stored phone is offered alongside it -
    // checking the JID alone refuses a legitimate recipient whose number IS allowed.
    if (!allowlist.permits(recipient, privatePii?.phone)) {
      trace.stop(
        PIPELINE_STAGE.OUTBOUND_DELIVERY,
        'recipient is not on WHATSAPP_TEST_ALLOWED_NUMBERS, so the send was blocked before it reached the socket',
        () => ({ step: 'allowlist', to: maskTraceJid(recipient), message: message._id.toString() }),
      );

      await messageRepository.markOutboundMessageFailed({
        messageId: message._id,
        organizationId,
        error: 'blocked_by_test_allowlist',
        permanent: true,
        now: now(),
      });

      await publishStatusChange({ organizationId, message });

      return {
        delivered: false,
        failed: true,
        permanent: true,
        reason: 'blocked_by_test_allowlist',
      };
    }

    trace.pass(PIPELINE_STAGE.OUTBOUND_DELIVERY, () => ({
      step: 'allowlist',
      to: maskTraceJid(recipient),
      verdict: allowlist.active ? 'allowed' : 'not configured (all recipients allowed)',
    }));

    // (b) AI-authored guards: an opt-out check, a re-check that automation is still on, a
    // staleness check, and quiet hours. Human-authored messages (staff dashboard sends) skip all
    // four - they are never gated by the conversation's automation flag, never dropped for
    // staleness (they carry `scheduledAt: null`), and never delayed for quiet hours. That is
    // also the whole point of putting the opt-out check inside this branch: the lead opted out
    // of being AUTOMATED at, not of hearing from the business, and the owner may still need to
    // answer them personally.
    if (message.authoredBy === MESSAGE_AUTHORS.AI) {
      const conversation = await findConversationById({
        conversationId: message.conversationId,
        organizationId,
      });

      // Checked before the automation flag so the recorded reason says what actually happened.
      // An opted-out conversation always has automation off too, and "automation_paused" would
      // hide the one fact anybody auditing a complaint needs to see. This is the last line of
      // defence: it catches a message drafted and queued before the lead said stop.
      if (conversation?.optedOutAt) {
        trace.stop(
          PIPELINE_STAGE.OUTBOUND_DELIVERY,
          'this lead asked us to stop messaging them after the reply was queued, so it is dropped rather than sent',
          () => ({ step: 'opt-out', message: message._id.toString() }),
        );

        await messageRepository.markOutboundMessageFailed({
          messageId: message._id,
          organizationId,
          error: 'recipient_opted_out',
          permanent: true,
          now: now(),
        });

        await publishStatusChange({ organizationId, message });

        return {
          delivered: false,
          failed: true,
          permanent: true,
          reason: 'recipient_opted_out',
        };
      }

      // Checked before the automation flag for the same reason the opt-out is: both turn
      // automation off as well, and "automation_paused" would hide the one fact anybody
      // auditing a complaint needs to see. THIS IS THE LAST LINE OF DEFENCE for a reply that
      // was drafted and queued in the seconds before the lead said they had booked somebody
      // else - the queue is the one place a message can outlive the decision that should have
      // stopped it.
      if (conversation?.salesRejectedAt) {
        trace.stop(
          PIPELINE_STAGE.OUTBOUND_DELIVERY,
          'this lead said they are not going ahead after the reply was queued, so it is dropped rather than sent',
          () => ({ step: 'sales-rejected', message: message._id.toString() }),
        );

        await messageRepository.markOutboundMessageFailed({
          messageId: message._id,
          organizationId,
          error: 'lead_rejected_service',
          permanent: true,
          now: now(),
        });

        await publishStatusChange({ organizationId, message });

        return {
          delivered: false,
          failed: true,
          permanent: true,
          reason: 'lead_rejected_service',
        };
      }

      if (!conversation || conversation.aiAutomationEnabled !== true) {
        trace.stop(
          PIPELINE_STAGE.OUTBOUND_DELIVERY,
          conversation?.aiAutomationPausedReason
            ? `automation was paused after the reply was queued: ${conversation.aiAutomationPausedReason}`
            : 'automation is no longer on for this conversation, so the queued AI reply is dropped',
          () => ({ step: 'automation', message: message._id.toString() }),
        );

        await messageRepository.markOutboundMessageFailed({
          messageId: message._id,
          organizationId,
          error: 'automation_paused_before_send',
          permanent: true,
          now: now(),
        });

        await publishStatusChange({ organizationId, message });

        return {
          delivered: false,
          failed: true,
          permanent: true,
          reason: 'automation_paused_before_send',
        };
      }

      // (c) Stale-message guard: the poller may have been down, or a huge backlog piled up. A
      // reply that goes out this wildly late reads worse than silence, so it is dropped rather
      // than sent. NURTURE_STALE_AFTER_MS is reused here rather than a duplicate env var - this
      // guard is conceptually general to any AI-authored send, not nurture-specific.
      if (
        message.scheduledAt &&
        now().getTime() - message.scheduledAt.getTime() > config.NURTURE_STALE_AFTER_MS
      ) {
        trace.stop(
          PIPELINE_STAGE.OUTBOUND_DELIVERY,
          'this reply sat in the queue past NURTURE_STALE_AFTER_MS - sending it now would read worse than silence, so it is dropped',
          () => ({
            step: 'staleness',
            message: message._id.toString(),
            queuedFor: message.scheduledAt,
          }),
        );

        await messageRepository.markOutboundMessageFailed({
          messageId: message._id,
          organizationId,
          error: 'stale_ai_message_dropped',
          permanent: true,
          now: now(),
        });

        await publishStatusChange({ organizationId, message });

        return {
          delivered: false,
          failed: true,
          permanent: true,
          reason: 'stale_ai_message_dropped',
        };
      }

      // (c2) SUPERSEDED BY THE CUSTOMER. The draft was written against the conversation as it
      // stood when it was queued; if the lead has said something since, it is answering a
      // question they have already moved on from - and for a silence follow-up ("still
      // there?") it is worse than that, because they plainly are.
      //
      // THE WINDOW IS NOT THEORETICAL. Every AI message carries a 60-120s human-like send
      // delay (WHATSAPP_HUMAN_DELAY_*), and the claim query matches on `scheduledAt <= now`
      // alone - so a reply arriving inside that window previously went out regardless. The
      // other direction is already handled: a reply TO this inbound is enqueued after it, so
      // its createdAt is later and it is not superseded.
      //
      // Checked HERE, after the claim, because that is the only point where the row is already
      // ours and the conversation has just been re-read. A check before the claim would race.
      const supersededBy = conversation?.lastInboundAt ?? null;

      if (supersededBy && message.createdAt && supersededBy.getTime() > message.createdAt.getTime()) {
        trace.stop(
          PIPELINE_STAGE.OUTBOUND_DELIVERY,
          'the lead sent something after this reply was queued, so the reply is answering a moment that has passed and is dropped rather than sent',
          () => ({ step: 'superseded', message: message._id.toString() }),
        );

        await messageRepository.markOutboundMessageFailed({
          messageId: message._id,
          organizationId,
          error: 'superseded_by_inbound',
          permanent: true,
          now: now(),
        });

        await publishStatusChange({ organizationId, message });

        return {
          delivered: false,
          failed: true,
          permanent: true,
          reason: 'superseded_by_inbound',
        };
      }

      if (
        isWithinQuietHours(
          now(),
          config.WHATSAPP_QUIET_HOURS_START,
          config.WHATSAPP_QUIET_HOURS_END,
          config.WHATSAPP_BUSINESS_TIMEZONE,
        )
      ) {
        const nextAllowedTime = nextAllowedSendTime(
          now(),
          config.WHATSAPP_QUIET_HOURS_END,
          config.WHATSAPP_BUSINESS_TIMEZONE,
        );

        // Not a stop: the reply is not lost, it is held. Printed as a pass with the time it
        // will actually go out, which is the answer to "why has nothing happened".
        trace.pass(PIPELINE_STAGE.OUTBOUND_DELIVERY, () => ({
          step: 'quiet-hours',
          message: message._id.toString(),
          held: 'inside WHATSAPP_QUIET_HOURS - rescheduled, not dropped',
          sendAt: nextAllowedTime,
        }));

        await messageRepository.rescheduleOutboundMessage({
          messageId: message._id,
          organizationId,
          scheduledAt: nextAllowedTime,
          now: now(),
        });

        return {
          delivered: false,
          rescheduled: true,
          reason: 'quiet_hours',
        };
      }
    }

    // (d) An attachment is read off disk here and nowhere earlier: a 12 MB video has no business
    // sitting in memory while the message waits in the queue, and a row that fails every guard
    // above should never have caused a disk read at all.
    let mediaPayload: { bytes: Buffer; kind: OutboundMediaKind } | null = null;

    if (message.mediaObjectKey) {
      const kind = message.type as OutboundMediaKind;

      if (typeof sessionService.sendMediaMessage !== 'function') {
        await failPermanently({ organizationId, message, reason: 'media_unsupported', trace });

        return {
          delivered: false,
          failed: true,
          permanent: true,
          reason: 'media_unsupported',
        };
      }

      try {
        mediaPayload = { bytes: await mediaStorage.readMediaObject(message.mediaObjectKey), kind };
      } catch {
        // The row says stored and the disk disagrees. Retrying cannot conjure the file back, so
        // this is permanent - and the reason is specific enough to diagnose from the inbox.
        await failPermanently({ organizationId, message, reason: 'media_missing', trace });

        return {
          delivered: false,
          failed: true,
          permanent: true,
          reason: 'media_missing',
        };
      }
    }

    try {
      const result = mediaPayload
        ? await sessionService.sendMediaMessage!({
            to: recipient,
            kind: mediaPayload.kind,
            data: mediaPayload.bytes,
            mimeType: message.media?.mimeType ?? 'application/octet-stream',
            fileName: message.media?.fileName ?? null,
            caption: message.body,
            // Persisted at upload time; `audio` alone would arrive as an attached track.
            isVoiceNote: message.media?.isVoiceNote === true,
          })
        : await sessionService.sendTextMessage({
            to: recipient,
            text: message.body,
          });

      await messageRepository.markOutboundMessageSent({
        messageId: message._id,
        organizationId,
        providerMessageId: result?.providerMessageId ?? null,
        now: now(),
      });

      // Stamped here, at the one moment the message is known to have reached WhatsApp, so the
      // inbox and the analytics page can tell an answered customer from a queued draft.
      // Failure-isolated: a bookkeeping error must not turn a delivered message into a failed
      // one, which would resend it.
      await recordOutboundDeliveryOutcome({
        conversationId: message.conversationId,
        organizationId,
        authoredByAi: message.authoredBy === MESSAGE_AUTHORS.AI,
        outcome: 'sent',
        now: now(),
      }).catch((error: unknown) => {
        const err = error as { code?: unknown; name?: unknown };
        logger?.error?.('Could not record the delivery outcome on the conversation.', {
          code: err?.code,
          name: err?.name,
        });
      });

      // Every successful send is remembered so the echo guard can recognize our own message
      // when Baileys reflects it back as a `fromMe` inbound event.
      trace.pass(PIPELINE_STAGE.OUTBOUND_DELIVERY, () => ({
        step: 'sent',
        message: message._id.toString(),
        to: maskTraceJid(recipient),
        providerMessageId: result?.providerMessageId ?? '(none returned)',
        body: tracePreview(message.body),
      }));

      await echoGuardService.remember({
        accountId: message.whatsappAccountId,
        providerMessageId: result?.providerMessageId ?? null,
      });

      // THE CONVERSATION IS NOW AN ESTABLISHED LEAD - and this is the only place that can
      // honestly say so. The eligibility gate's verdict was a classifier's guess; a draft that
      // was queued might never have left. Here the message has actually reached WhatsApp, which
      // means it cleared the gate, automation, safety checks, quiet hours and the queue. From
      // the next inbound message the gate stops re-interviewing this thread.
      //
      // AI-AUTHORED ONLY. An owner typing by hand is not the AI qualifying anyone, and treating
      // it as such would let any manual reply to any stranger widen the gate for that number.
      //
      // Idempotent and atomic in the repository, so a retried delivery cannot re-stamp it, and
      // failure-isolated here: a conversation that cannot be marked must not turn a message that
      // WAS delivered into a failed one, which would resend it.
      if (message.authoredBy === MESSAGE_AUTHORS.AI) {
        await confirmLeadQualification({
          conversationId: message.conversationId,
          organizationId,
        }).catch((error: unknown) => {
          const err = error as { code?: unknown; name?: unknown };
          logger?.error?.('Could not confirm lead qualification after a successful send.', {
            code: err?.code,
            name: err?.name,
          });
        });
      }

      // THE ONLY MOMENT A CHASE MAY BE ARMED. Queued is not sent, and an hour counted from a
      // draft would chase someone who was never asked anything. Failure-isolated for the same
      // reason as the qualification hook above: this message WAS delivered, and turning that
      // into a failure would resend it.
      await onOutboundMessageSent({
        message,
        organizationId: organizationId as ObjectIdLike,
        sentAt: now(),
      }).catch((error: unknown) => {
        const err = error as { code?: unknown; name?: unknown };
        logger?.error?.('Could not arm the call-scheduling follow-up after a send.', {
          code: err?.code,
          name: err?.name,
        });
      });

      await publishStatusChange({ organizationId, message });

      return {
        delivered: true,
        messageId: message._id.toString(),
      };
    } catch (error: unknown) {
      const permanent = message.deliveryAttempts >= maxAttempts;
      const nextAttemptAt = permanent
        ? null
        : new Date(now().getTime() + computeBackoffMs(message.deliveryAttempts));

      trace.fail(PIPELINE_STAGE.OUTBOUND_DELIVERY, error, () => ({
        step: 'send',
        message: message._id.toString(),
        to: maskTraceJid(recipient),
        outcome: permanent
          ? 'permanent - no further attempts'
          : `retrying at ${nextAttemptAt?.toTimeString().slice(0, 8) ?? 'unknown'}`,
      }));

      const err = error as { code?: unknown; name?: unknown };
      logger?.error?.('Outbound delivery attempt failed safely.', {
        code: err?.code,
        name: err?.name,
        permanent,
      });

      await messageRepository.markOutboundMessageFailed({
        messageId: message._id,
        organizationId,
        error: sanitizeDeliveryError(error),
        permanent,
        nextAttemptAt,
        now: now(),
      });

      // Only a PERMANENT failure is stamped on the conversation. A retryable one is still in
      // flight, and flickering the dashboard through "AI reply failed" for thirty seconds
      // would report a problem that is about to resolve itself.
      if (permanent) {
        await recordOutboundDeliveryOutcome({
          conversationId: message.conversationId,
          organizationId,
          authoredByAi: message.authoredBy === MESSAGE_AUTHORS.AI,
          outcome: 'failed',
          now: now(),
        }).catch(() => undefined);
      }

      await publishStatusChange({ organizationId, message });

      return {
        delivered: false,
        failed: true,
        permanent,
      };
    }
  };

  const drainQueue = async ({
    organizationId,
    whatsappAccountId,
    max = maxPerMinute,
  }: DrainQueueOptions = {}) => {
    let delivered = 0;
    let failed = 0;

    for (let processed = 0; processed < max; processed += 1) {
      const result = await deliverNext({
        organizationId,
        whatsappAccountId,
      });

      if ('empty' in result && result.empty) {
        break;
      }

      if ('disabled' in result && result.disabled) {
        break;
      }

      if (result.delivered) {
        delivered += 1;
      } else if ('failed' in result && result.failed) {
        failed += 1;
      }
    }

    return {
      delivered,
      failed,
    };
  };

  return {
    deliverNext,
    drainQueue,
  };
};

export type OutboundDeliveryService = ReturnType<typeof createOutboundDeliveryService>;
