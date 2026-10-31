/**
 * Who may touch a call record, and what the CRM is allowed to claim about a call.
 *
 * TWO THINGS ARE BEING DEFENDED HERE, and they are different in kind.
 *
 * AUTHORISATION. A call is reached through its conversation, so the question "can this person
 * see this call" has exactly one answer - the one `loadVisibleConversationForActor` already
 * gives for the thread, its messages and its reminders. These tests prove no second, weaker
 * path was invented: the lookup is org-scoped first (another studio's id is NOT FOUND, not
 * forbidden, so the response does not confirm the id exists), and the conversation gate runs
 * even when the caller supplies a call id directly.
 *
 * HONESTY. Vistaar hands the number to the system dialler and Android tells it nothing more.
 * So `initiated` is the only status the app may write by itself, and every fact about the
 * outcome has to come from a human. The tests below pin that: opening the dialler is not a
 * completed call, a duration never appears on a call nobody answered, and `endedAt` is only
 * computed when somebody actually said how long they spoke.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const mocks = vi.hoisted(() => ({
  createCallRecord: vi.fn(),
  findCallRecordById: vi.fn(),
  findCallRecordByIdempotencyKey: vi.fn(),
  findCallRecordsByConversation: vi.fn(),
  updateCallOutcome: vi.fn(),
  attachCallRecording: vi.fn(),
  createActivity: vi.fn(),
  loadVisibleConversationForActor: vi.fn(),
}));

vi.mock('./call-record.repository.js', () => ({
  createCallRecord: mocks.createCallRecord,
  findCallRecordById: mocks.findCallRecordById,
  findCallRecordByIdempotencyKey: mocks.findCallRecordByIdempotencyKey,
  findCallRecordsByConversation: mocks.findCallRecordsByConversation,
  updateCallOutcome: mocks.updateCallOutcome,
  attachCallRecording: mocks.attachCallRecording,
}));

vi.mock('../activity/activity-log.repository.js', () => ({ createActivity: mocks.createActivity }));

vi.mock('../conversations/conversation.service.js', () => ({
  loadVisibleConversationForActor: mocks.loadVisibleConversationForActor,
}));

const {
  attachRecordingForActor,
  getCallForActor,
  listConversationCallsForActor,
  recordCallOutcomeForActor,
  startCallForActor,
} = await import('./call-record.service.js');

const ORG = '6ab4c2037469f65204cfe999';
const CONVERSATION = '68f1a2b3c4d5e6f708192a3b';
const ACCOUNT = '6ab4c2037469f65204cfe222';
const CONTACT = '6ab4c2037469f65204cfe333';
const CALL = '6adf2dd59f91cdd63f09e0f3';
const ACTOR_ID = '6ab4c2037469f65204cfe111';
const actor = { _id: ACTOR_ID } as never;

const conversation = {
  _id: CONVERSATION,
  whatsappAccountId: ACCOUNT,
  contactId: CONTACT,
};

const callRow = (overrides: Record<string, unknown> = {}) => ({
  _id: CALL,
  organizationId: ORG,
  conversationId: CONVERSATION,
  whatsappAccountId: ACCOUNT,
  contactId: CONTACT,
  initiatedBy: ACTOR_ID,
  direction: 'outbound',
  status: 'initiated',
  startedAt: new Date('2026-10-30T09:00:00.000Z'),
  endedAt: null,
  durationSeconds: null,
  recordingStatus: 'unavailable',
  recordingObjectKey: null,
  transcriptionStatus: 'not_applicable',
  summaryStatus: 'not_applicable',
  ...overrides,
});

const base = { organizationId: ORG, actor, permissions: [] as never };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadVisibleConversationForActor.mockResolvedValue(conversation);
  mocks.createCallRecord.mockResolvedValue(callRow());
  mocks.findCallRecordByIdempotencyKey.mockResolvedValue(null);
  mocks.findCallRecordById.mockResolvedValue(callRow());
  mocks.updateCallOutcome.mockImplementation(async ({ status, durationSeconds, endedAt }) =>
    callRow({ status, durationSeconds, endedAt }),
  );
  mocks.attachCallRecording.mockResolvedValue(callRow({ recordingStatus: 'uploaded' }));
  mocks.findCallRecordsByConversation.mockResolvedValue([callRow()]);
});

describe('opening the dialler', () => {
  it('records INITIATED and nothing stronger', async () => {
    const call = await startCallForActor({ ...base, conversationId: CONVERSATION });

    // The whole honesty rule in one assertion. Android gives no evidence the call happened, so
    // anything other than `initiated` here would be the CRM asserting a customer conversation
    // that may never have taken place.
    expect(call?.status).toBe('initiated');
    expect(call?.durationSeconds).toBeNull();
    expect(call?.endedAt).toBeNull();
  });

  it('checks the conversation is visible to this actor BEFORE writing anything', async () => {
    mocks.loadVisibleConversationForActor.mockRejectedValue(
      new Error('CONVERSATION_ACCESS_DENIED'),
    );

    await expect(startCallForActor({ ...base, conversationId: CONVERSATION })).rejects.toThrow(
      'CONVERSATION_ACCESS_DENIED',
    );
    expect(mocks.createCallRecord).not.toHaveBeenCalled();
  });

  it('writes a timeline entry that does not claim a call was made', async () => {
    await startCallForActor({ ...base, conversationId: CONVERSATION });

    const entry = mocks.createActivity.mock.calls[0]![0];

    expect(entry.eventType).toBe('call.started');
    expect(String(entry.summary).toLowerCase()).toContain('dialler');
  });

  it('NEVER PUTS A PHONE NUMBER IN ACTIVITY METADATA', async () => {
    // Activity metadata is read back into the timeline and into AI context. The number lives on
    // the contact, encrypted, behind its own permission, and must not be copied here.
    await startCallForActor({ ...base, conversationId: CONVERSATION });

    const metadata = mocks.createActivity.mock.calls[0]![0].metadata as Record<string, unknown>;

    expect(Object.keys(metadata).sort()).toEqual(['callId', 'direction']);
  });

  it('IS IDEMPOTENT: a retried tap returns the first row', async () => {
    // Phones retry on bad connections. Two rows on a lead's timeline for one tap is a mess
    // somebody has to clean up by hand.
    mocks.findCallRecordByIdempotencyKey.mockResolvedValue(callRow({ status: 'completed' }));

    const call = await startCallForActor({
      ...base,
      conversationId: CONVERSATION,
      idempotencyKey: 'call-tap-0199aa',
    });

    expect(mocks.createCallRecord).not.toHaveBeenCalled();
    expect(call?.status).toBe('completed');
  });

  it('does not look for a duplicate when no key was supplied', async () => {
    await startCallForActor({ ...base, conversationId: CONVERSATION });

    expect(mocks.findCallRecordByIdempotencyKey).not.toHaveBeenCalled();
    expect(mocks.createCallRecord).toHaveBeenCalled();
  });
});

describe('recording the outcome', () => {
  it('stores the duration a human gave, and derives the end time from it', async () => {
    const call = await recordCallOutcomeForActor({
      ...base,
      callId: CALL,
      status: 'completed',
      durationSeconds: 300,
    });

    expect(call?.durationSeconds).toBe(300);
    expect(mocks.updateCallOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ endedAt: new Date('2026-10-30T09:05:00.000Z') }),
    );
  });

  it('DROPS A DURATION ON A CALL THAT DID NOT CONNECT', async () => {
    // "No answer, 5 minutes long" is a contradiction. The API refuses it too; this is the
    // second line of defence, in the layer that decides what gets stored.
    await recordCallOutcomeForActor({
      ...base,
      callId: CALL,
      status: 'failed',
      durationSeconds: 300,
    });

    expect(mocks.updateCallOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ durationSeconds: null, endedAt: null }),
    );
  });

  it('keeps awaySeconds SEPARATE from the duration', async () => {
    // Time backgrounded is an upper bound - it includes finding the contact, the ringing and
    // any wandering off afterwards. Conflating the two would put a fabricated call length on a
    // customer's timeline.
    await recordCallOutcomeForActor({
      ...base,
      callId: CALL,
      status: 'unknown',
      awaySeconds: 252,
    });

    expect(mocks.updateCallOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ awaySeconds: 252, durationSeconds: null }),
    );
  });

  it('REFUSES A CALL FROM ANOTHER ORGANISATION as not-found', async () => {
    // The repository lookup is org-scoped, so a foreign id returns null. Reported as missing
    // rather than forbidden, which would confirm the id exists.
    mocks.findCallRecordById.mockResolvedValue(null);

    await expect(
      recordCallOutcomeForActor({ ...base, callId: CALL, status: 'completed' }),
    ).rejects.toThrow('CALL_NOT_FOUND');
    expect(mocks.updateCallOutcome).not.toHaveBeenCalled();
  });

  it('still applies the conversation gate when the call id is supplied directly', async () => {
    // Knowing a call id is not permission to act on it: an assignment-restricted agent must not
    // reach a call on a lead they cannot open.
    mocks.loadVisibleConversationForActor.mockRejectedValue(
      new Error('CONVERSATION_ACCESS_DENIED'),
    );

    await expect(
      recordCallOutcomeForActor({ ...base, callId: CALL, status: 'completed' }),
    ).rejects.toThrow('CONVERSATION_ACCESS_DENIED');
    expect(mocks.updateCallOutcome).not.toHaveBeenCalled();
  });

  it('describes the outcome in plain words on the timeline', async () => {
    await recordCallOutcomeForActor({ ...base, callId: CALL, status: 'failed' });

    const entry = mocks.createActivity.mock.calls[0]![0];

    expect(entry.eventType).toBe('call.completed');
    expect(entry.summary).toBe('Called, but the lead did not answer.');
  });
});

describe('reading calls', () => {
  it('scopes the list to the conversation and the organisation', async () => {
    await listConversationCallsForActor({ ...base, conversationId: CONVERSATION });

    expect(mocks.findCallRecordsByConversation).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, conversationId: CONVERSATION }),
    );
  });

  it('NEVER SERIALISES THE RECORDING KEY', async () => {
    // The key names a file on the server's disk. The client fetches audio by CALL id from an
    // authenticated route and the server resolves the key itself, so sending it out would turn
    // an internal path into something a client can hold and leak, for no capability gained.
    mocks.findCallRecordsByConversation.mockResolvedValue([
      callRow({ recordingObjectKey: `${ORG}/${CONVERSATION}/abc.m4a`, recordingStatus: 'uploaded' }),
    ]);

    const calls = await listConversationCallsForActor({ ...base, conversationId: CONVERSATION });

    expect(JSON.stringify(calls)).not.toContain('.m4a');
    // It still says audio EXISTS, which is what the player needs.
    expect(calls[0]?.hasRecording).toBe(true);
  });

  it('reports hasRecording false when there is no audio', async () => {
    const calls = await listConversationCallsForActor({ ...base, conversationId: CONVERSATION });

    expect(calls[0]?.hasRecording).toBe(false);
    expect(calls[0]?.recordingStatus).toBe('unavailable');
  });

  it('refuses a single call from another organisation', async () => {
    mocks.findCallRecordById.mockResolvedValue(null);

    await expect(getCallForActor({ ...base, callId: CALL })).rejects.toThrow('CALL_NOT_FOUND');
  });
});

describe('attaching a recording', () => {
  it('arms the transcript pipeline IN THE SAME WRITE as the audio', async () => {
    // A row with audio but `not_applicable` is invisible to the sweep forever; one that says
    // `pending` with no audio is a job that can never succeed. They have to land together.
    await attachRecordingForActor({
      ...base,
      callId: CALL,
      objectKey: `${ORG}/${CONVERSATION}/abc.m4a`,
      mimeType: 'audio/mp4',
      sizeBytes: 512_000,
    });

    expect(mocks.attachCallRecording).toHaveBeenCalledWith(
      expect.objectContaining({
        recordingStatus: 'uploaded',
        transcriptionStatus: 'pending',
      }),
    );
  });

  it('applies the same authorisation as everything else', async () => {
    mocks.findCallRecordById.mockResolvedValue(null);

    await expect(
      attachRecordingForActor({
        ...base,
        callId: CALL,
        objectKey: 'x',
        mimeType: 'audio/mp4',
        sizeBytes: 1,
      }),
    ).rejects.toThrow('CALL_NOT_FOUND');
    expect(mocks.attachCallRecording).not.toHaveBeenCalled();
  });

  it('logs the size and type but NOT the storage key', async () => {
    await attachRecordingForActor({
      ...base,
      callId: CALL,
      objectKey: `${ORG}/${CONVERSATION}/secret.m4a`,
      mimeType: 'audio/mp4',
      sizeBytes: 512_000,
    });

    const metadata = mocks.createActivity.mock.calls[0]![0].metadata as Record<string, unknown>;

    expect(Object.keys(metadata).sort()).toEqual(['callId', 'mimeType', 'sizeBytes']);
    expect(JSON.stringify(metadata)).not.toContain('secret');
  });
});
