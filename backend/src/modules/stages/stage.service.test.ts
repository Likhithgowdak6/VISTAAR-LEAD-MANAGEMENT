/**
 * CHARACTERISATION TESTS. Written before the Python port, against the Node implementation as it
 * stands, to capture behaviour that is currently specified nowhere - this module shipped with
 * zero tests.
 *
 * THE RULE THAT MATTERS MOST IS `normalizeStageKey`. A stage's key is not an opaque id: it is
 * the literal string written into `Conversation.stage`, and `conversation.service.ts` calls
 * `resolveUsableStageValue` to look it up again on every stage change. After the routes move to
 * Python, Node KEEPS that lookup - the Stage collection is shared. So if Python normalises
 * "Follow Up!" to anything other than `follow-up`, every stage Python creates becomes a value
 * Node refuses with INVALID_STAGE. Nothing would fail at deploy time; it would surface as the
 * owner being unable to move a lead into a stage he can see in the list.
 *
 * THE SECOND IS THE RESERVED-KEY GUARD. The seven built-in stages are not rows, they are an
 * enum. A custom stage normalising onto `won` would shadow a built-in and silently change what
 * "won" means for that organisation's reporting.
 *
 * Filters are asserted rather than results: a filter missing `organizationId` still returns
 * rows, so the returned value proves nothing about tenancy.
 *
 * Mocked repository, no real Mongo.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const mocks = vi.hoisted(() => ({
  archiveStage: vi.fn(),
  createStage: vi.fn(),
  deleteStage: vi.fn(),
  findStageByKeyInOrg: vi.fn(),
  findStageById: vi.fn(),
  findStagesByOrganization: vi.fn(),
}));

vi.mock('./stage.repository.js', async () => {
  // `normalizeStageKey` is deliberately NOT mocked - it is the behaviour under test.
  const actual = await vi.importActual<typeof import('./stage.repository.js')>(
    './stage.repository.js',
  );

  return { ...actual, ...mocks };
});

const {
  archiveStageForActor,
  createStageForActor,
  deleteStageForActor,
  listStagesForOrganization,
  resolveUsableStageValue,
} = await import('./stage.service.js');

const { normalizeStageKey } = await import('./stage.repository.js');

const ORG = new Types.ObjectId();
// The id is held separately because ACTOR is cast to `never` so it can stand in for a
// HydratedDocument at the call sites - reading `._id` back off a `never` does not
// typecheck, even though it is present at runtime.
const ACTOR_ID = new Types.ObjectId();
const ACTOR = { _id: ACTOR_ID } as never;

const stageRow = (over: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  organizationId: ORG,
  key: 'follow-up',
  label: 'Follow Up',
  color: null,
  status: 'active',
  createdBy: null,
  updatedBy: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findStagesByOrganization.mockResolvedValue([]);
  mocks.findStageByKeyInOrg.mockResolvedValue(null);
});

describe('normalizeStageKey', () => {
  // The exact table the Python port must reproduce. Each row is a real thing an owner types.
  it.each([
    ['Follow Up', 'follow-up'],
    ['  Follow  Up  ', 'follow-up'],
    ['FOLLOW_UP', 'follow-up'],
    ['Follow-Up', 'follow-up'],
    ['Site Visit #2', 'site-visit-2'],
    ['Awaiting Advance ₹', 'awaiting-advance'],
    ['---edge---', 'edge'],
    ['a', 'a'],
  ])('maps %j to %j', (input, expected) => {
    expect(normalizeStageKey(input)).toBe(expected);
  });

  it('COLLAPSES RUNS OF SEPARATORS INTO ONE HYPHEN', () => {
    // Not `follow---up`. A Python `re.sub` that forgets the `+` produces that instead, and the
    // resulting key would never match what Node looks up.
    expect(normalizeStageKey('follow   up')).toBe('follow-up');
  });

  it('can produce an empty string, which the model then rejects', () => {
    // Documented, not endorsed: the service does not guard this, so a label of only punctuation
    // reaches the schema and fails its `match`. Python must fail here too, not succeed.
    expect(normalizeStageKey('!!!')).toBe('');
  });
});

describe('createStageForActor', () => {
  it('DERIVES THE KEY FROM THE LABEL WHEN NONE IS GIVEN', async () => {
    mocks.createStage.mockResolvedValue(stageRow());

    await createStageForActor({ organizationId: ORG, actor: ACTOR, label: 'Follow Up' });

    expect(mocks.createStage).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'follow-up', label: 'Follow Up' }),
    );
  });

  it('NORMALISES AN EXPLICIT KEY TOO', async () => {
    mocks.createStage.mockResolvedValue(stageRow());

    await createStageForActor({
      organizationId: ORG,
      actor: ACTOR,
      label: 'Anything',
      key: 'Site Visit',
    });

    expect(mocks.createStage).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'site-visit' }),
    );
  });

  it('stores the label verbatim, not normalised', async () => {
    mocks.createStage.mockResolvedValue(stageRow());

    await createStageForActor({ organizationId: ORG, actor: ACTOR, label: 'Follow Up' });

    expect(mocks.createStage.mock.calls[0][0].label).toBe('Follow Up');
  });

  it.each(['new', 'contacted', 'qualified', 'proposal', 'won', 'lost', 'closed'])(
    'REFUSES THE RESERVED BUILT-IN KEY %j',
    async (reserved) => {
      await expect(
        createStageForActor({ organizationId: ORG, actor: ACTOR, label: reserved }),
      ).rejects.toThrow('STAGE_KEY_RESERVED');

      expect(mocks.createStage).not.toHaveBeenCalled();
    },
  );

  it('REFUSES A LABEL THAT NORMALISES ONTO A BUILT-IN', async () => {
    // "Won " and "WON" are not the reserved word by string equality - they become it only after
    // normalisation, which is why the guard runs on the normalised value.
    await expect(
      createStageForActor({ organizationId: ORG, actor: ACTOR, label: '  WON  ' }),
    ).rejects.toThrow('STAGE_KEY_RESERVED');
  });

  it('refuses a duplicate key in the same organisation', async () => {
    mocks.findStageByKeyInOrg.mockResolvedValue(stageRow());

    await expect(
      createStageForActor({ organizationId: ORG, actor: ACTOR, label: 'Follow Up' }),
    ).rejects.toThrow('STAGE_KEY_EXISTS');

    expect(mocks.createStage).not.toHaveBeenCalled();
  });

  it('CHECKS THE RESERVED LIST BEFORE TOUCHING THE DATABASE', async () => {
    // Ordering is observable: a reserved key must answer 400 RESERVED, never 409 EXISTS, even if
    // a row somehow shares the key.
    mocks.findStageByKeyInOrg.mockResolvedValue(stageRow({ key: 'won' }));

    await expect(
      createStageForActor({ organizationId: ORG, actor: ACTOR, label: 'won' }),
    ).rejects.toThrow('STAGE_KEY_RESERVED');

    expect(mocks.findStageByKeyInOrg).not.toHaveBeenCalled();
  });

  it('scopes the duplicate check to the organisation', async () => {
    mocks.createStage.mockResolvedValue(stageRow());

    await createStageForActor({ organizationId: ORG, actor: ACTOR, label: 'Follow Up' });

    expect(mocks.findStageByKeyInOrg).toHaveBeenCalledWith({
      organizationId: ORG,
      key: 'follow-up',
    });
  });

  it('records the actor as createdBy', async () => {
    mocks.createStage.mockResolvedValue(stageRow());

    await createStageForActor({ organizationId: ORG, actor: ACTOR, label: 'Follow Up' });

    expect(mocks.createStage.mock.calls[0][0].createdBy).toBe(ACTOR_ID);
  });

  it('returns the serialized shape, not the document', async () => {
    const row = stageRow();
    mocks.createStage.mockResolvedValue(row);

    const result = await createStageForActor({
      organizationId: ORG,
      actor: ACTOR,
      label: 'Follow Up',
    });

    expect(result).toEqual({
      id: row._id.toString(),
      organizationId: ORG.toString(),
      key: 'follow-up',
      label: 'Follow Up',
      color: null,
      status: 'active',
      createdBy: null,
      updatedBy: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });
});

describe('listStagesForOrganization', () => {
  it('passes the organisation, status and pagination straight through', async () => {
    await listStagesForOrganization({
      organizationId: ORG,
      status: 'active',
      limit: 25,
      skip: 50,
    });

    expect(mocks.findStagesByOrganization).toHaveBeenCalledWith({
      organizationId: ORG,
      status: 'active',
      limit: 25,
      skip: 50,
    });
  });

  it('omits the status filter when none is asked for', async () => {
    await listStagesForOrganization({ organizationId: ORG });

    expect(mocks.findStagesByOrganization.mock.calls[0][0].status).toBeUndefined();
  });
});

describe('archiveStageForActor', () => {
  it('ARCHIVES RATHER THAN DELETES', async () => {
    const row = stageRow();
    mocks.findStageById.mockResolvedValue(row);
    mocks.archiveStage.mockResolvedValue(stageRow({ _id: row._id, status: 'archived' }));

    const result = await archiveStageForActor({
      organizationId: ORG,
      stageId: row._id,
      actor: ACTOR,
    });

    expect(result?.status).toBe('archived');
    expect(mocks.deleteStage).not.toHaveBeenCalled();
  });

  it('records the actor as updatedBy', async () => {
    const row = stageRow();
    mocks.findStageById.mockResolvedValue(row);
    mocks.archiveStage.mockResolvedValue(row);

    await archiveStageForActor({ organizationId: ORG, stageId: row._id, actor: ACTOR });

    expect(mocks.archiveStage).toHaveBeenCalledWith({
      stageId: row._id,
      organizationId: ORG,
      actorId: ACTOR_ID,
    });
  });

  it('REFUSES A STAGE FROM ANOTHER ORGANISATION', async () => {
    // The scoping lives in the lookup filter, so a miss is indistinguishable from "not found" -
    // which is the correct answer to give a cross-tenant id.
    mocks.findStageById.mockResolvedValue(null);

    await expect(
      archiveStageForActor({
        organizationId: ORG,
        stageId: new Types.ObjectId(),
        actor: ACTOR,
      }),
    ).rejects.toThrow('STAGE_NOT_FOUND');

    expect(mocks.archiveStage).not.toHaveBeenCalled();
  });
});

describe('deleteStageForActor', () => {
  it('returns the removed record', async () => {
    const row = stageRow();
    mocks.deleteStage.mockResolvedValue(row);

    const result = await deleteStageForActor({ organizationId: ORG, stageId: row._id });

    expect(result?.id).toBe(row._id.toString());
  });

  it('scopes the delete to the organisation IN THE QUERY', async () => {
    const id = new Types.ObjectId();
    mocks.deleteStage.mockResolvedValue(stageRow());

    await deleteStageForActor({ organizationId: ORG, stageId: id });

    expect(mocks.deleteStage).toHaveBeenCalledWith({ stageId: id, organizationId: ORG });
  });

  it('is not found when nothing matched', async () => {
    mocks.deleteStage.mockResolvedValue(null);

    await expect(
      deleteStageForActor({ organizationId: ORG, stageId: new Types.ObjectId() }),
    ).rejects.toThrow('STAGE_NOT_FOUND');
  });
});

describe('resolveUsableStageValue', () => {
  /**
   * THE CROSS-SERVICE SEAM. Node's `conversation.service.ts` calls this on every stage change
   * and will keep calling it after the stage ROUTES move to Python. These assertions are the
   * contract between the two services.
   */

  it.each(['new', 'contacted', 'qualified', 'proposal', 'won', 'lost', 'closed'])(
    'accepts the built-in %j without a database read',
    async (builtIn) => {
      await expect(resolveUsableStageValue({ organizationId: ORG, stage: builtIn })).resolves.toBe(
        builtIn,
      );

      expect(mocks.findStageByKeyInOrg).not.toHaveBeenCalled();
    },
  );

  it('RETURNS THE STORED KEY, NOT THE INPUT', async () => {
    // A differently-cased input must land on the exact stored key, or the conversation ends up
    // holding a value no lookup will ever match again.
    mocks.findStageByKeyInOrg.mockResolvedValue(stageRow({ key: 'follow-up' }));

    await expect(
      resolveUsableStageValue({ organizationId: ORG, stage: 'Follow Up' }),
    ).resolves.toBe('follow-up');
  });

  it('REFUSES AN ARCHIVED CUSTOM STAGE', async () => {
    // Archiving must actually stop new assignment; otherwise it is only a display change.
    mocks.findStageByKeyInOrg.mockResolvedValue(stageRow({ status: 'archived' }));

    await expect(
      resolveUsableStageValue({ organizationId: ORG, stage: 'follow-up' }),
    ).rejects.toThrow('INVALID_STAGE');
  });

  it('refuses a key that does not exist', async () => {
    mocks.findStageByKeyInOrg.mockResolvedValue(null);

    await expect(
      resolveUsableStageValue({ organizationId: ORG, stage: 'invented' }),
    ).rejects.toThrow('INVALID_STAGE');
  });

  it('scopes the lookup to the organisation', async () => {
    mocks.findStageByKeyInOrg.mockResolvedValue(stageRow());

    await resolveUsableStageValue({ organizationId: ORG, stage: 'follow-up' });

    expect(mocks.findStageByKeyInOrg).toHaveBeenCalledWith({
      organizationId: ORG,
      key: 'follow-up',
    });
  });
});
