/**
 * Decides what to do with a normalized Baileys inbound message before (or instead of) handing
 * it to ingestion. Three outcomes for a `fromMe` message:
 *
 *  1. It is an echo of something this CRM just sent (echo-guard recognizes the provider
 *     message id) -> do nothing, this is expected traffic, not new information.
 *  2. It landed in the owner's own "message yourself" chat -> route to the (currently stub)
 *     owner self-chat reply handler, the future approval-reply channel.
 *  3. It is the owner typing directly into a real lead's chat from their own phone -> resolve
 *     the matching conversation and instantly switch automation off for it.
 *
 * A normal (non-`fromMe`) message is untouched and goes straight to ingestion, exactly as
 * before this router existed.
 */
import { env, type Env } from '../../../config/env.js';
import { type ObjectIdLike } from '../../../types/common.js';
import { findContactByProviderKey as defaultFindContactByProviderKey } from '../../contacts/contact.repository.js';
import { type ContactDocument } from '../../contacts/contact.model.js';
import {
  findConversationByAccountAndContact as defaultFindConversationByAccountAndContact,
  markOwnerTookOver as defaultMarkOwnerTookOver,
} from '../../conversations/conversation.repository.js';
import { type ConversationDocument } from '../../conversations/conversation.model.js';
import { getOrganizationSettingsService } from '../../organizations/organization-settings.service.js';
import { computeContactProviderKey as defaultComputeContactProviderKey } from '../../privacy/protected-pii.service.js';
import { REALTIME_REASONS } from '../../realtime/realtime.events.js';
import { publishConversationChanged as defaultPublishConversationChanged } from '../../realtime/realtime.publisher.js';
import { type NormalizedInboundMessage } from '../providers/whatsapp-provider.interface.js';
import { createNumberAllowlist, type NumberAllowlist } from './allowlist.js';

/**
 * Enough of a JID to recognise in a log line, without writing a lead's full phone number into
 * the logs. Local to this module so the log path never depends on the provider layer.
 */
const maskJid = (jid: unknown): string => {
  const value = typeof jid === 'string' ? jid.trim() : '';

  if (value === '') {
    return '(none)';
  }

  const [local = '', domain = 'unknown'] = value.split('@');

  return `${local.slice(0, 3)}***${local.slice(-3)}@${domain}`;
};
import {
  createEchoGuardService as defaultCreateEchoGuardService,
  type EchoGuardService,
} from './echo-guard.service.js';
import { handleOwnerSelfChatReply as defaultHandleOwnerSelfChatReply } from './owner-reply.service.js';

export const OWNER_TAKEOVER_REASON = 'You replied here, so the AI stepped back.';

export interface ContactRepositoryLike {
  findContactByProviderKey: (options: {
    organizationId?: ObjectIdLike;
    providerContactKey?: string;
  }) => Promise<ContactDocument | null>;
}

export interface ConversationRepositoryLike {
  findConversationByAccountAndContact: (options: {
    organizationId?: ObjectIdLike;
    whatsappAccountId?: ObjectIdLike;
    contactId?: ObjectIdLike;
  }) => Promise<ConversationDocument | null>;
  markOwnerTookOver: (options: {
    conversationId?: ObjectIdLike;
    organizationId?: ObjectIdLike;
    pausedReason: string;
  }) => Promise<unknown>;
}

export interface IngestInboundMessageLike {
  (options: {
    organizationId?: ObjectIdLike;
    whatsappAccountId?: ObjectIdLike;
    inboundMessage?: NormalizedInboundMessage;
  }): Promise<unknown>;
}

/** The slice of the organization-settings service this needs; see owner-notify.service.ts. */
export interface InboundRouterSettingsService {
  getOwnerNumber: (params?: { organizationId?: ObjectIdLike }) => Promise<string>;
}

export interface CreateInboundMessageRouterOptions {
  ingestInboundMessage: IngestInboundMessageLike;
  config?: Env;
  /** Overridable so tests can drive the gate without touching env. */
  allowlist?: NumberAllowlist;
  /**
   * Recognises the owner's own phone, as a one-entry allowlist purely to reuse its number
   * matching (country-code-tolerant, @lid-aware). Inactive when no owner number is configured,
   * which leaves the older self-chat behaviour untouched.
   *
   * Normally left unset: the number is then resolved per message from the organization's
   * settings, so an admin changing it in the dashboard takes effect without a restart (the
   * settings service caches, so this costs nothing per message). Injecting one here is an
   * explicit override that pins the matcher and skips the lookup entirely - what the tests do.
   */
  ownerNumbers?: NumberAllowlist;
  organizationSettingsService?: InboundRouterSettingsService;
  echoGuardService?: EchoGuardService;
  handleOwnerSelfChatReply?: typeof defaultHandleOwnerSelfChatReply;
  contactRepository?: ContactRepositoryLike;
  conversationRepository?: ConversationRepositoryLike;
  computeContactProviderKey?: (jid: unknown) => string | null;
  publishEvent?: (options: {
    organizationId?: ObjectIdLike;
    conversationId?: ObjectIdLike;
    assignedTo?: ObjectIdLike | null;
    reason?: string;
  }) => Promise<unknown>;
  logger?: {
    error?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
  };
}

export interface RouteInboundMessageParams {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike;
  inboundMessage?: NormalizedInboundMessage | null;
}

export const createInboundMessageRouter = ({
  ingestInboundMessage,
  config = env,
  allowlist = createNumberAllowlist(String(config?.WHATSAPP_TEST_ALLOWED_NUMBERS ?? '')),
  ownerNumbers,
  organizationSettingsService = getOrganizationSettingsService(),
  echoGuardService = defaultCreateEchoGuardService(),
  handleOwnerSelfChatReply = defaultHandleOwnerSelfChatReply,
  contactRepository = {
    findContactByProviderKey:
      defaultFindContactByProviderKey as ContactRepositoryLike['findContactByProviderKey'],
  },
  conversationRepository = {
    findConversationByAccountAndContact: defaultFindConversationByAccountAndContact,
    markOwnerTookOver: defaultMarkOwnerTookOver,
  },
  computeContactProviderKey = defaultComputeContactProviderKey as (jid: unknown) => string | null,
  publishEvent = defaultPublishConversationChanged as CreateInboundMessageRouterOptions['publishEvent'],
  logger = console,
}: CreateInboundMessageRouterOptions) => {
  /**
   * Resolved per message rather than once at factory time, so an owner number saved in the
   * dashboard applies to the very next message instead of the next restart. The settings
   * service answers off a short-lived per-organization cache, so this is not a database read
   * per message. An explicitly injected `ownerNumbers` wins and short-circuits the lookup.
   */
  const resolveOwnerNumbers = async (organizationId?: ObjectIdLike): Promise<NumberAllowlist> => {
    if (ownerNumbers) {
      return ownerNumbers;
    }

    if (!organizationId) {
      return createNumberAllowlist(String(config?.WHATSAPP_OWNER_NUMBER ?? ''));
    }

    try {
      return createNumberAllowlist(await organizationSettingsService.getOwnerNumber({ organizationId }));
    } catch (error: unknown) {
      // Never let a settings lookup decide whether a lead's message is handled at all.
      const err = error as { code?: unknown; name?: unknown };
      logger?.error?.('Owner-number lookup failed safely; using the configured default.', {
        code: err?.code,
        name: err?.name,
      });

      return createNumberAllowlist(String(config?.WHATSAPP_OWNER_NUMBER ?? ''));
    }
  };

  const routeOwnerDirectReply = async ({
    organizationId,
    whatsappAccountId,
    inboundMessage,
  }: {
    organizationId?: ObjectIdLike;
    whatsappAccountId?: ObjectIdLike;
    inboundMessage: NormalizedInboundMessage;
  }) => {
    const providerContactKey = computeContactProviderKey(inboundMessage.remoteJid);

    if (!providerContactKey) {
      return;
    }

    const contact = await contactRepository.findContactByProviderKey({
      organizationId,
      providerContactKey,
    });

    if (!contact) {
      // The owner texted someone this CRM does not know about yet - out of scope for now.
      return;
    }

    const conversation = await conversationRepository.findConversationByAccountAndContact({
      organizationId,
      whatsappAccountId,
      contactId: contact._id,
    });

    if (!conversation) {
      return;
    }

    const updated = await conversationRepository.markOwnerTookOver({
      conversationId: conversation._id,
      organizationId,
      pausedReason: OWNER_TAKEOVER_REASON,
    });

    await publishEvent?.({
      organizationId,
      conversationId: conversation._id,
      assignedTo: (updated as ConversationDocument | null)?.assignedTo ?? conversation.assignedTo,
      reason: REALTIME_REASONS.OWNER_TAKEOVER,
    });
  };

  const routeInboundMessage = async ({
    organizationId,
    whatsappAccountId,
    inboundMessage,
  }: RouteInboundMessageParams = {}) => {
    if (!inboundMessage) {
      return;
    }

    const senderCandidates = [
      inboundMessage.senderPhoneJid,
      inboundMessage.senderJid,
      inboundMessage.remoteJid,
    ] as const;

    if (inboundMessage.fromMe !== true) {
      const ownerMatcher = await resolveOwnerNumbers(organizationId);

      // The owner writing in from their own phone. Their words are decisions about leads, not a
      // lead of their own, so this is handled before anything else and never reaches ingestion -
      // otherwise the owner would show up in the pipeline as somebody to sell to.
      if (ownerMatcher.active && ownerMatcher.permitsInboundJid(...senderCandidates)) {
        try {
          await handleOwnerSelfChatReply({
            organizationId,
            whatsappAccountId,
            text: inboundMessage.text,
            messageId: inboundMessage.messageId,
          });
        } catch (error: unknown) {
          const err = error as { code?: unknown; name?: unknown };
          logger?.error?.('Owner reply handling failed safely.', {
            code: err?.code,
            name: err?.name,
          });
        }
        return;
      }

      // Test-only mode: refuse anything that is not from an allowed number BEFORE it is
      // persisted, so the owner's own real conversations never reach the dashboard. No-op once
      // WHATSAPP_TEST_ALLOWED_NUMBERS is cleared for production.
      //
      // Logged, and deliberately not quietly: a silent drop here is indistinguishable from "the
      // socket never delivered anything", which makes a genuinely blocked lead impossible to
      // diagnose from the outside. Warn level, because while the allowlist is active every drop
      // is something a person chose to block and may well want to know about. JIDs are masked -
      // this is a lead's phone number.
      if (!allowlist.permitsInboundJid(...senderCandidates)) {
        logger?.warn?.(
          {
            senderPhoneJid: maskJid(inboundMessage.senderPhoneJid),
            senderJid: maskJid(inboundMessage.senderJid),
            remoteJid: maskJid(inboundMessage.remoteJid),
          },
          'Inbound message dropped: sender is not on WHATSAPP_TEST_ALLOWED_NUMBERS. A JID with no readable phone (an unmapped @lid) is refused too, since the allowlist fails closed.',
        );
        return;
      }

      await ingestInboundMessage({ organizationId, whatsappAccountId, inboundMessage });
      return;
    }

    try {
      const isEcho = await echoGuardService.isOwnMessage({
        accountId: whatsappAccountId,
        providerMessageId: inboundMessage.messageId,
      });

      if (isEcho) {
        // Our own just-sent message reflected back by WhatsApp - expected, not new information.
        return;
      }

      if (inboundMessage.isSelfChat === true) {
        await handleOwnerSelfChatReply({
          organizationId,
          whatsappAccountId,
          text: inboundMessage.text,
          messageId: inboundMessage.messageId,
        });
        return;
      }

      await routeOwnerDirectReply({ organizationId, whatsappAccountId, inboundMessage });
    } catch (error: unknown) {
      const err = error as { code?: unknown; name?: unknown };
      logger?.error?.('Inbound-router owner-message handling failed safely.', {
        code: err?.code,
        name: err?.name,
      });
    }
  };

  return {
    routeInboundMessage,
  };
};

export type InboundMessageRouter = ReturnType<typeof createInboundMessageRouter>;
