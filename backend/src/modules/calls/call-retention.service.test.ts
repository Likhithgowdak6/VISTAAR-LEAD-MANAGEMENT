/**
 * Scheduled deletion of old call data.
 *
 * THE MOST IMPORTANT TEST IN THIS FILE IS THE ONE WHERE NOTHING HAPPENS.
 *
 * This code is being added to a database that already holds real recorded conversations with
 * real customers. If retention defaulted to any number of days, the first sweep after deploy
 * would destroy every recording older than it - irreversibly, on a schedule nobody chose. So
 * null means keep forever, an unconfigured organisation is skipped entirely, and that is
 * pinned here rather than left to a comment somebody edits later.
 *
 * THE SECOND MOST IMPORTANT IS THE BLAST RADIUS. The only file this sweep may remove is the
 * key stored on the call row it is holding. It must never reach a message attachment, a
 * contact, a conversation or a task - a bug there would quietly delete a studio's actual
 * business records while reporting a successful retention pass.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', MEDIA_STORAGE_DIR: 'var/media' },
}));

vi.mock('../../config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  findExpiredRecordings: vi.fn(),
  countExpiredRecordings: vi.fn(),
  clearCallRecording: vi.fn(),
  findExpiredAnalyses: vi.fn(),
  countExpiredAnalyses: vi.fn(),
  deleteCallAnalysis: vi.fn(),
  clearCallSummary: vi.fn(),
  createActivity: vi.fn(),
}));

vi.mock('../organizations/organization.model.js', () => ({
  Organization: { findById: mocks.findById },
}));

vi.mock('./call-record.repository.js', () => ({
  findExpiredRecordings: mocks.findExpiredRecordings,
  countExpiredRecordings: mocks.countExpiredRecordings,
  clearCallRecording: mocks.clearCallRecording,
}));

vi.mock('./call-analysis.repository.js', () => ({
  findExpiredAnalyses: mocks.findExpiredAnalyses,
  countExpiredAnalyses: mocks.countExpiredAnalyses,
  deleteCallAnalysis: mocks.deleteCallAnalysis,
  clearCallSummary: mocks.clearCallSummary,
}));

vi.mock('../activity/activity-log.repository.js', () => ({ createActivity: mocks.createActivity }));

const { previewRetention, resolveRetentionPolicy, runRetentionForOrganization } = await import(
  './call-retention.service.js'
);

const ORG = '6ab4c2037469f65204cfe999';
const CONVERSATION = '68f1a2b3c4d5e6f708192a3b';
const ACCOUNT = '6ab4c2037469f65204cfe222';
const CALL = '6adf2dd59f91cdd63f09e0f3';
const KEY = `${ORG}/${CONVERSATION}/0199aa11-2233-4455-6677-8899aabbccdd.m4a`;
const NOW = new Date('2026-10-30T09:00:00.000Z');

/** Mongoose's `findById().select().lean()` chain. */
const orgWith = (callRetention: unknown) => ({
  select: () => ({ lean: () => Promise.resolve(callRetention === undefined ? null : { callRetention }) }),
});

const expiredCall = (overrides: Record<string, unknown> = {}) => ({
  _id: CALL,
  organizationId: ORG,
  conversationId: CONVERSATION,
  whatsappAccountId: ACCOUNT,
  recordingObjectKey: KEY,
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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findById.mockReturnValue(orgWith({ recordingDays: null, transcriptDays: null, summaryDays: null }));
  mocks.findExpiredRecordings.mockResolvedValue([]);
  mocks.findExpiredAnalyses.mockResolvedValue([]);
  mocks.countExpiredRecordings.mockResolvedValue(0);
  mocks.countExpiredAnalyses.mockResolvedValue(0);
  mocks.clearCallRecording.mockResolvedValue(expiredCall({ recordingObjectKey: null }));
  mocks.deleteCallAnalysis.mockResolvedValue({ deletedCount: 1 });
  mocks.clearCallSummary.mockResolvedValue({});
});

describe('an organisation with no policy', () => {
  it('DELETES ABSOLUTELY NOTHING', async () => {
    // The default state of every existing organisation, and the whole safety argument for
    // shipping this to a live database.
    const store = storage();

    const result = await runRetentionForOrganization({
      organizationId: ORG,
      storage: store as never,
      now: NOW,
    });

    expect(result).toEqual({
      recordingsDeleted: 0,
      analysesDeleted: 0,
      summariesCleared: 0,
      failures: 0,
    });
    expect(mocks.findExpiredRecordings).not.toHaveBeenCalled();
    expect(mocks.findExpiredAnalyses).not.toHaveBeenCalled();
    expect(store.deleteMediaObject).not.toHaveBeenCalled();
  });

  it('treats a missing organisation as no policy', async () => {
    mocks.findById.mockReturnValue(orgWith(undefined));

    const policy = await resolveRetentionPolicy({ organizationId: ORG });

    expect(policy).toEqual({ recordingDays: null, transcriptDays: null, summaryDays: null });
  });

  it('TREATS ZERO AND NEGATIVE AS NO POLICY, not as delete-everything', async () => {
    // A `0` in the field would otherwise mean "cutoff = now", which deletes the entire
    // history. Refusing it turns a plausible typo into a no-op.
    mocks.findById.mockReturnValue(orgWith({ recordingDays: 0, transcriptDays: -5, summaryDays: null }));

    const result = await runRetentionForOrganization({
      organizationId: ORG,
      storage: storage() as never,
      now: NOW,
    });

    expect(result.recordingsDeleted).toBe(0);
    expect(mocks.findExpiredRecordings).not.toHaveBeenCalled();
  });

  it('reports the preview as unconfigured, with zero counts', async () => {
    const preview = await previewRetention({ organizationId: ORG, now: NOW });

    expect(preview.unconfigured).toBe(true);
    expect(preview.recordings).toEqual({ count: 0, cutoff: null });
    expect(mocks.countExpiredRecordings).not.toHaveBeenCalled();
  });
});

describe('the dry run', () => {
  it('counts what WOULD go, and deletes nothing', async () => {
    mocks.findById.mockReturnValue(orgWith({ recordingDays: 90, transcriptDays: 365, summaryDays: null }));
    mocks.countExpiredRecordings.mockResolvedValue(12);
    mocks.countExpiredAnalyses.mockResolvedValue(3);

    const preview = await previewRetention({ organizationId: ORG, now: NOW });

    expect(preview.unconfigured).toBe(false);
    expect(preview.recordings.count).toBe(12);
    expect(preview.transcripts.count).toBe(3);
    // Nothing destructive was reached.
    expect(mocks.clearCallRecording).not.toHaveBeenCalled();
    expect(mocks.deleteCallAnalysis).not.toHaveBeenCalled();
  });

  it('reports the cutoff it computed, so the number can be checked', async () => {
    mocks.findById.mockReturnValue(orgWith({ recordingDays: 90, transcriptDays: null, summaryDays: null }));

    const preview = await previewRetention({ organizationId: ORG, now: NOW });

    // 90 days before 2026-10-30.
    expect(preview.recordings.cutoff).toBe('2026-08-01T09:00:00.000Z');
  });

  it('LEAKS NO CONTENT — counts and dates only', async () => {
    mocks.findById.mockReturnValue(orgWith({ recordingDays: 90, transcriptDays: 90, summaryDays: 90 }));
    mocks.countExpiredRecordings.mockResolvedValue(2);
    mocks.countExpiredAnalyses.mockResolvedValue(2);

    const preview = await previewRetention({ organizationId: ORG, now: NOW });

    // A preview listing transcripts would be a new way to read the data it is about to destroy.
    expect(JSON.stringify(preview)).not.toContain(CALL);
    expect(JSON.stringify(preview)).not.toContain('.m4a');
  });
});

describe('deleting expired recordings', () => {
  beforeEach(() => {
    mocks.findById.mockReturnValue(orgWith({ recordingDays: 90, transcriptDays: null, summaryDays: null }));
    mocks.findExpiredRecordings.mockResolvedValue([expiredCall()]);
  });

  it('removes the bytes and then the reference', async () => {
    const store = storage();

    const result = await runRetentionForOrganization({
      organizationId: ORG,
      storage: store as never,
      now: NOW,
    });

    expect(store.deleteMediaObject).toHaveBeenCalledWith(KEY);
    expect(result.recordingsDeleted).toBe(1);
  });

  it('TOUCHES ONLY THE KEY ON THE ROW IT IS HOLDING', async () => {
    // The blast-radius guarantee. This sweep does not walk directories and cannot reach a
    // message attachment, a contact or a conversation.
    const store = storage();

    await runRetentionForOrganization({ organizationId: ORG, storage: store as never, now: NOW });

    expect(store.deleteMediaObject).toHaveBeenCalledTimes(1);
    expect(store.deleteMediaObject).toHaveBeenCalledWith(KEY);
  });

  it('SCOPES EVERY QUERY TO ONE ORGANISATION', async () => {
    // Retention is per-studio. A cross-tenant query would apply one studio's policy to
    // another studio's recordings.
    await runRetentionForOrganization({ organizationId: ORG, storage: storage() as never, now: NOW });

    expect(mocks.findExpiredRecordings).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG }),
    );
  });

  it('SKIPS AND RETRIES LATER when storage fails, without marking it deleted', async () => {
    const store = storage();
    store.deleteMediaObject.mockRejectedValue(new Error('EACCES'));

    const result = await runRetentionForOrganization({
      organizationId: ORG,
      storage: store as never,
      now: NOW,
    });

    expect(result.failures).toBe(1);
    expect(result.recordingsDeleted).toBe(0);
    // The reference survives, so the next pass tries again and nothing lies about the bytes.
    expect(mocks.clearCallRecording).not.toHaveBeenCalled();
  });

  it('one failure does not stop the rest of the batch', async () => {
    const store = storage();
    const other = `${ORG}/${CONVERSATION}/0199bb22-3344-5566-7788-99aabbccddee.m4a`;
    mocks.findExpiredRecordings.mockResolvedValue([
      expiredCall(),
      expiredCall({ _id: 'second', recordingObjectKey: other }),
    ]);
    store.deleteMediaObject.mockRejectedValueOnce(new Error('EACCES'));

    const result = await runRetentionForOrganization({
      organizationId: ORG,
      storage: store as never,
      now: NOW,
    });

    expect(result.failures).toBe(1);
    expect(result.recordingsDeleted).toBe(1);
  });

  it('IS IDEMPOTENT — a second pass finds nothing', async () => {
    // The query only matches rows that still hold a key, so a processed row cannot be
    // selected again.
    const store = storage();
    await runRetentionForOrganization({ organizationId: ORG, storage: store as never, now: NOW });

    mocks.findExpiredRecordings.mockResolvedValue([]);
    const second = await runRetentionForOrganization({
      organizationId: ORG,
      storage: store as never,
      now: NOW,
    });

    expect(second.recordingsDeleted).toBe(0);
    expect(store.deleteMediaObject).toHaveBeenCalledTimes(1);
  });

  it('records the deletion as policy-driven, with no actor and no content', async () => {
    await runRetentionForOrganization({ organizationId: ORG, storage: storage() as never, now: NOW });

    const entry = mocks.createActivity.mock.calls[0]![0];

    expect(entry.eventType).toBe('call.recording_deleted');
    expect(entry.actorId).toBeNull();
    expect(entry.metadata).toEqual({ callId: CALL, reason: 'retention' });
  });
});

describe('deleting expired analyses', () => {
  it('destroys transcript and summary together when transcripts expire', async () => {
    mocks.findById.mockReturnValue(orgWith({ recordingDays: null, transcriptDays: 365, summaryDays: 30 }));
    mocks.findExpiredAnalyses.mockResolvedValue([{ callId: CALL }]);

    const result = await runRetentionForOrganization({
      organizationId: ORG,
      storage: storage() as never,
      now: NOW,
    });

    expect(result.analysesDeleted).toBe(1);
    // Not ALSO cleared - that would count one deletion twice.
    expect(mocks.clearCallSummary).not.toHaveBeenCalled();
  });

  it('clears ONLY the summary when transcripts are kept indefinitely', async () => {
    // The case this branch exists for: keep the words for a year, the AI's reading for a month.
    mocks.findById.mockReturnValue(orgWith({ recordingDays: null, transcriptDays: null, summaryDays: 30 }));
    mocks.findExpiredAnalyses.mockResolvedValue([{ callId: CALL }]);

    const result = await runRetentionForOrganization({
      organizationId: ORG,
      storage: storage() as never,
      now: NOW,
    });

    expect(result.summariesCleared).toBe(1);
    expect(mocks.deleteCallAnalysis).not.toHaveBeenCalled();
    expect(mocks.findExpiredAnalyses).toHaveBeenCalledWith(
      expect.objectContaining({ requireSummary: true }),
    );
  });

  it('NEVER TOUCHES TASKS, MESSAGES OR CONTACTS', async () => {
    // Exhaustive by construction: the only collections this service imports are the two call
    // repositories, the organisation lookup and the activity log.
    mocks.findById.mockReturnValue(orgWith({ recordingDays: 90, transcriptDays: 90, summaryDays: 90 }));
    mocks.findExpiredRecordings.mockResolvedValue([expiredCall()]);
    mocks.findExpiredAnalyses.mockResolvedValue([{ callId: CALL }]);

    await runRetentionForOrganization({ organizationId: ORG, storage: storage() as never, now: NOW });

    const called = Object.entries(mocks)
      .filter(([, fn]) => (fn as { mock: { calls: unknown[] } }).mock.calls.length > 0)
      .map(([name]) => name);

    expect(called.sort()).toEqual([
      'clearCallRecording',
      'createActivity',
      'deleteCallAnalysis',
      'findById',
      'findExpiredAnalyses',
      'findExpiredRecordings',
    ]);
  });
});
