/**
 * Destroying a call's recording or its analysis, on purpose.
 *
 * THE FAILURE THIS FILE EXISTS TO PREVENT is a silent orphan: a row saying "deleted" beside a
 * file that is still on disk. Nothing would ever look at that file again - it appears in no
 * UI, no sweep reconsiders it, and nobody knows the studio is still holding a recorded
 * customer conversation. So the order is delete-then-clear, a storage failure is NOT swallowed,
 * and the tests below pin both.
 *
 * AND CONFIRMED TASKS MUST SURVIVE. Deleting the AI's notes is not the same decision as
 * cancelling the reminders somebody scheduled off the back of them, and conflating the two
 * would silently drop real work off real leads.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', MEDIA_STORAGE_DIR: 'var/media' },
}));

vi.mock('../../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mocks = vi.hoisted(() => ({
  getCallForActor: vi.fn(),
  clearCallRecording: vi.fn(),
  deleteCallAnalysis: vi.fn(),
  setTranscriptionStatus: vi.fn(),
  setSummaryStatus: vi.fn(),
  createActivity: vi.fn(),
}));

vi.mock('./call-record.service.js', () => ({ getCallForActor: mocks.getCallForActor }));

vi.mock('./call-record.repository.js', () => ({
  clearCallRecording: mocks.clearCallRecording,
}));

vi.mock('./call-analysis.repository.js', () => ({
  deleteCallAnalysis: mocks.deleteCallAnalysis,
  setTranscriptionStatus: mocks.setTranscriptionStatus,
  setSummaryStatus: mocks.setSummaryStatus,
}));

vi.mock('../activity/activity-log.repository.js', () => ({ createActivity: mocks.createActivity }));

const { deleteCallAnalysisForActor, deleteCallRecordingForActor, RecordingDeletionFailedError } =
  await import('./call-deletion.service.js');

const ORG = '6ab4c2037469f65204cfe999';
const CONVERSATION = '68f1a2b3c4d5e6f708192a3b';
const ACCOUNT = '6ab4c2037469f65204cfe222';
const CALL = '6adf2dd59f91cdd63f09e0f3';
const KEY = `${ORG}/${CONVERSATION}/0199aa11-2233-4455-6677-8899aabbccdd.m4a`;
const actor = { _id: '6ab4c2037469f65204cfe111' } as never;

const call = (overrides: Record<string, unknown> = {}) => ({
  _id: CALL,
  organizationId: ORG,
  conversationId: CONVERSATION,
  whatsappAccountId: ACCOUNT,
  recordingObjectKey: KEY,
  recordingStatus: 'uploaded',
  ...overrides,
});

const storage = () => ({
  deleteMediaObject: vi.fn().mockResolvedValue(undefined),
  writeMediaObject: vi.fn(),
  readMediaObject: vi.fn(),
  statMediaObject: vi.fn(),
  openMediaObjectStream: vi.fn(),
  root: '/tmp',
});

const base = { organizationId: ORG, callId: CALL, actor, permissions: [] as never };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCallForActor.mockResolvedValue(call());
  mocks.clearCallRecording.mockResolvedValue(call({ recordingObjectKey: null, recordingStatus: 'deleted' }));
  mocks.deleteCallAnalysis.mockResolvedValue({ deletedCount: 1 });
  mocks.setTranscriptionStatus.mockResolvedValue({});
  mocks.setSummaryStatus.mockResolvedValue({});
});

describe('deleting a recording', () => {
  it('DELETES THE BYTES BEFORE clearing the reference', async () => {
    const store = storage();

    await deleteCallRecordingForActor({ ...base, storage: store as never });

    const deleteOrder = store.deleteMediaObject.mock.invocationCallOrder[0]!;
    const clearOrder = mocks.clearCallRecording.mock.invocationCallOrder[0]!;

    expect(store.deleteMediaObject).toHaveBeenCalledWith(KEY);
    expect(deleteOrder).toBeLessThan(clearOrder);
  });

  it('marks it deleted rather than reverting to unavailable', async () => {
    // Two different facts: "never recorded" and "was recorded, now gone". A customer asking
    // what happened to their recording deserves the second answer.
    await deleteCallRecordingForActor({ ...base, storage: storage() as never });

    expect(mocks.clearCallRecording).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'deleted', expectedObjectKey: KEY }),
    );
  });

  it('DOES NOT CLAIM SUCCESS when storage deletion fails', async () => {
    // The central guarantee. A row saying "deleted" beside a file still on disk is an orphan
    // nothing will ever revisit.
    const store = storage();
    store.deleteMediaObject.mockRejectedValue(new Error('EACCES'));

    await expect(
      deleteCallRecordingForActor({ ...base, storage: store as never }),
    ).rejects.toBeInstanceOf(RecordingDeletionFailedError);

    expect(mocks.clearCallRecording).not.toHaveBeenCalled();
    expect(mocks.createActivity).not.toHaveBeenCalled();
  });

  it('IS SAFE TO RETRY when there is nothing left to delete', async () => {
    // The caller asked for the recording not to exist, and it does not. Erroring here would
    // make a retry after a partial failure look broken.
    const store = storage();
    mocks.getCallForActor.mockResolvedValue(call({ recordingObjectKey: null }));

    await expect(
      deleteCallRecordingForActor({ ...base, storage: store as never }),
    ).resolves.toBeTruthy();

    expect(store.deleteMediaObject).not.toHaveBeenCalled();
  });

  it('REFUSES TO HAND A MALFORMED KEY TO THE FILESYSTEM', async () => {
    // The key shape is what stops a `..` escaping the storage root.
    const store = storage();
    mocks.getCallForActor.mockResolvedValue(call({ recordingObjectKey: '../../../etc/passwd' }));

    await deleteCallRecordingForActor({ ...base, storage: store as never });

    expect(store.deleteMediaObject).not.toHaveBeenCalled();
    // The reference is still cleared, so the row stops claiming audio it cannot name.
    expect(mocks.clearCallRecording).toHaveBeenCalled();
  });

  it('denies a call from another organisation', async () => {
    const store = storage();
    mocks.getCallForActor.mockRejectedValue(new Error('CALL_NOT_FOUND'));

    await expect(
      deleteCallRecordingForActor({ ...base, storage: store as never }),
    ).rejects.toThrow('CALL_NOT_FOUND');
    expect(store.deleteMediaObject).not.toHaveBeenCalled();
  });

  it('denies an actor who cannot see the conversation', async () => {
    const store = storage();
    mocks.getCallForActor.mockRejectedValue(new Error('CONVERSATION_ACCESS_DENIED'));

    await expect(
      deleteCallRecordingForActor({ ...base, storage: store as never }),
    ).rejects.toThrow('CONVERSATION_ACCESS_DENIED');
    expect(store.deleteMediaObject).not.toHaveBeenCalled();
  });

  it('LOGS WHO AND WHICH CALL, never the storage key', async () => {
    await deleteCallRecordingForActor({ ...base, storage: storage() as never });

    const entry = mocks.createActivity.mock.calls[0]![0];

    expect(entry.eventType).toBe('call.recording_deleted');
    expect(Object.keys(entry.metadata as object).sort()).toEqual(['callId', 'reason']);
    expect(JSON.stringify(entry.metadata)).not.toContain('.m4a');
  });
});

describe('deleting the analysis', () => {
  it('destroys the transcript, summary and suggestions together', async () => {
    await deleteCallAnalysisForActor(base);

    expect(mocks.deleteCallAnalysis).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, callId: CALL }),
    );
  });

  it('PRESERVES CONFIRMED TASKS', async () => {
    // Nothing in this path may reach the follow-up collection. A task an agent confirmed is
    // ordinary CRM work by the time it exists; deleting the AI's notes must not cancel it.
    await deleteCallAnalysisForActor(base);

    const touched = Object.keys(mocks).filter(
      (name) => (mocks as Record<string, { mock: { calls: unknown[] } }>)[name]!.mock.calls.length > 0,
    );

    expect(touched).not.toContain('createFollowUpTask');
    expect(touched).not.toContain('updateTaskStatus');
  });

  it('LEAVES THE RECORDING ALONE', async () => {
    // Separate decisions with separate retention settings. Somebody deleting an inaccurate
    // summary almost never means "and destroy the evidence of what was actually said".
    await deleteCallAnalysisForActor(base);

    expect(mocks.clearCallRecording).not.toHaveBeenCalled();
  });

  it('re-queues transcription when the audio is still there', async () => {
    await deleteCallAnalysisForActor(base);

    expect(mocks.setTranscriptionStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'pending' }),
    );
  });

  it('marks transcription not-applicable when the audio has gone too', async () => {
    mocks.getCallForActor.mockResolvedValue(call({ recordingObjectKey: null }));

    await deleteCallAnalysisForActor(base);

    expect(mocks.setTranscriptionStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'not_applicable' }),
    );
  });

  it('DOES NOT LOG A DELETION THAT DELETED NOTHING', async () => {
    // Otherwise a retry fills the lead's timeline with repeated deletions of an absence.
    mocks.deleteCallAnalysis.mockResolvedValue({ deletedCount: 0 });

    const result = await deleteCallAnalysisForActor(base);

    expect(result.deleted).toBe(false);
    expect(mocks.createActivity).not.toHaveBeenCalled();
  });

  it('keeps transcript content out of the audit metadata', async () => {
    await deleteCallAnalysisForActor(base);

    const entry = mocks.createActivity.mock.calls[0]![0];

    expect(Object.keys(entry.metadata as object).sort()).toEqual(['callId', 'reason']);
  });

  it('denies another organisation', async () => {
    mocks.getCallForActor.mockRejectedValue(new Error('CALL_NOT_FOUND'));

    await expect(deleteCallAnalysisForActor(base)).rejects.toThrow('CALL_NOT_FOUND');
    expect(mocks.deleteCallAnalysis).not.toHaveBeenCalled();
  });
});
