/**
 * Who may change a reminder, and which lead a new one belongs to.
 *
 * WHY THIS FILE EXISTS NOW. Reminders used to be reached through a screen of their own, where
 * the list you could act on was the list the server had already scoped to you. They are now
 * opened from inside a lead's Details panel, which means a reminder id travels with a
 * conversation id, and "can this person change this reminder" becomes a question an attacker
 * can ask directly. The guard that answers it - `transitionTask` - had no test of its own.
 *
 * The three things being defended:
 *
 *   - TENANCY. The lookup is org-scoped, so another organization's reminder is simply not
 *     found. Not "forbidden" - not found, which also avoids confirming that the id exists.
 *   - PERSONAL REMINDERS. A reminder with no conversation belongs to one person. Lead
 *     follow-ups stay org-wide on purpose (a manager closing a colleague's call-back is
 *     ordinary CRM behaviour), but a personal one is not CRM work and a colleague who guessed
 *     an id must not be able to cancel it.
 *   - IDEMPOTENT LIFECYCLE. Only a pending task transitions, so a completed reminder cannot be
 *     completed twice or quietly re-opened by cancelling it.
 *
 * Every collaborator is injected or mocked; no database is touched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

vi.mock('../../config/database.js', () => ({
  runInTransaction: (command: (session: undefined) => unknown) => command(undefined),
}));

const mocks = vi.hoisted(() => ({
  findFollowUpTaskById: vi.fn(),
  updateTaskStatus: vi.fn(),
  createFollowUpTask: vi.fn(),
  listFollowUpTasksForConversation: vi.fn(),
  createActivity: vi.fn(),
  loadVisibleConversationForActor: vi.fn(),
  findEarliestPendingDueAt: vi.fn(),
  setConversationNextFollowUpAt: vi.fn(),
}));

vi.mock('./followup-task.repository.js', () => ({
  findFollowUpTaskById: mocks.findFollowUpTaskById,
  updateTaskStatus: mocks.updateTaskStatus,
  createFollowUpTask: mocks.createFollowUpTask,
  listFollowUpTasksForConversation: mocks.listFollowUpTasksForConversation,
  findEarliestPendingDueAt: mocks.findEarliestPendingDueAt,
}));

vi.mock('../conversations/conversation.repository.js', () => ({
  setConversationNextFollowUpAt: mocks.setConversationNextFollowUpAt,
}));

vi.mock('../activity/activity-log.repository.js', () => ({ createActivity: mocks.createActivity }));

vi.mock('../conversations/conversation.service.js', () => ({
  loadVisibleConversationForActor: mocks.loadVisibleConversationForActor,
}));

const service = await import('./followup.service.js');

const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const LEAD_A = 'conv-a';
const LEAD_B = 'conv-b';
const OWNER = { _id: 'user-1' } as never;
const COLLEAGUE = { _id: 'user-2' } as never;

const leadTask = (overrides: Record<string, unknown> = {}) => ({
  _id: 'task-1',
  organizationId: ORG,
  conversationId: LEAD_A,
  whatsappAccountId: 'acct-1',
  assignedTo: 'user-1',
  status: 'pending',
  ...overrides,
});

const personalTask = (overrides: Record<string, unknown> = {}) =>
  leadTask({ conversationId: null, whatsappAccountId: null, ...overrides });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.updateTaskStatus.mockImplementation(async ({ status }: { status: string }) => ({
    _id: 'task-1',
    organizationId: ORG,
    conversationId: LEAD_A,
    status,
  }));
  mocks.createActivity.mockResolvedValue(undefined);
  mocks.findEarliestPendingDueAt.mockResolvedValue(null);
  mocks.setConversationNextFollowUpAt.mockResolvedValue({ acknowledged: true });
});

describe('tenancy', () => {
  it('scopes the lookup to the caller’s organization', async () => {
    mocks.findFollowUpTaskById.mockResolvedValue(leadTask());

    await service.completeFollowUpForActor({
      organizationId: ORG,
      taskId: 'task-1',
      actor: OWNER,
    });

    // The org is part of the QUERY, not checked after the fact - so another tenant's row never
    // comes back to be compared in the first place.
    expect(mocks.findFollowUpTaskById).toHaveBeenCalledWith({ taskId: 'task-1', organizationId: ORG });
  });

  it('REFUSES a reminder that belongs to another organization', async () => {
    // The org-scoped query returns nothing for a foreign id.
    mocks.findFollowUpTaskById.mockResolvedValue(null);

    await expect(
      service.completeFollowUpForActor({
        organizationId: OTHER_ORG,
        taskId: 'task-1',
        actor: OWNER,
      }),
    ).rejects.toThrow('FOLLOWUP_NOT_FOUND');

    expect(mocks.updateTaskStatus).not.toHaveBeenCalled();
  });
});

describe('personal reminders', () => {
  it('lets the person they belong to complete one', async () => {
    mocks.findFollowUpTaskById.mockResolvedValue(personalTask({ assignedTo: 'user-1' }));

    await expect(
      service.completeFollowUpForActor({ organizationId: ORG, taskId: 'task-1', actor: OWNER }),
    ).resolves.toBeTruthy();
  });

  it('REFUSES a colleague who guessed the id', async () => {
    mocks.findFollowUpTaskById.mockResolvedValue(personalTask({ assignedTo: 'user-1' }));

    await expect(
      service.cancelFollowUpForActor({ organizationId: ORG, taskId: 'task-1', actor: COLLEAGUE }),
    ).rejects.toThrow('FOLLOWUP_NOT_FOUND');

    expect(mocks.updateTaskStatus).not.toHaveBeenCalled();
  });

  it('still lets a colleague close a LEAD follow-up, which is ordinary CRM work', async () => {
    // The distinction that makes the rule above narrow rather than blanket.
    mocks.findFollowUpTaskById.mockResolvedValue(leadTask({ assignedTo: 'user-1' }));

    await expect(
      service.completeFollowUpForActor({ organizationId: ORG, taskId: 'task-1', actor: COLLEAGUE }),
    ).resolves.toBeTruthy();
  });

  it('writes no activity entry for a personal reminder, which has no lead timeline', async () => {
    mocks.findFollowUpTaskById.mockResolvedValue(personalTask());

    await service.completeFollowUpForActor({ organizationId: ORG, taskId: 'task-1', actor: OWNER });

    expect(mocks.createActivity).not.toHaveBeenCalled();
  });

  it('writes one for a lead follow-up', async () => {
    mocks.findFollowUpTaskById.mockResolvedValue(leadTask());

    await service.completeFollowUpForActor({ organizationId: ORG, taskId: 'task-1', actor: OWNER });

    expect(mocks.createActivity).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: LEAD_A, organizationId: ORG }),
    );
  });
});

describe('the lifecycle', () => {
  it('completes a pending reminder', async () => {
    mocks.findFollowUpTaskById.mockResolvedValue(leadTask());

    await service.completeFollowUpForActor({ organizationId: ORG, taskId: 'task-1', actor: OWNER });

    expect(mocks.updateTaskStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'completed', organizationId: ORG }),
    );
  });

  it('cancels a pending reminder, which is what stops it ringing', async () => {
    mocks.findFollowUpTaskById.mockResolvedValue(leadTask());

    await service.cancelFollowUpForActor({ organizationId: ORG, taskId: 'task-1', actor: OWNER });

    expect(mocks.updateTaskStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'cancelled' }),
    );
  });

  it.each(['completed', 'cancelled'])('refuses to transition a %s reminder', async (status) => {
    // Double-completion, and re-opening by cancelling something already closed. Also what makes
    // a rapid double-click harmless: the second request finds a non-pending row.
    mocks.findFollowUpTaskById.mockResolvedValue(leadTask({ status }));

    await expect(
      service.completeFollowUpForActor({ organizationId: ORG, taskId: 'task-1', actor: OWNER }),
    ).rejects.toThrow('FOLLOWUP_NOT_PENDING');

    expect(mocks.updateTaskStatus).not.toHaveBeenCalled();
  });
});

describe('which lead a new reminder belongs to', () => {
  beforeEach(() => {
    mocks.loadVisibleConversationForActor.mockResolvedValue({
      _id: LEAD_A,
      whatsappAccountId: 'acct-1',
    });
    mocks.createFollowUpTask.mockResolvedValue({
      _id: 'task-new',
      organizationId: ORG,
      conversationId: LEAD_A,
      status: 'pending',
    });
  });

  it('files it against the conversation the caller was authorised for', async () => {
    await service.createFollowUpForActor({
      organizationId: ORG,
      conversationId: LEAD_A,
      actor: OWNER,
      permissions: ['crm.tasks.manage'] as never,
      type: 'call',
      dueAt: new Date('2026-11-01T10:00:00.000Z'),
    } as never);

    // The id comes from the route and is checked for visibility first - there is no field on
    // the request body that can move a reminder onto a different lead.
    expect(mocks.loadVisibleConversationForActor).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: LEAD_A, organizationId: ORG }),
    );
    expect(mocks.createFollowUpTask).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: LEAD_A, organizationId: ORG }),
    );
  });

  it('REFUSES when the caller cannot see that conversation', async () => {
    // Lead B's details cannot be used to file a reminder the caller has no access to.
    mocks.loadVisibleConversationForActor.mockRejectedValue(
      new Error('CONVERSATION_ACCESS_DENIED'),
    );

    await expect(
      service.createFollowUpForActor({
        organizationId: ORG,
        conversationId: LEAD_B,
        actor: COLLEAGUE,
        permissions: [] as never,
        type: 'call',
        dueAt: new Date('2026-11-01T10:00:00.000Z'),
      } as never),
    ).rejects.toThrow('CONVERSATION_ACCESS_DENIED');

    expect(mocks.createFollowUpTask).not.toHaveBeenCalled();
  });
});
