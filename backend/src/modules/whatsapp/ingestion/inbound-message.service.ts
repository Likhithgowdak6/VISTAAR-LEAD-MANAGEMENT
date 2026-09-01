import { type HydratedDocument } from 'mongoose';

import { logger as defaultLogger } from '../../../config/logger.js';
import { CONVERSATION_STAGES } from '../../../constants/conversation-stages.js';
import { MESSAGE_TYPES, type MessageType } from '../../../constants/message-types.js';
import {
  createPipelineTrace,
  PIPELINE_STAGE,
  preview as tracePreview,
  type PipelineTrace,
} from '../../../observability/pipeline-trace.js';
import { type ObjectIdLike } from '../../../types/common.js';
import { handleInboundMessageForAutomation as defaultHandleAutomation } from '../../ai-brain/ai-brain.service.js';
import { sendNewLeadAlert as defaultSendNewLeadAlert } from '../../ai-brain/new-lead-alert.service.js';
import { sendOptOutAlert as defaultSendOptOutAlert } from '../../ai-brain/owner-approval-card.service.js';
import {
  attachContactPhoneIfMissing as defaultAttachContactPhoneIfMissing,
  findOrCreateContactByProviderKey as defaultFindOrCreateContactByProviderKey,
} from '../../contacts/contact.repository.js';
import { type ContactDocument } from '../../contacts/contact.model.js';
import {
  markOptedOut as defaultMarkOptedOut,
  type mergeConversationAiContext as defaultMergeConversationAiContext,
  updateConversationPreview as defaultUpdateConversationPreview,
  upsertConversationForContact as defaultUpsertConversationForContact,
} from '../../conversations/conversation.repository.js';
import { recomputeLeadScore as defaultRecomputeLeadScore } from '../../conversations/lead-score.service.js';
import { type ConversationDocument } from '../../conversations/conversation.model.js';
import {
  buildLeadFormFacts,
  looksLikeForm as defaultLooksLikeForm,
  parsePastedForm,
  type LeadFormFacts,
} from '../../lead-sources/lead-field-rules.js';
import { describeMediaMessage } from '../../messages/message-media-labels.js';
import { type MessageDocument, type MessageMedia } from '../../messages/message.model.js';
import { createInboundMessage as defaultCreateInboundMessage } from '../../messages/message.repository.js';
import {
  computeContactProviderKey as defaultComputeContactProviderKey,
  extractPhoneFromJid as defaultExtractPhoneFromJid,
  normalizeProviderJid as defaultNormalizeProviderJid,
} from '../../privacy/protected-pii.service.js';
import { REALTIME_REASONS } from '../../realtime/realtime.events.js';
import { publishConversationChanged as defaultPublishConversationChanged } from '../../realtime/realtime.publisher.js';
import {
  isOptOutRequest as defaultIsOptOutRequest,
  OPT_OUT_PAUSED_REASON,
} from '../automation/opt-out.js';
import { type NormalizedInboundMessage } from '../providers/whatsapp-provider.interface.js';
import { WhatsAppProviderError } from '../whatsapp.errors.js';

const MESSAGE_BODY_MAX_LENGTH = 5000;
const CONVERSATION_PREVIEW_MAX_LENGTH = 500;
const DISPLAY_NAME_MAX_LENGTH = 160;
const DEFAULT_DISPLAY_NAME = 'WhatsApp Lead';

const INBOUND_EVENT_TYPE = 'message.received';

const truncate = (value: string, maxLength: number): string =>
  value.length > maxLength ? value.slice(0, maxLength) : value;

const resolveDisplayName = (pushName: unknown): string => {
  const normalizedPushName = typeof pushName === 'string' ? pushName.trim() : '';

  if (normalizedPushName === '') {
    return DEFAULT_DISPLAY_NAME;
  }

  return truncate(normalizedPushName, DISPLAY_NAME_MAX_LENGTH);
};

const resolveProfileName = (pushName: unknown): string | null => {
  const normalizedPushName = typeof pushName === 'string' ? pushName.trim() : '';

  return normalizedPushName === '' ? null : truncate(normalizedPushName, DISPLAY_NAME_MAX_LENGTH);
};

/**
 * Baileys timestamps arrive as seconds (number or Long). Convert to a Date, or
 * null when unusable.
 */
const resolveProviderTimestamp = (timestamp: unknown): Date | null => {
  if (timestamp === null || timestamp === undefined) {
    return null;
  }

  const seconds = Number(timestamp);

  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }

  return new Date(seconds * 1000);
};

const isDuplicateKeyError = (error: unknown): boolean =>
  Boolean(error && typeof error === 'object' && 'code' in error && error.code === 11000);

export interface ContactRepositoryLike {
  findOrCreateContactByProviderKey: (options: {
    organizationId?: ObjectIdLike;
    providerContactKey?: string | null;
    displayName?: string;
    profileName?: string | null;
    phone?: string | null;
    providerJids?: string[];
    source?: string;
  }) => Promise<{ contact: ContactDocument; created: boolean }>;
  attachContactPhoneIfMissing?: (options: {
    contactId?: ObjectIdLike;
    organizationId?: ObjectIdLike;
    phone?: string | null;
  }) => Promise<unknown>;
}

export interface ConversationRepositoryLike {
  upsertConversationForContact: typeof defaultUpsertConversationForContact;
  updateConversationPreview: typeof defaultUpdateConversationPreview;
  /** Optional so an existing test double without it still works; the pasted-form branch simply
   *  does nothing when it is absent. */
  mergeConversationAiContext?: typeof defaultMergeConversationAiContext;
  /** Optional for the same reason. Absent means an opt-out is still detected and still stops the
   *  AI replying to this message, it just cannot be written down. */
  markOptedOut?: typeof defaultMarkOptedOut;
}

export interface MessageRepositoryLike {
  createInboundMessage: (options: {
    organizationId?: ObjectIdLike;
    whatsappAccountId?: ObjectIdLike;
    conversationId?: ObjectIdLike;
    contactId?: ObjectIdLike;
    providerMessageId?: string | null;
    body?: string;
    type?: MessageType;
    media?: Partial<MessageMedia>;
    receivedAt?: Date;
    providerTimestamp?: Date | null;
  }) => Promise<MessageDocument>;
}

export interface CreateInboundMessageIngestionServiceOptions {
  contactRepository?: ContactRepositoryLike;
  conversationRepository?: ConversationRepositoryLike;
  messageRepository?: MessageRepositoryLike;
  computeContactProviderKey?: (jid: unknown) => string | null;
  extractPhoneFromJid?: (jid: unknown) => string | null;
  normalizeProviderJid?: (jid: unknown) => string | null;
  publishEvent?: (options: {
    organizationId?: ObjectIdLike;
    conversationId?: ObjectIdLike;
    assignedTo?: ObjectIdLike | null;
    reason?: string;
  }) => Promise<unknown>;
  /**
   * Lets ai-brain-service's automation react to a freshly-persisted inbound message. Swappable
   * mainly for tests - in production this is always ai-brain.service's real
   * handleInboundMessageForAutomation, which itself no-ops unless the conversation has
   * automation turned on and never throws (a stalled or unreachable AI service must never stop
   * a message from being received and shown to the team).
   */
  handleAutomation?: (options: {
    organizationId: ObjectIdLike;
    conversation: HydratedDocument<ConversationDocument>;
    inboundMessageId: ObjectIdLike;
    inboundText: string;
    messageType?: MessageType;
    isVoiceNote?: boolean;
    traceId?: string;
  }) => Promise<void>;
  /**
   * Pings the owner's WhatsApp self-chat about a brand-new lead's first message. Held to the
   * same contract as `handleAutomation`: internally failure-isolated, never throws, so a missing
   * WhatsApp session can never stop a lead's message from being received and shown to the team.
   */
  sendNewLeadAlert?: typeof defaultSendNewLeadAlert;
  /** "Did this lead just ask us to stop messaging them?" Pure; injected for tests. */
  isOptOutRequest?: (text: unknown) => boolean;
  /**
   * Tells the owner on WhatsApp that a lead opted out. Same contract as `sendNewLeadAlert`:
   * internally failure-isolated, never throws, and guarded again below regardless.
   */
  sendOptOutAlert?: typeof defaultSendOptOutAlert;
  /**
   * Rescores the lead now that they have said something. Same failure-isolated, never-throws
   * contract as `sendNewLeadAlert`: a scoring bug must cost the score and nothing else.
   */
  recomputeLeadScore?: typeof defaultRecomputeLeadScore;
  /** "Is this first message a pasted Meta lead form rather than someone saying hello?" */
  looksLikeForm?: (text: string | null | undefined) => boolean;
  /** Reads that pasted form into canonical facts + a category. Pure; injected for tests. */
  readPastedFormFacts?: (text: string) => LeadFormFacts;
  /**
   * Stages 7-9 of the pipeline trace, plus the opt-out stop that belongs to stage 10 because
   * this is where it is actually decided. One trace per message, seeded with the same WhatsApp
   * message id the provider and router used.
   */
  createTrace?: (options: { seed?: unknown }) => PipelineTrace;
  logger?: { error?: (...args: unknown[]) => void };
  now?: () => Date;
}

export interface IngestInboundMessageOptions {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike;
  inboundMessage?: NormalizedInboundMessage | null;
}

/**
 * Persists inbound WhatsApp messages into the CRM (Contact -> Conversation ->
 * Message). Contact identity is resolved through a deterministic blind index so
 * returning senders reuse the same contact and conversation. Duplicate provider
 * messages are idempotent: they do not double-count unread or bump the preview.
 */
export const createInboundMessageIngestionService = ({
  contactRepository = {
    findOrCreateContactByProviderKey:
      defaultFindOrCreateContactByProviderKey as ContactRepositoryLike['findOrCreateContactByProviderKey'],
    attachContactPhoneIfMissing:
      defaultAttachContactPhoneIfMissing as ContactRepositoryLike['attachContactPhoneIfMissing'],
  },
  conversationRepository = {
    upsertConversationForContact: defaultUpsertConversationForContact,
    updateConversationPreview: defaultUpdateConversationPreview,
    markOptedOut: defaultMarkOptedOut,
  },
  messageRepository = {
    createInboundMessage:
      defaultCreateInboundMessage as MessageRepositoryLike['createInboundMessage'],
  },
  computeContactProviderKey = defaultComputeContactProviderKey as (jid: unknown) => string | null,
  extractPhoneFromJid = defaultExtractPhoneFromJid as (jid: unknown) => string | null,
  normalizeProviderJid = defaultNormalizeProviderJid as (jid: unknown) => string | null,
  publishEvent = defaultPublishConversationChanged as CreateInboundMessageIngestionServiceOptions['publishEvent'],
  handleAutomation = defaultHandleAutomation,
  sendNewLeadAlert = defaultSendNewLeadAlert,
  isOptOutRequest = defaultIsOptOutRequest,
  sendOptOutAlert = defaultSendOptOutAlert,
  recomputeLeadScore = defaultRecomputeLeadScore,
  looksLikeForm = defaultLooksLikeForm,
  readPastedFormFacts = (text: string) => buildLeadFormFacts(parsePastedForm(text)),
  createTrace = createPipelineTrace,
  logger = defaultLogger,
  now = () => new Date(),
}: CreateInboundMessageIngestionServiceOptions = {}) => {
  const ingestInboundMessage = async ({
    organizationId,
    whatsappAccountId,
    inboundMessage,
  }: IngestInboundMessageOptions = {}) => {
    // Stages 7-9. Same seed as the provider and router stages, so all nine share one id.
    const trace = createTrace({ seed: inboundMessage?.messageId });

    if (!inboundMessage || inboundMessage.eventType !== INBOUND_EVENT_TYPE) {
      trace.stop(
        PIPELINE_STAGE.INGEST_CONTACT,
        `not an inbound message event (eventType=${inboundMessage?.eventType ?? 'none'})`,
      );

      return {
        persisted: false,
        ignored: true,
      };
    }

    if (!organizationId || !whatsappAccountId) {
      trace.stop(
        PIPELINE_STAGE.INGEST_CONTACT,
        'no organization or WhatsApp account on the ingestion call - the session is not wired up',
      );

      throw new WhatsAppProviderError('Inbound ingestion requires organization and account ids.', {
        code: 'WHATSAPP_INGESTION_CONTEXT_REQUIRED',
      });
    }

    const senderJid = inboundMessage.senderJid ?? inboundMessage.remoteJid;
    const providerContactKey = computeContactProviderKey(senderJid);

    if (!providerContactKey) {
      trace.stop(
        PIPELINE_STAGE.INGEST_CONTACT,
        'the sender JID produced no contact key, so there is nobody to attach this message to',
      );

      throw new WhatsAppProviderError('Inbound message is missing a usable sender JID.', {
        code: 'WHATSAPP_INGESTION_SENDER_MISSING',
      });
    }

    const normalizedJid = normalizeProviderJid(senderJid);

    // `senderJid` may be an opaque `@lid` that carries no phone. The provider resolves it to a
    // phone JID when the mapping is known, so prefer that. Contact identity stays keyed on the
    // sender JID's blind index either way — changing that basis would fork existing contacts.
    const phone =
      extractPhoneFromJid(inboundMessage.senderPhoneJid) ?? extractPhoneFromJid(senderJid);

    const { contact, created: contactCreated } =
      await contactRepository.findOrCreateContactByProviderKey({
        organizationId,
        providerContactKey,
        displayName: resolveDisplayName(inboundMessage.pushName),
        profileName: resolveProfileName(inboundMessage.pushName),
        phone,
        providerJids: normalizedJid ? [normalizedJid] : [],
        source: 'whatsapp',
      });

    trace.pass(PIPELINE_STAGE.INGEST_CONTACT, () => ({
      contact: contact._id.toString(),
      how: contactCreated ? 'created' : 'existing',
      name: tracePreview(contact.displayName, 40),
    }));

    // A contact created before its LID mapping was known has no stored phone. Fill it in on the
    // next inbound message so existing rows heal without a migration. The "only if missing"
    // guard lives in the query, so this never overwrites a known number.
    if (phone && contact && contactRepository.attachContactPhoneIfMissing) {
      await contactRepository.attachContactPhoneIfMissing({
        contactId: contact._id,
        organizationId,
        phone,
      });
    }

    const conversation = (await conversationRepository.upsertConversationForContact({
      organizationId,
      whatsappAccountId,
      contactId: contact._id,
      leadId: contact.leadId,
      displayName: contact.displayName,
      defaults: {
        stage: CONVERSATION_STAGES.NEW,
      },
    })) as ConversationDocument;

    trace.pass(PIPELINE_STAGE.INGEST_CONVERSATION, () => ({
      conversation: conversation._id.toString(),
      // upsertConversationForContact cannot report whether it inserted, so this reports the
      // thing the owner actually wants to know instead: is this a brand-new thread?
      how: conversation.lastMessageAt ? 'existing' : 'new thread',
      stage: conversation.stage,
      automation: conversation.aiAutomationEnabled ? 'on' : 'off',
    }));

    // Read BEFORE this message is persisted and the preview is updated: no inbound message has
    // ever landed in this thread, so the one being ingested right now is the lead's first-ever
    // contact. This covers both a brand-new contact and a previously imported lead (from a lead
    // sheet, say) messaging in for the first time, which a contact-level `created` flag would
    // miss. Actually sending the alert is still gated on the atomic `newLeadAlertSentAt` claim,
    // so a duplicate delivery of that same first message cannot alert twice.
    const isFirstInboundMessage = !conversation.lastInboundAt;

    // Read for the same reason and at the same moment: "replied to the AI" means this inbound
    // message answers something we already sent them. `lastOutboundAt` is set at enqueue time for
    // every outbound message, AI-authored or not, and is untouched by the write below - so
    // reading it here, before this message is persisted, is what makes the question answerable
    // at all. A lead's unprompted first message is not a reply, however long it is.
    const isReplyToUs = Boolean(conversation.lastOutboundAt);

    const receivedAt = now();
    const providerTimestamp = resolveProviderTimestamp(inboundMessage.timestamp);
    const body = truncate(inboundMessage.text ?? '', MESSAGE_BODY_MAX_LENGTH);

    // A provider that predates media detection (or a fixture) sends no messageType at all, and
    // every message it ever produced was text - so that is the default.
    const messageType = inboundMessage.messageType ?? MESSAGE_TYPES.TEXT;
    const inboundMedia = inboundMessage.media ?? null;

    // `not_applicable` rather than `pending`: nothing was downloaded and, deliberately, nothing
    // is queued to download it either (see the provider - fetching media bytes is separate work).
    // `pending` would claim a job exists that would eventually flip this to `stored`.
    const media: Partial<MessageMedia> | undefined = inboundMedia
      ? {
          mimeType: inboundMedia.mimeType,
          fileName: inboundMedia.fileName,
          sizeBytes: inboundMedia.sizeBytes,
          storageStatus: 'not_applicable',
        }
      : undefined;

    /** "📷 Photo" / "🎤 Voice note" - what a human sees where there is no text to show. */
    const mediaLabel = describeMediaMessage({
      type: messageType,
      isVoiceNote: inboundMedia?.isVoiceNote,
    });

    let message: MessageDocument;

    try {
      message = await messageRepository.createInboundMessage({
        organizationId,
        whatsappAccountId,
        conversationId: conversation._id,
        contactId: contact._id,
        providerMessageId: inboundMessage.messageId ?? null,
        body,
        type: messageType,
        media,
        receivedAt,
        providerTimestamp,
      });
    } catch (error: unknown) {
      if (isDuplicateKeyError(error)) {
        trace.stop(
          PIPELINE_STAGE.INGEST_MESSAGE,
          'WhatsApp delivered this same message id again - already saved, so nothing more happens',
          () => ({ conversation: conversation._id.toString() }),
        );

        return {
          persisted: false,
          duplicate: true,
          contactId: contact._id.toString(),
          conversationId: conversation._id.toString(),
          leadId: conversation.leadId,
        };
      }

      trace.fail(PIPELINE_STAGE.INGEST_MESSAGE, error, () => ({
        conversation: conversation._id.toString(),
      }));

      throw error;
    }

    trace.pass(PIPELINE_STAGE.INGEST_MESSAGE, () => ({
      message: message._id.toString(),
      conversation: conversation._id.toString(),
      type: messageType,
      body: tracePreview(body),
    }));

    // A caption wins over the label - it says more about the message than "📷 Photo" does. Only
    // a media message with nothing written on it falls back to the label, which is the whole
    // point: a photo used to leave a blank row in the conversation list.
    const preview = body.trim() !== '' ? body : (mediaLabel ?? body);

    await conversationRepository.updateConversationPreview({
      conversationId: conversation._id,
      organizationId,
      lastMessageAt: message.sentAt ?? receivedAt,
      lastMessagePreview: truncate(preview, CONVERSATION_PREVIEW_MAX_LENGTH),
      unreadCountIncrement: 1,
      lastInboundAt: message.sentAt ?? receivedAt,
    });

    await publishEvent?.({
      organizationId,
      conversationId: conversation._id,
      assignedTo: conversation.assignedTo,
      reason: REALTIME_REASONS.INBOUND,
    });

    // Meta's click-to-WhatsApp forms are handed to the LEAD, who pastes the whole block of
    // "Label: value" lines in as their first message. Read now, before the automation handler
    // below sees this conversation, so the AI's very first look already knows the event type and
    // date the lead typed into the form instead of asking for them again. No `aiContextEnabled`
    // gate here, unlike the sheet importer: the lead sent this content into the chat themselves,
    // it is not third-party data the CRM went and fetched. Failure-isolated like every other
    // best-effort side effect on this path - a parser or write fault must never cost the message.
    let conversationForAutomation = conversation as HydratedDocument<ConversationDocument>;

    if (isFirstInboundMessage && looksLikeForm(body)) {
      try {
        const { facts, category } = readPastedFormFacts(body);

        if (Object.keys(facts).length > 0) {
          const merged = await conversationRepository.mergeConversationAiContext?.({
            conversationId: conversation._id,
            organizationId,
            facts,
            category,
          });

          if (merged) {
            conversationForAutomation = merged as HydratedDocument<ConversationDocument>;
          }
        }
      } catch (error: unknown) {
        const err = error as { code?: unknown; name?: unknown };
        logger?.error?.(
          { code: err?.code, name: err?.name, conversationId: conversation._id.toString() },
          'Pasted lead form could not be read; inbound ingestion continued.',
        );
      }
    }

    if (isFirstInboundMessage) {
      // sendNewLeadAlert is already internally failure-isolated (it never throws), exactly like
      // handleAutomation below. The outer guard is here anyway because this is the one call on
      // this path whose entire purpose is a courtesy ping: nothing it could ever do - not even a
      // programming error inside it - is worth losing a lead's first message over.
      try {
        await sendNewLeadAlert?.({
          organizationId,
          whatsappAccountId,
          conversationId: conversation._id,
          leadDisplayName: conversation.displayName,
          phone,
          firstMessage: body,
        });
      } catch (error: unknown) {
        const err = error as { code?: unknown; name?: unknown };
        logger?.error?.(
          { code: err?.code, name: err?.name, conversationId: conversation._id.toString() },
          'New-lead owner alert threw unexpectedly; inbound ingestion continued.',
        );
      }
    }

    // Everything that feeds the lead score has now happened: the form they pasted has been read
    // into the facts blob above, this message is on record, and we know whether it answers
    // something we sent. Rescoring here - after the new-lead alert, before the AI is given the
    // conversation - means the panel, the inbox band and the owner's 🔥 alert are all working off
    // this message rather than the one before it. `recomputeLeadScore` is internally
    // failure-isolated (it never throws); the outer guard is here for the same reason the
    // new-lead alert has one - nothing about a score is worth losing a lead's message over.
    try {
      await recomputeLeadScore?.({
        organizationId,
        conversationId: conversation._id,
        whatsappAccountId,
        inboundText: body,
        repliedToAi: isReplyToUs,
      });
    } catch (error: unknown) {
      const err = error as { code?: unknown; name?: unknown };
      logger?.error?.(
        { code: err?.code, name: err?.name, conversationId: conversation._id.toString() },
        'Lead score recompute threw unexpectedly; inbound ingestion continued.',
      );
    }

    // The lead asking to stop is enforced here, at the front door, and again in the nurture
    // sweep's query and at the outbound send gate - three places because they fail differently:
    // this one cannot help a message already queued, the sweep's cannot help a reply the AI is
    // about to draft, and the send gate cannot stop the AI from answering "stop" with a sales
    // question. Note the ordering: the message itself is already persisted above, because their
    // "stop" is the evidence that they asked. Only the reply to it is suppressed.
    //
    // `optedOutAt` already set means they asked at some earlier point and nothing has changed.
    let optedOut = Boolean(conversation.optedOutAt);

    if (!optedOut && isOptOutRequest(body)) {
      // Set before the write, not after: if the update or the owner alert throws, the AI still
      // must not answer this message. Suppressing a reply is free; sending one is not.
      optedOut = true;

      try {
        await conversationRepository.markOptedOut?.({
          conversationId: conversation._id,
          organizationId,
          pausedReason: OPT_OUT_PAUSED_REASON,
          now: receivedAt,
        });

        // Same failure-isolated, never-throws contract as the new-lead alert above, and guarded
        // again here for the same reason: a courtesy ping is never worth a lead's message.
        await sendOptOutAlert?.({
          organizationId,
          accountId: whatsappAccountId,
          conversationId: conversation._id,
          leadDisplayName: conversation.displayName,
          lastLeadMessage: body,
        });
      } catch (error: unknown) {
        const err = error as { code?: unknown; name?: unknown };
        logger?.error?.(
          { code: err?.code, name: err?.name, conversationId: conversation._id.toString() },
          'Opt-out handling failed; the message is saved and automation is suppressed for it anyway.',
        );
      }
    }

    if (optedOut) {
      // Decided here rather than in ai-brain.service, so this is where it has to be said: the
      // message IS saved and visible in the dashboard, but no AI reply will ever follow it.
      trace.stop(
        PIPELINE_STAGE.AI_ELIGIBILITY,
        'this lead has opted out, so the message is saved but the AI will not reply to it',
        () => ({ conversation: conversation._id.toString() }),
      );
    } else {
      await handleAutomation?.({
        organizationId,
        conversation: conversationForAutomation,
        inboundMessageId: message._id,
        inboundText: body,
        messageType,
        isVoiceNote: inboundMedia?.isVoiceNote ?? false,
        // Hands the AI stages this message's correlation id. They cannot derive it themselves:
        // by then only the Mongo message id is in scope, not the WhatsApp one.
        traceId: trace.id,
      });
    }

    return {
      persisted: true,
      duplicate: false,
      optedOut,
      contactId: contact._id.toString(),
      conversationId: conversation._id.toString(),
      leadId: conversation.leadId,
      messageId: message._id.toString(),
    };
  };

  return {
    ingestInboundMessage,
  };
};
