/**
 * The filters, which is where ownership and search safety both live.
 *
 * TWO FAILURES THESE EXIST FOR.
 *
 * Ownership: these rows are personal. A filter missing `userId` shows one colleague's saved
 * replies to another, and a filter missing `organizationId` reaches across tenants. Neither
 * looks broken from the outside - the list returns rows either way - so the filter itself is
 * what gets asserted, not the result.
 *
 * Search: the term is typed into a box and then compiled into a RegExp. Unescaped, `(` throws
 * outright, `.*` matches every saved message regardless of what was typed, and a nested
 * quantifier is a CPU bill. Escaping is one easily-deleted line with no visible symptom in the
 * common case, which is exactly the kind that needs a test.
 *
 * Mocked model, no real Mongo.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const chain = () => {
  const exec = vi.fn().mockResolvedValue([]);
  const limit = vi.fn(() => ({ exec }));
  const sort = vi.fn(() => ({ limit }));

  return { sort, limit, exec };
};

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  findOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
  findOneAndDelete: vi.fn(),
  create: vi.fn(),
}));

vi.mock('./starred-message.model.js', () => ({
  StarredMessage: {
    find: mocks.find,
    findOne: mocks.findOne,
    findOneAndUpdate: mocks.findOneAndUpdate,
    findOneAndDelete: mocks.findOneAndDelete,
    create: mocks.create,
  },
}));

const {
  deleteStarredMessage,
  escapeRegExp,
  findStarredMessageById,
  findStarredMessages,
  updateStarredMessage,
} = await import('./starred-message.repository.js');

const organizationId = 'org-1';
const userId = 'user-1';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.find.mockReturnValue(chain());
  mocks.findOne.mockReturnValue({ exec: vi.fn().mockResolvedValue(null) });
  mocks.findOneAndUpdate.mockReturnValue({ exec: vi.fn().mockResolvedValue(null) });
  mocks.findOneAndDelete.mockReturnValue({ exec: vi.fn().mockResolvedValue(null) });
});

describe('every filter carries both the organisation and the user', () => {
  it('list', async () => {
    await findStarredMessages({ organizationId, userId });

    expect(mocks.find).toHaveBeenCalledWith(expect.objectContaining({ organizationId, userId }));
  });

  it('read by id', async () => {
    await findStarredMessageById({ starredMessageId: 'starred-1', organizationId, userId });

    expect(mocks.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'starred-1', organizationId, userId }),
    );
  });

  it('update', async () => {
    await updateStarredMessage({
      starredMessageId: 'starred-1',
      organizationId,
      userId,
      title: 'Edited',
    });

    expect(mocks.findOneAndUpdate.mock.calls[0]![0]).toEqual(
      expect.objectContaining({ _id: 'starred-1', organizationId, userId }),
    );
  });

  it('delete', async () => {
    await deleteStarredMessage({ starredMessageId: 'starred-1', organizationId, userId });

    expect(mocks.findOneAndDelete).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'starred-1', organizationId, userId }),
    );
  });
});

describe('what an update is allowed to write', () => {
  it('leaves the source message alone even when one is passed in', async () => {
    // Rewriting `sourceMessageId` would let a saved message claim to be a different bubble,
    // and the star on that bubble would follow it.
    // Cast because the parameter type does not admit this field - which is itself the point.
    // A caller reaching the repository another way (a controller that spreads req.body, say)
    // would have no such protection, so the runtime behaviour is what gets asserted.
    await updateStarredMessage({
      starredMessageId: 'starred-1',
      organizationId,
      userId,
      title: 'Edited',
      sourceMessageId: 'hijacked',
    } as unknown as Parameters<typeof updateStarredMessage>[0]);

    expect(mocks.findOneAndUpdate.mock.calls[0]![1]).toEqual({ $set: { title: 'Edited' } });
  });

  it('omits a field that was not supplied, rather than nulling it', async () => {
    await updateStarredMessage({
      starredMessageId: 'starred-1',
      organizationId,
      userId,
      body: 'New body',
    });

    // A PATCH with only a body must not wipe the title.
    expect(mocks.findOneAndUpdate.mock.calls[0]![1]).toEqual({ $set: { body: 'New body' } });
  });
});

describe('search', () => {
  it('matches title or body, case-insensitively', async () => {
    await findStarredMessages({ organizationId, userId, search: 'Drone' });

    const filter = mocks.find.mock.calls[0]![0] as { $or: { title?: RegExp; body?: RegExp }[] };

    expect(filter.$or).toHaveLength(2);
    expect(filter.$or[0]!.title!.flags).toContain('i');
    expect(filter.$or[0]!.title!.test('drone coverage')).toBe(true);
  });

  it('ESCAPES REGEX METACHARACTERS instead of compiling them', async () => {
    await findStarredMessages({ organizationId, userId, search: '.*' });

    const filter = mocks.find.mock.calls[0]![0] as { $or: { title?: RegExp }[] };
    const pattern = filter.$or[0]!.title!;

    // Unescaped, `.*` matches everything the user ever saved. Escaped, it matches the literal.
    expect(pattern.test('anything at all')).toBe(false);
    expect(pattern.test('price list .* here')).toBe(true);
  });

  it('does not throw on an unbalanced bracket', async () => {
    // `new RegExp('(')` is a SyntaxError, so without escaping this is a 500 from a typo.
    await expect(
      findStarredMessages({ organizationId, userId, search: '(' }),
    ).resolves.toBeDefined();
  });

  it('adds no $or at all when the term is blank', async () => {
    await findStarredMessages({ organizationId, userId, search: '   ' });

    expect(mocks.find.mock.calls[0]![0]).not.toHaveProperty('$or');
  });

  it('escapeRegExp leaves ordinary text untouched', () => {
    expect(escapeRegExp('drone coverage')).toBe('drone coverage');
    expect(escapeRegExp('a+b')).toBe('a\\+b');
  });
});
