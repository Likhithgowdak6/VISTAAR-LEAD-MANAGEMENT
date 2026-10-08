/**
 * What pressing Remove does, in both of the shapes it has.
 *
 * An account nothing references is deleted for good, together with its stored Baileys
 * credentials; an account that owns conversations, messages or a lead source is soft-removed so
 * nothing is orphaned. Both paths must close the live socket first - a hard delete that left a
 * socket running would be a socket nothing can reach or stop - and both must report which
 * happened, because "deleted permanently" and "hidden, it still has 47 conversations" are
 * different facts.
 *
 * Every dependency is injected, so nothing here touches Mongo or a real session. `config/env.js`
 * is mocked because the real module calls `process.exit(1)` on invalid config and would take the
 * test runner with it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const { createAccountRemovalService } = await import('./whatsapp-account.service.js');

const organizationId = 'org-1';
const accountId = 'account-1';
const actor = { _id: 'user-1' };

const account = {
  _id: { toString: () => accountId },
  organizationId,
  name: 'Likhith Gowda k',
  brandKey: 'likhith-gowda-k',
  status: 'disconnected',
};

interface HarnessOptions {
  conversations?: number;
  messages?: number;
  leadSources?: number;
  found?: unknown;
}

const createHarness = ({
  conversations = 0,
  messages = 0,
  leadSources = 0,
  found = account,
}: HarnessOptions = {}) => {
  const calls: string[] = [];

  const disconnectAccount = vi.fn(async () => {
    calls.push('disconnect');
  });
  const findAccount = vi.fn(async () => found);
  const countReferences = vi.fn(async () => ({
    conversations,
    messages,
    leadSources,
    total: conversations + messages + leadSources,
  }));
  const hardDelete = vi.fn(async () => {
    calls.push('hardDelete');
    return { deletedAccounts: 1, deletedAuthStates: 1204 };
  });
  const softRemove = vi.fn(async () => {
    calls.push('softRemove');
    return { ...account, status: 'removed', removedAt: new Date('2026-09-02T00:00:00.000Z') };
  });
  const recordAudit = vi.fn(async () => ({}));
  const purgeData = vi.fn(async () => {
    calls.push('purge');
    return {
      conversations: 134,
      messages: 818,
      leadSources: 1,
      leadSubmissions: 12,
      activityLogs: 402,
      followUpTasks: 3,
      notes: 5,
      tags: 2,
      aiApprovals: 7,
      aiDrafts: 9,
      realtimeOutbox: 0,
      total: 1393,
    };
  });

  const service = createAccountRemovalService({
    findAccount: findAccount as never,
    countReferences: countReferences as never,
    hardDelete: hardDelete as never,
    purgeData: purgeData as never,
    softRemove: softRemove as never,
    recordAudit: recordAudit as never,
    sessionManager: (() => ({ disconnectAccount })) as never,
  });

  return {
    service,
    calls,
    disconnectAccount,
    findAccount,
    countReferences,
    hardDelete,
    purgeData,
    softRemove,
    recordAudit,
  };
};

const remove = (harness: ReturnType<typeof createHarness>) =>
  harness.service.removeAccountForActor({ organizationId, accountId, actor });

const purge = (harness: ReturnType<typeof createHarness>) =>
  harness.service.removeAccountForActor({
    organizationId,
    accountId,
    actor,
    purgeHistory: true,
  });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('removing an account with no history', () => {
  it('hard deletes it and reports that it is gone', async () => {
    const harness = createHarness();

    const result = await remove(harness);

    expect(harness.hardDelete).toHaveBeenCalledWith({ accountId, organizationId });
    expect(harness.softRemove).not.toHaveBeenCalled();
    expect(result.outcome).toBe('deleted');
    expect(result.references).toEqual({
      conversations: 0,
      messages: 0,
      leadSources: 0,
      total: 0,
    });
    expect(result.account?.name).toBe('Likhith Gowda k');
  });

  it('closes the live session before deleting anything', async () => {
    const harness = createHarness();

    await remove(harness);

    expect(harness.disconnectAccount).toHaveBeenCalledWith({
      accountId,
      organizationId,
      status: 'removed',
      disconnectCode: 'account_removed',
      disconnectReason: 'Account removed from the app.',
    });
    expect(harness.calls).toEqual(['disconnect', 'hardDelete']);
  });

  it('leaves an audit entry naming the account and how many credential rows went with it', async () => {
    const harness = createHarness();

    await remove(harness);

    expect(harness.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId,
        eventType: 'WHATSAPP_ACCOUNT_DELETED',
        actorId: actor._id,
        metadata: {
          whatsappAccountId: accountId,
          name: 'Likhith Gowda k',
          brandKey: 'likhith-gowda-k',
          deletedAuthStates: 1204,
        },
      }),
    );
  });
});

describe('removing an account that still has history', () => {
  it('soft removes it when it has conversations, and says why', async () => {
    const harness = createHarness({ conversations: 47, messages: 912 });

    const result = await remove(harness);

    expect(harness.softRemove).toHaveBeenCalledWith({
      accountId,
      organizationId,
      actorId: actor._id,
    });
    expect(harness.hardDelete).not.toHaveBeenCalled();
    expect(result.outcome).toBe('hidden');
    expect(result.references).toEqual({
      conversations: 47,
      messages: 912,
      leadSources: 0,
      total: 959,
    });
    expect(result.account?.status).toBe('removed');
  });

  it('soft removes an account whose only reference is a lead source', async () => {
    const harness = createHarness({ leadSources: 1 });

    const result = await remove(harness);

    expect(result.outcome).toBe('hidden');
    expect(harness.hardDelete).not.toHaveBeenCalled();
  });

  it('closes the live session before soft removing', async () => {
    const harness = createHarness({ messages: 3 });

    await remove(harness);

    expect(harness.calls).toEqual(['disconnect', 'softRemove']);
  });

  it('writes no audit entry, because the document itself records the removal', async () => {
    const harness = createHarness({ conversations: 1 });

    await remove(harness);

    expect(harness.recordAudit).not.toHaveBeenCalled();
  });
});

describe('removing an account that is not there', () => {
  it('throws ACCOUNT_NOT_FOUND without disconnecting or deleting anything', async () => {
    const harness = createHarness({ found: null });

    await expect(remove(harness)).rejects.toThrow('ACCOUNT_NOT_FOUND');
    expect(harness.disconnectAccount).not.toHaveBeenCalled();
    expect(harness.hardDelete).not.toHaveBeenCalled();
    expect(harness.softRemove).not.toHaveBeenCalled();
  });
});

// --------------------------------------------------------------------------
// "If I remove it there should be no trace of it." The admin's explicit opt-in, and the reason
// the default is not this: once these run, 818 real customer messages are gone and there is no
// backup to put them back from.
// --------------------------------------------------------------------------
describe('removing an account AND its history', () => {
  it('purges the history, then hard deletes the account', async () => {
    const harness = createHarness({ conversations: 134, messages: 818, leadSources: 1 });

    const result = await harness.service.removeAccountForActor({
      organizationId,
      accountId,
      actor,
      purgeHistory: true,
    });

    expect(harness.purgeData).toHaveBeenCalledWith({ accountId, organizationId });
    expect(harness.hardDelete).toHaveBeenCalledWith({ accountId, organizationId });
    expect(harness.softRemove).not.toHaveBeenCalled();
    expect(result.outcome).toBe('purged');
  });

  it('closes the socket before deleting anything', async () => {
    const harness = createHarness({ conversations: 134, messages: 818 });

    await purge(harness);

    // Deleting a number out from under a live session leaves a socket nothing can reach.
    expect(harness.calls).toEqual(['disconnect', 'purge', 'hardDelete']);
  });

  it('reports exactly what was destroyed', async () => {
    const harness = createHarness({ conversations: 134, messages: 818, leadSources: 1 });

    const result = await purge(harness);

    expect(result.purged).toMatchObject({ conversations: 134, messages: 818, total: 1393 });
    expect(result.references).toMatchObject({ conversations: 134, messages: 818 });
  });

  it('keeps the counts in the audit trail, which is the only record left', async () => {
    const harness = createHarness({ conversations: 134, messages: 818 });

    await purge(harness);

    expect(harness.recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          brandKey: 'likhith-gowda-k',
          purged: expect.objectContaining({ conversations: 134, messages: 818 }),
        }),
      }),
    );
  });

  it('does not purge when the flag is absent, even for a number full of history', async () => {
    const harness = createHarness({ conversations: 134, messages: 818 });

    const result = await remove(harness);

    // The whole safety property: destructive only on explicit request.
    expect(harness.purgeData).not.toHaveBeenCalled();
    expect(harness.hardDelete).not.toHaveBeenCalled();
    expect(harness.softRemove).toHaveBeenCalled();
    expect(result.outcome).toBe('hidden');
  });

  it('skips the purge entirely when there is nothing to purge', async () => {
    const harness = createHarness();

    const result = await purge(harness);

    // No history means the plain hard-delete path already does the job; running a purge that
    // would delete nothing just adds eleven pointless deleteMany calls.
    expect(harness.purgeData).not.toHaveBeenCalled();
    expect(harness.hardDelete).toHaveBeenCalled();
    expect(result.outcome).toBe('deleted');
    expect(result.purged).toBeNull();
  });

  it('leaves `purged` null on a soft remove', async () => {
    const harness = createHarness({ conversations: 1 });

    const result = await remove(harness);

    expect(result.purged).toBeNull();
  });
});
