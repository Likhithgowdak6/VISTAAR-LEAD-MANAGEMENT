/**
 * CHARACTERISATION TESTS for the Mongo filters. Written before the Python port; this module
 * shipped with zero tests.
 *
 * THE FILTER IS ASSERTED, NOT THE RESULT. A filter that forgot `organizationId` still returns
 * rows, and the stage list looks perfectly healthy - it is simply another studio's pipeline.
 * Only the filter itself shows that.
 *
 * THE SORT IS PART OF THE API. Stages render as an ordered pipeline in the UI; a port that
 * sorted by `createdAt` would reorder every owner's board with nothing failing.
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
  findOneAndDelete: vi.fn(),
  create: vi.fn(),
}));

vi.mock('./stage.model.js', () => ({ Stage: model }));

const {
  archiveStage,
  createStage,
  deleteStage,
  findStageByKeyInOrg,
  findStageById,
  findStagesByOrganization,
} = await import('./stage.repository.js');

const ORG = new Types.ObjectId();

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
  const exec = vi.fn().mockResolvedValue(null);
  model.findOne.mockReturnValue({ exec });
  model.findOneAndUpdate.mockReturnValue({ exec });
  model.findOneAndDelete.mockReturnValue({ exec });
});

describe('findStagesByOrganization', () => {
  it('always scopes to the organisation', async () => {
    findChain();

    await findStagesByOrganization({ organizationId: ORG, status: 'active' });

    expect(model.find).toHaveBeenCalledWith({ organizationId: ORG, status: 'active' });
  });

  it('omits the status key entirely when none is given', async () => {
    findChain();

    await findStagesByOrganization({ organizationId: ORG });

    expect('status' in model.find.mock.calls[0][0]).toBe(false);
  });

  it('SORTS BY LABEL ASCENDING, defaulting to 100 rows from offset 0', async () => {
    const { sort, skip, limit } = findChain();

    await findStagesByOrganization({ organizationId: ORG });

    expect(sort).toHaveBeenCalledWith({ label: 1 });
    expect(skip).toHaveBeenCalledWith(0);
    expect(limit).toHaveBeenCalledWith(100);
  });

  it('applies the pagination it is given', async () => {
    const { skip, limit } = findChain();

    await findStagesByOrganization({ organizationId: ORG, limit: 25, skip: 50 });

    expect(skip).toHaveBeenCalledWith(50);
    expect(limit).toHaveBeenCalledWith(25);
  });
});

describe('findStageByKeyInOrg', () => {
  it('NORMALISES THE KEY BEFORE LOOKING IT UP', async () => {
    // The caller may pass whatever the owner typed. Without normalisation here, a stage created
    // as `follow-up` would be unreachable by the label `Follow Up` that produced it.
    await findStageByKeyInOrg({ organizationId: ORG, key: '  Follow Up  ' });

    expect(model.findOne).toHaveBeenCalledWith({ organizationId: ORG, key: 'follow-up' });
  });
});

describe('findStageById', () => {
  it('SCOPES TO THE ORGANISATION IN THE QUERY, not as a follow-up check', async () => {
    const id = new Types.ObjectId();

    await findStageById({ stageId: id, organizationId: ORG });

    expect(model.findOne).toHaveBeenCalledWith({ _id: id, organizationId: ORG });
  });
});

describe('createStage', () => {
  it('normalises the key from the label and defaults createdBy', async () => {
    model.create.mockResolvedValue({});

    await createStage({ organizationId: ORG, label: 'Follow Up' });

    expect(model.create).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'follow-up', label: 'Follow Up', createdBy: null }),
    );
  });
});

describe('deleteStage', () => {
  it('SCOPES THE DELETE TO THE ORGANISATION IN THE QUERY', async () => {
    // This one is permanent. A delete filtered only by `_id` would let a crafted id remove
    // another studio's stage, and there is no row left to notice it from.
    const id = new Types.ObjectId();

    await deleteStage({ stageId: id, organizationId: ORG });

    expect(model.findOneAndDelete).toHaveBeenCalledWith({ _id: id, organizationId: ORG });
  });
});

describe('archiveStage', () => {
  it('SETS THE STATUS AND RETURNS THE UPDATED ROW', async () => {
    const id = new Types.ObjectId();
    const actor = new Types.ObjectId();

    await archiveStage({ stageId: id, organizationId: ORG, actorId: actor });

    expect(model.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: id, organizationId: ORG },
      { $set: { status: 'archived', updatedBy: actor } },
      // `after`, not the Mongoose default - the route answers with the archived row, so
      // returning the pre-update document would show the caller `active` right after archiving.
      { returnDocument: 'after', runValidators: true },
    );
  });
});
