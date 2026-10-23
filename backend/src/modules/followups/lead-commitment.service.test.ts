/**
 * Reading "contact me tomorrow at 5" out of a lead's message.
 *
 * The model is faked throughout, so nothing here proves its judgement - that is a smoke-test
 * question. What IS proven is everything around it, which is where the expensive mistakes live:
 *
 *  - a commitment with no usable time creates NOTHING, rather than a reminder at an invented
 *    hour. This is the single most important assertion in the file;
 *  - an uncertain verdict creates nothing, because a reminder for every future-tense sentence
 *    teaches the owner to ignore reminders;
 *  - a lead who moves the time MOVES the reminder instead of getting a second one;
 *  - an opted-out lead produces nothing at all;
 *  - nothing here can enqueue a message, resume automation, or throw into ingestion.
 *
 * Manual takeover is not asserted here but in the ingestion tests, because the property is
 * structural: this service is called from the burst flush, beside `handleAutomation` rather
 * than inside it, so the automation flag it checks is never consulted.
 *
 * Clock fixed at 2026-10-11T06:30:00Z = 12:00 noon IST.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', WHATSAPP_BUSINESS_TIMEZONE: 'Asia/Kolkata' },
}));

const { createLeadCommitmentService } = await import('./lead-commitment.service.js');

const NOW = new Date('2026-10-11T06:30:00.000Z');
const organizationId = 'org-1';
const conversationId = 'conv-1';

const verdict = (overrides: Record<string, unknown> = {}) => ({
  action: 'contact_lead',
  when: 'tomorrow at 5 pm',
  task: 'Call Rahul back',
  quote: 'contact me tomorrow at 5',
  confidence: 0.9,
  ...overrides,
});

const createHarness = ({ existing = [] }: { existing?: Record<string, unknown>[] } = {}) => {
  const classifyCommitment = vi.fn(async (_p?: Record<string, unknown>) => verdict());
  const getOwnerActor = vi.fn(async (_p?: Record<string, unknown>) => ({
    actor: { _id: 'owner-1' },
    permissions: [],
  }));
  const createFollowUpTask = vi.fn(async (p: Record<string, unknown>) => ({ _id: 'task-new', ...p }));
  const findTasksByConversation = vi.fn(async (_p?: Record<string, unknown>) => existing);
  const rescheduleReminder = vi.fn(async (_p?: Record<string, unknown>) => null);
  // Injected for the same reason as enqueueCommitmentRetry below: uninjected, the real
  // repository reaches the Mongoose model, and recordPromise would swallow the resulting error
  // into a log line instead of the test seeing it.
  const setPromisedFollowUp = vi.fn(async (_p?: Record<string, unknown>) => null);
  const logger = { info: vi.fn(), error: vi.fn() };
  // Injected, or a transient failure reaches the real Mongoose model and logs a second error.
  const enqueueCommitmentRetry = vi.fn(async (_p?: Record<string, unknown>) => null);

  const service = createLeadCommitmentService({
    aiBrainClient: { classifyCommitment } as never,
    getOwnerActor: getOwnerActor as never,
    createFollowUpTask: createFollowUpTask as never,
    findTasksByConversation: findTasksByConversation as never,
    rescheduleReminder: rescheduleReminder as never,
    setPromisedFollowUp: setPromisedFollowUp as never,
    enqueueCommitmentRetry: enqueueCommitmentRetry as never,
    now: () => NOW,
    logger,
  });

  const run = (text: string, extra: Record<string, unknown> = {}) =>
    service.extractLeadCommitment({
      organizationId,
      whatsappAccountId: 'account-1',
      conversationId,
      text,
      messageId: 'msg-1',
      ...extra,
    });

  return {
    run,
    service,
    logger,
    enqueueCommitmentRetry,
    classifyCommitment,
    getOwnerActor,
    createFollowUpTask,
    findTasksByConversation,
    rescheduleReminder,
    setPromisedFollowUp,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('creating a reminder from a commitment', () => {
  it('creates one linked to the lead and conversation', async () => {
    const h = createHarness();

    const result = await h.run('contact me tomorrow at 5 pm');

    expect(result).toEqual({ created: true, updated: false });
    expect(h.createFollowUpTask).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId,
        conversationId,
        whatsappAccountId: 'account-1',
        assignedTo: 'owner-1',
        source: 'lead_commitment',
        title: 'Call Rahul back',
      }),
    );
  });

  it('resolves the phrase the model returned into an instant, in the business timezone', async () => {
    const h = createHarness();

    await h.run('contact me tomorrow at 5 pm');

    const [[params]] = h.createFollowUpTask.mock.calls;
    // 17:00 IST on 12 Oct 2026 = 11:30Z. The model never saw a date - it returned a phrase.
    expect((params.dueAt as Date).toISOString()).toBe('2026-10-12T11:30:00.000Z');
  });

  it('keeps the lead\'s own words, so the owner can see why', async () => {
    const h = createHarness();

    await h.run('contact me tomorrow at 5 pm');

    expect(h.createFollowUpTask).toHaveBeenCalledWith(
      expect.objectContaining({ sourceQuote: 'contact me tomorrow at 5' }),
    );
  });

  it('handles "call me in 30 minutes"', async () => {
    const h = createHarness();
    h.classifyCommitment.mockResolvedValue(verdict({ when: 'in 30 minutes' }));

    await h.run('call me in 30 minutes');

    const [[params]] = h.createFollowUpTask.mock.calls;
    expect((params.dueAt as Date).toISOString()).toBe('2026-10-11T07:00:00.000Z');
  });

  it('creates a check-back task when the LEAD owes something', async () => {
    const h = createHarness();
    h.classifyCommitment.mockResolvedValue(
      verdict({ action: 'await_lead', task: 'Check if Rahul sent the documents' }),
    );

    await h.run("I'll send the details tomorrow at 5 pm");

    expect(h.createFollowUpTask).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Check if Rahul sent the documents' }),
    );
  });
});

describe('refusing to invent a time', () => {
  it.each([
    ['no time at all', ''],
    ['a vague daypart', 'this evening'],
    ['a bare day', 'tomorrow'],
    ['an unparseable phrase', 'sometime soon'],
  ])('creates nothing when the phrase is %s', async (_label, when) => {
    const h = createHarness();
    h.classifyCommitment.mockResolvedValue(verdict({ when }));

    const result = await h.run("I'll get back to you");

    // THE ASSERTION THAT MATTERS. A reminder at an hour nobody chose is worse than no
    // reminder - the message is still sitting in the inbox for a human to read.
    expect(result.created).toBe(false);
    expect(h.createFollowUpTask).not.toHaveBeenCalled();
  });
});

describe('not every future-tense sentence', () => {
  it('creates nothing when the model says none', async () => {
    const h = createHarness();
    h.classifyCommitment.mockResolvedValue(verdict({ action: 'none' }));

    const result = await h.run('I contacted you yesterday');

    expect(result.created).toBe(false);
    expect(h.createFollowUpTask).not.toHaveBeenCalled();
  });

  it('creates nothing when the model is unsure', async () => {
    const h = createHarness();
    h.classifyCommitment.mockResolvedValue(verdict({ confidence: 0.4 }));

    await h.run('we might connect someday');

    // Below the threshold the model is guessing, and a wrong reminder costs more than a
    // missed one.
    expect(h.createFollowUpTask).not.toHaveBeenCalled();
  });

  it('does not even ask about an empty turn', async () => {
    const h = createHarness();

    await h.run('   ');

    expect(h.classifyCommitment).not.toHaveBeenCalled();
  });
});

describe('a changed commitment moves the reminder', () => {
  const existing = [
    {
      _id: 'task-old',
      source: 'lead_commitment',
      dueAt: new Date('2026-10-12T11:30:00.000Z'),
    },
  ];

  it('reschedules rather than creating a second one', async () => {
    const h = createHarness({ existing });
    h.classifyCommitment.mockResolvedValue(verdict({ when: 'tomorrow at 6 pm' }));

    const result = await h.run('actually make it 6');

    expect(result).toEqual({ created: false, updated: true });
    expect(h.createFollowUpTask).not.toHaveBeenCalled();
    // rescheduleReminder, because only that clears lastNotificationAt and bumps the version -
    // otherwise the reminder never fires again and the handset keeps the old alarm.
    expect(h.rescheduleReminder).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-old' }),
    );
  });

  it('creates a separate reminder for a commitment days away', async () => {
    const h = createHarness({ existing });
    // Friday, not Monday: NOW is a Sunday, so "next monday" is tomorrow and would fall INSIDE
    // the 24-hour correction window - which is correct behaviour, just not this test's point.
    h.classifyCommitment.mockResolvedValue(verdict({ when: 'next friday at 11 am' }));

    const result = await h.run('and let us also talk next friday at 11');

    // Outside the correction window, so it is a new commitment rather than a changed one.
    expect(result.created).toBe(true);
  });

  it('ignores a manually-created task when looking for one to supersede', async () => {
    const h = createHarness({
      existing: [{ _id: 'task-manual', source: 'manual', dueAt: new Date('2026-10-12T11:30:00.000Z') }],
    });

    const result = await h.run('contact me tomorrow at 5 pm');

    // A follow-up a human typed is theirs; an extracted one must not quietly move it.
    expect(result.created).toBe(true);
    expect(h.rescheduleReminder).not.toHaveBeenCalled();
  });
});

describe('safety', () => {
  it('creates nothing for a lead who opted out', async () => {
    const h = createHarness();

    const result = await h.run('contact me tomorrow at 5 pm', { optedOut: true });

    expect(result.created).toBe(false);
    expect(h.classifyCommitment).not.toHaveBeenCalled();
  });

  it('keys on the message id, so a replayed webhook cannot duplicate', async () => {
    const h = createHarness();

    await h.run('contact me tomorrow at 5 pm', { messageId: 'wamid-xyz' });

    expect(h.createFollowUpTask).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'lead-commit:wamid-xyz' }),
    );
  });

  it('treats a duplicate-key collision as already handled', async () => {
    const h = createHarness();
    h.createFollowUpTask.mockRejectedValue(Object.assign(new Error('dup'), { code: 11000 }));

    await expect(h.run('contact me tomorrow at 5 pm')).resolves.toEqual({
      created: false,
      updated: false,
    });
  });

  it('never throws into ingestion when the classifier is down', async () => {
    const h = createHarness();
    h.classifyCommitment.mockRejectedValue(new Error('ETIMEDOUT'));

    // A classifier outage must not cost the lead their message or stall the pipeline.
    await expect(h.run('contact me tomorrow at 5 pm')).resolves.toMatchObject({
      created: false,
      updated: false,
    });
  });

  it('creates nothing when the organisation has no owner user', async () => {
    const h = createHarness();
    h.getOwnerActor.mockResolvedValue(null as never);

    const result = await h.run('contact me tomorrow at 5 pm');

    expect(result.created).toBe(false);
    expect(h.createFollowUpTask).not.toHaveBeenCalled();
  });
});

describe('PRODUCTION: the classifier timing out', () => {
  /**
   * The real shape, from the production log:
   *
   *   {"level":"error","code":20,"name":"AbortError",
   *    "msg":"Lead commitment extraction failed safely; no reminder was created."}
   *
   * `classifyCommitment` is called with AI_BRAIN_INTENT_TIMEOUT_MS (8s by default), and
   * ai-brain.client.ts aborts the fetch on that timer. An aborted fetch rejects with a
   * DOMException named AbortError whose `code` is 20 - which is exactly what was logged, so
   * this is a timeout on /v1/commitment rather than a crash anywhere in this file.
   */
  const abortError = () => {
    const error = new Error('This operation was aborted');
    Object.assign(error, { name: 'AbortError', code: 20 });

    return error;
  };

  it('creates no reminder and does not throw into ingestion', async () => {
    const h = createHarness();
    h.classifyCommitment.mockRejectedValue(abortError());

    await expect(h.run('I will message you after 5 min')).resolves.toMatchObject({
      created: false,
      updated: false,
    });
    expect(h.createFollowUpTask).not.toHaveBeenCalled();
  });

  it('QUEUES the turn durably instead of losing it', async () => {
    const h = createHarness();
    h.classifyCommitment.mockRejectedValue(abortError());

    const outcome = await h.run('I will message you after 5 min');

    // This used to be the end of the road - the turn was gone, the burst window had closed,
    // and the reminder the customer implicitly asked for never existed. Now the turn is
    // written to a row that survives a restart, keyed on the same message id the reminder's
    // idempotency key is built from.
    expect(h.createFollowUpTask).not.toHaveBeenCalled();
    expect(outcome.retryable).toBe(true);
    expect(h.enqueueCommitmentRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'msg-1',
        text: 'I will message you after 5 min',
        conversationId,
      }),
    );
  });

  it('does NOT queue a retry for a failure that will not change', async () => {
    const h = createHarness();
    // A 400 from the service: malformed input, or a rejected key. Asking again next minute
    // fails identically, and a queue that retries those spends money to stay wrong.
    h.classifyCommitment.mockRejectedValue(
      Object.assign(new Error('bad request'), { name: 'AiBrainRequestError', statusCode: 400 }),
    );

    const outcome = await h.run('I will message you after 5 min');

    expect(outcome.retryable).toBe(false);
    expect(h.enqueueCommitmentRetry).not.toHaveBeenCalled();
  });

  it('does not queue anything when the model simply found no commitment', async () => {
    const h = createHarness();
    h.classifyCommitment.mockResolvedValue(verdict({ action: 'none' }) as never);

    await h.run('what are your rates');

    // A successful classification is an answer. Retrying it is an LLM call to be told the
    // same thing.
    expect(h.enqueueCommitmentRetry).not.toHaveBeenCalled();
  });

  it('does not queue a below-confidence result either', async () => {
    const h = createHarness();
    h.classifyCommitment.mockResolvedValue(
      verdict({ action: 'contact_lead', confidence: 0.1 }) as never,
    );

    await h.run('maybe I will call you tomorrow at 5 pm');

    expect(h.enqueueCommitmentRetry).not.toHaveBeenCalled();
  });

  it('survives the retry queue itself being unavailable', async () => {
    const h = createHarness();
    h.classifyCommitment.mockRejectedValue(abortError());
    h.enqueueCommitmentRetry.mockRejectedValue(new Error('mongo down'));

    // Even the recovery mechanism is best-effort. Ingestion must not break because the thing
    // meant to rescue a commitment could not be written.
    await expect(h.run('I will message you after 5 min')).resolves.toMatchObject({
      created: false,
    });
  });

  it('logs the failure without the customer\'s message in it', async () => {
    const h = createHarness();
    h.classifyCommitment.mockRejectedValue(abortError());

    await h.run('I will message you after 5 min on 9876543210');

    const logged = JSON.stringify([h.logger.error.mock.calls, h.logger.info.mock.calls]);

    expect(logged).toContain('AbortError');
    // Logs are shipped and retained; the lead's words and number are not theirs to keep.
    expect(logged).not.toContain('9876543210');
    expect(logged).not.toContain('I will message you');
  });

  it('is distinguishable in the log from the model simply finding nothing', async () => {
    const timedOut = createHarness();
    timedOut.classifyCommitment.mockRejectedValue(abortError());
    await timedOut.run('I will message you after 5 min');

    const foundNothing = createHarness();
    foundNothing.classifyCommitment.mockResolvedValue(verdict({ action: 'none' }) as never);
    await foundNothing.run('what are your rates');

    // THE OBSERVABILITY GAP THIS CLOSED. Both outcomes create no reminder. Before, only the
    // first said anything, so "no reminder appeared" could not be diagnosed from the logs -
    // a slow classifier and a model that saw no commitment looked identical.
    expect(timedOut.logger.error).toHaveBeenCalledTimes(1);
    expect(foundNothing.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'none' }),
      expect.stringContaining('no commitment in this turn'),
    );
  });
});

describe('every extraction outcome says which one it was', () => {
  it('announces a reminder it created', async () => {
    const h = createHarness();

    await h.run('contact me tomorrow at 5 pm');

    expect(h.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ action: expect.any(String) }),
      expect.stringContaining('reminder created from a lead commitment'),
    );
  });

  it('announces a commitment it could not time', async () => {
    const h = createHarness();
    h.classifyCommitment.mockResolvedValue(
      verdict({ action: 'contact_lead', when: 'sometime next year maybe' }) as never,
    );

    await h.run('call me sometime');

    expect(h.logger.info).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('no usable time'),
    );
  });

  it('announces a commitment below the confidence bar, with the score', async () => {
    const h = createHarness();
    h.classifyCommitment.mockResolvedValue(
      verdict({ action: 'contact_lead', confidence: 0.1 }) as never,
    );

    await h.run('maybe I will call you tomorrow at 5 pm');

    // Separate from "none" on purpose: this one is a threshold worth tuning, and the score is
    // the number you would tune it against.
    expect(h.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ confidence: 0.1 }),
      expect.stringContaining('below the confidence threshold'),
    );
  });

  it('logs no customer text on any of those paths', async () => {
    const h = createHarness();
    h.classifyCommitment.mockResolvedValue(verdict({ action: 'none' }) as never);

    await h.run('my number is 9876543210 and my budget is 2 lakhs');

    const logged = JSON.stringify(h.logger.info.mock.calls);

    expect(logged).not.toContain('9876543210');
    expect(logged).not.toContain('2 lakhs');
  });
});

/**
 * Decision 2: the lead hears from us at the promised time, and the owner still gets reminded.
 * Both halves, or the feature is either a broken promise or an owner chased twice.
 */
describe('the lead-facing half of the promise', () => {
  it('records a promised follow-up alongside the owner reminder, not instead of it', async () => {
    const h = createHarness();

    await h.run('contact me tomorrow at 5 pm');

    expect(h.createFollowUpTask).toHaveBeenCalledTimes(1);
    expect(h.setPromisedFollowUp).toHaveBeenCalledTimes(1);
  });

  it('promises it for the same instant the owner is reminded about', async () => {
    // Two different times would be two different promises, and the lead only heard one.
    const h = createHarness();

    await h.run('contact me tomorrow at 5 pm');

    const [[task]] = h.createFollowUpTask.mock.calls;
    const [[promise]] = h.setPromisedFollowUp.mock.calls;

    expect((promise as { dueAt: Date }).dueAt).toEqual((task as { dueAt: Date }).dueAt);
  });

  it('seeds the key from the message, so a replayed webhook cannot double-send', async () => {
    const h = createHarness();

    await h.run('contact me tomorrow at 5 pm');

    expect(h.setPromisedFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'lead-commit:msg-1', organizationId, conversationId }),
    );
  });

  it('records WHO owed WHOM, so the message can be worded correctly', async () => {
    const h = createHarness();
    h.classifyCommitment.mockResolvedValue(verdict({ action: 'await_lead' }));

    await h.run('I will confirm by tomorrow at 5 pm');

    expect(h.setPromisedFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({ direction: 'await_lead' }),
    );
  });

  it('carries the lead’s own words through', async () => {
    const h = createHarness();

    await h.run('contact me tomorrow at 5 pm');

    expect(h.setPromisedFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({ quote: 'contact me tomorrow at 5' }),
    );
  });

  it('moves the promise when the lead moves the time', async () => {
    // "Actually make it 6" reschedules the owner's reminder; the lead-facing half has to move
    // with it, or they are messaged at a time they already changed.
    const h = createHarness({
      existing: [
        {
          _id: 'task-old',
          source: 'lead_commitment',
          dueAt: new Date('2026-10-12T11:30:00.000Z'),
        },
      ],
    });
    h.classifyCommitment.mockResolvedValue(verdict({ when: 'tomorrow at 6 pm' }));

    const result = await h.run('actually make it 6');

    expect(result).toEqual({ created: false, updated: true });
    expect(h.setPromisedFollowUp).toHaveBeenCalledTimes(1);
    expect(h.setPromisedFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({ dueAt: new Date('2026-10-12T12:30:00.000Z') }),
    );
  });

  it('promises nothing when no reminder was created', async () => {
    const h = createHarness();
    h.classifyCommitment.mockResolvedValue(verdict({ action: 'none' }));

    await h.run('thanks, looks good');

    expect(h.setPromisedFollowUp).not.toHaveBeenCalled();
  });

  it('promises nothing to a lead who opted out', async () => {
    const h = createHarness();

    await h.run('contact me tomorrow at 5 pm', { optedOut: true });

    expect(h.setPromisedFollowUp).not.toHaveBeenCalled();
  });

  it('promises nothing when the time could not be pinned down', async () => {
    const h = createHarness();
    h.classifyCommitment.mockResolvedValue(verdict({ when: 'in the evening' }));

    await h.run('I will get back to you in the evening');

    expect(h.setPromisedFollowUp).not.toHaveBeenCalled();
  });

  it('THE OWNER REMINDER SURVIVES a failure to record the lead-facing half', async () => {
    // Ordered task-first for exactly this: the reminder is the safety net, so it must not be
    // taken down by the newer, less important write.
    const h = createHarness();
    h.setPromisedFollowUp.mockRejectedValue(new Error('mongo blew up'));

    const result = await h.run('contact me tomorrow at 5 pm');

    expect(result).toEqual({ created: true, updated: false });
    expect(h.createFollowUpTask).toHaveBeenCalledTimes(1);
  });

  it('keeps the lead’s words out of the log when that write fails', async () => {
    const h = createHarness();
    h.setPromisedFollowUp.mockRejectedValue(new Error('mongo blew up'));

    await h.run('contact me tomorrow at 5 pm on 9876543210');

    const logged = JSON.stringify(h.logger.error.mock.calls);

    expect(logged).toContain('conv-1');
    expect(logged).not.toContain('9876543210');
  });
});

/**
 * Every outcome says what it decided, exactly once.
 *
 * THE INCIDENT THIS GUARDS. On 2026-10-23 a lead moved their own reminder - "come back after 5
 * min" after an earlier "after 2 min" - and extraction handled it perfectly: the existing task
 * was rescheduled, version went to 2, and the owner was notified 3.5s after the new due time.
 * But the reschedule branch returned in SILENCE. The only line in the journal for that turn was
 * the REJECTION_CHECK that runs after it, so a working path looked exactly like extraction
 * having crashed, and two people went hunting for a bug that was not there.
 *
 * Observability is the feature being tested, so the tests are about the LOG, not the write. The
 * coverage test is the one that matters: it fails for a NEW branch added without a line, which
 * is how this recurs.
 */
describe('every outcome is logged exactly once', () => {
  /** The REMINDER_EXTRACT lines emitted, as [context, message] pairs. */
  const extractLines = (h: ReturnType<typeof createHarness>) =>
    h.logger.info.mock.calls.filter(([, msg]) => String(msg).startsWith('REMINDER_EXTRACT:'));

  it('the reschedule branch logs once, with the task it moved', async () => {
    const h = createHarness({
      existing: [
        {
          _id: 'task-old',
          source: 'lead_commitment',
          dueAt: new Date('2026-10-12T11:30:00.000Z'),
        },
      ],
    });
    h.classifyCommitment.mockResolvedValue(verdict({ when: 'tomorrow at 6 pm' }));

    const result = await h.run('actually make it 6');
    const lines = extractLines(h);

    expect(result).toEqual({ created: false, updated: true });
    expect(lines).toHaveLength(1);
    expect(lines[0]?.[1]).toBe('REMINDER_EXTRACT: commitment moved an existing reminder.');
    expect(lines[0]?.[0]).toMatchObject({
      conversationId,
      action: 'contact_lead',
      taskId: 'task-old',
    });
  });

  it('names the task that MOVED, not a new one', async () => {
    // The id is the whole point: without it the line cannot be joined to the reminder that
    // actually changed, which is the question anybody reading these logs is asking.
    const h = createHarness({
      existing: [
        { _id: 'task-abc', source: 'lead_commitment', dueAt: new Date('2026-10-12T11:30:00.000Z') },
      ],
    });
    h.classifyCommitment.mockResolvedValue(verdict({ when: 'tomorrow at 6 pm' }));

    await h.run('actually make it 6');

    expect(h.createFollowUpTask).not.toHaveBeenCalled();
    expect(extractLines(h)[0]?.[0]).toMatchObject({ taskId: 'task-abc' });
  });

  /**
   * Each outcome, the message it must emit, and how to provoke it. Table-driven so a new
   * branch is one row - and a new branch with no line fails the coverage test below.
   */
  const OUTCOMES: {
    label: string;
    message: string;
    arrange: (h: ReturnType<typeof createHarness>) => void;
    text: string;
  }[] = [
    {
      label: 'no commitment',
      message: 'REMINDER_EXTRACT: no commitment in this turn; nothing created.',
      arrange: (h) => h.classifyCommitment.mockResolvedValue(verdict({ action: 'none' })),
      text: 'thanks, looks good',
    },
    {
      label: 'below the confidence threshold',
      message: 'REMINDER_EXTRACT: commitment below the confidence threshold; nothing created.',
      arrange: (h) => h.classifyCommitment.mockResolvedValue(verdict({ confidence: 0.3 })),
      text: 'maybe call me sometime tomorrow',
    },
    {
      label: 'no usable time',
      message: 'REMINDER_EXTRACT: commitment found but no usable time; nothing created.',
      arrange: (h) => h.classifyCommitment.mockResolvedValue(verdict({ when: 'in the evening' })),
      text: 'I will get back to you in the evening',
    },
    {
      label: 'created',
      message: 'REMINDER_EXTRACT: reminder created from a lead commitment.',
      arrange: () => undefined,
      text: 'contact me tomorrow at 5 pm',
    },
  ];

  for (const outcome of OUTCOMES) {
    it(`logs exactly once for: ${outcome.label}`, async () => {
      const h = createHarness();
      outcome.arrange(h);

      await h.run(outcome.text);
      const lines = extractLines(h);

      expect(lines).toHaveLength(1);
      expect(lines[0]?.[1]).toBe(outcome.message);
    });
  }

  it('EVERY outcome branch emits a line - including reschedule', async () => {
    // THE COVERAGE TEST. The four above plus reschedule, asserted as a set: a branch added
    // later without a log makes this fail, which is the only thing that stops the silence
    // coming back somewhere else.
    const seen: string[] = [];

    for (const outcome of OUTCOMES) {
      const h = createHarness();
      outcome.arrange(h);
      await h.run(outcome.text);
      seen.push(...extractLines(h).map(([, msg]) => String(msg)));
    }

    const rescheduleHarness = createHarness({
      existing: [
        { _id: 'task-old', source: 'lead_commitment', dueAt: new Date('2026-10-12T11:30:00.000Z') },
      ],
    });
    rescheduleHarness.classifyCommitment.mockResolvedValue(verdict({ when: 'tomorrow at 6 pm' }));
    await rescheduleHarness.run('actually make it 6');
    seen.push(...extractLines(rescheduleHarness).map(([, msg]) => String(msg)));

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('logs ids and a verdict, never the lead’s words or number', async () => {
    const h = createHarness({
      existing: [
        { _id: 'task-old', source: 'lead_commitment', dueAt: new Date('2026-10-12T11:30:00.000Z') },
      ],
    });
    h.classifyCommitment.mockResolvedValue(verdict({ when: 'tomorrow at 6 pm' }));

    await h.run('actually make it 6, my number is 9876543210');

    const logged = JSON.stringify(h.logger.info.mock.calls);

    expect(logged).toContain('task-old');
    expect(logged).not.toContain('9876543210');
    expect(logged).not.toContain('actually make it 6');
  });

  it('rescheduling still moves the reminder rather than adding one', async () => {
    // The log must not have changed the behaviour it describes.
    const h = createHarness({
      existing: [
        { _id: 'task-old', source: 'lead_commitment', dueAt: new Date('2026-10-12T11:30:00.000Z') },
      ],
    });
    h.classifyCommitment.mockResolvedValue(verdict({ when: 'tomorrow at 6 pm' }));

    await h.run('actually make it 6');

    expect(h.rescheduleReminder).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-old', dueAt: new Date('2026-10-12T12:30:00.000Z') }),
    );
    expect(h.createFollowUpTask).not.toHaveBeenCalled();
  });
});
