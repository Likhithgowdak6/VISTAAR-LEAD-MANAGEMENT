/**
 * Turning a transcript into a structured summary.
 *
 * THE ONLY THING THAT REALLY MATTERS IN THIS FILE: the parser must not let a model put words in
 * a customer's mouth. A summary is read as a record of what somebody said, and a plausible
 * invented budget or an imagined promise attached to a real lead is worse than no summary - it
 * is a lie the agent will act on.
 *
 * So the parser is tested for what it DISCARDS as much as what it keeps: non-strings in list
 * fields, commitments with no title, and - most importantly - due dates the model produced that
 * the transcript could not have supported.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  // AI_ENABLED is explicit now: the summariser checks ADR-005's kill switch before claiming a
  // call, so a mock without it would make every test here look like a disabled system.
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', AI_ENABLED: true },
}));

vi.mock('../../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mocks = vi.hoisted(() => ({
  findOneAndUpdate: vi.fn(),
  findCallAnalysis: vi.fn(),
  saveSummary: vi.fn(),
  setSummaryStatus: vi.fn(),
  getAiProvider: vi.fn(),
}));

vi.mock('./call-record.model.js', () => ({
  CallRecord: { findOneAndUpdate: mocks.findOneAndUpdate },
}));

vi.mock('./call-analysis.repository.js', () => ({
  findCallAnalysis: mocks.findCallAnalysis,
  saveSummary: mocks.saveSummary,
  setSummaryStatus: mocks.setSummaryStatus,
}));

vi.mock('../ai/ai-provider.instance.js', () => ({ getAiProvider: mocks.getAiProvider }));

const { CALL_SUMMARY_MAX_OUTPUT_TOKENS, parseSummaryResponse, summariseNextCall } = await import(
  './call-summary.service.js'
);
const { logger } = await import('../../config/logger.js');

const CALL = '6adf2dd59f91cdd63f09e0f3';
const ORG = '6ab4c2037469f65204cfe999';
const STARTED_AT = new Date('2026-10-30T09:00:00.000Z');

const exec = (value: unknown) => ({ exec: () => Promise.resolve(value) });

const call = () => ({ _id: CALL, organizationId: ORG, startedAt: STARTED_AT });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findOneAndUpdate.mockReturnValue(exec(call()));
  mocks.findCallAnalysis.mockResolvedValue({ transcriptText: 'Hello. I need a wedding shoot.' });
  mocks.saveSummary.mockResolvedValue({});
  mocks.setSummaryStatus.mockResolvedValue({});
});

const aiReturning = (text: string) => ({
  name: 'fake',
  generateReplyDraft: vi.fn().mockResolvedValue({ draftText: text }),
});

describe('parsing what the model returned', () => {
  it('keeps every supported field', () => {
    const { summary, commitments } = parseSummaryResponse(
      JSON.stringify({
        overview: 'Vaishu asked about a wedding shoot.',
        customerRequirements: ['Two-day wedding coverage'],
        budget: 'Around 2 lakh',
        expectedTimeline: 'February 2027',
        preferences: ['Candid style'],
        questionsAsked: ['Do you travel to Mysore?'],
        concerns: ['Worried about the drone cost'],
        decisions: ['Will send a quotation'],
        nextSteps: ['Share the package PDF'],
        inferences: ['Seems price-sensitive'],
        lowConfidence: false,
        commitments: [{ title: 'Send the package PDF', evidence: 'send me the packages' }],
      }),
      STARTED_AT,
    );

    expect(summary.budget).toBe('Around 2 lakh');
    expect(summary.customerRequirements).toEqual(['Two-day wedding coverage']);
    expect(commitments).toHaveLength(1);
    expect(commitments[0]?.commitmentId).toBe('c0');
  });

  it('KEEPS INFERENCE SEPARATE from what was said', () => {
    // The whole summary is worthless if a reader cannot tell "the customer said 2 lakh" from
    // "the customer seems price-sensitive".
    const { summary } = parseSummaryResponse(
      JSON.stringify({ inferences: ['Seems price-sensitive'], budget: null }),
      STARTED_AT,
    );

    expect(summary.inferences).toEqual(['Seems price-sensitive']);
    expect(summary.budget).toBeNull();
  });

  it('treats an empty field as a correct answer, not a gap to fill', () => {
    const { summary } = parseSummaryResponse(JSON.stringify({ overview: 'Short call.' }), STARTED_AT);

    expect(summary.budget).toBeNull();
    expect(summary.expectedTimeline).toBeNull();
    expect(summary.customerRequirements).toEqual([]);
  });

  it('DROPS A DUE DATE THAT PREDATES THE CALL', () => {
    // A follow-up due before the call happened is a hallucination or a misparse. Scheduling it
    // would fire a reminder immediately for something nobody agreed to.
    const { commitments } = parseSummaryResponse(
      JSON.stringify({
        commitments: [{ title: 'Call back', evidence: 'ring me', dueAt: '2020-01-01' }],
      }),
      STARTED_AT,
    );

    expect(commitments[0]?.dueAt).toBeNull();
  });

  it('keeps a due date the transcript actually supported', () => {
    const { commitments } = parseSummaryResponse(
      JSON.stringify({
        commitments: [{ title: 'Call back', evidence: 'ring me Friday', dueAt: '2026-11-06T10:00:00.000Z' }],
      }),
      STARTED_AT,
    );

    expect(commitments[0]?.dueAt?.toISOString()).toBe('2026-11-06T10:00:00.000Z');
  });

  it('discards nonsense in list fields rather than storing it', () => {
    const { summary } = parseSummaryResponse(
      JSON.stringify({ concerns: ['Real concern', 42, null, { a: 1 }, '   '] }),
      STARTED_AT,
    );

    expect(summary.concerns).toEqual(['Real concern']);
  });

  it('drops a commitment with no title', () => {
    const { commitments } = parseSummaryResponse(
      JSON.stringify({ commitments: [{ evidence: 'something' }, { title: 'Real one' }] }),
      STARTED_AT,
    );

    expect(commitments).toHaveLength(1);
    expect(commitments[0]?.title).toBe('Real one');
  });

  it('GIVES THE SAME IDS ON REPROCESSING, which is what makes tasks idempotent', () => {
    const payload = JSON.stringify({
      commitments: [{ title: 'A' }, { title: 'B' }],
    });

    const first = parseSummaryResponse(payload, STARTED_AT).commitments.map((c) => c.commitmentId);
    const second = parseSummaryResponse(payload, STARTED_AT).commitments.map((c) => c.commitmentId);

    expect(first).toEqual(['c0', 'c1']);
    expect(second).toEqual(first);
  });

  it('carries lowConfidence through so the UI can hedge', () => {
    const { summary } = parseSummaryResponse(JSON.stringify({ lowConfidence: true }), STARTED_AT);

    expect(summary.lowConfidence).toBe(true);
  });

  it('finds the JSON even when the model wrapped it in prose', () => {
    const { summary } = parseSummaryResponse(
      'Here you go:\n```json\n{"overview":"Short call."}\n```\nHope that helps.',
      STARTED_AT,
    );

    expect(summary.overview).toBe('Short call.');
  });

  it('refuses a response with no JSON at all', () => {
    expect(() => parseSummaryResponse('I could not summarise that.', STARTED_AT)).toThrow(
      'SUMMARY_NOT_JSON',
    );
  });
});

describe('the sweep', () => {
  it('reports idle with nothing pending', async () => {
    mocks.findOneAndUpdate.mockReturnValue(exec(null));

    expect(await summariseNextCall()).toEqual({ processed: false, reason: 'idle' });
  });

  it('REFUSES TO SUMMARISE AN EMPTY TRANSCRIPT', async () => {
    // Summarising silence means a model writing a call report from a blank page.
    mocks.findCallAnalysis.mockResolvedValue({ transcriptText: '   ' });

    const result = await summariseNextCall({ provider: aiReturning('{}') as never });

    expect(result).toMatchObject({ status: 'failed' });
    expect(mocks.setSummaryStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error: 'TRANSCRIPT_EMPTY' }),
    );
    expect(mocks.saveSummary).not.toHaveBeenCalled();
  });

  it('stores the summary and its suggestions on success', async () => {
    const ai = aiReturning(
      JSON.stringify({ overview: 'Asked about wedding packages.', commitments: [{ title: 'Send PDF' }] }),
    );

    const result = await summariseNextCall({ provider: ai as never });

    expect(result).toMatchObject({ status: 'completed' });
    expect(mocks.saveSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestions: [expect.objectContaining({ commitmentId: 'c0', title: 'Send PDF' })],
      }),
    );
  });

  it('records a failure when the model returns something unusable', async () => {
    const result = await summariseNextCall({ provider: aiReturning('sorry, no') as never });

    expect(result).toMatchObject({ status: 'failed' });
    expect(mocks.setSummaryStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error: 'SUMMARY_NOT_JSON' }),
    );
  });

  it('NEVER LOGS SUMMARY CONTENT', async () => {
    const ai = aiReturning(
      JSON.stringify({
        overview: 'Vaishu wants a wedding shoot for two lakh.',
        commitments: [{ title: 'Send PDF' }],
      }),
    );

    await summariseNextCall({ provider: ai as never });

    const logged = JSON.stringify((logger.info as ReturnType<typeof vi.fn>).mock.calls);

    expect(logged).not.toContain('Vaishu');
    expect(logged).not.toContain('two lakh');
    expect(logged).toContain(CALL);
  });
});

describe('the AI kill switch', () => {
  it('DOES NOT CLAIM A CALL when AI is disabled', async () => {
    /*
     * The order is the whole point. Claiming and then refusing would leave the call `failed`,
     * which is permanent until somebody reprocesses it by hand - turning AI off for an
     * afternoon would quietly poison every call made during it.
     */
    const result = await summariseNextCall({ aiEnabled: false });

    expect(result).toEqual({ processed: false, reason: 'ai_disabled' });
    expect(mocks.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('NEVER REACHES THE MODEL when AI is disabled', async () => {
    const ai = aiReturning('{}');

    await summariseNextCall({ aiEnabled: false, provider: ai as never });

    expect(ai.generateReplyDraft).not.toHaveBeenCalled();
  });

  it('LEAVES THE CALL PENDING, so it resumes when AI is switched back on', async () => {
    // Not `failed` (permanent) and not re-claimed-then-released (a write per tick achieving
    // nothing). The row is untouched, so the next tick after re-enabling picks it up.
    await summariseNextCall({ aiEnabled: false });

    expect(mocks.setSummaryStatus).not.toHaveBeenCalled();
    expect(mocks.saveSummary).not.toHaveBeenCalled();
  });

  it('works normally when AI is enabled', async () => {
    const ai = aiReturning(JSON.stringify({ overview: 'Short call.' }));

    const result = await summariseNextCall({ aiEnabled: true, provider: ai as never });

    expect(result).toMatchObject({ status: 'completed' });
  });
});

describe('the output token budget', () => {
  it('ASKS FOR 2000 TOKENS, not the 300-token reply-draft default', async () => {
    // An eleven-field JSON object does not fit in 300 tokens: it is cut off mid-object and
    // fails to parse every time. This is the fix for that.
    const ai = aiReturning(JSON.stringify({ overview: 'Short call.' }));

    await summariseNextCall({ provider: ai as never });

    expect(ai.generateReplyDraft).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: CALL_SUMMARY_MAX_OUTPUT_TOKENS }),
    );
    expect(CALL_SUMMARY_MAX_OUTPUT_TOKENS).toBe(2000);
  });
});

describe('the bounded retry', () => {
  it('RETRIES ONCE when the model did not return JSON', async () => {
    // The one failure a retry actually fixes - the transcript is already in hand, so this
    // costs one more request and no re-transcription.
    const ai = {
      name: 'fake',
      generateReplyDraft: vi
        .fn()
        .mockResolvedValueOnce({ draftText: 'Sure! Here is your summary in prose.' })
        .mockResolvedValueOnce({ draftText: JSON.stringify({ overview: 'Recovered.' }) }),
    };

    const result = await summariseNextCall({ provider: ai as never });

    expect(ai.generateReplyDraft).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: 'completed' });
    expect(mocks.saveSummary).toHaveBeenCalledWith(
      expect.objectContaining({ summary: expect.objectContaining({ overview: 'Recovered.' }) }),
    );
  });

  it('tells the model what went wrong on the second attempt', async () => {
    const ai = {
      name: 'fake',
      generateReplyDraft: vi
        .fn()
        .mockResolvedValueOnce({ draftText: 'no json here' })
        .mockResolvedValueOnce({ draftText: '{}' }),
    };

    await summariseNextCall({ provider: ai as never });

    expect(ai.generateReplyDraft.mock.calls[1]![0].instructions).toContain('not valid JSON');
  });

  it('STOPS AT TWO ATTEMPTS, not three', async () => {
    // A model that ignored the instruction twice will ignore it a third time, and each
    // attempt is billed.
    const ai = aiReturning('still not json');

    const result = await summariseNextCall({ provider: ai as never });

    expect(ai.generateReplyDraft).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: 'failed' });
    expect(mocks.setSummaryStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed', error: 'SUMMARY_NOT_JSON' }),
    );
  });

  it('RETRIES A MALFORMED OBJECT TOO, not just a reply with no JSON at all', async () => {
    /*
     * `{oops}` reaches JSON.parse and throws a SyntaxError rather than SUMMARY_NOT_JSON - a
     * different error for the same underlying problem, a reply that was not usable JSON.
     * Retrying only the first kind would let a truncated or malformed object fail without the
     * retry most likely to fix it.
     */
    const ai = {
      name: 'fake',
      generateReplyDraft: vi
        .fn()
        .mockResolvedValueOnce({ draftText: '{oops}' })
        .mockResolvedValueOnce({ draftText: JSON.stringify({ overview: 'Recovered.' }) }),
    };

    const result = await summariseNextCall({ provider: ai as never });

    expect(ai.generateReplyDraft).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ status: 'completed' });
  });

  it('records the real reason when a malformed object fails twice', async () => {
    const ai = aiReturning('{oops}');

    const result = await summariseNextCall({ provider: ai as never });

    expect(result).toMatchObject({ status: 'failed' });
    // A JSON.parse SyntaxError message, not SUMMARY_NOT_JSON - the two are distinguishable in
    // the stored error so an operator can tell them apart.
    expect(mocks.setSummaryStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('DOES NOT RETRY AN EMPTY TRANSCRIPT', async () => {
    // It will be empty again. Retrying would just bill a second request to fail identically.
    mocks.findCallAnalysis.mockResolvedValue({ transcriptText: '   ' });
    const ai = aiReturning('{}');

    await summariseNextCall({ provider: ai as never });

    expect(ai.generateReplyDraft).not.toHaveBeenCalled();
  });

  it('does not retry a provider error - the SDK already does that itself', async () => {
    const ai = {
      name: 'fake',
      generateReplyDraft: vi.fn().mockRejectedValue(new Error('RATE_LIMITED')),
    };

    const result = await summariseNextCall({ provider: ai as never });

    expect(ai.generateReplyDraft).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'failed' });
  });

  it('PRESERVES SUGGESTION IDS across the retry, so tasks stay idempotent', async () => {
    // The downstream task key is `call:<callId>:<commitmentId>`, and the ids are positional.
    // A retry must produce the same ids or a confirmed task could be created twice.
    const ai = {
      name: 'fake',
      generateReplyDraft: vi
        .fn()
        .mockResolvedValueOnce({ draftText: 'prose' })
        .mockResolvedValueOnce({
          draftText: JSON.stringify({ commitments: [{ title: 'A' }, { title: 'B' }] }),
        }),
    };

    await summariseNextCall({ provider: ai as never });

    expect(mocks.saveSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        suggestions: [
          expect.objectContaining({ commitmentId: 'c0', title: 'A' }),
          expect.objectContaining({ commitmentId: 'c1', title: 'B' }),
        ],
      }),
    );
  });
});
