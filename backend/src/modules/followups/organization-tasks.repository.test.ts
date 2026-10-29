/**
 * The query behind the centralised Tasks screen.
 *
 * WHY THE PIPELINE ITSELF IS THE SUBJECT. This is one aggregation that decides who may see
 * what, and every test in this module mocks the model rather than touching a database - so the
 * thing that can actually be asserted is the pipeline handed to Mongo. That is also the thing
 * worth asserting: a missing `organizationId` in the base `$match` is a cross-tenant leak that
 * no amount of UI testing would catch, because the UI would look perfect while serving another
 * studio's reminders.
 *
 * THE PRIVACY RULE THIS PINS. `team` must include every LEAD follow-up plus the caller's OWN
 * personal reminders, and must NOT include anybody else's personal reminders. That boundary is
 * older than this screen - followup.service.ts refuses cross-user transitions on them and the
 * device sync is assignee-scoped - and a team list is exactly where it would be lost.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const mocks = vi.hoisted(() => ({ aggregate: vi.fn() }));

vi.mock('./followup-task.model.js', () => ({
  FollowUpTask: { aggregate: mocks.aggregate },
}));

const { findOrganizationTasks } = await import('./followup-task.repository.js');

const ORG = '6ab4c2037469f65204cfe999';
const OTHER_ORG = '6ab4c2037469f65204cfe888';
const ACTOR = '6ab4c2037469f65204cfe111';
const NOW = new Date('2026-10-30T09:00:00.000Z');

/** The pipeline as Mongo received it. */
const pipeline = () => mocks.aggregate.mock.calls[0]![0] as Record<string, never>[];

const stage = (name: string) =>
  pipeline().find((entry) => Object.prototype.hasOwnProperty.call(entry, name)) as
    | Record<string, never>
    | undefined;

const facet = () => (stage('$facet') as never as { $facet: Record<string, unknown[]> }).$facet;

const run = (overrides: Record<string, unknown> = {}) =>
  findOrganizationTasks({
    organizationId: ORG,
    actorId: ACTOR,
    scope: 'mine',
    now: NOW,
    ...overrides,
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.aggregate.mockResolvedValue([{ rows: [], matched: [], counts: [] }]);
});

describe('organisation isolation', () => {
  it('SCOPES EVERY QUERY BY ORGANIZATION, in the first stage', async () => {
    await run();

    const match = (stage('$match') as never as { $match: Record<string, unknown> }).$match;

    expect(String(match.organizationId)).toBe(ORG);
  });

  it('cannot be widened by a search term or a status filter', async () => {
    // Both arrive from a query string. Neither may reach outside the tenant.
    await run({ search: 'vaishu', status: 'late', scope: 'team' });

    const match = (stage('$match') as never as { $match: Record<string, unknown> }).$match;

    expect(String(match.organizationId)).toBe(ORG);
    expect(String(match.organizationId)).not.toBe(OTHER_ORG);
  });
});

describe('mine versus team', () => {
  it('mine is the caller’s own assignments and nothing else', async () => {
    await run({ scope: 'mine' });

    const match = (stage('$match') as never as { $match: Record<string, unknown> }).$match;

    expect(String(match.assignedTo)).toBe(ACTOR);
    expect(match.$or).toBeUndefined();
  });

  it('TEAM EXCLUDES OTHER PEOPLE’S PERSONAL REMINDERS', async () => {
    // The whole rule in one assertion: a row qualifies if it is MINE, or if it belongs to a
    // LEAD. A personal reminder of a colleague's is neither, so it cannot match. Widening this
    // to a bare organizationId filter would expose "call the bank about the overdraft" to the
    // entire studio.
    await run({ scope: 'team' });

    const match = (stage('$match') as never as { $match: Record<string, unknown> }).$match;
    const clauses = match.$or as Record<string, unknown>[];

    expect(clauses).toHaveLength(2);
    expect(String(clauses[0]!.assignedTo)).toBe(ACTOR);
    expect(clauses[1]!.conversationId).toEqual({ $ne: null });
  });
});

describe('the status chips', () => {
  it('filters the page but NEVER the counts', async () => {
    // The chips have to be able to say "Done 112" while the pending list is on screen. If the
    // status filter reached the counts facet, every chip would read as the count of itself.
    await run({ status: 'completed' });

    expect(JSON.stringify(facet().rows)).toContain('completed');
    expect(JSON.stringify(facet().counts)).not.toContain('$match');
  });

  it('treats late as DERIVED, not as a stored status', async () => {
    // `missed` exists in the enum and nothing has ever written it, so "late" can only mean
    // pending-and-past-due. Matching on a status of 'late' would return nothing, forever.
    await run({ status: 'late' });

    expect(JSON.stringify(facet().rows)).toContain('overdueRank');
    expect(JSON.stringify(facet().rows)).not.toContain('"status":"late"');
  });

  it('computes overdue against the supplied clock', async () => {
    await run();

    const added = JSON.stringify(stage('$addFields'));

    expect(added).toContain('pending');
    expect(added).toContain(NOW.toISOString());
  });

  it('applies no status match at all when no chip is selected', async () => {
    await run({ status: null });

    expect(JSON.stringify(facet().rows)).not.toContain('$match');
  });
});

describe('search', () => {
  it('covers the task title, its note and the customer’s name', async () => {
    await run({ search: 'vaishu' });

    const text = JSON.stringify(pipeline());

    expect(text).toContain('title');
    expect(text).toContain('note');
    expect(text).toContain('conversation.displayName');
  });

  it('ESCAPES THE TERM before it reaches the regex', async () => {
    // Unescaped, `(a+)+$` is catastrophic backtracking executed inside the database, and a lone
    // `(` is a 500. Escaped, it is matched literally - which is also what somebody typing a
    // customer's name expects.
    await run({ search: '(a+)+$' });

    const text = JSON.stringify(pipeline());

    expect(text).toContain('\\\\(a\\\\+\\\\)\\\\+\\\\$');
  });

  it('ignores a blank term rather than matching everything slowly', async () => {
    await run({ search: '   ' });

    expect(JSON.stringify(pipeline())).not.toContain('$regex');
  });
});

describe('ordering and pagination', () => {
  it('puts overdue first, then soonest due', async () => {
    await run();

    const sort = (facet().rows.find((entry) =>
      Object.prototype.hasOwnProperty.call(entry as object, '$sort'),
    ) as { $sort: Record<string, number> }).$sort;

    expect(Object.keys(sort)).toEqual(['overdueRank', 'dueAt', '_id']);
    expect(sort.overdueRank).toBe(1);
    expect(sort.dueAt).toBe(1);
  });

  it('BREAKS TIES ON _id, so pagination cannot skip or repeat a row', async () => {
    // Two reminders set for the same minute is ordinary. Without a total order Mongo may
    // return them either way round, so one appears on both pages and the other on neither.
    await run();

    const sort = (facet().rows.find((entry) =>
      Object.prototype.hasOwnProperty.call(entry as object, '$sort'),
    ) as { $sort: Record<string, number> }).$sort;

    expect(sort._id).toBe(1);
  });

  it('passes the window through', async () => {
    await run({ limit: 10, skip: 20 });

    expect(facet().rows).toContainEqual({ $skip: 20 });
    expect(facet().rows).toContainEqual({ $limit: 10 });
  });

  it('narrows counts as well as rows for a due-date window', async () => {
    // A date window is the caller saying "only this period". A count reaching outside it would
    // be answering a question nobody asked.
    const dueFrom = new Date('2026-10-30T00:00:00.000Z');
    const dueTo = new Date('2026-10-30T23:59:59.000Z');

    await run({ dueFrom, dueTo });

    const match = (stage('$match') as never as { $match: Record<string, unknown> }).$match;

    expect(match.dueAt).toEqual({ $gte: dueFrom, $lte: dueTo });
  });
});

describe('the lead each task is about', () => {
  it('joins only the two fields a card draws', async () => {
    await run();

    const lookup = (stage('$lookup') as never as {
      $lookup: { from: string; pipeline: Record<string, unknown>[] };
    }).$lookup;

    expect(lookup.from).toBe('conversations');
    // Never the whole conversation: a task card has no use for the thread, the AI facts or the
    // encrypted lead payload, and the phone number is a permissioned reveal of its own.
    expect(lookup.pipeline).toEqual([{ $project: { displayName: 1, leadId: 1 } }]);
  });

  it('KEEPS PERSONAL REMINDERS, which have no conversation to join', async () => {
    await run();

    const unwind = (stage('$unwind') as never as {
      $unwind: { preserveNullAndEmptyArrays: boolean };
    }).$unwind;

    expect(unwind.preserveNullAndEmptyArrays).toBe(true);
  });
});

describe('the result', () => {
  it('reports counts and totals from the facet', async () => {
    mocks.aggregate.mockResolvedValue([
      {
        rows: [{ _id: 'a' }],
        matched: [{ value: 14 }],
        counts: [{ total: 35, pending: 20, overdue: 14, completed: 12, cancelled: 3 }],
      },
    ]);

    const result = await run();

    expect(result.matched).toBe(14);
    expect(result.counts).toEqual({
      total: 35,
      pending: 20,
      overdue: 14,
      completed: 12,
      cancelled: 3,
    });
  });

  it('reads an empty result as zeroes rather than throwing', async () => {
    // A studio with no tasks at all, and the shape Mongo returns for it: empty facet arrays.
    mocks.aggregate.mockResolvedValue([{ rows: [], matched: [], counts: [] }]);

    const result = await run();

    expect(result.rows).toEqual([]);
    expect(result.matched).toBe(0);
    expect(result.counts.total).toBe(0);
  });
});
