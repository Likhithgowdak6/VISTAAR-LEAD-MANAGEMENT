/**
 * The three query/delete decisions this repository makes on behalf of Remove:
 * `findAccountsByOrganization` hiding soft-removed accounts unless one is asked for by name,
 * `countAccountReferences` counting only the references that a hard delete would orphan, and
 * `hardDeleteAccount` taking the stored Baileys credentials down with the account document.
 *
 * Every model is mocked - no Mongo. `config/env.js` is mocked because the real module calls
 * `process.exit(1)` on invalid config and would take the test runner with it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const mocks = vi.hoisted(() => ({
  accountFind: vi.fn(),
  accountDeleteOne: vi.fn(),
  conversationCount: vi.fn(),
  messageCount: vi.fn(),
  leadSourceCount: vi.fn(),
  deleteAuthStateForAccount: vi.fn(),
  conversationDistinct: vi.fn(),
  leadSourceDistinct: vi.fn(),
  conversationDeleteMany: vi.fn(),
  messageDeleteMany: vi.fn(),
  leadSourceDeleteMany: vi.fn(),
  leadSubmissionDeleteMany: vi.fn(),
  activityDeleteMany: vi.fn(),
  followUpDeleteMany: vi.fn(),
  noteDeleteMany: vi.fn(),
  tagDeleteMany: vi.fn(),
  approvalDeleteMany: vi.fn(),
  draftDeleteMany: vi.fn(),
  outboxDeleteMany: vi.fn(),
}));

vi.mock('./whatsapp-account.model.js', () => ({
  WhatsAppAccount: {
    find: mocks.accountFind,
    deleteOne: mocks.accountDeleteOne,
  },
}));

vi.mock('../conversations/conversation.model.js', () => ({
  Conversation: {
    countDocuments: mocks.conversationCount,
    find: mocks.conversationDistinct,
    deleteMany: mocks.conversationDeleteMany,
  },
}));

vi.mock('../messages/message.model.js', () => ({
  Message: { countDocuments: mocks.messageCount, deleteMany: mocks.messageDeleteMany },
}));

vi.mock('../lead-sources/lead-source.model.js', () => ({
  LeadSource: {
    countDocuments: mocks.leadSourceCount,
    find: mocks.leadSourceDistinct,
    deleteMany: mocks.leadSourceDeleteMany,
  },
}));

vi.mock('../lead-sources/lead-submission.model.js', () => ({
  LeadSubmission: { deleteMany: mocks.leadSubmissionDeleteMany },
}));

vi.mock('../activity/activity-log.model.js', () => ({
  ActivityLog: { deleteMany: mocks.activityDeleteMany },
}));

vi.mock('../followups/followup-task.model.js', () => ({
  FollowUpTask: { deleteMany: mocks.followUpDeleteMany },
}));

vi.mock('../notes/note.model.js', () => ({
  Note: { deleteMany: mocks.noteDeleteMany },
}));

vi.mock('../tags/tag.model.js', () => ({
  Tag: { deleteMany: mocks.tagDeleteMany },
}));

vi.mock('../ai-brain/ai-brain-approval.model.js', () => ({
  AiBrainApproval: { deleteMany: mocks.approvalDeleteMany },
}));

vi.mock('../ai/ai-draft.model.js', () => ({
  AiDraft: { deleteMany: mocks.draftDeleteMany },
}));

vi.mock('../realtime/realtime-outbox.model.js', () => ({
  RealtimeOutboxEvent: { deleteMany: mocks.outboxDeleteMany },
}));

vi.mock('../whatsapp-auth-states/whatsapp-auth-state.repository.js', () => ({
  deleteAuthStateForAccount: mocks.deleteAuthStateForAccount,
}));

const {
  countAccountReferences,
  findAccountsByOrganization,
  hardDeleteAccount,
  purgeAccountData,
} = await import('./whatsapp-account.repository.js');

const organizationId = 'org-1';
const accountId = 'account-1';

const createFindChain = (result: unknown[]) => {
  const exec = vi.fn().mockResolvedValue(result);
  const limit = vi.fn().mockReturnValue({ exec });
  const skip = vi.fn().mockReturnValue({ limit });
  const sort = vi.fn().mockReturnValue({ skip });
  return { sort, skip, limit, exec };
};

const countingOf = (value: number) => ({ exec: vi.fn().mockResolvedValue(value) });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('findAccountsByOrganization', () => {
  it('excludes removed accounts when no status is asked for', async () => {
    mocks.accountFind.mockReturnValue(createFindChain([]));

    await findAccountsByOrganization({ organizationId });

    expect(mocks.accountFind).toHaveBeenCalledWith({
      organizationId,
      status: { $ne: 'removed' },
    });
  });

  it('still returns removed accounts when they are requested by name', async () => {
    mocks.accountFind.mockReturnValue(createFindChain([]));

    await findAccountsByOrganization({ organizationId, status: 'removed' });

    expect(mocks.accountFind).toHaveBeenCalledWith({ organizationId, status: 'removed' });
  });

  it('leaves any other explicit status filter alone', async () => {
    mocks.accountFind.mockReturnValue(createFindChain([]));

    await findAccountsByOrganization({ organizationId, status: 'active' });

    expect(mocks.accountFind).toHaveBeenCalledWith({ organizationId, status: 'active' });
  });
});

describe('countAccountReferences', () => {
  it('counts conversations, messages and lead sources for this account only', async () => {
    mocks.conversationCount.mockReturnValue(countingOf(47));
    mocks.messageCount.mockReturnValue(countingOf(912));
    mocks.leadSourceCount.mockReturnValue(countingOf(1));

    const references = await countAccountReferences({ accountId, organizationId });

    const scoped = { organizationId, whatsappAccountId: accountId };
    expect(mocks.conversationCount).toHaveBeenCalledWith(scoped);
    expect(mocks.messageCount).toHaveBeenCalledWith(scoped);
    expect(mocks.leadSourceCount).toHaveBeenCalledWith(scoped);
    expect(references).toEqual({
      conversations: 47,
      messages: 912,
      leadSources: 1,
      total: 960,
    });
  });

  it('totals zero for an account nothing points at', async () => {
    mocks.conversationCount.mockReturnValue(countingOf(0));
    mocks.messageCount.mockReturnValue(countingOf(0));
    mocks.leadSourceCount.mockReturnValue(countingOf(0));

    await expect(countAccountReferences({ accountId, organizationId })).resolves.toEqual({
      conversations: 0,
      messages: 0,
      leadSources: 0,
      total: 0,
    });
  });
});

describe('hardDeleteAccount', () => {
  it('deletes the stored credentials and the account document, both scoped to the organization', async () => {
    mocks.deleteAuthStateForAccount.mockResolvedValue({ deletedCount: 1204 });
    mocks.accountDeleteOne.mockReturnValue({
      exec: vi.fn().mockResolvedValue({ deletedCount: 1 }),
    });

    const result = await hardDeleteAccount({ accountId, organizationId });

    expect(mocks.deleteAuthStateForAccount).toHaveBeenCalledWith({
      organizationId,
      whatsappAccountId: accountId,
    });
    expect(mocks.accountDeleteOne).toHaveBeenCalledWith({ _id: accountId, organizationId });
    expect(result).toEqual({ deletedAccounts: 1, deletedAuthStates: 1204 });
  });

  it('clears the auth states before the account, so a half-failure never leaves live secrets behind', async () => {
    const order: string[] = [];
    mocks.deleteAuthStateForAccount.mockImplementation(async () => {
      order.push('auth-states');
      return { deletedCount: 3 };
    });
    mocks.accountDeleteOne.mockReturnValue({
      exec: vi.fn().mockImplementation(async () => {
        order.push('account');
        return { deletedCount: 1 };
      }),
    });

    await hardDeleteAccount({ accountId, organizationId });

    expect(order).toEqual(['auth-states', 'account']);
  });

  it('reports zero rather than throwing when nothing matched', async () => {
    mocks.deleteAuthStateForAccount.mockResolvedValue(null);
    mocks.accountDeleteOne.mockReturnValue({ exec: vi.fn().mockResolvedValue(null) });

    await expect(hardDeleteAccount({ accountId, organizationId })).resolves.toEqual({
      deletedAccounts: 0,
      deletedAuthStates: 0,
    });
  });
});

// --------------------------------------------------------------------------
// The cascade behind "delete its history too".
//
// A PARTIAL cascade is worse than no cascade: it is precisely the orphaned-inbox failure the
// soft remove exists to avoid, except now the account is gone too and nothing is left that can
// find the leftovers. So these tests are mostly an inventory - every collection holding a
// whatsappAccountId or a conversationId has to appear here, and the ones that must NOT be
// touched have to stay untouched.
// --------------------------------------------------------------------------
const deletedCount = (count: number) => ({
  exec: vi.fn().mockResolvedValue({ deletedCount: count }),
});

const distinctOf = (ids: string[]) => ({
  distinct: vi.fn().mockReturnValue({ exec: vi.fn().mockResolvedValue(ids) }),
});

describe('purgeAccountData', () => {
  const everyDeleteMock = () => [
    mocks.conversationDeleteMany,
    mocks.messageDeleteMany,
    mocks.leadSourceDeleteMany,
    mocks.leadSubmissionDeleteMany,
    mocks.activityDeleteMany,
    mocks.followUpDeleteMany,
    mocks.noteDeleteMany,
    mocks.tagDeleteMany,
    mocks.approvalDeleteMany,
    mocks.draftDeleteMany,
    mocks.outboxDeleteMany,
  ];

  beforeEach(() => {
    mocks.conversationDistinct.mockReturnValue(distinctOf(['conv-1', 'conv-2']));
    mocks.leadSourceDistinct.mockReturnValue(distinctOf(['src-1']));
    everyDeleteMock().forEach((mock) => mock.mockReturnValue(deletedCount(1)));
  });

  it('empties every collection that references the account', async () => {
    await purgeAccountData({ accountId, organizationId });

    everyDeleteMock().forEach((mock) => expect(mock).toHaveBeenCalledTimes(1));
  });

  it('scopes the account-owned collections by organization AND account', async () => {
    await purgeAccountData({ accountId, organizationId });

    const byAccount = { organizationId, whatsappAccountId: accountId };
    [
      mocks.conversationDeleteMany,
      mocks.messageDeleteMany,
      mocks.leadSourceDeleteMany,
      mocks.activityDeleteMany,
      mocks.followUpDeleteMany,
      mocks.noteDeleteMany,
      mocks.tagDeleteMany,
    ].forEach((mock) => expect(mock).toHaveBeenCalledWith(byAccount));
  });

  it('reaches approvals, drafts and queued events through the conversation ids', async () => {
    await purgeAccountData({ accountId, organizationId });

    // None of these three carries a whatsappAccountId, so the conversation ids have to be read
    // before the conversations go - which is what the ordering test below pins.
    const byConversation = { organizationId, conversationId: { $in: ['conv-1', 'conv-2'] } };
    expect(mocks.approvalDeleteMany).toHaveBeenCalledWith(byConversation);
    expect(mocks.draftDeleteMany).toHaveBeenCalledWith(byConversation);
    expect(mocks.outboxDeleteMany).toHaveBeenCalledWith(byConversation);
  });

  it('reaches lead submissions through the lead source ids', async () => {
    await purgeAccountData({ accountId, organizationId });

    expect(mocks.leadSubmissionDeleteMany).toHaveBeenCalledWith({
      organizationId,
      leadSourceId: { $in: ['src-1'] },
    });
  });

  it('collects the ids before deleting the documents they came from', async () => {
    const order: string[] = [];
    mocks.conversationDistinct.mockReturnValue({
      distinct: vi.fn().mockReturnValue({
        exec: vi.fn().mockImplementation(async () => {
          order.push('read-conversations');
          return ['conv-1'];
        }),
      }),
    });
    mocks.approvalDeleteMany.mockReturnValue({
      exec: vi.fn().mockImplementation(async () => {
        order.push('delete-approvals');
        return { deletedCount: 1 };
      }),
    });
    mocks.conversationDeleteMany.mockReturnValue({
      exec: vi.fn().mockImplementation(async () => {
        order.push('delete-conversations');
        return { deletedCount: 1 };
      }),
    });

    await purgeAccountData({ accountId, organizationId });

    expect(order).toEqual(['read-conversations', 'delete-approvals', 'delete-conversations']);
  });

  it('totals what it deleted', async () => {
    mocks.conversationDeleteMany.mockReturnValue(deletedCount(134));
    mocks.messageDeleteMany.mockReturnValue(deletedCount(818));

    const result = await purgeAccountData({ accountId, organizationId });

    expect(result.conversations).toBe(134);
    expect(result.messages).toBe(818);
    // 134 + 818 + the nine other collections returning 1 each.
    expect(result.total).toBe(961);
  });

  it('survives a driver response with no deletedCount', async () => {
    everyDeleteMock().forEach((mock) =>
      mock.mockReturnValue({ exec: vi.fn().mockResolvedValue(null) }),
    );

    const result = await purgeAccountData({ accountId, organizationId });

    expect(result.total).toBe(0);
  });

  it('never deletes the account document or its credentials itself', async () => {
    await purgeAccountData({ accountId, organizationId });

    // hardDeleteAccount's job, and it has to run AFTER this: a failure mid-purge must leave the
    // account present so pressing Remove again finishes what was started.
    expect(mocks.accountDeleteOne).not.toHaveBeenCalled();
    expect(mocks.deleteAuthStateForAccount).not.toHaveBeenCalled();
  });
});
