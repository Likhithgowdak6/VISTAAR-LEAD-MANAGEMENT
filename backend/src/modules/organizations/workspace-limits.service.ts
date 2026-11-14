import mongoose from 'mongoose';
import { type DatabaseSession } from '../../config/database.js';
import { type ObjectIdLike } from '../../types/common.js';
import { createHttpError } from '../../utils/http-error.js';
import { Organization } from './organization.model.js';

/** Must run in the SAME transaction as the insert. The revision write serializes admission. */
export const admitWorkspaceResource = async (
  organizationId: ObjectIdLike | undefined,
  resource: 'users' | 'whatsappAccounts',
  session: DatabaseSession,
  excludeId?: ObjectIdLike,
): Promise<void> => {
  if (!organizationId) return;
  const organization = await Organization.findById(organizationId).session(session).lean().exec();
  if (!organization?.saasManaged) return;
  await Organization.updateOne({ _id: organizationId }, { $inc: { saasRevision: 1 } }, { session });
  const limit = organization.saasLimits?.[resource];
  const collection = resource === 'users' ? 'users' : 'whatsappaccounts';
  const query = {
    organizationId: new mongoose.Types.ObjectId(organizationId.toString()),
    ...(resource === 'users'
      ? { status: 'active', email: { $ne: 'ai-assistant@internal.local' } }
      : { status: { $ne: 'removed' } }),
    ...(excludeId ? { _id: { $ne: new mongoose.Types.ObjectId(excludeId.toString()) } } : {}),
  };
  const count = await mongoose.connection.collection(collection).countDocuments(query, { session });
  if (!Number.isInteger(limit) || !limit || count >= limit) {
    throw createHttpError({ statusCode: 403, code: 'WORKSPACE_LIMIT_REACHED',
      message: `Workspace limit reached for ${resource}.` });
  }
};
