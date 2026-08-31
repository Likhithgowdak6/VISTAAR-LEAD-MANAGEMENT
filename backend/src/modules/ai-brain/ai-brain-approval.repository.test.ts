/**
 * Exercises generateUniqueApprovalCode's collision-retry loop and upsertPendingApproval's
 * always-assign-a-fresh-code behavior, against a mocked AiBrainApproval model - no real Mongo.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    MONGODB_URI: 'mongodb://localhost:27017/test',
    REDIS_URL: 'redis://localhost:6379',
    JWT_ACCESS_SECRET: 'test-secret-at-least-32-characters-long',
    LOG_LEVEL: 'silent',
  },
}));

const mocks = vi.hoisted(() => ({
  exists: vi.fn(),
  findOneAndUpdate: vi.fn(),
  generateApprovalCode: vi.fn(),
}));

vi.mock('./ai-brain-approval.model.js', () => ({
  AiBrainApproval: {
    exists: mocks.exists,
    findOneAndUpdate: mocks.findOneAndUpdate,
  },
}));

vi.mock('./approval-code.js', () => ({
  generateApprovalCode: mocks.generateApprovalCode,
}));

const { generateUniqueApprovalCode, upsertPendingApproval } = await import(
  './ai-brain-approval.repository.js'
);

const organizationId = 'org-1';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('generateUniqueApprovalCode', () => {
  it('returns the first generated code when nothing pending collides with it', async () => {
    mocks.generateApprovalCode.mockReturnValueOnce('A7');
    mocks.exists.mockResolvedValue(null);

    const code = await generateUniqueApprovalCode({ organizationId });

    expect(code).toBe('A7');
    expect(mocks.generateApprovalCode).toHaveBeenCalledTimes(1);
    expect(mocks.exists).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId, code: 'A7' }),
    );
  });

  it('retries past a collision and returns the first non-colliding candidate', async () => {
    mocks.generateApprovalCode
      .mockReturnValueOnce('A1')
      .mockReturnValueOnce('A1')
      .mockReturnValueOnce('B2');
    mocks.exists.mockImplementation(async ({ code }: { code: string }) =>
      code === 'B2' ? null : { _id: 'existing-approval' },
    );

    const code = await generateUniqueApprovalCode({ organizationId });

    expect(code).toBe('B2');
    expect(mocks.generateApprovalCode).toHaveBeenCalledTimes(3);
  });

  it('excludes the conversation whose own card is being (re)assigned a code from the collision check', async () => {
    mocks.generateApprovalCode.mockReturnValueOnce('A7');
    mocks.exists.mockResolvedValue(null);

    await generateUniqueApprovalCode({ organizationId, excludeConversationId: 'conv-1' });

    expect(mocks.exists).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: { $ne: 'conv-1' } }),
    );
  });

  it('throws after exhausting maxAttempts if every candidate keeps colliding', async () => {
    mocks.generateApprovalCode.mockReturnValue('A1');
    mocks.exists.mockResolvedValue({ _id: 'existing-approval' });

    await expect(
      generateUniqueApprovalCode({ organizationId, maxAttempts: 3 }),
    ).rejects.toThrow('AI_BRAIN_APPROVAL_CODE_EXHAUSTED');
    expect(mocks.generateApprovalCode).toHaveBeenCalledTimes(3);
  });
});

describe('upsertPendingApproval', () => {
  it('always assigns a freshly generated code, whether this is an insert or an update', async () => {
    mocks.generateApprovalCode.mockReturnValueOnce('C4');
    mocks.exists.mockResolvedValue(null);
    mocks.findOneAndUpdate.mockReturnValue({ exec: vi.fn().mockResolvedValue({ code: 'C4' }) });

    const validOrgId = '507f1f77bcf86cd799439011';
    const validConversationId = '507f1f77bcf86cd799439012';

    const result = await upsertPendingApproval({
      organizationId: validOrgId,
      conversationId: validConversationId,
      draft: 'Hello there',
      facts: {},
    });

    expect(result).toEqual({ code: 'C4' });
    expect(mocks.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: validOrgId, conversationId: validConversationId }),
      expect.objectContaining({ $set: expect.objectContaining({ code: 'C4' }) }),
      expect.objectContaining({ upsert: true }),
    );
  });
});
