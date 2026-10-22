/**
 * Reading a rejection, and - far more often - refusing to.
 *
 * THE ASYMMETRY RUNS THROUGH EVERY CASE HERE. A missed rejection costs one more follow-up that
 * the lead ignores. A FALSE rejection silently ends a live deal: the AI goes quiet, both sweeps
 * skip the thread, and nobody finds out until the enquiry is dead. So most of this file is
 * about hesitation, price objections and half-answers NOT closing a lead out.
 *
 * The classifier itself is a language model and is faked throughout - these do not prove the
 * model judges "I'll think about it" correctly. (The prompt contract for that is pinned in
 * ai-brain-service/tests/test_rejection.py.) What they pin is everything around it: the
 * ordering against the opt-out path, the confidence floor, stickiness, and that a failure
 * leaves the lead active.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const { createSalesRejectionService } = await import('./sales-rejection.service.js');
const { MIN_SALES_REJECTION_CONFIDENCE } = await import('../../constants/sales-rejection.js');

const organizationId = 'org-1';
const conversationId = 'conv-1';

/** The model's verdict. Defaults to a confident rejection; tests weaken it as needed. */
const verdict = (overrides: Record<string, unknown> = {}) => ({
  verdict: 'firm_rejection',
  quote: 'we have booked another photographer',
  confidence: 0.95,
  ...overrides,
});

const createHarness = () => {
  const classifyRejection = vi.fn(async (_p?: Record<string, unknown>) => verdict());
  const markSalesRejected = vi.fn(async (_p?: Record<string, unknown>) => ({ _id: conversationId }));
  const createActivity = vi.fn(async (_p?: Record<string, unknown>) => undefined);
  const logger = { info: vi.fn(), error: vi.fn() };

  const service = createSalesRejectionService({
    aiBrainClient: { classifyRejection } as never,
    markSalesRejected: markSalesRejected as never,
    createActivity: createActivity as never,
    logger,
  });

  const run = (text: string, extra: Record<string, unknown> = {}) =>
    service.detectSalesRejection({
      organizationId,
      whatsappAccountId: 'account-1',
      conversationId,
      text,
      ...extra,
    });

  return { run, service, classifyRejection, markSalesRejected, createActivity, logger };
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('a firm rejection', () => {
  it('stops automated follow-ups for "we booked another photographer"', async () => {
    const h = createHarness();

    const result = await h.run('We have booked another photographer');

    expect(result).toEqual({ rejected: true });
    expect(h.markSalesRejected).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId, conversationId, source: 'ai_classifier' }),
    );
  });

  it('records the lead’s own words, so the owner can see what was read as a no', async () => {
    const h = createHarness();

    await h.run('We have booked another photographer');

    expect(h.markSalesRejected).toHaveBeenCalledWith(
      expect.objectContaining({ quote: 'we have booked another photographer' }),
    );
  });

  it('falls back to the message when the model returns no quote', async () => {
    const h = createHarness();
    h.classifyRejection.mockResolvedValue(verdict({ quote: '' }));

    await h.run('We selected another vendor');

    expect(h.markSalesRejected).toHaveBeenCalledWith(
      expect.objectContaining({ quote: 'We selected another vendor' }),
    );
  });

  it('writes a timeline entry distinct from an opt-out', async () => {
    const h = createHarness();

    await h.run('We don’t need this service anymore');

    expect(h.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'ai_brain.sales_rejection_detected' }),
    );
  });
});

describe('hesitation is NOT rejection', () => {
  // The model is told to return `none` for all of these; what this block pins is that a `none`
  // verdict writes absolutely nothing, whatever else is going on.
  const stillDeciding = [
    'I will confirm tomorrow',
    'Let me discuss with my family',
    'I will think about it',
    'Your price is high',
    'Maybe later',
    'I am busy right now',
  ];

  for (const message of stillDeciding) {
    it(`leaves the lead active for "${message}"`, async () => {
      const h = createHarness();
      h.classifyRejection.mockResolvedValue({ verdict: 'none', quote: '', confidence: 0 });

      const result = await h.run(message);

      expect(result).toEqual({ rejected: false, reason: 'no_rejection' });
      expect(h.markSalesRejected).not.toHaveBeenCalled();
      expect(h.createActivity).not.toHaveBeenCalled();
    });
  }

  it('a price objection does not stop follow-ups even if the model sounds sure', async () => {
    // Belt and braces: `none` means none, and a high confidence attached to it must not be
    // read as high confidence in a rejection.
    const h = createHarness();
    h.classifyRejection.mockResolvedValue({ verdict: 'none', quote: '', confidence: 0.99 });

    const result = await h.run('Your price is too high for us');

    expect(result.rejected).toBe(false);
    expect(h.markSalesRejected).not.toHaveBeenCalled();
  });
});

describe('failing safely', () => {
  it('does nothing when the model is not sure enough', async () => {
    const h = createHarness();
    h.classifyRejection.mockResolvedValue(
      verdict({ confidence: MIN_SALES_REJECTION_CONFIDENCE - 0.01 }),
    );

    const result = await h.run('I think we are going a different way, maybe');

    expect(result).toEqual({ rejected: false, reason: 'low_confidence' });
    expect(h.markSalesRejected).not.toHaveBeenCalled();
  });

  it('acts exactly at the threshold, not a hair under', async () => {
    const h = createHarness();
    h.classifyRejection.mockResolvedValue(
      verdict({ confidence: MIN_SALES_REJECTION_CONFIDENCE }),
    );

    expect((await h.run('We went with someone else')).rejected).toBe(true);
  });

  it('holds the bar HIGHER than the commitment classifier’s', async () => {
    // 0.6 is good enough to create a reminder on the owner's own list. It is not good enough to
    // close a lead out. If these are ever levelled, this test is the argument.
    expect(MIN_SALES_REJECTION_CONFIDENCE).toBeGreaterThan(0.6);
  });

  it('leaves the lead active when the classifier throws', async () => {
    const h = createHarness();
    h.classifyRejection.mockRejectedValue(new Error('ai-brain unreachable'));

    const result = await h.run('We have booked another photographer');

    expect(result).toEqual({ rejected: false, reason: 'classifier_failed' });
    expect(h.markSalesRejected).not.toHaveBeenCalled();
  });

  it('leaves the lead active when an unreadable verdict comes back', async () => {
    const h = createHarness();
    h.classifyRejection.mockResolvedValue({ verdict: 'maybe' } as never);

    expect((await h.run('hmm')).rejected).toBe(false);
  });

  it('NEVER THROWS, so the sales agent still runs after it', async () => {
    // The contract that matters most in the burst flush: this runs between reminder extraction
    // and the AI reply, and an exception here would take the lead's answer down with it.
    const h = createHarness();
    h.markSalesRejected.mockRejectedValue(new Error('mongo blew up'));

    await expect(h.run('We have booked another photographer')).resolves.toEqual({
      rejected: false,
      reason: 'classifier_failed',
    });
  });

  it('does nothing for an empty message', async () => {
    const h = createHarness();

    expect(await h.run('   ')).toEqual({ rejected: false, reason: 'empty' });
    expect(h.classifyRejection).not.toHaveBeenCalled();
  });
});

describe('the opt-out path outranks it', () => {
  it('does not even call the model when the lead asked us to stop', async () => {
    // THE RULE THAT KEEPS A GUESS OFF AN EXPLICIT INSTRUCTION. "Stop messaging me" is already
    // handled deterministically, completely, with its own owner alert. A second opinion here
    // could only add a conflicting record.
    const h = createHarness();

    const result = await h.run('Please stop messaging me', { optedOut: true });

    expect(result).toEqual({ rejected: false, reason: 'opted_out' });
    expect(h.classifyRejection).not.toHaveBeenCalled();
    expect(h.markSalesRejected).not.toHaveBeenCalled();
  });

  it('never sets the opt-out flag itself', async () => {
    // Two mechanisms, ordered, not merged. A service rejection must not trigger the opt-out
    // confirmation flow the customer never asked for.
    const h = createHarness();

    await h.run('We have booked another photographer');

    const written = h.markSalesRejected.mock.calls[0]?.[0] as Record<string, unknown>;

    expect(written).not.toHaveProperty('optedOutAt');
  });
});

describe('stickiness', () => {
  it('does not re-decide a lead that already rejected us', async () => {
    const h = createHarness();

    const result = await h.run('ok thanks', { alreadyRejected: true });

    expect(result).toEqual({ rejected: false, reason: 'already_rejected' });
    expect(h.classifyRejection).not.toHaveBeenCalled();
  });

  it('treats a refused write as "already rejected", not as an error', async () => {
    // The repository refuses to overwrite an existing rejection and returns null. Two workers
    // on the same burst both reach here; only one writes an activity row.
    const h = createHarness();
    h.markSalesRejected.mockResolvedValue(null as never);

    const result = await h.run('We have booked another photographer');

    expect(result).toEqual({ rejected: false, reason: 'already_rejected' });
    expect(h.createActivity).not.toHaveBeenCalled();
  });

  it('has no path at all from a "none" verdict to reviving a lead', async () => {
    // A later routine message must never reactivate follow-ups. The only writer this service
    // has is markSalesRejected - there is nothing here that can clear anything.
    const h = createHarness();
    h.classifyRejection.mockResolvedValue({ verdict: 'none', quote: '', confidence: 0 });

    await h.run('hi, are you there?', { alreadyRejected: true });

    expect(h.markSalesRejected).not.toHaveBeenCalled();
  });
});

describe('logging', () => {
  it('keeps the lead’s words and phone number out of the logs', async () => {
    const h = createHarness();
    h.classifyRejection.mockRejectedValue(new Error('boom'));

    await h.run('call me on 9876543210, we booked someone else');

    const logged = JSON.stringify([...h.logger.error.mock.calls, ...h.logger.info.mock.calls]);

    expect(logged).toContain('conv-1');
    expect(logged).not.toContain('9876543210');
    expect(logged).not.toContain('booked someone else');
  });
});
