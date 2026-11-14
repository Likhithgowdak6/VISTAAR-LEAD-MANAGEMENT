import mongoose from 'mongoose';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findById, updateOne, collection, countDocuments, exec } = vi.hoisted(() => ({
  findById: vi.fn(), updateOne: vi.fn(), collection: vi.fn(), countDocuments: vi.fn(), exec: vi.fn(),
}));
vi.mock('./organization.model.js', () => ({ Organization: { findById, updateOne } }));
const { admitWorkspaceResource } = await import('./workspace-limits.service.js');
const organizationId = '507f1f77bcf86cd799439011';
const session = {} as never;
beforeEach(() => {
  vi.clearAllMocks();
  findById.mockReturnValue({ session: vi.fn().mockReturnValue({ lean: () => ({ exec }) }) });
  exec.mockResolvedValue({ saasManaged: true, saasLimits: { users: 5, whatsappAccounts: 1 } });
  countDocuments.mockResolvedValue(0);
  collection.mockReturnValue({ countDocuments });
  vi.spyOn(mongoose.connection, 'collection').mockImplementation(collection);
});

describe('workspace resource limits', () => {
  it('enforces the account cap before an insert', async () => {
    countDocuments.mockResolvedValue(1);
    await expect(admitWorkspaceResource(organizationId, 'whatsappAccounts', session))
      .rejects.toMatchObject({ statusCode: 403, code: 'WORKSPACE_LIMIT_REACHED' });
    expect(collection).toHaveBeenCalledWith('whatsappaccounts');
  });
  it('enforces the team cap', async () => {
    countDocuments.mockResolvedValue(5);
    await expect(admitWorkspaceResource(organizationId, 'users', session))
      .rejects.toMatchObject({ code: 'WORKSPACE_LIMIT_REACHED' });
  });
  it('threads the same tenant and transaction through admission', async () => {
    await admitWorkspaceResource(organizationId, 'users', session);
    expect(updateOne).toHaveBeenCalledWith({ _id: organizationId }, { $inc: { saasRevision: 1 } }, { session });
    expect(countDocuments).toHaveBeenCalledWith({ organizationId: new mongoose.Types.ObjectId(organizationId), status: 'active',
      email: { $ne: 'ai-assistant@internal.local' } }, { session });
  });
  it('keeps existing installs uncapped', async () => {
    exec.mockResolvedValue({ saasManaged: false });
    await admitWorkspaceResource(organizationId, 'users', session);
    expect(countDocuments).not.toHaveBeenCalled();
  });
});
