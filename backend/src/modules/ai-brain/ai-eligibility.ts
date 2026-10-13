/**
 * THE ONE RULE: the AI speaks to a customer only when the message in front of it is a genuine
 * enquiry about this business. Everything else is met with silence.
 *
 * WHY THIS MODULE EXISTS. The rule used to live in two places that disagreed. A deterministic
 * phrase filter ran during ingestion and a model-backed intent gate ran inside the brain, each
 * with its own idea of what "not a lead" meant and its own escape hatch, and between the two of
 * them was a gap wide enough to drive fifty cold messages through. See `canAiRespondToInbound`
 * for what actually went wrong. One function now owns the decision; nothing else may form its
 * own opinion about whether to answer.
 *
 * QUALIFY ONCE, THEN STOP ASKING. The gate judges a message on its own merits only while the
 * conversation is still unproven. Once a thread has been qualified AND a reply has actually
 * reached the customer, the classifier is no longer consulted for it - see check 4. The cheaper
 * safety checks never stop running, so an empty body is silence on an established lead exactly
 * as it is on a stranger.
 *
 * SILENCE IS NOT A PAUSE. This is the part that is easy to get wrong in the other direction.
 * Ignoring a message must leave the conversation exactly as able to be served as it was a second
 * earlier, because the person who just sent "hi" is very often the person who sends "I need a
 * photographer for December" a minute later. So an IGNORE writes nothing that could stop that
 * second message landing: no paused flag, no escalation, no owner alert, no draft, no follow-up.
 * It declines to speak, and that is all it does.
 *
 * FAIL CLOSED. Every uncertain branch - no text, a classifier that timed out, a verdict the
 * service could not express, a message the model is unsure about - resolves to silence. The cost
 * of a wrong silence is that a lead waits for a human who is already being shown the message.
 * The cost of a wrong reply is a cold intro sent to someone's bank, which is how a WhatsApp
 * number gets banned.
 */
import { AI_INTENTS, type AiIntent } from '../../constants/ai-intents.js';
import { logger as defaultLogger } from '../../config/logger.js';
import {
  classifyNonLead as defaultClassifyNonLead,
  NON_LEAD_REASONS,
} from '../whatsapp/automation/non-lead.js';
import { normalizeOptOutText } from '../whatsapp/automation/opt-out.js';

/** Why the gate decided what it decided. Logged, never shown to a customer. */
export const AI_ELIGIBILITY_REASONS = Object.freeze({
  OWNER_DIRECTED: 'owner_directed',
  NO_TEXT: 'no_text',
  DETERMINISTIC_NON_LEAD: 'deterministic_non_lead',
  INTENT_NOT_SALES_LEAD: 'intent_not_sales_lead',
  CLASSIFIER_UNAVAILABLE: 'classifier_unavailable',
  SERVICE_ENQUIRY: 'service_enquiry',
  /** An established lead: already qualified, so the classifier was not consulted again. */
  CONFIRMED_LEAD: 'confirmed_lead',
} as const);

export type AiEligibilityReason =
  (typeof AI_ELIGIBILITY_REASONS)[keyof typeof AI_ELIGIBILITY_REASONS];

export interface AiEligibilityVerdict {
  /** The only field callers may branch on. True means "this is a service enquiry, go ahead". */
  respond: boolean;
  intent: AiIntent;
  reason: AiEligibilityReason;
  /** Present only when a model produced a verdict worth storing on the conversation. */
  decided: boolean;
}

export interface ClassifyIntentFn {
  (params: { message: string; transcript: { role: string; text: string }[] }): Promise<{
    intent?: string;
    confidence?: number;
    reason?: string;
  } | null>;
}

export interface CanAiRespondToInboundParams {
  inboundText?: string | null;
  /**
   * True when this conversation is an established service lead - qualified once, and a reply
   * actually delivered. Skips the CLASSIFIER only; every cheaper safety check above it still
   * runs. See the `leadQualified` branch below for why that distinction matters.
   */
  leadQualified?: boolean;
  /** A directive from a human or from the importer's greeting job - not a customer message. */
  ownerInstruction?: string | null;
  /** Recent turns, oldest first, so "how much?" can be read against what came before it. */
  transcript?: { role: string; text: string }[];
  classifyIntent: ClassifyIntentFn;
  classifyNonLead?: typeof defaultClassifyNonLead;
  logger?: { error?: (...args: unknown[]) => void };
}

const ignore = (reason: AiEligibilityReason, intent: AiIntent): AiEligibilityVerdict => ({
  respond: false,
  intent,
  reason,
  decided: false,
});

/**
 * May the AI answer this inbound message?
 *
 * THE BUG THIS WAS WRITTEN FOR, because the shape of it should not be forgotten. A marketing
 * broadcast with a "Shop Now" button arrives as a `templateMessage`; a bot menu arrives as a
 * `listMessage`. The Baileys text extractor reads five shapes - `conversation`,
 * `extendedTextMessage` and three media captions - and none of those is one of them, so the body
 * came through as an empty string. `resolveBaileysMessageType` then falls back to TEXT (correct,
 * and deliberate: it stops protocol noise paging the owner), which meant the no-caption media
 * escalation did not fire either. And the old intent gate SKIPPED itself on empty text, reasoning
 * there was nothing to classify - so an empty body sailed past the deterministic filter, past the
 * media guard, past the intent gate, and reached the brain, which did the only thing it could
 * with no transcript and introduced the studio. Fifty times, in four minutes, after a reconnect
 * replayed months of marketing history as fresh inbound.
 *
 * "Nothing to classify" must therefore mean SILENCE, never "carry on". That is the second check
 * below, and it is the single most important line in this file.
 */
export const canAiRespondToInbound = async ({
  inboundText,
  ownerInstruction,
  leadQualified = false,
  transcript = [],
  classifyIntent,
  classifyNonLead = defaultClassifyNonLead,
  logger = defaultLogger,
}: CanAiRespondToInboundParams): Promise<AiEligibilityVerdict> => {
  // 1. A human (or the importer's greeting job) told the AI to speak. This is an internal
  //    control path, not a customer message, and it is the only bypass that exists. It cannot be
  //    reached from anything a customer sends - `ownerInstruction` is set by the owner-reply
  //    handler and by imported-lead-greeting, never from inbound text.
  if ((ownerInstruction ?? '').trim() !== '') {
    return {
      respond: true,
      intent: AI_INTENTS.SALES_LEAD,
      reason: AI_ELIGIBILITY_REASONS.OWNER_DIRECTED,
      decided: false,
    };
  }

  // 2. Nothing readable to judge. Empty bodies, template/button/list messages the extractor
  //    cannot read, and messages that are only an emoji or only punctuation all land here -
  //    `normalizeOptOutText` strips to [a-z0-9], so "👍" and "???" normalise to "".
  if (normalizeOptOutText(inboundText) === '') {
    return ignore(AI_ELIGIBILITY_REASONS.NO_TEXT, AI_INTENTS.NON_LEAD);
  }

  // 3. The cheap layer: obvious noise, no model call. Its own positive override means a message
  //    naming the work still gets through even if it also mentions an invoice.
  const deterministic = classifyNonLead(inboundText);

  if (deterministic.isNonLead) {
    // "YES" IS AN ANSWER WHEN SOMEBODY WAS ASKED A QUESTION.
    //
    // The pleasantry list matches a whole message equal to "hi", "ok", "yes", "sure", "thanks".
    // That list exists to stop the AI introducing the studio to a stranger who typed "hi" - a
    // perfectly good rule for a conversation that has not started. It is the wrong rule once one
    // has: the AI asks "photography, or videography as well?", the customer answers "yes", and
    // the thread dies on the one message that was a direct reply to our own question.
    //
    // So for an established lead this single reason is waived and the message carries on to the
    // brain, which has the transcript and can tell what "yes" was agreeing to. The brain may
    // still choose to say nothing; that is its call to make with context, not this filter's to
    // make without any.
    //
    // EVERY OTHER REASON STILL STANDS, for confirmed and unconfirmed threads alike - banking and
    // OTPs, vendor paperwork, marketing blasts, automated notices, bare links. A forwarded OTP
    // is an OTP whoever sends it, and widening more than one reason here would re-open the hole
    // this file was written to close.
    const waivedForEstablishedLead =
      leadQualified && deterministic.reason === NON_LEAD_REASONS.PLEASANTRY;

    if (!waivedForEstablishedLead) {
      return ignore(AI_ELIGIBILITY_REASONS.DETERMINISTIC_NON_LEAD, AI_INTENTS.NON_LEAD);
    }
  }

  // 4. AN ESTABLISHED LEAD DOES NOT GET RE-INTERVIEWED.
  //
  //    THE BUG THIS FIXES. constants/ai-intents.ts has always said the classifier should run
  //    "ONCE per conversation rather than on every inbound message", and the conversation model
  //    says `aiIntent` is "set once by the intent gate so the classifier is not re-run". Both
  //    describe a short-circuit that this file stopped performing: when the gate was rewritten
  //    after the cold-message incident, the WRITE of that field survived and the READ was lost.
  //    Every message has been re-interviewed since.
  //
  //    What that costs is not theoretical. The classifier is told to prefer "unclear", and is
  //    judging one message, so an answer inside a live sale - "I'll confirm tomorrow", "which
  //    package do you recommend?" - is not a service enquiry on its own terms and comes back
  //    unclear. The AI then goes silent in the middle of a conversation it started, mid
  //    qualification, which reads to the customer as being ignored.
  //
  //    ONLY THE CLASSIFIER IS SKIPPED, and every check above it still ran. That is deliberate
  //    and is what keeps the incident closed: an empty body is still silence (check 2) even on
  //    a confirmed lead, because "nothing to classify" meaning "carry on" is precisely what put
  //    fifty cold intros on the wire. Deterministic noise is still noise (check 3). This branch
  //    widens exactly one thing - whether a model gets a veto over a thread it already approved.
  if (leadQualified) {
    return {
      respond: true,
      intent: AI_INTENTS.SALES_LEAD,
      reason: AI_ELIGIBILITY_REASONS.CONFIRMED_LEAD,
      // Nothing new was decided, so nothing is written back. The conversation is already
      // confirmed; re-stamping it on every message would be churn with no information in it.
      decided: false,
    };
  }

  // 5. The model, for a conversation that is not yet established. A thread that sent an invoice
  //    can ask a real question an hour later, so an unconfirmed verdict describes THIS message
  //    and never mutes what comes next.
  try {
    const result = await classifyIntent({ message: inboundText ?? '', transcript });
    const returned = result?.intent;

    if (returned === AI_INTENTS.SALES_LEAD) {
      return {
        respond: true,
        intent: AI_INTENTS.SALES_LEAD,
        reason: AI_ELIGIBILITY_REASONS.SERVICE_ENQUIRY,
        decided: true,
      };
    }

    // non_lead, unclear, or anything the service invented. All silence.
    return {
      respond: false,
      intent: returned === AI_INTENTS.NON_LEAD ? AI_INTENTS.NON_LEAD : AI_INTENTS.UNCLEAR,
      reason: AI_ELIGIBILITY_REASONS.INTENT_NOT_SALES_LEAD,
      decided: returned === AI_INTENTS.NON_LEAD || returned === AI_INTENTS.UNCLEAR,
    };
  } catch (error: unknown) {
    // A timeout or a 500 is not permission to speak. Not recorded on the conversation either -
    // a transient fault must not brand the thread, so the next message gets a fresh attempt.
    logger?.error?.(
      { err: error },
      'Intent classifier unavailable; staying silent on this inbound message.',
    );

    return ignore(AI_ELIGIBILITY_REASONS.CLASSIFIER_UNAVAILABLE, AI_INTENTS.UNCLEAR);
  }
};
