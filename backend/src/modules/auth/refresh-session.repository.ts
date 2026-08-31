import { type UpdateQuery } from 'mongoose';

import { REFRESH_SESSION_STATUSES } from '../../constants/refresh-session-statuses.js';
import { type DatabaseSession } from '../../config/database.js';
import { type ObjectIdLike } from '../../types/common.js';

import { RefreshSession, type RefreshSessionDocument } from './refresh-session.model.js';

export interface CreateRefreshSessionOptions {
  session?: DatabaseSession;
}

export const createRefreshSession = async (
  sessionData: Partial<RefreshSessionDocument>,
  { session }: CreateRefreshSessionOptions = {},
) => {
  const [createdSession] = await RefreshSession.create([sessionData], { session });
  return createdSession!;
};

export interface FindRefreshSessionByIdParams {
  sessionId?: ObjectIdLike;
  includeTokenHash?: boolean;
}

export const findRefreshSessionById = ({
  sessionId,
  includeTokenHash = false,
}: FindRefreshSessionByIdParams = {}) => {
  let query = RefreshSession.findById(sessionId);

  if (includeTokenHash) {
    query = query.select('+tokenHash');
  }

  return query.exec();
};

export interface FindRefreshSessionByTokenHashParams {
  tokenHash: string;
  includeTokenHash?: boolean;
}

export const findRefreshSessionByTokenHash = ({
  tokenHash,
  includeTokenHash = false,
}: FindRefreshSessionByTokenHashParams) => {
  let query = RefreshSession.findOne({
    tokenHash,
  });

  if (includeTokenHash) {
    query = query.select('+tokenHash');
  }

  return query.exec();
};

export interface FindActiveRefreshSessionByFamilyParams {
  familyId: ObjectIdLike;
  userId: ObjectIdLike;
  organizationId: ObjectIdLike;
  now?: Date;
}

export const findActiveRefreshSessionByFamily = ({
  familyId,
  userId,
  organizationId,
  now = new Date(),
}: FindActiveRefreshSessionByFamilyParams) =>
  RefreshSession.findOne({
    familyId,
    userId,
    organizationId,
    status: REFRESH_SESSION_STATUSES.ACTIVE,
    expiresAt: { $gt: now },
  })
    .sort({ createdAt: -1 })
    .exec();

export const listActiveRefreshSessionsByUserId = (userId: ObjectIdLike) =>
  RefreshSession.find({
    userId,
    status: REFRESH_SESSION_STATUSES.ACTIVE,
    expiresAt: {
      $gt: new Date(),
    },
  })
    .sort({
      createdAt: -1,
    })
    .exec();

export interface UpdateRefreshSessionLastUsedParams {
  sessionId?: ObjectIdLike;
  lastUsedAt?: Date;
  lastUsedByIp?: string | null;
}

export const updateRefreshSessionLastUsed = ({
  sessionId,
  lastUsedAt = new Date(),
  lastUsedByIp,
}: UpdateRefreshSessionLastUsedParams = {}) =>
  RefreshSession.findByIdAndUpdate(
    sessionId,
    {
      lastUsedAt,
      lastUsedByIp,
    },
    {
      returnDocument: 'after',
      runValidators: true,
    },
  ).exec();

export interface MarkRefreshSessionRotatedParams {
  sessionId?: ObjectIdLike;
  replacedBySessionId?: ObjectIdLike;
  rotatedAt?: Date;
  session?: DatabaseSession;
}

/**
 * Claims the rotation atomically: the `status` guard means only one caller can
 * move a session out of ACTIVE, so concurrent refreshes with the same token
 * cannot both succeed. Returns `null` when another caller already rotated it.
 */
export const markRefreshSessionRotated = ({
  sessionId,
  replacedBySessionId,
  rotatedAt = new Date(),
  session,
}: MarkRefreshSessionRotatedParams = {}) =>
  RefreshSession.findOneAndUpdate(
    {
      _id: sessionId,
      status: REFRESH_SESSION_STATUSES.ACTIVE,
    },
    {
      status: REFRESH_SESSION_STATUSES.ROTATED,
      rotatedAt,
      replacedBySessionId,
      lastUsedAt: rotatedAt,
    },
    {
      returnDocument: 'after',
      runValidators: true,
      session,
    },
  ).exec();

export interface MarkRefreshSessionExpiredParams {
  sessionId?: ObjectIdLike;
  expiredAt?: Date;
  revokeReason?: string;
}

export const markRefreshSessionExpired = ({
  sessionId,
  expiredAt = new Date(),
  revokeReason = 'refresh_token_expired',
}: MarkRefreshSessionExpiredParams = {}) =>
  RefreshSession.findByIdAndUpdate(
    sessionId,
    {
      status: REFRESH_SESSION_STATUSES.EXPIRED,
      revokedAt: expiredAt,
      revokeReason,
    },
    {
      returnDocument: 'after',
      runValidators: true,
    },
  ).exec();

export interface RevokeRefreshSessionByIdParams {
  sessionId?: ObjectIdLike;
  revokedAt?: Date;
  revokeReason?: string;
  session?: DatabaseSession;
}

export const revokeRefreshSessionById = ({
  sessionId,
  revokedAt = new Date(),
  revokeReason = 'manual_revoke',
  session,
}: RevokeRefreshSessionByIdParams = {}) =>
  RefreshSession.findByIdAndUpdate(
    sessionId,
    {
      status: REFRESH_SESSION_STATUSES.REVOKED,
      revokedAt,
      revokeReason,
    },
    {
      returnDocument: 'after',
      runValidators: true,
      session,
    },
  ).exec();

export interface RevokeRefreshSessionFamilyParams {
  familyId?: ObjectIdLike;
  revokedAt?: Date;
  revokeReason?: string;
  markAsCompromised?: boolean;
  session?: DatabaseSession;
}

export const revokeRefreshSessionFamily = ({
  familyId,
  revokedAt = new Date(),
  revokeReason = 'family_revoke',
  markAsCompromised = false,
  session,
}: RevokeRefreshSessionFamilyParams = {}) => {
  const updateData: UpdateQuery<RefreshSessionDocument> = {
    status: markAsCompromised
      ? REFRESH_SESSION_STATUSES.COMPROMISED
      : REFRESH_SESSION_STATUSES.REVOKED,
    revokedAt,
    revokeReason,
  };

  if (markAsCompromised) {
    updateData.reuseDetectedAt = revokedAt;
  }

  return RefreshSession.updateMany(
    {
      familyId,
      status: {
        $in: [REFRESH_SESSION_STATUSES.ACTIVE, REFRESH_SESSION_STATUSES.ROTATED],
      },
    },
    updateData,
    {
      runValidators: true,
      session,
    },
  ).exec();
};

export interface RevokeActiveRefreshSessionsForUserParams {
  userId?: ObjectIdLike;
  revokedAt?: Date;
  revokeReason?: string;
  /** Keeps one session alive — used when a user changes their own password. */
  exceptSessionId?: ObjectIdLike | null;
  session?: DatabaseSession;
}

export const revokeActiveRefreshSessionsForUser = ({
  userId,
  revokedAt = new Date(),
  revokeReason = 'user_sessions_revoked',
  // Keeps one session alive — used when a user changes their own password, so the session
  // that just authenticated the change is not logged out along with the others.
  exceptSessionId = null,
  session,
}: RevokeActiveRefreshSessionsForUserParams = {}) =>
  RefreshSession.updateMany(
    {
      userId,
      status: REFRESH_SESSION_STATUSES.ACTIVE,
      ...(exceptSessionId ? { _id: { $ne: exceptSessionId } } : {}),
    },
    {
      status: REFRESH_SESSION_STATUSES.REVOKED,
      revokedAt,
      revokeReason,
    },
    {
      runValidators: true,
      session,
    },
  ).exec();
