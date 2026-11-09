/**
 * CHARACTERISATION TESTS for the Mongo filters. Written before the Python port; this module
 * shipped with zero tests.
 *
 * THE FILTER IS ASSERTED, NOT THE RESULT. A filter that forgot `organizationId` still returns
 * rows, and the list looks perfectly healthy from the outside - it is simply another studio's
 * tags. Only the filter itself shows that.
 *
 * THE GLOBAL-TAG RULE IS THE ONE A PORT GETS WRONG. A tag with `whatsappAccountId: null` belongs
 * to every account in the organisation. Listing for a specific account must return BOTH that
 * account's own tags and the global ones; narrowing to the account alone makes the org-wide tags
 * disappear from the picker with no error anywhere.
 *
 * Mocked model, no real Mongo.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const model = vi.hoisted(() => ({
  find: vi.fn(),
  findOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
  create: vi.fn(),
}));

vi.mock('./tag.model.js', () => ({ Tag: model }));

const {
  archiveTag,
  createTag,
  findTagById,
  findTagBySlugInScope,
  findTagsByOrganization,
} = await import('./tag.repository.js');

const ORG = new Types.ObjectId();
const ACCOUNT = new Types.ObjectId();

const findChain = () => {
  const exec = vi.fn().mockResolvedValue([]);
  const limit = vi.fn(() => ({ exec }));
  const skip = vi.fn(() => ({ limit }));
  const sort = vi.fn(() => ({ skip }));

  model.find.mockReturnValue({ sort });

  return { sort, skip, limit, exec };
};

beforeEach(() => {
  vi.clearAllMocks();
  model.findOne.mockReturnValue({ exec: vi.fn().mockResolvedValue(null) });
  model.findOneAndUpdate.mockReturnValue({ exec: vi.fn().mockResolvedValue(null) });
});

describe('findTagsByOrganization', () => {
  it('always scopes to the organisation', async () => {
    findChain();

    await findTagsByOrganization({ organizationId: ORG, status: 'active' });

    expect(model.find).toHaveBeenCalledWith({ organizationId: ORG, status: 'active' });
  });

  it('omits the status key entirely when none is given', async () => {
    findChain();

    await findTagsByOrganization({ organizationId: ORG });

    expect('status' in model.find.mock.calls[0][0]).toBe(false);
  });

  it("INCLUDES GLOBAL TAGS ALONGSIDE AN ACCOUNT'S OWN BY DEFAULT", async () => {
    findChain();

    await findTagsByOrganization({ organizationId: ORG, whatsappAccountId: ACCOUNT });

    expect(model.find.mock.calls[0][0].whatsappAccountId).toEqual({ $in: [null, ACCOUNT] });
  });

  it('narrows to the account alone when includeGlobal is false', async () => {
    findChain();

    await findTagsByOrganization({
      organizationId: ORG,
      whatsappAccountId: ACCOUNT,
      includeGlobal: false,
    });

    expect(model.find.mock.calls[0][0].whatsappAccountId).toBe(ACCOUNT);
  });

  it('does not filter on account at all when none is given', async () => {
    findChain();

    await findTagsByOrganization({ organizationId: ORG });

    expect('whatsappAccountId' in model.find.mock.calls[0][0]).toBe(false);
  });

  it('SORTS BY NAME ASCENDING, defaulting to 100 rows from offset 0', async () => {
    const { sort, skip, limit } = findChain();

    await findTagsByOrganization({ organizationId: ORG });

    expect(sort).toHaveBeenCalledWith({ name: 1 });
    expect(skip).toHaveBeenCalledWith(0);
    expect(limit).toHaveBeenCalledWith(100);
  });

  it('applies the pagination it is given', async () => {
    const { skip, limit } = findChain();

    await findTagsByOrganization({ organizationId: ORG, limit: 25, skip: 50 });

    expect(skip).toHaveBeenCalledWith(50);
    expect(limit).toHaveBeenCalledWith(25);
  });
});

describe('findTagBySlugInScope', () => {
  it('MATCHES THE GLOBAL SCOPE AS A VALUE, NOT AS AN ABSENT FILTER', async () => {
    // `whatsappAccountId: null` must appear in the query. Dropping the key would let the lookup
    // match an account-scoped tag and reject a legitimate global one with a 409.
    await findTagBySlugInScope({ organizationId: ORG, slug: 'VIP' });

    expect(model.findOne).toHaveBeenCalledWith({
      organizationId: ORG,
      whatsappAccountId: null,
      slug: 'vip',
    });
  });

  it('normalises the slug before looking it up', async () => {
    await findTagBySlugInScope({ organizationId: ORG, slug: '  Repeat Client  ' });

    expect(model.findOne.mock.calls[0][0].slug).toBe('repeat-client');
  });
});

describe('findTagById', () => {
  it('SCOPES TO THE ORGANISATION IN THE QUERY, not as a follow-up check', async () => {
    const id = new Types.ObjectId();

    await findTagById({ tagId: id, organizationId: ORG });

    expect(model.findOne).toHaveBeenCalledWith({ _id: id, organizationId: ORG });
  });
});

describe('createTag', () => {
  it('normalises the slug and defaults the optional fields', async () => {
    model.create.mockResolvedValue({});

    await createTag({ organizationId: ORG, name: 'Repeat Client' });

    expect(model.create).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'repeat-client',
        name: 'Repeat Client',
        whatsappAccountId: null,
        createdBy: null,
      }),
    );
  });
});

describe('archiveTag', () => {
  it('SETS THE STATUS AND RETURNS THE UPDATED ROW', async () => {
    const id = new Types.ObjectId();
    const actor = new Types.ObjectId();

    await archiveTag({ tagId: id, organizationId: ORG, actorId: actor });

    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: id, organizationId: ORG },
      { $set: { status: 'archived', updatedBy: actor } },
      // `after`, not the Mongoose default - the route answers with the archived row, so
      // returning the pre-update document would show the caller `active` right after archiving.
      { returnDocument: 'after', runValidators: true },
    );
  });
});
