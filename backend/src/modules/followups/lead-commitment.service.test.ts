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

  const service = createLeadCommitmentService({
    aiBrainClient: { classifyCommitment } as never,
    getOwnerActor: getOwnerActor as never,
    createFollowUpTask: createFollowUpTask as never,
    findTasksByConversation: findTasksByConversation as never,
    rescheduleReminder: rescheduleReminder as never,
    now: () => NOW,
    logger: { info: vi.fn(), error: vi.fn() },
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
    classifyCommitment,
    getOwnerActor,
    createFollowUpTask,
    findTasksByConversation,
    rescheduleReminder,
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
    await expect(h.run('contact me tomorrow at 5 pm')).resolves.toEqual({
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
