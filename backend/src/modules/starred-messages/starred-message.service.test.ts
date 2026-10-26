/**
 * Starred messages, with the repository mocked.
 *
 * WHAT THESE ARE ACTUALLY FOR. A starred message is personal, so the only thing standing
 * between one user and another's saved replies is that every query carries BOTH the
 * organisation and the user. That is easy to write once and easy to drop in the next edit, and
 * nothing about the feature looks broken when it is missing - the list still returns rows, the
 * edit still succeeds. So most of these tests assert the shape of the query rather than the
 * shape of the answer.
 *
 * The other half is idempotent starring: a double tap must not leave two copies of the same
 * message in the list, and must not surface the unique index as a 500.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const mocks = vi.hoisted(() => ({
  createStarredMessage: vi.fn(),
  findStarredMessages: vi.fn(),
  findStarredMessageById: vi.fn(),
  findStarredMessageBySource: vi.fn(),
  updateStarredMessage: vi.fn(),
  deleteStarredMessage: vi.fn(),
}));

vi.mock('./starred-message.repository.js', () => ({
  createStarredMessage: mocks.createStarredMessage,
  findStarredMessages: mocks.findStarredMessages,
  findStarredMessageById: mocks.findStarredMessageById,
  findStarredMessageBySource: mocks.findStarredMessageBySource,
  updateStarredMessage: mocks.updateStarredMessage,
  deleteStarredMessage: mocks.deleteStarredMessage,
}));

const {
  editStarredMessageForUser,
  listStarredMessagesForUser,
  removeStarredMessageForUser,
  saveStarredMessageForUser,
  STARRED_MESSAGE_NOT_FOUND,
} = await import('./starred-message.service.js');

const organizationId = 'org-1';
const userId = 'user-1';

const row = (overrides: Record<string, unknown> = {}) => ({
  _id: 'starred-1',
  organizationId,
  userId,
  title: 'Drone coverage',
  body: 'Yes, drone coverage is included in the premium package.',
  sourceMessageId: null,
  sourceConversationId: null,
  createdAt: new Date('2026-10-26T09:00:00.000Z'),
  updatedAt: new Date('2026-10-26T09:00:00.000Z'),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findStarredMessages.mockResolvedValue([]);
  mocks.findStarredMessageBySource.mockResolvedValue(null);
  mocks.createStarredMessage.mockResolvedValue(row());
  mocks.findStarredMessageById.mockResolvedValue(row());
  mocks.updateStarredMessage.mockResolvedValue(row({ title: 'Edited' }));
  mocks.deleteStarredMessage.mockResolvedValue(row());
});

describe('every query is scoped to one user in one organisation', () => {
  it('scopes the list', async () => {
    await listStarredMessagesForUser({ organizationId, userId });

    expect(mocks.findStarredMessages).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId, userId }),
    );
  });

  it('scopes the edit', async () => {
    await editStarredMessageForUser({
      organizationId,
      userId,
      starredMessageId: 'starred-1',
      title: 'Edited',
    });

    expect(mocks.updateStarredMessage).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId, userId, starredMessageId: 'starred-1' }),
    );
  });

  it('scopes both halves of the delete', async () => {
    await removeStarredMessageForUser({ organizationId, userId, starredMessageId: 'starred-1' });

    // The read AND the delete. Scoping only the read would let a race delete across accounts.
    expect(mocks.findStarredMessageById).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId, userId }),
    );
    expect(mocks.deleteStarredMessage).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId, userId }),
    );
  });

  it('stores the owner on create rather than trusting a caller-supplied id', async () => {
    await saveStarredMessageForUser({
      organizationId,
      userId,
      title: 'Drone coverage',
      body: 'Yes, drone coverage is included.',
    });

    expect(mocks.createStarredMessage).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId, userId }),
    );
  });
});

describe("someone else's saved message", () => {
  it('is a not-found on edit, not a silent no-op', async () => {
    // The repository returns null for "no such id" and for "not yours" alike, and the service
    // must not try to tell them apart - doing so confirms the record exists.
    mocks.updateStarredMessage.mockResolvedValue(null);

    await expect(
      editStarredMessageForUser({
        organizationId,
        userId,
        starredMessageId: 'someone-elses',
        title: 'Edited',
      }),
    ).rejects.toThrow(STARRED_MESSAGE_NOT_FOUND);
  });

  it('is a not-found on delete, and nothing is deleted', async () => {
    mocks.findStarredMessageById.mockResolvedValue(null);

    await expect(
      removeStarredMessageForUser({
        organizationId,
        userId,
        starredMessageId: 'someone-elses',
      }),
    ).rejects.toThrow(STARRED_MESSAGE_NOT_FOUND);

    expect(mocks.deleteStarredMessage).not.toHaveBeenCalled();
  });
});

describe('starring the same message twice', () => {
  it('returns what is already saved instead of creating a second copy', async () => {
    mocks.findStarredMessageBySource.mockResolvedValue(row({ _id: 'already-there' }));

    const result = await saveStarredMessageForUser({
      organizationId,
      userId,
      title: 'Drone coverage',
      body: 'Yes, drone coverage is included.',
      sourceMessageId: 'message-1',
    });

    // A double tap, or two devices. The unique index would turn this into a 500 otherwise.
    expect(mocks.createStarredMessage).not.toHaveBeenCalled();
    expect(result?.id).toBe('already-there');
  });

  it('looks for the existing one scoped to this user', async () => {
    await saveStarredMessageForUser({
      organizationId,
      userId,
      title: 'T',
      body: 'B',
      sourceMessageId: 'message-1',
    });

    expect(mocks.findStarredMessageBySource).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId, userId, sourceMessageId: 'message-1' }),
    );
  });

  it('does not run the lookup for a hand-written entry', async () => {
    // Every typed entry has a null source, so looking one up would match the FIRST typed entry
    // and silently refuse to save any others.
    await saveStarredMessageForUser({ organizationId, userId, title: 'T', body: 'B' });

    expect(mocks.findStarredMessageBySource).not.toHaveBeenCalled();
    expect(mocks.createStarredMessage).toHaveBeenCalledTimes(1);
  });
});

describe('what comes back', () => {
  it('never includes the owner id', async () => {
    mocks.findStarredMessages.mockResolvedValue([row()]);

    const [first] = await listStarredMessagesForUser({ organizationId, userId });

    expect(first).not.toHaveProperty('userId');
    expect(first).toMatchObject({ id: 'starred-1', title: 'Drone coverage' });
  });

  it('passes the search term through', async () => {
    await listStarredMessagesForUser({ organizationId, userId, search: 'drone' });

    expect(mocks.findStarredMessages).toHaveBeenCalledWith(
      expect.objectContaining({ search: 'drone' }),
    );
  });
});
