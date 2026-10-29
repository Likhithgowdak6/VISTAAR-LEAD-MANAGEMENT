/**
 * Who may ask for the Team task list.
 *
 * WHY THIS IS A SERVER TEST AND NOT A UI ONE. `scope` arrives in a query string. Hiding the
 * Team tab from a user who lacks the permission is a courtesy, not a control - anyone can type
 * `?scope=team` into the address bar, or replay the request from the Android app. So the gate
 * has to be here, and the test has to prove it is here rather than that the tab is hidden.
 *
 * THE PERMISSION IS REUSED, NOT INVENTED. CONVERSATIONS_READ_ALL is already what decides
 * whether somebody may see work assigned to other people - see assertConversationVisible in
 * conversation.service.ts. A second permission meaning the same thing is how two checks that
 * were supposed to agree quietly stop agreeing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

vi.mock('../../config/database.js', () => ({
  runInTransaction: (command: (session: undefined) => unknown) => command(undefined),
}));

const mocks = vi.hoisted(() => ({
  findOrganizationTasks: vi.fn(),
  findFollowUpTaskById: vi.fn(),
  updateTaskStatus: vi.fn(),
  createFollowUpTask: vi.fn(),
  findFollowUpTasksByConversation: vi.fn(),
  findPendingTasksByUser: vi.fn(),
  rescheduleReminder: vi.fn(),
  findEarliestPendingDueAt: vi.fn(),
  createActivity: vi.fn(),
  loadVisibleConversationForActor: vi.fn(),
  syncQuietly: vi.fn(),
}));

vi.mock('./followup-task.repository.js', () => ({
  findOrganizationTasks: mocks.findOrganizationTasks,
  findFollowUpTaskById: mocks.findFollowUpTaskById,
  updateTaskStatus: mocks.updateTaskStatus,
  createFollowUpTask: mocks.createFollowUpTask,
  findFollowUpTasksByConversation: mocks.findFollowUpTasksByConversation,
  findPendingTasksByUser: mocks.findPendingTasksByUser,
  rescheduleReminder: mocks.rescheduleReminder,
  findEarliestPendingDueAt: mocks.findEarliestPendingDueAt,
}));

vi.mock('../activity/activity-log.repository.js', () => ({ createActivity: mocks.createActivity }));

vi.mock('../conversations/conversation.service.js', () => ({
  loadVisibleConversationForActor: mocks.loadVisibleConversationForActor,
}));

vi.mock('./next-follow-up.service.js', () => ({
  getNextFollowUpSync: () => ({ syncQuietly: mocks.syncQuietly }),
}));

const { listOrganizationTasksForActor } = await import('./followup.service.js');
const { PERMISSIONS } = await import('../../constants/permissions.js');

const ORG = '6ab4c2037469f65204cfe999';
const actor = { _id: '6ab4c2037469f65204cfe111' } as never;

const call = (
  scope: 'mine' | 'team',
  permissions: readonly string[],
  overrides: Record<string, unknown> = {},
) =>
  listOrganizationTasksForActor({
    organizationId: ORG,
    actor,
    permissions: permissions as never,
    scope,
    ...overrides,
  } as never);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findOrganizationTasks.mockResolvedValue({
    rows: [],
    matched: 0,
    counts: { total: 0, pending: 0, overdue: 0, completed: 0, cancelled: 0 },
  });
});

describe('the team gate', () => {
  it('REFUSES team to a user without conversations.read_all', async () => {
    await expect(call('team', [PERMISSIONS.CRM_TASKS_MANAGE])).rejects.toThrow(
      'TASKS_TEAM_ACCESS_DENIED',
    );
  });

  it('does not even reach the database when it refuses', async () => {
    // The refusal must happen before the query, not be filtered out of its results - otherwise
    // a mistake downstream turns a 403 into a silent leak.
    await expect(call('team', [PERMISSIONS.CRM_TASKS_MANAGE])).rejects.toThrow();

    expect(mocks.findOrganizationTasks).not.toHaveBeenCalled();
  });

  it('allows team with conversations.read_all', async () => {
    await call('team', [PERMISSIONS.CRM_TASKS_MANAGE, PERMISSIONS.CONVERSATIONS_READ_ALL]);

    expect(mocks.findOrganizationTasks).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'team' }),
    );
  });

  it('ALLOWS MINE WITHOUT ANY EXTRA PERMISSION', async () => {
    // Looking at your own assignments is not a privilege. A staff member with only
    // crm.tasks.manage - which the route already requires - must still get their own list.
    await call('mine', [PERMISSIONS.CRM_TASKS_MANAGE]);

    expect(mocks.findOrganizationTasks).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'mine' }),
    );
  });
});

describe('what reaches the query', () => {
  it('always passes the caller’s own organisation and id', async () => {
    await call('mine', [PERMISSIONS.CRM_TASKS_MANAGE]);

    expect(mocks.findOrganizationTasks).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, actorId: actor._id }),
    );
  });

  it('forwards the filters it was given', async () => {
    const dueFrom = new Date('2026-10-30T00:00:00.000Z');

    await call('mine', [PERMISSIONS.CRM_TASKS_MANAGE], {
      status: 'late',
      search: 'vaishu',
      dueFrom,
      limit: 10,
      skip: 20,
    });

    expect(mocks.findOrganizationTasks).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'late',
        search: 'vaishu',
        dueFrom,
        limit: 10,
        skip: 20,
      }),
    );
  });

  it('returns the counts alongside the rows', async () => {
    mocks.findOrganizationTasks.mockResolvedValue({
      rows: [],
      matched: 14,
      counts: { total: 35, pending: 20, overdue: 14, completed: 12, cancelled: 3 },
    });

    const result = await call('mine', [PERMISSIONS.CRM_TASKS_MANAGE]);

    expect(result.matched).toBe(14);
    expect(result.counts.overdue).toBe(14);
  });
});

describe('serialisation', () => {
  it('carries the lead’s name, and NEVER its phone number', async () => {
    // The card needs a name. A list endpoint is the worst possible place to hand out phone
    // numbers in bulk - revealing one is its own permissioned action (client_pii.reveal).
    mocks.findOrganizationTasks.mockResolvedValue({
      rows: [
        {
          _id: '6adf2dd59f91cdd63f09e0f3',
          organizationId: ORG,
          conversationId: '68f1a2b3c4d5e6f708192a3b',
          assignedTo: actor._id,
          title: 'Call vaishu',
          status: 'pending',
          dueAt: new Date('2026-10-30T15:40:00.000Z'),
          conversation: {
            _id: '68f1a2b3c4d5e6f708192a3b',
            displayName: 'vaishu',
            leadId: 'L-1042',
            phone: '+919876543210',
          },
        },
      ],
      matched: 1,
      counts: { total: 1, pending: 1, overdue: 0, completed: 0, cancelled: 0 },
    });

    const result = await call('mine', [PERMISSIONS.CRM_TASKS_MANAGE]);

    expect(result.tasks[0]?.lead).toEqual({
      conversationId: '68f1a2b3c4d5e6f708192a3b',
      displayName: 'vaishu',
      leadId: 'L-1042',
    });
    expect(JSON.stringify(result.tasks[0])).not.toContain('919876543210');
  });

  it('leaves lead null for a personal reminder', async () => {
    mocks.findOrganizationTasks.mockResolvedValue({
      rows: [
        {
          _id: '6adf2dd59f91cdd63f09e0f4',
          organizationId: ORG,
          conversationId: null,
          assignedTo: actor._id,
          title: 'Review the campaign',
          status: 'pending',
          dueAt: new Date('2026-10-30T11:00:00.000Z'),
        },
      ],
      matched: 1,
      counts: { total: 1, pending: 1, overdue: 0, completed: 0, cancelled: 0 },
    });

    const result = await call('mine', [PERMISSIONS.CRM_TASKS_MANAGE]);

    // Null rather than an empty object, so the card renders no customer line at all instead of
    // a blank one that reads as a name we failed to load.
    expect(result.tasks[0]?.lead).toBeNull();
  });
});
