/**
 * The owner's catch-up read of a conversation the AI has been handling.
 *
 * The owner runs this business from WhatsApp. He comes back to a lead thread after days and
 * should not have to scroll twenty messages to work out where things stand - so ai-brain-service
 * reads the thread once and wam-crm-ai stores what it said.
 *
 * THE REGENERATION POLICY, which is the whole design:
 *
 *   - A summary is NEVER generated on an inbound message. This service runs against Groq's free
 *     tier, capped at 8,000 tokens a minute, and a whole transcript per message would eat that
 *     ceiling on a single busy thread. Every generation here is on demand.
 *   - A stored summary is CURRENT while the thread still holds exactly as many messages as it
 *     held when the summary was read (`aiSummaryMessageCount`). Current means served as-is: no
 *     LLM call, no cost, no latency.
 *   - It is STALE once a message has arrived since. Stale is not wrong, only out of date, so it
 *     is still shown - flagged, beside a regenerate the owner can press.
 *   - Regeneration therefore happens exactly twice: when there is no summary at all, and when
 *     the owner explicitly asks for one on a stale thread.
 *
 * FAILURE ISOLATION. ai-brain-service is optional infrastructure: it can be switched off, down,
 * or rate-limited, and none of that may break the conversation view. Every call below that can
 * reach it returns `{ summary, unavailable }` and throws nothing - the same best-effort contract
 * owner-approval-card.service.ts's owner-facing sends keep. The only errors that escape are the
 * caller's own (CONVERSATION_NOT_FOUND / CONVERSATION_ACCESS_DENIED), which are answers, not
 * failures.
 */
import { logger as defaultLogger } from '../../config/logger.js';
import { type Permission } from '../../constants/permissions.js';
import { type ObjectIdLike } from '../../types/common.js';
import {
  type ConversationAiSummary,
  type ConversationDocument,
} from '../conversations/conversation.model.js';
import { updateConversationSummary as defaultUpdateConversationSummary } from '../conversations/conversation.repository.js';
import {
  serializeConversationSummary,
  type SerializedConversationSummary,
} from '../conversations/conversation.serializer.js';
import { loadVisibleConversationForActor as defaultLoadVisibleConversationForActor } from '../conversations/conversation.service.js';
import {
  countMessagesByConversation as defaultCountMessagesByConversation,
  findMessagesByConversationCursor as defaultFindMessagesByConversationCursor,
} from '../messages/message.repository.js';
import { buildAiBrainContext as defaultBuildAiBrainContext } from './ai-brain-context.service.js';
import { buildTranscript } from './ai-brain-transcript.js';
import { getSummary as defaultGetSummary } from './ai-brain.client.js';

/**
 * How far back the summariser reads. Matches ai-brain-service's own TRANSCRIPT_LIMIT in
 * app/summary.py - asking for more than the prompt will keep only spends tokens on the wire.
 */
export const SUMMARY_TRANSCRIPT_MESSAGE_LIMIT = 40;

type Logger = { error?: (...args: unknown[]) => void };

type ConversationLike = Pick<ConversationDocument, 'aiCategory' | 'aiFacts'> & {
  _id: ObjectIdLike;
  organizationId?: ObjectIdLike;
};

export interface CreateConversationSummaryServiceOptions {
  loadVisibleConversationForActor?: typeof defaultLoadVisibleConversationForActor;
  findMessagesByConversationCursor?: typeof defaultFindMessagesByConversationCursor;
  countMessagesByConversation?: typeof defaultCountMessagesByConversation;
  updateConversationSummary?: typeof defaultUpdateConversationSummary;
  buildAiBrainContext?: typeof defaultBuildAiBrainContext;
  getSummary?: typeof defaultGetSummary;
  logger?: Logger;
  now?: () => Date;
}

export interface ConversationSummaryResult {
  /** The current stored summary, or null when there has never been one and none could be made. */
  summary: SerializedConversationSummary | null;
  /** True when this call actually spent an ai-brain-service call. */
  regenerated: boolean;
  /** True when ai-brain-service could not be reached; any stored summary is still returned. */
  unavailable: boolean;
}

export interface ConversationSummaryActorParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  permissions: readonly Permission[];
  actorId: ObjectIdLike;
}

export interface ReadStoredSummaryParams {
  organizationId: ObjectIdLike;
  conversation: ConversationLike;
}

export const createConversationSummaryService = ({
  loadVisibleConversationForActor = defaultLoadVisibleConversationForActor,
  findMessagesByConversationCursor = defaultFindMessagesByConversationCursor,
  countMessagesByConversation = defaultCountMessagesByConversation,
  updateConversationSummary = defaultUpdateConversationSummary,
  buildAiBrainContext = defaultBuildAiBrainContext,
  getSummary = defaultGetSummary,
  logger = defaultLogger,
  now = () => new Date(),
}: CreateConversationSummaryServiceOptions = {}) => {
  const countMessages = async (
    organizationId: ObjectIdLike,
    conversationId: ObjectIdLike,
  ): Promise<number> => {
    const count = await countMessagesByConversation({ organizationId, conversationId });
    return typeof count === 'number' ? count : 0;
  };

  /**
   * The stored summary as it stands, with staleness worked out against the thread as it is now.
   * Reads only - it never asks ai-brain-service for anything, which is what makes it safe to
   * call from a sweep (see handover-read.service.ts).
   */
  const readStoredSummary = async ({
    organizationId,
    conversation,
  }: ReadStoredSummaryParams): Promise<SerializedConversationSummary | null> => {
    const currentMessageCount = await countMessages(organizationId, conversation._id);
    return serializeConversationSummary(conversation, currentMessageCount);
  };

  /**
   * Reads the thread and asks ai-brain-service for a fresh summary, then stores it.
   *
   * Returns null - never throws - when the summariser is unavailable for any reason: disabled,
   * unreachable, rate-limited, or answering something unusable. The caller falls back to
   * whatever was stored before.
   */
  const generateForConversation = async ({
    organizationId,
    conversation,
  }: ReadStoredSummaryParams): Promise<SerializedConversationSummary | null> => {
    const conversationId = conversation._id;

    try {
      const [recentMessages, totalMessageCount, context] = await Promise.all([
        findMessagesByConversationCursor({
          organizationId,
          conversationId,
          limit: SUMMARY_TRANSCRIPT_MESSAGE_LIMIT,
        }),
        countMessages(organizationId, conversationId),
        buildAiBrainContext({ organizationId, category: conversation.aiCategory }),
      ]);

      const result = await getSummary(conversationId.toString(), {
        facts: conversation.aiFacts ?? {},
        transcript: buildTranscript(recentMessages),
        category: conversation.aiCategory,
        knowledgeText: context.knowledgeText,
      });

      const summary: ConversationAiSummary = {
        headline: result.headline ?? '',
        whatTheyAskedFor: result.what_they_asked_for ?? '',
        whereItStands: result.where_it_stands ?? '',
        openQuestions: Array.isArray(result.open_questions)
          ? result.open_questions.map((question) => String(question))
          : [],
        suggestedNextStep: result.suggested_next_step ?? '',
      };

      const generatedAt = now();

      // The count written is the one measured BEFORE the read, not after: a message that landed
      // while the model was thinking is not in the transcript it read, so the summary genuinely
      // is one message out of date and must say so.
      const updated = await updateConversationSummary({
        conversationId,
        organizationId,
        summary,
        messageCount: totalMessageCount,
        generatedAt,
      });

      return serializeConversationSummary(
        updated ?? {
          aiSummary: summary,
          aiSummaryGeneratedAt: generatedAt,
          aiSummaryMessageCount: totalMessageCount,
        },
        await countMessages(organizationId, conversationId),
      );
    } catch (error: unknown) {
      const err = error as { code?: unknown; name?: unknown; statusCode?: unknown };
      logger?.error?.(
        {
          code: err?.code,
          name: err?.name,
          statusCode: err?.statusCode,
          organizationId: organizationId?.toString?.(),
          conversationId: conversationId?.toString?.(),
        },
        'Conversation summary generation failed safely; the stored summary (if any) still stands.',
      );
      return null;
    }
  };

  /** What the conversation view asks for on open. Never generates - it only reports. */
  const getSummaryForActor = async ({
    organizationId,
    conversationId,
    permissions,
    actorId,
  }: ConversationSummaryActorParams): Promise<ConversationSummaryResult> => {
    const conversation = await loadVisibleConversationForActor({
      organizationId,
      conversationId,
      permissions,
      actorId,
    });

    return {
      summary: await readStoredSummary({ organizationId, conversation }),
      regenerated: false,
      unavailable: false,
    };
  };

  /**
   * The explicit "(re)generate" action.
   *
   * A current summary is served straight back without touching ai-brain-service - pressing
   * regenerate on a thread nothing has happened in must not cost a call. `force` is the escape
   * hatch for an owner who wants a second reading of the same messages anyway.
   */
  const regenerateSummaryForActor = async ({
    organizationId,
    conversationId,
    permissions,
    actorId,
    force = false,
  }: ConversationSummaryActorParams & { force?: boolean }): Promise<ConversationSummaryResult> => {
    const conversation = await loadVisibleConversationForActor({
      organizationId,
      conversationId,
      permissions,
      actorId,
    });

    const stored = await readStoredSummary({ organizationId, conversation });

    if (stored && !stored.stale && !force) {
      return { summary: stored, regenerated: false, unavailable: false };
    }

    const fresh = await generateForConversation({ organizationId, conversation });

    if (!fresh) {
      return { summary: stored, regenerated: false, unavailable: true };
    }

    return { summary: fresh, regenerated: true, unavailable: false };
  };

  return {
    readStoredSummary,
    generateForConversation,
    getSummaryForActor,
    regenerateSummaryForActor,
  };
};

export type ConversationSummaryService = ReturnType<typeof createConversationSummaryService>;

// --------------------------------------------------------------------------
// The default instance the controller and the morning read use. Built lazily, for the same
// reason digest.service.ts builds its owner-notify handle lazily: nothing in this module graph
// may be constructed at import time.
// --------------------------------------------------------------------------
let singleton: ConversationSummaryService | null = null;
const service = (): ConversationSummaryService => {
  singleton ??= createConversationSummaryService();
  return singleton;
};

export const getConversationSummaryForActor = (
  params: ConversationSummaryActorParams,
): Promise<ConversationSummaryResult> => service().getSummaryForActor(params);

export const regenerateConversationSummaryForActor = (
  params: ConversationSummaryActorParams & { force?: boolean },
): Promise<ConversationSummaryResult> => service().regenerateSummaryForActor(params);

export const readStoredConversationSummary = (
  params: ReadStoredSummaryParams,
): Promise<SerializedConversationSummary | null> => service().readStoredSummary(params);
