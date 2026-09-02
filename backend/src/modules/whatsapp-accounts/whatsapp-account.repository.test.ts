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
}));

vi.mock('./whatsapp-account.model.js', () => ({
  WhatsAppAccount: {
    find: mocks.accountFind,
    deleteOne: mocks.accountDeleteOne,
  },
}));

vi.mock('../conversations/conversation.model.js', () => ({
  Conversation: { countDocuments: mocks.conversationCount },
}));

vi.mock('../messages/message.model.js', () => ({
  Message: { countDocuments: mocks.messageCount },
}));

vi.mock('../lead-sources/lead-source.model.js', () => ({
  LeadSource: { countDocuments: mocks.leadSourceCount },
}));

vi.mock('../whatsapp-auth-states/whatsapp-auth-state.repository.js', () => ({
  deleteAuthStateForAccount: mocks.deleteAuthStateForAccount,
}));

const { countAccountReferences, findAccountsByOrganization, hardDeleteAccount } = await import(
  './whatsapp-account.repository.js'
);

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
