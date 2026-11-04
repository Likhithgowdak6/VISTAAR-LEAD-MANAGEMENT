/**
 * One owner answer, three records moved - and the ways that can go wrong.
 *
 * THE TWO FAILURES WORTH MOST OF THIS FILE:
 *
 *   1. Marking somebody BOOKED because they answered the phone. Connecting a call and closing a
 *      sale are different facts, and most outcomes must move the call without touching the
 *      stage. A system that conflates them reports revenue that does not exist.
 *   2. Resuming the QUALIFYING agent on a customer who has already paid. "Resume AI" after a
 *      booking has to mean post-booking communication, never another sales pitch.
 *
 * Everything here runs against mocked repositories: no database, no WhatsApp, no reminders.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const mocks = vi.hoisted(() => ({
  loadVisibleConversationForActor: vi.fn(),
  setAiMode: vi.fn(),
  updateStage: vi.fn(),
  createActivity: vi.fn(),
  findCallRecordById: vi.fn(),
  createCallRecord: vi.fn(),
  updateCallOutcome: vi.fn(),
  findFollowUpTaskById: vi.fn(),
  rescheduleReminder: vi.fn(),
  updateTaskStatus: vi.fn(),
  syncQuietly: vi.fn(),
}));

vi.mock('../conversations/conversation.service.js', () => ({
  loadVisibleConversationForActor: mocks.loadVisibleConversationForActor,
}));

vi.mock('../conversations/conversation.repository.js', () => ({
  setAiMode: mocks.setAiMode,
  updateStage: mocks.updateStage,
}));

vi.mock('../activity/activity-log.repository.js', () => ({
  createActivity: mocks.createActivity,
}));

vi.mock('./call-record.repository.js', () => ({
  findCallRecordById: mocks.findCallRecordById,
  createCallRecord: mocks.createCallRecord,
  updateCallOutcome: mocks.updateCallOutcome,
}));

vi.mock('../followups/followup-task.repository.js', () => ({
  findFollowUpTaskById: mocks.findFollowUpTaskById,
  rescheduleReminder: mocks.rescheduleReminder,
  updateTaskStatus: mocks.updateTaskStatus,
}));

vi.mock('../followups/next-follow-up.service.js', () => ({
  getNextFollowUpSync: () => ({ syncQuietly: mocks.syncQuietly }),
}));

const { CallOutcomeError, recordCallOutcomeForActor } = await import('./call-outcome.service.js');

const ORG = '6ab4c2037469f65204cfe999';
const CONVERSATION = '68f1a2b3c4d5e6f708192a3b';
const CALL = '6adf2dd59f91cdd63f09e0f3';
const TASK = '6adf2dd59f91cdd63f09e0f4';

const actor = { _id: 'user-1' } as never;

const base = {
  organizationId: ORG,
  conversationId: CONVERSATION,
  actor,
  permissions: [] as never,
};

beforeEach(() => {
  vi.clearAllMocks();

  mocks.loadVisibleConversationForActor.mockResolvedValue({
    _id: CONVERSATION,
    whatsappAccountId: 'wa-1',
    contactId: 'ct-1',
  });
  mocks.createCallRecord.mockResolvedValue({
    _id: CALL,
    startedAt: new Date('2026-11-04T10:00:00.000Z'),
  });
  mocks.findCallRecordById.mockResolvedValue({
    _id: CALL,
    startedAt: new Date('2026-11-04T10:00:00.000Z'),
  });
  mocks.updateCallOutcome.mockResolvedValue({ _id: CALL });
  mocks.findFollowUpTaskById.mockResolvedValue({ _id: TASK });
});

describe('a call outcome is not a sale', () => {
  it('ANSWERING THE PHONE DOES NOT MOVE THE STAGE', async () => {
    // The expensive mistake. "They picked up" says nothing about whether they are buying.
    await recordCallOutcomeForActor({ ...base, outcome: 'contacted', resumeAi: true });

    expect(mocks.updateStage).not.toHaveBeenCalled();
    expect(mocks.updateCallOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('records a missed call as failed, still without touching the stage', async () => {
    await recordCallOutcomeForActor({
      ...base,
      outcome: 'not_received',
      resumeAi: false,
      callbackAt: new Date('2026-11-05T10:00:00.000Z'),
    });

    expect(mocks.updateCallOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
    expect(mocks.updateStage).not.toHaveBeenCalled();
  });

  it('treats "call me later" as a CONNECTED call', async () => {
    // They answered - they just asked for another time. Recording it as failed would lose the
    // fact that contact was made at all.
    await recordCallOutcomeForActor({
      ...base,
      outcome: 'call_later',
      resumeAi: false,
      callbackAt: new Date('2026-11-05T10:00:00.000Z'),
    });

    expect(mocks.updateCallOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed' }),
    );
  });

  it('moves the stage only where the outcome proves something', async () => {
    await recordCallOutcomeForActor({ ...base, outcome: 'interested', resumeAi: false });
    expect(mocks.updateStage).toHaveBeenCalledWith(expect.objectContaining({ stage: 'qualified' }));

    vi.clearAllMocks();
    mocks.loadVisibleConversationForActor.mockResolvedValue({ _id: CONVERSATION, whatsappAccountId: 'wa-1' });
    mocks.createCallRecord.mockResolvedValue({ _id: CALL, startedAt: new Date() });
    mocks.updateCallOutcome.mockResolvedValue({ _id: CALL });

    await recordCallOutcomeForActor({ ...base, outcome: 'booking_confirmed', resumeAi: false });
    expect(mocks.updateStage).toHaveBeenCalledWith(expect.objectContaining({ stage: 'won' }));
  });
});

describe('the AI decision', () => {
  it('REFUSES TO GUESS when the owner did not answer', async () => {
    // Both defaults are wrong: on messages a customer the owner may have promised to handle,
    // off silently strands a lead nobody is talking to.
    await expect(
      recordCallOutcomeForActor({ ...base, outcome: 'contacted' }),
    ).rejects.toBeInstanceOf(CallOutcomeError);

    expect(mocks.setAiMode).not.toHaveBeenCalled();
  });

  it('resumes the ordinary agent on yes', async () => {
    await recordCallOutcomeForActor({ ...base, outcome: 'contacted', resumeAi: true });

    expect(mocks.setAiMode).toHaveBeenCalledWith(
      expect.objectContaining({ aiMode: 'qualifying' }),
    );
  });

  it('stays silent on no', async () => {
    await recordCallOutcomeForActor({ ...base, outcome: 'contacted', resumeAi: false });

    expect(mocks.setAiMode).toHaveBeenCalledWith(expect.objectContaining({ aiMode: 'off' }));
  });

  it('A CONFIRMED BOOKING RESUMES POST-BOOKING, NEVER QUALIFYING', async () => {
    // The second expensive mistake: selling to somebody who has already bought.
    await recordCallOutcomeForActor({ ...base, outcome: 'booking_confirmed', resumeAi: true });

    expect(mocks.setAiMode).toHaveBeenCalledWith(
      expect.objectContaining({ aiMode: 'post_booking' }),
    );
  });

  it('NEVER RE-ENABLES AI after "not interested", even if yes is sent', async () => {
    // The option is not offered in the UI; this proves the server does not honour it either,
    // because a promotional message to somebody who declined is the worst outcome here.
    await recordCallOutcomeForActor({ ...base, outcome: 'not_interested', resumeAi: true });

    expect(mocks.setAiMode).toHaveBeenCalledWith(expect.objectContaining({ aiMode: 'off' }));
    expect(mocks.updateStage).toHaveBeenCalledWith(expect.objectContaining({ stage: 'lost' }));
  });
});

describe('the reminder', () => {
  it('MOVES THE EXISTING ONE rather than creating a second', async () => {
    const callbackAt = new Date('2026-11-05T12:30:00.000Z');

    await recordCallOutcomeForActor({
      ...base,
      outcome: 'call_later',
      resumeAi: false,
      callbackAt,
      reminderTaskId: TASK,
    });

    expect(mocks.rescheduleReminder).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: TASK, dueAt: callbackAt }),
    );
    expect(mocks.updateTaskStatus).not.toHaveBeenCalled();
  });

  it('completes it when no further attempt is needed', async () => {
    await recordCallOutcomeForActor({
      ...base,
      outcome: 'booking_confirmed',
      resumeAi: true,
      reminderTaskId: TASK,
    });

    expect(mocks.updateTaskStatus).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: TASK, status: 'completed' }),
    );
    expect(mocks.rescheduleReminder).not.toHaveBeenCalled();
  });

  it('refuses an outcome that needs a callback time without one', async () => {
    await expect(
      recordCallOutcomeForActor({ ...base, outcome: 'not_received', resumeAi: false }),
    ).rejects.toBeInstanceOf(CallOutcomeError);
  });

  it('refreshes the conversation next-reminder hint', async () => {
    await recordCallOutcomeForActor({
      ...base,
      outcome: 'contacted',
      resumeAi: true,
      reminderTaskId: TASK,
    });

    expect(mocks.syncQuietly).toHaveBeenCalled();
  });
});

describe('the call row', () => {
  it('CREATES ONE when the owner dialled from their own handset', async () => {
    // No callId: there is no CallRecord because the app's dialler was never used. Refusing
    // would mean the calls that mattered enough to be reminded about are the ones missing.
    await recordCallOutcomeForActor({ ...base, outcome: 'contacted', resumeAi: true });

    expect(mocks.createCallRecord).toHaveBeenCalled();
  });

  it('updates the existing row when there is one', async () => {
    await recordCallOutcomeForActor({
      ...base,
      outcome: 'contacted',
      resumeAi: true,
      callId: CALL,
    });

    expect(mocks.createCallRecord).not.toHaveBeenCalled();
    expect(mocks.updateCallOutcome).toHaveBeenCalled();
  });

  it('refuses a call id from another organisation', async () => {
    mocks.findCallRecordById.mockResolvedValue(null);

    await expect(
      recordCallOutcomeForActor({ ...base, outcome: 'contacted', resumeAi: true, callId: CALL }),
    ).rejects.toBeInstanceOf(CallOutcomeError);
  });

  it('applies the conversation gate BEFORE writing anything', async () => {
    mocks.loadVisibleConversationForActor.mockRejectedValue(new Error('CONVERSATION_ACCESS_DENIED'));

    await expect(
      recordCallOutcomeForActor({ ...base, outcome: 'booking_confirmed', resumeAi: true }),
    ).rejects.toThrow('CONVERSATION_ACCESS_DENIED');

    expect(mocks.updateStage).not.toHaveBeenCalled();
    expect(mocks.setAiMode).not.toHaveBeenCalled();
    expect(mocks.updateCallOutcome).not.toHaveBeenCalled();
  });
});

describe('the timeline', () => {
  it('describes the outcome in plain words and NEVER a phone number', async () => {
    await recordCallOutcomeForActor({ ...base, outcome: 'booking_confirmed', resumeAi: true });

    const entry = mocks.createActivity.mock.calls[0]?.[0];

    expect(entry.summary).toBe('Booking confirmed on the phone.');
    expect(JSON.stringify(entry.metadata)).not.toMatch(/\d{10}/);
  });
});
