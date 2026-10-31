import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { PROCESSING_STATUSES } from '../../constants/call-statuses.js';
import { getAiProvider } from '../ai/ai-provider.instance.js';
import { type AiProvider } from '../ai/ai-provider.interface.js';
import { CallRecord } from './call-record.model.js';
import { type CallSummaryDocument } from './call-analysis.model.js';
import { findCallAnalysis, saveSummary, setSummaryStatus } from './call-analysis.repository.js';

/**
 * Turning a transcript into the structured summary the call detail screen renders.
 *
 * REUSES THE CONFIGURED MODEL CLIENT rather than adding a provider or an endpoint.
 * `generateReplyDraft` is the one text-in / text-out primitive the AI layer exposes; the name
 * is historical and the call is a plain completion, so pointing it at a summarisation prompt
 * costs nothing and keeps one place where the model, the key and the token ceiling are
 * configured. Adding a fourth provider method would have meant changing all three providers and
 * every fake in the test suite for no capability gained.
 *
 * THE PROMPT'S ONE JOB IS TO STOP INVENTION. A model asked for "budget" will supply a plausible
 * figure if the schema demands one, and a plausible figure attached to a real customer is worse
 * than no summary at all. So every field may be empty, emptiness is explicitly the right answer
 * when the call did not cover something, and anything the model concluded rather than heard
 * goes in `inferences` - its own field, rendered under its own heading.
 *
 * NOTHING HERE LOGS TRANSCRIPT CONTENT. Not the text, not the summary, not a snippet on the
 * failure path. A call id and a failure code is all a log line gets.
 */

const SYSTEM_PROMPT = `You summarise a recorded sales phone call for a photography and events studio in Bangalore.

Return ONLY a JSON object. No prose, no markdown fence.

{
  "overview": string,
  "customerRequirements": string[],
  "budget": string | null,
  "expectedTimeline": string | null,
  "preferences": string[],
  "questionsAsked": string[],
  "concerns": string[],
  "decisions": string[],
  "nextSteps": string[],
  "inferences": string[],
  "lowConfidence": boolean,
  "commitments": [{ "title": string, "evidence": string, "dueAt": string | null }]
}

RULES, in order of importance:

1. NEVER invent. If the call did not cover something, use null or an empty array. An empty
   field is a correct answer, not a failure.
2. Only put something in "budget", "expectedTimeline" or "decisions" if it was actually said
   out loud. Do not estimate, round, or infer a figure from context.
3. Anything you concluded rather than heard goes in "inferences", never anywhere else.
4. "commitments" are things someone explicitly promised to do. "dueAt" is an ISO-8601 date ONLY
   if a date or day was actually stated; otherwise null. Never guess a date.
5. If the transcript is short, garbled or mostly silence, set "lowConfidence": true and keep
   every other field minimal rather than filling them in.
6. Quote the customer's own words in "evidence".`;

/** Strings only, trimmed, empty dropped, capped. A model returning an object here is ignored. */
const asStringArray = (value: unknown, max = 12): string[] =>
  Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
        .slice(0, max)
    : [];

const asNullableString = (value: unknown, max = 500): string | null => {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();

  return trimmed === '' ? null : trimmed.slice(0, max);
};

/**
 * Parses a date the model supplied, refusing anything that is not one.
 *
 * REFUSES A PAST DATE TOO. A follow-up due before the call happened is a hallucination or a
 * misparse, and either way scheduling it would fire a reminder immediately for something nobody
 * agreed to.
 */
const asFutureDate = (value: unknown, after: Date): Date | null => {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= after.getTime()) {
    return null;
  }

  return parsed;
};

/** Pulls the JSON object out of whatever the model wrapped it in. */
const extractJson = (raw: string): unknown => {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');

  if (start === -1 || end === -1 || end <= start) {
    throw new Error('SUMMARY_NOT_JSON');
  }

  return JSON.parse(raw.slice(start, end + 1)) as unknown;
};

export interface ParsedSummary {
  summary: CallSummaryDocument;
  commitments: { commitmentId: string; title: string; evidence: string | null; dueAt: Date | null }[];
}

/**
 * Normalises whatever the model returned into the stored shape.
 *
 * EVERY FIELD IS DEFENSIVELY READ. A model that returns a number for `budget`, an object inside
 * `concerns`, or a commitment with no title must degrade to an empty field rather than writing
 * nonsense onto a customer's record or throwing away the whole summary.
 *
 * `commitmentId` IS POSITIONAL AND DETERMINISTIC, which is what makes the downstream task
 * idempotency key stable: the same call reprocessed yields the same ids, so a confirmed task
 * cannot be created twice.
 */
export const parseSummaryResponse = (raw: string, callStartedAt: Date): ParsedSummary => {
  const parsed = extractJson(raw) as Record<string, unknown>;

  const summary: CallSummaryDocument = {
    overview: asNullableString(parsed.overview, 2000) ?? '',
    customerRequirements: asStringArray(parsed.customerRequirements),
    budget: asNullableString(parsed.budget),
    expectedTimeline: asNullableString(parsed.expectedTimeline),
    preferences: asStringArray(parsed.preferences),
    questionsAsked: asStringArray(parsed.questionsAsked),
    concerns: asStringArray(parsed.concerns),
    decisions: asStringArray(parsed.decisions),
    nextSteps: asStringArray(parsed.nextSteps),
    inferences: asStringArray(parsed.inferences),
    lowConfidence: parsed.lowConfidence === true,
  };

  const rawCommitments = Array.isArray(parsed.commitments) ? parsed.commitments : [];

  const commitments = rawCommitments
    .slice(0, 10)
    .map((entry, index) => {
      const value = (entry ?? {}) as Record<string, unknown>;
      const title = asNullableString(value.title, 200);

      return title
        ? {
            commitmentId: `c${index}`,
            title,
            evidence: asNullableString(value.evidence, 500),
            dueAt: asFutureDate(value.dueAt, callStartedAt),
          }
        : null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  return { summary, commitments };
};

/**
 * The output ceiling for a summary request.
 *
 * `AI_MAX_OUTPUT_TOKENS` defaults to 300 - correct for the WhatsApp reply draft this method was
 * built for, and nowhere near enough for an eleven-field JSON object with commitments, which
 * runs 800-1500 tokens. At 300 the response is cut off mid-object and fails to parse every
 * time. Sent per call so reply drafts keep their own, much smaller, budget.
 *
 * 2000 is the ceiling `AI_MAX_OUTPUT_TOKENS` itself allows, and it bounds the output cost of a
 * summary at roughly two US cents whatever the model returns.
 */
export const CALL_SUMMARY_MAX_OUTPUT_TOKENS = 2000;

export interface SummariseNextCallParams {
  provider?: AiProvider;
  /** Injected so a test can exercise the kill switch without touching process env. */
  aiEnabled?: boolean;
}

export type SummariseOutcome =
  | { processed: false; reason: 'idle' | 'ai_disabled' }
  | { processed: true; callId: string; status: 'completed' | 'failed' };

/**
 * Claims and summarises at most one transcribed call.
 *
 * The claim is the same conditional-update trick the transcription sweep uses, so two workers
 * cannot both summarise the same call and bill for it twice.
 */
export const summariseNextCall = async ({
  provider,
  aiEnabled = env.AI_ENABLED,
}: SummariseNextCallParams = {}): Promise<SummariseOutcome> => {
  /*
   * ADR-005'S KILL SWITCH, CHECKED BEFORE THE CLAIM - and the order is the whole design.
   *
   * Claiming first and then refusing would leave the call `failed`, which is permanent until
   * somebody reprocesses it by hand: turning AI off for an afternoon would quietly poison
   * every call made during it. Claiming and setting it back to `pending` is worse - the next
   * tick re-claims the same row, forever, writing to the database once a minute to achieve
   * nothing.
   *
   * Not claiming at all leaves the row exactly as it was. The moment AI is switched back on,
   * the sweep picks it up on the next tick with no intervention and no lost work.
   */
  if (!aiEnabled) {
    return { processed: false, reason: 'ai_disabled' };
  }

  const call = await CallRecord.findOneAndUpdate(
    { summaryStatus: PROCESSING_STATUSES.PENDING },
    { $set: { summaryStatus: PROCESSING_STATUSES.PROCESSING, summaryError: null } },
    { returnDocument: 'after', sort: { startedAt: 1 }, runValidators: true },
  ).exec();

  if (!call) {
    return { processed: false, reason: 'idle' };
  }

  const callId = String(call._id);

  try {
    const analysis = await findCallAnalysis({
      organizationId: call.organizationId,
      callId: call._id,
    });

    const transcript = (analysis?.transcriptText ?? '').trim();

    if (transcript === '') {
      // Nothing was heard. Summarising silence would mean a model writing a call report from
      // an empty page, which is the exact failure mode this feature must not have.
      throw new Error('TRANSCRIPT_EMPTY');
    }

    const ai = provider ?? getAiProvider();

    const ask = (instructions: string) =>
      ai.generateReplyDraft({
        systemPrompt: SYSTEM_PROMPT,
        threadText: transcript,
        instructions,
        // Per call, so reply drafts keep their 300-token default. See the constant.
        maxOutputTokens: CALL_SUMMARY_MAX_OUTPUT_TOKENS,
      });

    const first = await ask('Return the JSON object only.');

    /*
     * ONE RETRY, AND ONLY FOR A RESPONSE THAT WAS NOT JSON.
     *
     * This is the one failure a retry actually fixes: a model that wrapped its answer in prose
     * or stopped mid-object produces a different response next time, and re-transcribing is
     * not involved - the transcript is already in hand, so the retry costs one more request
     * and nothing else.
     *
     * NOT RETRIED: transport and rate-limit failures, which the Anthropic SDK already retries
     * twice itself, and TRANSCRIPT_EMPTY, which will be empty again. Bounded at one because a
     * model that ignored the instruction twice will ignore it a third time, and each attempt
     * is billed.
     */
    let parsed: ParsedSummary;

    try {
      parsed = parseSummaryResponse(first.draftText, call.startedAt);
    } catch {
      /*
       * EVERY parse failure retries, and the try block's scope is what makes that correct.
       *
       * Only `parseSummaryResponse` is inside it. A provider error happens in `ask()` above,
       * and TRANSCRIPT_EMPTY is thrown before either - so neither can reach here, and no
       * error-type check is needed to exclude them.
       *
       * Both parse failures are worth one retry and they are not the same failure:
       * `SUMMARY_NOT_JSON` is a reply with no object in it at all, while a `SyntaxError` from
       * `JSON.parse` is a reply that looked like one and was malformed or cut off. Checking
       * for only the first would let `{oops}` fail without the retry that would most likely
       * have fixed it.
       */
      logger.info({ callId }, 'Call summary could not be parsed; retrying once.');

      const second = await ask(
        'Your previous reply was not valid JSON. Return ONLY the JSON object, with no prose, no explanation and no markdown fence.',
      );

      // A second failure throws, and the catch below records it as `failed` with the reason.
      parsed = parseSummaryResponse(second.draftText, call.startedAt);
    }

    const { summary, commitments } = parsed;

    await saveSummary({ callId: call._id, summary, suggestions: commitments });
    await setSummaryStatus({ callId: call._id, status: PROCESSING_STATUSES.COMPLETED });

    // Counts only. Never the overview, never a requirement, never a quoted commitment.
    logger.info({ callId, commitments: commitments.length }, 'Call summary stored.');

    return { processed: true, callId, status: 'completed' };
  } catch (error: unknown) {
    const code = error instanceof Error ? error.message : 'SUMMARY_FAILED';

    await setSummaryStatus({
      callId: call._id,
      status: PROCESSING_STATUSES.FAILED,
      error: code.slice(0, 200),
    });

    logger.warn({ callId, code }, 'Call summary failed.');

    return { processed: true, callId, status: 'failed' };
  }
};
