/**
 * Turning an AI suggestion into a real follow-up, or refusing to.
 *
 * THE ASYMMETRY THAT SHAPES ALL OF THIS: a suggestion the agent ignores costs a glance, while a
 * task created automatically is a reminder that will RING, on a real customer's lead, about
 * something a transcript may have misheard. So nothing here creates a task without a human
 * pressing confirm, and nothing invents a due date on the model's behalf.
 *
 * AND CONFIRMING TWICE MUST PRODUCE ONE TASK. Three independent things protect that: the
 * suggestion must still be `suggested`, the idempotency key is deterministic, and the follow-up
 * collection has a sparse unique index on it. The tests below cover the first two; the third is
 * the database's and is already pinned in followup-task.repository.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const mocks = vi.hoisted(() => ({
  getCallForActor: vi.fn(),
  findCallAnalysis: vi.fn(),
  decideSuggestion: vi.fn(),
  createFollowUpTask: vi.fn(),
  findFollowUpTaskByIdempotencyKey: vi.fn(),
}));

vi.mock('./call-record.service.js', () => ({ getCallForActor: mocks.getCallForActor }));

vi.mock('./call-analysis.repository.js', () => ({
  findCallAnalysis: mocks.findCallAnalysis,
  decideSuggestion: mocks.decideSuggestion,
}));

vi.mock('../followups/followup-task.repository.js', () => ({
  createFollowUpTask: mocks.createFollowUpTask,
  findFollowUpTaskByIdempotencyKey: mocks.findFollowUpTaskByIdempotencyKey,
}));

const {
  buildCommitmentIdempotencyKey,
  confirmSuggestionForActor,
  dismissSuggestionForActor,
} = await import('./call-suggestion.service.js');

const ORG = '6ab4c2037469f65204cfe999';
const CONVERSATION = '68f1a2b3c4d5e6f708192a3b';
const ACCOUNT = '6ab4c2037469f65204cfe222';
const CALL = '6adf2dd59f91cdd63f09e0f3';
const TASK = '6adf2dd59f91cdd63f09e0ff';
const ACTOR_ID = '6ab4c2037469f65204cfe111';
const actor = { _id: ACTOR_ID } as never;
const FUTURE = new Date('2026-11-06T10:00:00.000Z');

const base = {
  organizationId: ORG,
  callId: CALL,
  actor,
  permissions: [] as never,
  commitmentId: 'c0',
};

const suggestion = (overrides: Record<string, unknown> = {}) => ({
  commitmentId: 'c0',
  title: 'Send the package PDF',
  evidence: 'send me the packages',
  dueAt: null,
  status: 'suggested',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCallForActor.mockResolvedValue({
    _id: CALL,
    organizationId: ORG,
    conversationId: CONVERSATION,
    whatsappAccountId: ACCOUNT,
  });
  mocks.findCallAnalysis.mockResolvedValue({ suggestions: [suggestion()] });
  mocks.findFollowUpTaskByIdempotencyKey.mockResolvedValue(null);
  mocks.createFollowUpTask.mockResolvedValue({ _id: TASK, title: 'Send the package PDF' });
  mocks.decideSuggestion.mockResolvedValue({ suggestions: [] });
});

describe('the idempotency key', () => {
  it('is deterministic from the call and the commitment', () => {
    expect(buildCommitmentIdempotencyKey(CALL, 'c0')).toBe(`call:${CALL}:c0`);
    expect(buildCommitmentIdempotencyKey(CALL, 'c0')).toBe(buildCommitmentIdempotencyKey(CALL, 'c0'));
  });

  it('differs per commitment, so two suggestions are two tasks', () => {
    expect(buildCommitmentIdempotencyKey(CALL, 'c0')).not.toBe(
      buildCommitmentIdempotencyKey(CALL, 'c1'),
    );
  });
});

describe('confirming', () => {
  it('REFUSES WITHOUT A DATE rather than inventing one', async () => {
    // The model is forbidden from guessing a due date and this will not guess on its behalf.
    // A reminder for the wrong day is worse than one the agent had to think about.
    await expect(confirmSuggestionForActor(base)).rejects.toThrow('SUGGESTION_NEEDS_DUE_DATE');
    expect(mocks.createFollowUpTask).not.toHaveBeenCalled();
  });

  it('uses the date the agent supplied', async () => {
    await confirmSuggestionForActor({ ...base, dueAt: FUTURE });

    expect(mocks.createFollowUpTask).toHaveBeenCalledWith(
      expect.objectContaining({ dueAt: FUTURE, title: 'Send the package PDF' }),
    );
  });

  it('uses the transcript’s date when there was one', async () => {
    mocks.findCallAnalysis.mockResolvedValue({ suggestions: [suggestion({ dueAt: FUTURE })] });

    await confirmSuggestionForActor(base);

    expect(mocks.createFollowUpTask).toHaveBeenCalledWith(
      expect.objectContaining({ dueAt: FUTURE }),
    );
  });

  it('ASSIGNS THE TASK TO THE AGENT WHO CONFIRMED IT', async () => {
    // Never the model's idea of an owner - it has none, and picking somebody else's name out
    // of a transcript would be a guess with somebody else's workload attached.
    await confirmSuggestionForActor({ ...base, dueAt: FUTURE });

    expect(mocks.createFollowUpTask).toHaveBeenCalledWith(
      expect.objectContaining({ assignedTo: ACTOR_ID, createdBy: ACTOR_ID }),
    );
  });

  it('carries the customer’s own words onto the reminder', async () => {
    await confirmSuggestionForActor({ ...base, dueAt: FUTURE });

    expect(mocks.createFollowUpTask).toHaveBeenCalledWith(
      expect.objectContaining({ sourceQuote: 'send me the packages' }),
    );
  });

  it('files it under the call’s lead and organisation', async () => {
    await confirmSuggestionForActor({ ...base, dueAt: FUTURE });

    expect(mocks.createFollowUpTask).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, conversationId: CONVERSATION }),
    );
  });

  it('REUSES AN EXISTING TASK rather than creating a second one', async () => {
    // The retry path: the key already produced a task, so this returns it instead of racing
    // the unique index and surfacing an E11000 as "something went wrong".
    mocks.findFollowUpTaskByIdempotencyKey.mockResolvedValue({ _id: TASK, title: 'Send the package PDF' });

    await confirmSuggestionForActor({ ...base, dueAt: FUTURE });

    expect(mocks.createFollowUpTask).not.toHaveBeenCalled();
    expect(mocks.decideSuggestion).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'confirmed', taskId: TASK }),
    );
  });

  it('REFUSES A SUGGESTION THAT IS ALREADY DECIDED', async () => {
    // The double-tap guard. Without it the second press creates a second reminder for the same
    // promise, and the customer gets chased twice.
    mocks.findCallAnalysis.mockResolvedValue({
      suggestions: [suggestion({ status: 'confirmed' })],
    });

    await expect(confirmSuggestionForActor({ ...base, dueAt: FUTURE })).rejects.toThrow(
      'SUGGESTION_NOT_FOUND',
    );
    expect(mocks.createFollowUpTask).not.toHaveBeenCalled();
  });

  it('refuses a commitment id that does not exist', async () => {
    await expect(
      confirmSuggestionForActor({ ...base, commitmentId: 'c9', dueAt: FUTURE }),
    ).rejects.toThrow('SUGGESTION_NOT_FOUND');
  });

  it('applies the conversation gate before anything else', async () => {
    mocks.getCallForActor.mockRejectedValue(new Error('CONVERSATION_ACCESS_DENIED'));

    await expect(confirmSuggestionForActor({ ...base, dueAt: FUTURE })).rejects.toThrow(
      'CONVERSATION_ACCESS_DENIED',
    );
    expect(mocks.findCallAnalysis).not.toHaveBeenCalled();
    expect(mocks.createFollowUpTask).not.toHaveBeenCalled();
  });

  it('refuses a call from another organisation', async () => {
    mocks.getCallForActor.mockRejectedValue(new Error('CALL_NOT_FOUND'));

    await expect(confirmSuggestionForActor({ ...base, dueAt: FUTURE })).rejects.toThrow(
      'CALL_NOT_FOUND',
    );
  });
});

describe('dismissing', () => {
  it('CREATES NOTHING', async () => {
    await dismissSuggestionForActor(base);

    expect(mocks.createFollowUpTask).not.toHaveBeenCalled();
    expect(mocks.decideSuggestion).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'dismissed', commitmentId: 'c0' }),
    );
  });

  it('refuses one that is no longer open', async () => {
    // `decideSuggestion` matches only a `suggested` row, so a second dismiss returns null.
    mocks.decideSuggestion.mockResolvedValue(null);

    await expect(dismissSuggestionForActor(base)).rejects.toThrow('SUGGESTION_NOT_FOUND');
  });

  it('applies the same authorisation as confirming', async () => {
    mocks.getCallForActor.mockRejectedValue(new Error('CONVERSATION_ACCESS_DENIED'));

    await expect(dismissSuggestionForActor(base)).rejects.toThrow('CONVERSATION_ACCESS_DENIED');
    expect(mocks.decideSuggestion).not.toHaveBeenCalled();
  });
});
