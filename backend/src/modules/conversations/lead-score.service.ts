/**
 * Keeping `Conversation.leadScore` true.
 *
 * The scorer (lead-score.ts) is pure; this is the part that knows WHEN to run it and what to do
 * with the answer. It is called from every place a scoring input can change:
 *
 *   - a lead replies                    -> whatsapp/ingestion/inbound-message.service.ts
 *   - a pasted form's facts merge       -> the same, one line earlier
 *   - an imported form's facts merge    -> lead-sources/lead-import.service.ts
 *   - the AI learns a fact mid-chat     -> ai-brain/ai-brain.service.ts
 *
 * Every one of them writes its facts onto the conversation FIRST and then calls this, so the
 * facts blob read below is always the current one. It used to be possible to hand the score a
 * second, fresher copy of the facts, because the AI's learned facts were never written down at
 * all; they are now (see conversation.repository.ts's NEW_ANSWERS precedence) and that parameter
 * is gone with the gap it patched.
 *
 * Two rules run this module:
 *
 *  1. IT NEVER THROWS. Every one of those callers is on a path where an exception costs a lead
 *     their message or abandons a sheet import halfway. A scoring bug must cost the score and
 *     nothing else, so the whole body is wrapped and failures are logged, exactly like
 *     sendNewLeadAlert's contract on the same path.
 *  2. THE BEHAVIOURAL SIGNALS ARE STICKY. "They asked for a price" is a fact about this lead's
 *     history, not about their latest message - a lead who asks for a quote on Monday and sends
 *     "ok thanks" on Tuesday has not stopped wanting a quote. The conversation's stored
 *     `leadScoreSignals` is that memory, so it is always OR-ed with whatever this message says.
 */
import { logger as defaultLogger } from '../../config/logger.js';
import { type ObjectIdLike } from '../../types/common.js';
import { sendHotLeadAlert as defaultSendHotLeadAlert } from '../ai-brain/hot-lead-alert.service.js';
import {
  isAvailabilityQuestion as defaultIsAvailabilityQuestion,
  isQuotationRequest as defaultIsQuotationRequest,
} from '../whatsapp/automation/lead-intent.js';
import {
  findConversationById as defaultFindConversationById,
  updateLeadScore as defaultUpdateLeadScore,
} from './conversation.repository.js';
import {
  computeLeadScore,
  LEAD_SCORE_BANDS,
  LEAD_SCORE_SIGNALS,
  type LeadScoreResult,
} from './lead-score.js';

export interface RecomputeLeadScoreParams {
  organizationId?: ObjectIdLike;
  conversationId?: ObjectIdLike;
  /**
   * The lead's newest message, when this recompute was triggered by one. Read for the two
   * behavioural signals only - a message that mentions neither price nor availability simply
   * leaves the stored ones as they are.
   */
  inboundText?: string | null;
  /**
   * True when this inbound message is a REPLY to something we sent. Decided by the caller, which
   * is the only place that knows: ingestion reads it off the conversation before the new message
   * lands (see inbound-message.service.ts).
   */
  repliedToAi?: boolean;
  /** The account the owner's hot-lead alert would go out on. */
  whatsappAccountId?: ObjectIdLike;
  findConversationById?: typeof defaultFindConversationById;
  updateLeadScore?: typeof defaultUpdateLeadScore;
  sendHotLeadAlert?: typeof defaultSendHotLeadAlert;
  isQuotationRequest?: (text: unknown) => boolean;
  isAvailabilityQuestion?: (text: unknown) => boolean;
  logger?: { error?: (...args: unknown[]) => void };
}

export interface RecomputeLeadScoreResult extends LeadScoreResult {
  /** True when the owner's 🔥 alert actually went out on this recompute. */
  hotAlertSent: boolean;
}

/**
 * Recomputes and persists one conversation's lead score, and pulls a human in when it crosses
 * into HOT.
 *
 * Returns null when there was nothing to score (no ids, no such conversation) or when something
 * failed - never throws, and never leaves a caller with a reason to handle an error.
 *
 * The conversation is re-read here rather than taken as a parameter, for two reasons: the stored
 * signals are the sticky memory this function depends on, and the caller's copy of the document
 * is routinely one write out of date by the time it gets here (ingestion merged form facts into
 * it a moment ago; ai-brain.service just wrote an event date).
 */
export const recomputeLeadScore = async ({
  organizationId,
  conversationId,
  inboundText,
  repliedToAi = false,
  whatsappAccountId,
  findConversationById = defaultFindConversationById,
  updateLeadScore = defaultUpdateLeadScore,
  sendHotLeadAlert = defaultSendHotLeadAlert,
  isQuotationRequest = defaultIsQuotationRequest,
  isAvailabilityQuestion = defaultIsAvailabilityQuestion,
  logger = defaultLogger,
}: RecomputeLeadScoreParams = {}): Promise<RecomputeLeadScoreResult | null> => {
  if (!organizationId || !conversationId) {
    return null;
  }

  try {
    const conversation = await findConversationById({ conversationId, organizationId });

    if (!conversation) {
      return null;
    }

    const remembered: readonly string[] = Array.isArray(conversation.leadScoreSignals)
      ? conversation.leadScoreSignals
      : [];

    const wasFired = (signal: string): boolean => remembered.includes(signal);

    const result = computeLeadScore({
      facts: conversation.aiFacts as Record<string, unknown>,
      repliedToAi: repliedToAi || wasFired(LEAD_SCORE_SIGNALS.REPLIED),
      askedForQuotation:
        wasFired(LEAD_SCORE_SIGNALS.QUOTATION_REQUESTED) || isQuotationRequest(inboundText),
      askedAboutAvailability:
        wasFired(LEAD_SCORE_SIGNALS.AVAILABILITY_ASKED) || isAvailabilityQuestion(inboundText),
    });

    await updateLeadScore({
      conversationId,
      organizationId,
      score: result.score,
      band: result.band,
      signals: result.firedSignals,
    });

    // HOT means "a person should look at this now". The claim inside sendHotLeadAlert is what
    // makes it the UPWARD CROSSING and only that: every later recompute that is still HOT (and
    // every drop-then-return) finds the claim gone and stays quiet. Automation is deliberately
    // left running - the owner decides whether to take over, the score does not decide for them.
    let hotAlertSent = false;

    if (result.band === LEAD_SCORE_BANDS.HOT) {
      const alert = await sendHotLeadAlert({
        organizationId,
        whatsappAccountId: whatsappAccountId ?? conversation.whatsappAccountId,
        conversationId,
        leadDisplayName: conversation.displayName,
        score: result.score,
        signals: result.firedSignals,
      });

      hotAlertSent = Boolean(alert?.sent);
    }

    return { ...result, hotAlertSent };
  } catch (error: unknown) {
    const err = error as { code?: unknown; name?: unknown };
    logger.error?.(
      {
        code: err?.code,
        name: err?.name,
        organizationId: organizationId?.toString?.(),
        conversationId: conversationId?.toString?.(),
      },
      'Lead score recompute failed safely; the conversation keeps the score it already had.',
    );

    return null;
  }
};
