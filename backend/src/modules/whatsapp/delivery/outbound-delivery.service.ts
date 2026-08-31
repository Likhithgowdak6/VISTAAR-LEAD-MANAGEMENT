import { env, type Env } from '../../../config/env.js';
import { MESSAGE_AUTHORS } from '../../../constants/message-authors.js';
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
import { REALTIME_REASONS } from '../../realtime/realtime.events.js';
import { publishConversationChanged as defaultPublishConversationChanged } from '../../realtime/realtime.publisher.js';
import { type SendTextMessageResult } from '../providers/whatsapp-provider.interface.js';
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
  contactRepository?: ContactRepositoryLike;
  messageRepository?: MessageRepositoryLike;
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
  findConversationById = defaultFindConversationById,
  publishEvent = defaultPublishConversationChanged as CreateOutboundDeliveryServiceOptions['publishEvent'],
  computeBackoffMs = defaultComputeBackoffMs,
  now = () => new Date(),
  logger = console,
  echoGuardService = createEchoGuardService(),
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

    const privatePii = await contactRepository.findContactPrivatePiiForInternalUse({
      contactId: message.contactId,
      organizationId,
    });

    const recipient = resolveRecipient(privatePii);

    if (!recipient) {
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

      if (!conversation || conversation.aiAutomationEnabled !== true) {
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

    try {
      const result = await sessionService.sendTextMessage({
        to: recipient,
        text: message.body,
      });

      await messageRepository.markOutboundMessageSent({
        messageId: message._id,
        organizationId,
        providerMessageId: result?.providerMessageId ?? null,
        now: now(),
      });

      // Every successful send is remembered so the echo guard can recognize our own message
      // when Baileys reflects it back as a `fromMe` inbound event.
      await echoGuardService.remember({
        accountId: message.whatsappAccountId,
        providerMessageId: result?.providerMessageId ?? null,
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
