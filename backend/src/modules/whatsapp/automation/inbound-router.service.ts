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
import {
  createPipelineTrace,
  PIPELINE_STAGE,
  preview as tracePreview,
  type PipelineTrace,
} from '../../../observability/pipeline-trace.js';
import { type ObjectIdLike } from '../../../types/common.js';
import { findContactByProviderKey as defaultFindContactByProviderKey } from '../../contacts/contact.repository.js';
import { type ContactDocument } from '../../contacts/contact.model.js';
import {
  findConversationByAccountAndContact as defaultFindConversationByAccountAndContact,
  markOwnerTookOver as defaultMarkOwnerTookOver,
} from '../../conversations/conversation.repository.js';
import { type ConversationDocument } from '../../conversations/conversation.model.js';
import { getOrganizationSettingsService } from '../../organizations/organization-settings.service.js';
import { touchOwnerWhatsAppActivity as defaultTouchOwnerWhatsAppActivity } from '../../organizations/organization.repository.js';
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
  /**
   * Stages 4-6 of the pipeline trace. A factory rather than an instance: one trace per message,
   * seeded with that message's WhatsApp id so it shares a correlation id with the provider and
   * ingestion stages without any of them having to pass anything to each other.
   */
  createTrace?: (options: { seed?: unknown }) => PipelineTrace;
  echoGuardService?: EchoGuardService;
  handleOwnerSelfChatReply?: typeof defaultHandleOwnerSelfChatReply;
  contactRepository?: ContactRepositoryLike;
  conversationRepository?: ConversationRepositoryLike;
  computeContactProviderKey?: (jid: unknown) => string | null;
  touchOwnerWhatsAppActivity?: typeof defaultTouchOwnerWhatsAppActivity;
  publishEvent?: (options: {
    organizationId?: ObjectIdLike;
    conversationId?: ObjectIdLike;
    assignedTo?: ObjectIdLike | null;
    reason?: string;
  }) => Promise<unknown>;
  logger?: {
    error?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
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
  createTrace = createPipelineTrace,
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
  touchOwnerWhatsAppActivity = defaultTouchOwnerWhatsAppActivity,
  publishEvent = defaultPublishConversationChanged as CreateInboundMessageRouterOptions['publishEvent'],
  logger = console,
}: CreateInboundMessageRouterOptions) => {
  /**
   * Fire-and-forget on purpose: which lead's alert this happens to interrupt is not this
   * function's business, and the owner-call escalation sweep only needs the timestamp to be
   * roughly right, not synchronized with message handling. A failed write here must never affect
   * message handling.
   */
  const noteOwnerActivity = (organizationId?: ObjectIdLike): void => {
    if (!organizationId) {
      return;
    }

    void touchOwnerWhatsAppActivity({ organizationId }).catch((error: unknown) => {
      const err = error as { code?: unknown; name?: unknown };
      logger?.error?.('Owner-activity timestamp write failed safely.', {
        code: err?.code,
        name: err?.name,
      });
    });
  };

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
    trace,
  }: {
    organizationId?: ObjectIdLike;
    whatsappAccountId?: ObjectIdLike;
    inboundMessage: NormalizedInboundMessage;
    trace: PipelineTrace;
  }) => {
    const providerContactKey = computeContactProviderKey(inboundMessage.remoteJid);

    if (!providerContactKey) {
      trace.stop(
        PIPELINE_STAGE.ROUTER_FROM_ME,
        'owner-authored, but the chat JID produced no contact key so there is nothing to pause',
        () => ({ branch: 'owner-took-over', chat: maskJid(inboundMessage.remoteJid) }),
      );

      return;
    }

    const contact = await contactRepository.findContactByProviderKey({
      organizationId,
      providerContactKey,
    });

    if (!contact) {
      // The owner texted someone this CRM does not know about yet - out of scope for now.
      trace.stop(
        PIPELINE_STAGE.ROUTER_FROM_ME,
        'owner-authored, sent to somebody this CRM has no contact for - nothing to take over',
        () => ({ branch: 'owner-took-over', chat: maskJid(inboundMessage.remoteJid) }),
      );

      return;
    }

    const conversation = await conversationRepository.findConversationByAccountAndContact({
      organizationId,
      whatsappAccountId,
      contactId: contact._id,
    });

    if (!conversation) {
      trace.stop(
        PIPELINE_STAGE.ROUTER_FROM_ME,
        'owner-authored, but that contact has no conversation on this account yet',
        () => ({ branch: 'owner-took-over', contact: contact._id.toString() }),
      );

      return;
    }

    trace.done(
      PIPELINE_STAGE.ROUTER_FROM_ME,
      `owner took over this chat, so the AI has stepped back: ${OWNER_TAKEOVER_REASON}`,
      () => ({ branch: 'owner-took-over', conversation: conversation._id.toString() }),
    );

    noteOwnerActivity(organizationId);

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

    // Stages 4-6. Seeded with the same WhatsApp message id the provider used, so these lines
    // carry the same correlation id as the three before them.
    const trace = createTrace({ seed: inboundMessage.messageId });

    const senderCandidates = [
      inboundMessage.senderPhoneJid,
      inboundMessage.senderJid,
      inboundMessage.remoteJid,
    ] as const;

    if (inboundMessage.fromMe !== true) {
      trace.pass(PIPELINE_STAGE.ROUTER_FROM_ME, () => ({
        branch: 'lead',
        fromMe: false,
      }));

      const ownerMatcher = await resolveOwnerNumbers(organizationId);

      // The owner writing in from their own phone. Their words are decisions about leads, not a
      // lead of their own, so this is handled before anything else and never reaches ingestion -
      // otherwise the owner would show up in the pipeline as somebody to sell to.
      //
      // Logged for the same reason the allowlist drop below is logged, and it is the same
      // mistake twice if it is not: this branch RETURNS, so a message routed here never appears
      // in the dashboard and never gets an AI reply. When the configured owner number is also
      // the number someone is testing leads from - easy to do when there is only one spare phone
      // - every test message silently becomes an owner decision, and from the outside that is
      // indistinguishable from the socket delivering nothing at all.
      if (ownerMatcher.active && ownerMatcher.permitsInboundJid(...senderCandidates)) {
        // Exactly one message about this drop, never two: the trace line when tracing is on, the
        // original info line when it is off. It is never allowed to become zero - a silently
        // swallowed owner message is the mistake this whole trace exists to prevent.
        if (trace.enabled) {
          trace.stop(
            PIPELINE_STAGE.ROUTER_OWNER_CHECK,
            'sender matches WHATSAPP_OWNER_NUMBER, so this is read as an OWNER decision, not a lead - it is deliberately not ingested and will not appear in the dashboard',
            () => ({
              senderPhoneJid: maskJid(inboundMessage.senderPhoneJid),
              senderJid: maskJid(inboundMessage.senderJid),
              body: tracePreview(inboundMessage.text),
            }),
          );
        } else {
          logger?.info?.(
            {
              senderPhoneJid: maskJid(inboundMessage.senderPhoneJid),
              senderJid: maskJid(inboundMessage.senderJid),
            },
            'Inbound message read as an OWNER decision, not a lead: the sender matches the configured owner number. It is deliberately not ingested and will not appear in the dashboard.',
          );
        }

        noteOwnerActivity(organizationId);

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

      trace.pass(PIPELINE_STAGE.ROUTER_OWNER_CHECK, () => ({
        ownerNumber: ownerMatcher.active ? 'configured, no match' : 'not configured',
      }));

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
        // One message, never two and never none - same reasoning as the owner check above.
        if (trace.enabled) {
          trace.stop(
            PIPELINE_STAGE.ROUTER_ALLOWLIST,
            'sender is not on WHATSAPP_TEST_ALLOWED_NUMBERS. A JID with no readable phone (an unmapped @lid) is refused too, since the allowlist fails closed',
            () => ({
              senderPhoneJid: maskJid(inboundMessage.senderPhoneJid),
              senderJid: maskJid(inboundMessage.senderJid),
              remoteJid: maskJid(inboundMessage.remoteJid),
            }),
          );
        } else {
          logger?.warn?.(
            {
              senderPhoneJid: maskJid(inboundMessage.senderPhoneJid),
              senderJid: maskJid(inboundMessage.senderJid),
              remoteJid: maskJid(inboundMessage.remoteJid),
            },
            'Inbound message dropped: sender is not on WHATSAPP_TEST_ALLOWED_NUMBERS. A JID with no readable phone (an unmapped @lid) is refused too, since the allowlist fails closed.',
          );
        }
        return;
      }

      trace.pass(PIPELINE_STAGE.ROUTER_ALLOWLIST, () => ({
        allowlist: allowlist.active ? 'allowed' : 'not configured (all senders allowed)',
      }));

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
        trace.done(
          PIPELINE_STAGE.ROUTER_FROM_ME,
          'echo of a message this CRM just sent, reflected back by WhatsApp - expected, not new information',
          () => ({ branch: 'echo', fromMe: true }),
        );
        return;
      }

      if (inboundMessage.isSelfChat === true) {
        trace.done(
          PIPELINE_STAGE.ROUTER_FROM_ME,
          "owner's own self-chat - handed to the approval-reply handler, not ingested as a lead",
          () => ({ branch: 'self-chat', fromMe: true, body: tracePreview(inboundMessage.text) }),
        );

        noteOwnerActivity(organizationId);

        await handleOwnerSelfChatReply({
          organizationId,
          whatsappAccountId,
          text: inboundMessage.text,
          messageId: inboundMessage.messageId,
        });
        return;
      }

      await routeOwnerDirectReply({ organizationId, whatsappAccountId, inboundMessage, trace });
    } catch (error: unknown) {
      const err = error as { code?: unknown; name?: unknown };
      trace.fail(PIPELINE_STAGE.ROUTER_FROM_ME, error);
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
