/**
 * Reading "we've booked another photographer" and stopping, once, for good.
 *
 * WHERE THIS SITS. It runs from ingestion's burst flush, beside
 * `extractLeadCommitment` and for the same reason: `handleInboundMessageForAutomation` returns
 * at its first check when automation is off, and a lead rejecting the business while the owner
 * is typing to them by hand is exactly when this must still work. It reads a turn and writes one
 * field. It never replies, never enqueues, never touches a socket.
 *
 * THE OPT-OUT PATH OUTRANKS IT, ALWAYS. If the deterministic matcher already read this message
 * as "stop messaging me", this returns immediately without calling a model at all. That is the
 * rule that keeps an AI guess from ever landing on top of an explicit instruction from a
 * customer - the two mechanisms are ordered, not merged, and this one is second. It also means
 * a lead who opts out never gets a second, different owner alert for the same sentence.
 *
 * NOTHING HERE CAN REVIVE A LEAD. `markSalesRejected` only ever writes the rejection, the model
 * is never asked whether somebody is still interested, and there is no code path from a `none`
 * verdict to clearing anything. Reopening is a human action behind a permission - see
 * setAutomationForActor.
 *
 * WHEN IT IS UNSURE IT DOES NOTHING. Two independent floors: the classifier is told to prefer
 * `none` and has no way to express a maybe, and MIN_SALES_REJECTION_CONFIDENCE is applied here
 * on top of whatever it returns. A missed rejection costs one more follow-up; a false one ends
 * a live deal silently.
 */
import { ACTIVITY_EVENTS } from '../../constants/activity-events.js';
import {
  MIN_SALES_REJECTION_CONFIDENCE,
  SALES_REJECTION_SOURCES,
} from '../../constants/sales-rejection.js';
import { logger as defaultLogger } from '../../config/logger.js';
import { type ObjectIdLike } from '../../types/common.js';
import { createActivity as defaultCreateActivity } from '../activity/activity-log.repository.js';
import * as defaultAiBrainClient from '../ai-brain/ai-brain.client.js';
import { markSalesRejected as defaultMarkSalesRejected } from '../conversations/conversation.repository.js';

type Logger = { info?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };

export interface DetectSalesRejectionParams {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike;
  conversationId?: ObjectIdLike;
  /** The whole burst as one turn, so four rapid messages are read once. */
  text?: string | null;
  transcript?: { role: string; text: string }[];
  /** True when the deterministic matcher already read this as an opt-out. Then this does nothing. */
  optedOut?: boolean;
  /** True when the conversation is already rejected. Re-deciding a settled lead is pointless. */
  alreadyRejected?: boolean;
}

export interface DetectSalesRejectionResult {
  rejected: boolean;
  /** Why not, when `rejected` is false. Returned for the tests and the logs, never for a customer. */
  reason?:
    | 'opted_out'
    | 'already_rejected'
    | 'empty'
    | 'no_rejection'
    | 'low_confidence'
    | 'classifier_failed';
}

export interface CreateSalesRejectionServiceOptions {
  aiBrainClient?: Pick<typeof defaultAiBrainClient, 'classifyRejection'>;
  markSalesRejected?: typeof defaultMarkSalesRejected;
  createActivity?: typeof defaultCreateActivity;
  minConfidence?: number;
  now?: () => Date;
  logger?: Logger;
}

export const createSalesRejectionService = ({
  aiBrainClient = defaultAiBrainClient,
  markSalesRejected = defaultMarkSalesRejected,
  createActivity = defaultCreateActivity,
  minConfidence = MIN_SALES_REJECTION_CONFIDENCE,
  now = () => new Date(),
  logger = defaultLogger,
}: CreateSalesRejectionServiceOptions = {}) => {
  const classifyAndMark = async ({
    organizationId,
    whatsappAccountId,
    conversationId,
    text,
    transcript = [],
    optedOut = false,
    alreadyRejected = false,
  }: DetectSalesRejectionParams): Promise<DetectSalesRejectionResult> => {
    const body = String(text ?? '').trim();

    if (!organizationId || !conversationId || body === '') {
      return { rejected: false, reason: 'empty' };
    }

    // THE EXPLICIT DECISION WINS AND IS NOT SECOND-GUESSED. A lead who asked to stop being
    // messaged has already been handled, completely, by the opt-out path: automation off, owner
    // alerted, three enforcement points armed. Asking a model for a second opinion on the same
    // sentence could only ever add a conflicting record.
    if (optedOut) {
      return { rejected: false, reason: 'opted_out' };
    }

    // Sticky means settled. The repository's filter would refuse the write anyway; returning
    // here saves an LLM call on every subsequent message to a closed-out lead.
    if (alreadyRejected) {
      return { rejected: false, reason: 'already_rejected' };
    }

    let verdict;

    try {
      verdict = await aiBrainClient.classifyRejection({
        conversationId: String(conversationId),
        message: body,
        transcript,
      });
    } catch (error: unknown) {
      // A CLASSIFIER THAT NEVER ANSWERED IS NOT A REJECTION. Deliberately no retry queue, unlike
      // the commitment path: a missed rejection costs one extra follow-up, and the lead's own
      // next message gets another go at this anyway.
      const err = error as { code?: unknown; name?: unknown };
      logger?.error?.(
        { code: err?.code, name: err?.name, conversationId: String(conversationId) },
        'REJECTION_CHECK: classifier failed; the lead is left active.',
      );

      return { rejected: false, reason: 'classifier_failed' };
    }

    if (!verdict || verdict.verdict !== 'firm_rejection') {
      logger?.info?.(
        { conversationId: String(conversationId), verdict: verdict?.verdict ?? 'none' },
        'REJECTION_CHECK: no rejection in this turn; the lead stays active.',
      );

      return { rejected: false, reason: 'no_rejection' };
    }

    // THE SECOND FLOOR, independent of the prompt. Hesitation that the model mistook for a
    // decision usually comes back with middling confidence, and this is what stops it closing a
    // live deal. Logged distinctly from `no_rejection` because the two mean different things:
    // one is a threshold to tune, the other is the model working correctly.
    if ((verdict.confidence ?? 0) < minConfidence) {
      logger?.info?.(
        {
          conversationId: String(conversationId),
          confidence: verdict.confidence ?? 0,
          threshold: minConfidence,
        },
        'REJECTION_CHECK: rejection below the confidence threshold; the lead stays active.',
      );

      return { rejected: false, reason: 'low_confidence' };
    }

    const updated = await markSalesRejected({
      organizationId,
      conversationId,
      quote: verdict.quote || body.slice(0, 300),
      source: SALES_REJECTION_SOURCES.AI_CLASSIFIER,
      now: now(),
    });

    // Null means it was already rejected - another worker, or a second message in the same
    // burst. Not an error, and not a second activity row.
    if (!updated) {
      return { rejected: false, reason: 'already_rejected' };
    }

    if (whatsappAccountId) {
      await createActivity({
        organizationId,
        whatsappAccountId,
        conversationId,
        eventType: ACTIVITY_EVENTS.AI_BRAIN_SALES_REJECTION_DETECTED,
        summary: 'This lead said they are not going ahead — automated follow-ups stopped.',
        metadata: {
          confidence: verdict.confidence ?? 0,
          source: SALES_REJECTION_SOURCES.AI_CLASSIFIER,
        },
      });
    }

    logger?.info?.(
      { conversationId: String(conversationId), confidence: verdict.confidence ?? 0 },
      'REJECTION_CHECK: firm rejection recorded; automated follow-ups stopped.',
    );

    return { rejected: true };
  };

  /**
   * FAILURE-ISOLATED, NEVER THROWS - the same contract `handleAutomation` and
   * `extractLeadCommitment` are held to, and for a reason this very change demonstrated: these
   * three run in sequence inside one burst flush, so an exception here does not just lose a
   * rejection, it takes the sales agent down with it and the lead gets no reply at all.
   *
   * Failing closed is also the safe direction. Not recording a rejection costs one more
   * follow-up; throwing costs the whole turn.
   */
  const detectSalesRejection = async (
    params: DetectSalesRejectionParams = {},
  ): Promise<DetectSalesRejectionResult> => {
    try {
      return await classifyAndMark(params);
    } catch (error: unknown) {
      const err = error as { code?: unknown; name?: unknown };
      logger?.error?.(
        {
          code: err?.code,
          name: err?.name,
          conversationId: params.conversationId ? String(params.conversationId) : null,
        },
        'REJECTION_CHECK: failed safely; the lead is left active and ingestion continues.',
      );

      return { rejected: false, reason: 'classifier_failed' };
    }
  };

  return { detectSalesRejection };
};

export type SalesRejectionService = ReturnType<typeof createSalesRejectionService>;

let cached: SalesRejectionService | null = null;

/** Lazily built so importing this module does not construct the AI client at import time. */
export const getSalesRejectionService = (): SalesRejectionService => {
  cached ??= createSalesRejectionService();

  return cached;
};
