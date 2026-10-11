/**
 * REGRESSION: a reminder with no idempotency key must have NO key field.
 *
 * THE PRODUCTION FAILURE THIS PINS. The schema defaulted `idempotencyKey` to null, and the
 * unique index on (organizationId, idempotencyKey) is sparse. Sparse skips documents where the
 * field is ABSENT, not where it is null - so every manually-created reminder went into the
 * index under the same key, and the second one an owner created returned
 *
 *   E11000 duplicate key ... dup key: { organizationId: ..., idempotencyKey: null }
 *
 * as a 500. Creating two reminders by hand was impossible.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const mocks = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('./followup-task.model.js', () => ({
  FollowUpTask: { create: mocks.create },
}));

const { createFollowUpTask } = await import('./followup-task.repository.js');

// Real 24-hex ids: the repository runs these through toObjectId, which rejects anything else.
const baseArgs = {
  organizationId: '6ab4c2037469f65204cfe999',
  assignedTo: '6ab4c2037469f65204cfe111',
  createdBy: '6ab4c2037469f65204cfe111',
  type: 'custom' as const,
  dueAt: new Date('2026-10-12T11:30:00.000Z'),
};

/** The document handed to Mongoose. */
const written = () => mocks.create.mock.calls[0]![0][0] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.create.mockResolvedValue([{ _id: 'task-1' }]);
});

describe('idempotencyKey and the sparse unique index', () => {
  it('omits the field entirely when there is no key', async () => {
    await createFollowUpTask({ ...baseArgs } as never);

    // `in` rather than a null check: the whole point is that the KEY is absent, which is what
    // keeps the document out of the sparse index.
    expect('idempotencyKey' in written()).toBe(false);
  });

  it('omits it for an explicit null too', async () => {
    await createFollowUpTask({ ...baseArgs, idempotencyKey: null } as never);

    expect('idempotencyKey' in written()).toBe(false);
  });

  it('writes it when one is supplied', async () => {
    await createFollowUpTask({ ...baseArgs, idempotencyKey: 'owner-cmd:wamid-1' } as never);

    // Extracted reminders DO carry one - it is what makes a replayed webhook a no-op.
    expect(written().idempotencyKey).toBe('owner-cmd:wamid-1');
  });

  it('lets two keyless reminders be created back to back', async () => {
    await createFollowUpTask({ ...baseArgs } as never);
    await createFollowUpTask({ ...baseArgs, title: 'another' } as never);

    const first = mocks.create.mock.calls[0]![0][0] as Record<string, unknown>;
    const second = mocks.create.mock.calls[1]![0][0] as Record<string, unknown>;

    // Neither is indexed, so Mongo has nothing to collide on. This is the exact sequence that
    // returned a 500 in production.
    expect('idempotencyKey' in first).toBe(false);
    expect('idempotencyKey' in second).toBe(false);
  });

  it('still allows a personal reminder to have no conversation', async () => {
    await createFollowUpTask({ ...baseArgs, conversationId: null } as never);

    expect(written().conversationId).toBeNull();
  });
});
