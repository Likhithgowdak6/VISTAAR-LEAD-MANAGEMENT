import { type HydratedDocument, type UpdateQuery } from 'mongoose';

import {
  ACCOUNT_ACCESS_MODES,
  type AccountAccessMode,
} from '../../constants/account-access-modes.js';
import { AUDIT_EVENTS, type AuditEvent } from '../../constants/audit-events.js';
import { AUDIT_OUTCOMES } from '../../constants/audit-outcomes.js';
import { ROLES, type Role } from '../../constants/roles.js';
import { USER_STATUSES, type UserStatus } from '../../constants/user-statuses.js';
import { type DatabaseSession, runInTransaction } from '../../config/database.js';
import { type ObjectIdLike, type PaginationParams } from '../../types/common.js';
import { createAuditLog } from '../audit/audit.repository.js';
import { hashPassword, validatePlainPassword } from '../auth/password.service.js';
import { revokeActiveRefreshSessionsForUser } from '../auth/refresh-session.repository.js';
import { type AuthRequestContext } from '../auth/auth.service.js';

import {
  createUser,
  findUserByEmailInOrganization,
  findUserById,
  listUsersByOrganization,
  updateUserById,
} from './user.repository.js';
import { type PermissionOverrides, type UserDocument } from './user.model.js';
import { serializeUser } from './user.serializer.js';

const createUserManagementError = (code: string): Error => new Error(code);

export interface AssertTargetUserCanBeManagedParams {
  actor: HydratedDocument<UserDocument> | UserDocument;
  targetUser: HydratedDocument<UserDocument> | UserDocument | null;
}

const assertTargetUserCanBeManaged = (params: AssertTargetUserCanBeManagedParams): void => {
  const { actor, targetUser } = params;

  if (!targetUser) {
    throw createUserManagementError('USER_NOT_FOUND');
  }

  if (targetUser.role === ROLES.SUPER_ADMIN) {
    throw createUserManagementError('SUPER_ADMIN_CANNOT_BE_MANAGED');
  }

  if (actor._id.toString() === targetUser._id.toString()) {
    throw createUserManagementError('USER_CANNOT_MANAGE_SELF');
  }
};

export interface CreateUserAuditLogParams {
  organizationId: ObjectIdLike;
  eventType: AuditEvent;
  actorId: ObjectIdLike;
  targetUserId: ObjectIdLike;
  reasonCode: string;
  requestContext?: AuthRequestContext | null;
  metadata?: Record<string, unknown>;
  session?: DatabaseSession;
}

const createUserAuditLog = ({
  organizationId,
  eventType,
  actorId,
  targetUserId,
  reasonCode,
  requestContext,
  metadata = {},
  session,
}: CreateUserAuditLogParams) =>
  createAuditLog({
    organizationId,
    eventType,
    actorId,
    targetUserId,
    outcome: AUDIT_OUTCOMES.SUCCESS,
    reasonCode,
    requestId: requestContext?.requestId ?? null,
    ipAddress: requestContext?.ipAddress ?? null,
    userAgent: requestContext?.userAgent ?? null,
    metadata: {
      source: 'user-management',
      ...metadata,
    },
    session,
  });

export interface ListOrganizationUsersParams extends PaginationParams {
  organizationId: ObjectIdLike;
  role?: Role;
  status?: UserStatus;
}

export const listOrganizationUsers = async ({
  organizationId,
  role,
  status,
  limit,
  skip,
}: ListOrganizationUsersParams) => {
  const users = await listUsersByOrganization({
    organizationId,
    role,
    status,
    limit,
    skip,
  });

  return users.map((user) => serializeUser(user));
};

export interface GetOrganizationUserParams {
  organizationId: ObjectIdLike;
  userId: ObjectIdLike;
}

export const getOrganizationUser = async ({
  organizationId,
  userId,
}: GetOrganizationUserParams) => {
  const user = await findUserById({
    userId,
    organizationId,
  });

  if (!user) {
    throw createUserManagementError('USER_NOT_FOUND');
  }

  return serializeUser(user);
};

export interface CreateOrganizationUserData {
  name: string;
  email: string;
  password: string;
  role: Role;
  permissionOverrides?: PermissionOverrides;
  accountAccessMode: AccountAccessMode;
  accountAccess?: ObjectIdLike[];
  mustChangePassword?: boolean;
}

export interface CreateOrganizationUserParams {
  organizationId: ObjectIdLike;
  actor: HydratedDocument<UserDocument> | UserDocument;
  userData: CreateOrganizationUserData;
  requestContext?: AuthRequestContext | null;
}

export const createOrganizationUser = async ({
  organizationId,
  actor,
  userData,
  requestContext,
}: CreateOrganizationUserParams) => {
  if (userData.role === ROLES.SUPER_ADMIN) {
    throw createUserManagementError('SUPER_ADMIN_CANNOT_BE_CREATED_BY_API');
  }

  const passwordValidation = validatePlainPassword(userData.password);

  if (!passwordValidation.valid) {
    throw createUserManagementError(passwordValidation.reasonCode);
  }

  const existingUser = await findUserByEmailInOrganization({
    organizationId,
    email: userData.email,
  });

  if (existingUser) {
    throw createUserManagementError('USER_EMAIL_ALREADY_EXISTS');
  }

  const passwordHash = await hashPassword(userData.password);

  const user = await runInTransaction(async (session) => {
    const createdUser = await createUser({
      organizationId,
      name: userData.name,
      email: userData.email,
      passwordHash,
      role: userData.role,
      permissionOverrides: userData.permissionOverrides,
      accountAccessMode: userData.accountAccessMode,
      accountAccess:
        userData.accountAccessMode === ACCOUNT_ACCESS_MODES.ALL
          ? []
          : (userData.accountAccess ?? []),
      status: USER_STATUSES.ACTIVE,
      mustChangePassword: userData.mustChangePassword,
      createdBy: actor._id,
      updatedBy: actor._id,
      session,
    });

    await createUserAuditLog({
      organizationId,
      eventType: AUDIT_EVENTS.USER_CREATED,
      actorId: actor._id,
      targetUserId: createdUser._id,
      reasonCode: 'user_created',
      requestContext,
      session,
    });

    return createdUser;
  });

  return serializeUser(user);
};

export interface UpdateOrganizationUserParams {
  organizationId: ObjectIdLike;
  actor: HydratedDocument<UserDocument> | UserDocument;
  userId: ObjectIdLike;
  updateData: UpdateQuery<UserDocument> & Record<string, unknown>;
  requestContext?: AuthRequestContext | null;
}

export const updateOrganizationUser = async ({
  organizationId,
  actor,
  userId,
  updateData,
  requestContext,
}: UpdateOrganizationUserParams) => {
  const targetUser = await findUserById({
    userId,
    organizationId,
  });

  assertTargetUserCanBeManaged({
    actor,
    targetUser,
  });

  const sanitizedUpdateData: UpdateQuery<UserDocument> & Record<string, unknown> = {
    ...updateData,
    updatedBy: actor._id,
  };

  if (sanitizedUpdateData.role === ROLES.SUPER_ADMIN) {
    throw createUserManagementError('SUPER_ADMIN_CANNOT_BE_ASSIGNED_BY_API');
  }

  if (sanitizedUpdateData.accountAccessMode === ACCOUNT_ACCESS_MODES.ALL) {
    sanitizedUpdateData.accountAccess = [];
  }

  const updatedUser = await runInTransaction(async (session) => {
    const updatedUser = await updateUserById({
      userId,
      organizationId,
      updateData: sanitizedUpdateData,
      session,
    });

    await createUserAuditLog({
      organizationId,
      eventType: AUDIT_EVENTS.USER_UPDATED,
      actorId: actor._id,
      targetUserId: updatedUser!._id,
      reasonCode: 'user_updated',
      requestContext,
      metadata: {
        updatedFields: Object.keys(updateData),
      },
      session,
    });

    return updatedUser;
  });

  return serializeUser(updatedUser);
};

export interface DisableOrganizationUserParams {
  organizationId: ObjectIdLike;
  actor: HydratedDocument<UserDocument> | UserDocument;
  userId: ObjectIdLike;
  requestContext?: AuthRequestContext | null;
}

export const disableOrganizationUser = async ({
  organizationId,
  actor,
  userId,
  requestContext,
}: DisableOrganizationUserParams) => {
  const targetUser = await findUserById({
    userId,
    organizationId,
  });

  assertTargetUserCanBeManaged({
    actor,
    targetUser,
  });

  const updatedUser = await runInTransaction(async (session) => {
    const updatedUser = await updateUserById({
      userId,
      organizationId,
      updateData: {
        status: USER_STATUSES.DISABLED,
        updatedBy: actor._id,
      },
      session,
    });

    await revokeActiveRefreshSessionsForUser({
      userId,
      revokeReason: 'user_disabled',
      session,
    });

    await createUserAuditLog({
      organizationId,
      eventType: AUDIT_EVENTS.USER_DISABLED,
      actorId: actor._id,
      targetUserId: updatedUser!._id,
      reasonCode: 'user_disabled',
      requestContext,
      session,
    });

    return updatedUser;
  });

  return serializeUser(updatedUser);
};

export interface EnableOrganizationUserParams {
  organizationId: ObjectIdLike;
  actor: HydratedDocument<UserDocument> | UserDocument;
  userId: ObjectIdLike;
  requestContext?: AuthRequestContext | null;
}

export const enableOrganizationUser = async ({
  organizationId,
  actor,
  userId,
  requestContext,
}: EnableOrganizationUserParams) => {
  const targetUser = await findUserById({
    userId,
    organizationId,
  });

  assertTargetUserCanBeManaged({
    actor,
    targetUser,
  });

  const updatedUser = await runInTransaction(async (session) => {
    const updatedUser = await updateUserById({
      userId,
      organizationId,
      updateData: {
        status: USER_STATUSES.ACTIVE,
        updatedBy: actor._id,
      },
      session,
    });

    await createUserAuditLog({
      organizationId,
      eventType: AUDIT_EVENTS.USER_ENABLED,
      actorId: actor._id,
      targetUserId: updatedUser!._id,
      reasonCode: 'user_enabled',
      requestContext,
      session,
    });

    return updatedUser;
  });

  return serializeUser(updatedUser);
};

export interface ResetOrganizationUserPasswordParams {
  organizationId: ObjectIdLike;
  actor: HydratedDocument<UserDocument> | UserDocument;
  userId: ObjectIdLike;
  password: string;
  mustChangePassword: boolean;
  requestContext?: AuthRequestContext | null;
}

export const resetOrganizationUserPassword = async ({
  organizationId,
  actor,
  userId,
  password,
  mustChangePassword,
  requestContext,
}: ResetOrganizationUserPasswordParams) => {
  const targetUser = await findUserById({
    userId,
    organizationId,
  });

  assertTargetUserCanBeManaged({
    actor,
    targetUser,
  });

  const passwordValidation = validatePlainPassword(password);

  if (!passwordValidation.valid) {
    throw createUserManagementError(passwordValidation.reasonCode);
  }

  const passwordHash = await hashPassword(password);

  const updatedUser = await runInTransaction(async (session) => {
    const updatedUser = await updateUserById({
      userId,
      organizationId,
      updateData: {
        passwordHash,
        mustChangePassword,
        passwordChangedAt: new Date(),
        updatedBy: actor._id,
      },
      session,
    });

    await revokeActiveRefreshSessionsForUser({
      userId,
      revokeReason: 'password_reset',
      session,
    });

    await createUserAuditLog({
      organizationId,
      eventType: AUDIT_EVENTS.USER_PASSWORD_RESET,
      actorId: actor._id,
      targetUserId: updatedUser!._id,
      reasonCode: 'password_reset',
      requestContext,
      session,
    });

    return updatedUser;
  });

  return serializeUser(updatedUser);
};
