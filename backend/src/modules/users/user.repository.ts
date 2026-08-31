import { type QueryFilter, type UpdateQuery } from 'mongoose';

import { type AccountAccessMode } from '../../constants/account-access-modes.js';
import { type Role } from '../../constants/roles.js';
import { USER_STATUSES, type UserStatus } from '../../constants/user-statuses.js';
import { type DatabaseSession } from '../../config/database.js';
import { type ObjectIdLike, type PaginationParams, toObjectId } from '../../types/common.js';

import { User, type PermissionOverrides, type UserDocument } from './user.model.js';

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export interface CreateUserParams {
  organizationId: ObjectIdLike;
  name: string;
  email: string;
  passwordHash: string;
  role: Role;
  permissionOverrides?: PermissionOverrides;
  accountAccessMode?: AccountAccessMode;
  accountAccess?: readonly ObjectIdLike[];
  status?: UserStatus;
  mustChangePassword?: boolean;
  passwordChangedAt?: Date | null;
  lastLoginAt?: Date | null;
  createdBy?: ObjectIdLike | null;
  updatedBy?: ObjectIdLike | null;
  session?: DatabaseSession;
}

export const createUser = ({
  organizationId,
  name,
  email,
  passwordHash,
  role,
  permissionOverrides,
  accountAccessMode,
  accountAccess = [],
  status,
  mustChangePassword,
  passwordChangedAt,
  lastLoginAt,
  createdBy = null,
  updatedBy = null,
  session,
}: CreateUserParams) => {
  const userData = {
    organizationId: toObjectId(organizationId),
    name,
    email,
    passwordHash,
    role,
    permissionOverrides,
    accountAccessMode,
    accountAccess: accountAccess.map(toObjectId),
    status,
    mustChangePassword,
    passwordChangedAt,
    lastLoginAt,
    createdBy: createdBy ? toObjectId(createdBy) : null,
    updatedBy: updatedBy ? toObjectId(updatedBy) : null,
  };

  if (!session) {
    return User.create(userData);
  }

  return User.create([userData], { session }).then(([user]) => user!);
};

export interface FindUserByIdParams {
  userId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  includePasswordHash?: boolean;
}

export const findUserById = ({
  userId,
  organizationId,
  includePasswordHash = false,
}: FindUserByIdParams = {}) => {
  const filter: QueryFilter<UserDocument> = {
    _id: userId,
  };

  if (organizationId) {
    filter.organizationId = organizationId;
  }

  let query = User.findOne(filter);

  if (includePasswordHash) {
    query = query.select('+passwordHash');
  }

  return query.exec();
};

export interface FindUserByEmailInOrganizationParams {
  organizationId?: ObjectIdLike;
  email: string;
  includePasswordHash?: boolean;
}

export const findUserByEmailInOrganization = ({
  organizationId,
  email,
  includePasswordHash = false,
}: FindUserByEmailInOrganizationParams) => {
  let query = User.findOne({
    organizationId,
    email: normalizeEmail(email),
  });

  if (includePasswordHash) {
    query = query.select('+passwordHash');
  }

  return query.exec();
};

export interface ListUsersByOrganizationParams extends PaginationParams {
  organizationId?: ObjectIdLike;
  role?: Role;
  status?: UserStatus;
}

export const listUsersByOrganization = ({
  organizationId,
  role,
  status,
  limit = 50,
  skip = 0,
}: ListUsersByOrganizationParams = {}) => {
  const filter: QueryFilter<UserDocument> = {
    organizationId,
  };

  if (role) {
    filter.role = role;
  }

  if (status) {
    filter.status = status;
  }

  return User.find(filter)
    .sort({
      createdAt: -1,
    })
    .skip(skip)
    .limit(limit)
    .exec();
};

export interface FindFirstActiveUserByRoleParams {
  organizationId?: ObjectIdLike;
  role?: Role;
}

/**
 * Earliest-created active user in the organization with the given role. Used to resolve a real
 * human actor for actions triggered outside an authenticated dashboard session - e.g. the org
 * owner approving an AI draft by replying directly in their own WhatsApp "message yourself"
 * chat, where there is no login session to read an actor off of.
 */
export const findFirstActiveUserByRole = ({
  organizationId,
  role,
}: FindFirstActiveUserByRoleParams = {}) =>
  User.findOne({
    organizationId,
    role,
    status: USER_STATUSES.ACTIVE,
  })
    .sort({ createdAt: 1 })
    .exec();

export interface UpdateUserByIdParams {
  userId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  updateData: UpdateQuery<UserDocument>;
  session?: DatabaseSession;
}

export const updateUserById = ({
  userId,
  organizationId,
  updateData,
  session,
}: UpdateUserByIdParams) => {
  const filter: QueryFilter<UserDocument> = {
    _id: userId,
  };

  if (organizationId) {
    filter.organizationId = organizationId;
  }

  return User.findOneAndUpdate(filter, updateData, {
    returnDocument: 'after',
    runValidators: true,
    session,
  }).exec();
};
