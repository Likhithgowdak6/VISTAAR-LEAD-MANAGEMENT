import mongoose, { type HydratedDocument, type Types } from 'mongoose';

import { ACCOUNT_ACCESS_MODES } from '../../constants/account-access-modes.js';
import { AUDIT_EVENTS, type AuditEvent } from '../../constants/audit-events.js';
import { AUDIT_OUTCOMES, type AuditOutcome } from '../../constants/audit-outcomes.js';
import { type DatabaseSession, runInTransaction } from '../../config/database.js';
import { ORGANIZATION_STATUSES } from '../../constants/organization-statuses.js';
import { REFRESH_SESSION_STATUSES } from '../../constants/refresh-session-statuses.js';
import { USER_STATUSES } from '../../constants/user-statuses.js';
import { type ObjectIdLike } from '../../types/common.js';
import { createHttpError } from '../../utils/http-error.js';
import { createAuditLog } from '../audit/audit.repository.js';
import {
  findOrganizationById,
  findOrganizationBySlug,
} from '../organizations/organization.repository.js';
import { type OrganizationDocument } from '../organizations/organization.model.js';
import { serializeOrganization } from '../organizations/organization.serializer.js';
import {
  findUserByEmailInOrganization,
  findUserById,
  normalizeEmail,
  updateUserById,
} from '../users/user.repository.js';
import { type UserDocument } from '../users/user.model.js';
import { serializeUser } from '../users/user.serializer.js';

import {
  createRefreshSession,
  findRefreshSessionByTokenHash,
  markRefreshSessionExpired,
  markRefreshSessionRotated,
  revokeActiveRefreshSessionsForUser,
  revokeRefreshSessionById,
  revokeRefreshSessionFamily,
} from './refresh-session.repository.js';
import { type RefreshSessionDocument } from './refresh-session.model.js';
import { serializeRefreshSession } from './refresh-session.serializer.js';
import { clearLoginRateLimit, checkLoginRateLimit } from './login-rate-limit.service.js';
import {
  hashPassword,
  validatePlainPassword,
  verifyPassword,
  verifyPasswordOrDecoy,
} from './password.service.js';
import { resolveUserPermissions } from './permission.service.js';
import {
  generateRefreshToken,
  getRefreshTokenExpiresAt,
  hashRefreshToken,
  signAccessToken,
} from './token.service.js';

const DEFAULT_ORGANIZATION_SLUG = 'vistaar-media';

export interface AuthRequestContext {
  requestId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface CreateSafeAuditLogParams {
  organizationId?: ObjectIdLike | null;
  eventType: AuditEvent;
  actorId?: ObjectIdLike | null;
  targetUserId?: ObjectIdLike | null;
  sessionId?: ObjectIdLike | null;
  outcome: AuditOutcome;
  reasonCode?: string | null;
  requestContext?: AuthRequestContext | null;
  metadata?: Record<string, unknown>;
  session?: DatabaseSession;
}

const createSafeAuditLog = async ({
  organizationId,
  eventType,
  actorId = null,
  targetUserId = null,
  sessionId = null,
  outcome,
  reasonCode,
  requestContext,
  metadata = {},
  session,
}: CreateSafeAuditLogParams) => {
  if (!organizationId) {
    return null;
  }

  return createAuditLog({
    organizationId,
    eventType,
    actorId,
    targetUserId,
    sessionId,
    outcome,
    reasonCode,
    requestId: requestContext?.requestId ?? null,
    ipAddress: requestContext?.ipAddress ?? null,
    userAgent: requestContext?.userAgent ?? null,
    metadata,
    session,
  });
};

const createInvalidCredentialsError = () =>
  createHttpError({
    statusCode: 401,
    code: 'INVALID_CREDENTIALS',
    message: 'Invalid email or password.',
  });

class RefreshRotationConflictError extends Error {}

export interface CreateAuthPayloadParams {
  accessToken: string;
  user: unknown;
  organization: unknown;
  session: unknown;
}

const createAuthPayload = ({
  accessToken,
  user,
  organization,
  session,
}: CreateAuthPayloadParams) => ({
  accessToken,
  tokenType: 'Bearer' as const,
  organization: serializeOrganization(organization),
  user: serializeUser(user),
  permissions: resolveUserPermissions(user as UserDocument),
  session: serializeRefreshSession(session),
});

export interface CreateAuthenticatedSessionParams {
  organization: HydratedDocument<OrganizationDocument> | OrganizationDocument;
  user: HydratedDocument<UserDocument> | UserDocument;
  ipAddress?: string | null;
  userAgent?: string | null;
  familyId?: Types.ObjectId;
  session?: DatabaseSession;
}

const createAuthenticatedSession = async ({
  organization,
  user,
  ipAddress,
  userAgent,
  familyId = new mongoose.Types.ObjectId(),
  session: databaseSession,
}: CreateAuthenticatedSessionParams) => {
  const refreshToken = generateRefreshToken();
  const tokenHash = hashRefreshToken(refreshToken);

  const session = await createRefreshSession(
    {
      organizationId: organization._id,
      userId: user._id,
      familyId,
      tokenHash,
      expiresAt: getRefreshTokenExpiresAt(),
      createdByIp: ipAddress,
      lastUsedByIp: ipAddress,
      userAgent,
    },
    {
      session: databaseSession,
    },
  );

  const accessToken = signAccessToken({
    userId: user._id,
    sessionId: session._id,
    organizationId: organization._id,
  });

  return {
    refreshToken,
    accessToken,
    session,
  };
};

export interface LoginWithPasswordParams {
  organizationSlug?: string;
  email: string;
  password: string;
  requestContext?: AuthRequestContext | null;
}

export const loginWithPassword = async ({
  organizationSlug = DEFAULT_ORGANIZATION_SLUG,
  email,
  password,
  requestContext,
}: LoginWithPasswordParams) => {
  const normalizedEmail = normalizeEmail(email);
  const normalizedOrganizationSlug = organizationSlug.trim().toLowerCase();

  const rateLimitResult = await checkLoginRateLimit({
    email: normalizedEmail,
    ipAddress: requestContext?.ipAddress,
  });

  if (rateLimitResult.limited) {
    throw createHttpError({
      statusCode: 429,
      code: 'AUTH_LOGIN_RATE_LIMITED',
      message: 'Too many login attempts. Please try again later.',
      details: {
        retryAfterSeconds: rateLimitResult.retryAfterSeconds,
      },
    });
  }

  const organization = await findOrganizationBySlug(normalizedOrganizationSlug);

  if (!organization) {
    // Match the cost of a real verification so an unknown slug is not
    // distinguishable by response time.
    await verifyPasswordOrDecoy({ password });

    throw createInvalidCredentialsError();
  }

  const user = await findUserByEmailInOrganization({
    organizationId: organization._id,
    email: normalizedEmail,
    includePasswordHash: true,
  });

  const passwordMatches = await verifyPasswordOrDecoy({
    password,
    passwordHash: user?.passwordHash,
  });

  if (!user || !passwordMatches) {
    await createSafeAuditLog({
      organizationId: organization._id,
      eventType: AUDIT_EVENTS.AUTH_LOGIN_FAILED,
      outcome: AUDIT_OUTCOMES.FAILURE,
      reasonCode: 'invalid_credentials',
      requestContext,
      metadata: {
        source: 'auth-login',
      },
    });

    throw createInvalidCredentialsError();
  }

  if (organization.status !== ORGANIZATION_STATUSES.ACTIVE) {
    await createSafeAuditLog({
      organizationId: organization._id,
      eventType: AUDIT_EVENTS.AUTH_LOGIN_FAILED,
      targetUserId: user._id,
      outcome: AUDIT_OUTCOMES.FAILURE,
      reasonCode: 'organization_not_active',
      requestContext,
      metadata: {
        source: 'auth-login',
      },
    });

    throw createHttpError({
      statusCode: 403,
      code: 'ORGANIZATION_NOT_ACTIVE',
      message: 'Organization is not active.',
    });
  }

  if (user.status !== USER_STATUSES.ACTIVE) {
    await createSafeAuditLog({
      organizationId: organization._id,
      eventType: AUDIT_EVENTS.AUTH_LOGIN_FAILED,
      targetUserId: user._id,
      outcome: AUDIT_OUTCOMES.FAILURE,
      reasonCode: 'user_not_active',
      requestContext,
      metadata: {
        source: 'auth-login',
      },
    });

    throw createHttpError({
      statusCode: 403,
      code: 'USER_NOT_ACTIVE',
      message: 'User is not active.',
    });
  }

  const { refreshToken, accessToken, session, updatedUser } = await runInTransaction(
    async (databaseSession) => {
      const authenticatedSession = await createAuthenticatedSession({
        organization,
        user,
        ipAddress: requestContext?.ipAddress,
        userAgent: requestContext?.userAgent,
        session: databaseSession,
      });

      const updatedUser = await updateUserById({
        userId: user._id,
        organizationId: organization._id,
        updateData: {
          lastLoginAt: new Date(),
        },
        session: databaseSession,
      });

      await createSafeAuditLog({
        organizationId: organization._id,
        eventType: AUDIT_EVENTS.AUTH_LOGIN_SUCCEEDED,
        actorId: updatedUser!._id,
        targetUserId: updatedUser!._id,
        sessionId: authenticatedSession.session._id,
        outcome: AUDIT_OUTCOMES.SUCCESS,
        reasonCode: 'login_success',
        requestContext,
        metadata: {
          source: 'auth-login',
        },
        session: databaseSession,
      });

      return {
        ...authenticatedSession,
        updatedUser,
      };
    },
  );

  await clearLoginRateLimit({
    email: normalizedEmail,
    ipAddress: requestContext?.ipAddress,
  });

  return {
    refreshToken,
    data: createAuthPayload({
      accessToken,
      user: updatedUser,
      organization,
      session,
    }),
  };
};

export interface RefreshAuthenticatedSessionParams {
  refreshToken?: string | null;
  requestContext?: AuthRequestContext | null;
}

export const refreshAuthenticatedSession = async ({
  refreshToken,
  requestContext,
}: RefreshAuthenticatedSessionParams) => {
  if (!refreshToken) {
    throw createHttpError({
      statusCode: 401,
      code: 'REFRESH_TOKEN_MISSING',
      message: 'Refresh token is required.',
    });
  }

  const tokenHash = hashRefreshToken(refreshToken);

  const existingSession = await findRefreshSessionByTokenHash({
    tokenHash,
  });

  if (!existingSession) {
    throw createHttpError({
      statusCode: 401,
      code: 'REFRESH_SESSION_NOT_FOUND',
      message: 'Refresh session is not valid.',
    });
  }

  if (existingSession.status !== REFRESH_SESSION_STATUSES.ACTIVE) {
    if (existingSession.status === REFRESH_SESSION_STATUSES.ROTATED) {
      await revokeRefreshSessionFamily({
        familyId: existingSession.familyId,
        revokeReason: 'refresh_token_reuse_detected',
        markAsCompromised: true,
      });

      await createSafeAuditLog({
        organizationId: existingSession.organizationId,
        eventType: AUDIT_EVENTS.AUTH_REFRESH_REUSE_DETECTED,
        targetUserId: existingSession.userId,
        sessionId: existingSession._id,
        outcome: AUDIT_OUTCOMES.FAILURE,
        reasonCode: 'refresh_token_reuse_detected',
        requestContext,
        metadata: {
          source: 'auth-refresh',
        },
      });
    }

    throw createHttpError({
      statusCode: 401,
      code: 'REFRESH_SESSION_NOT_ACTIVE',
      message: 'Refresh session is not active.',
    });
  }

  if (existingSession.expiresAt <= new Date()) {
    await markRefreshSessionExpired({
      sessionId: existingSession._id,
    });

    throw createHttpError({
      statusCode: 401,
      code: 'REFRESH_SESSION_EXPIRED',
      message: 'Refresh session has expired.',
    });
  }

  const [organization, user] = await Promise.all([
    findOrganizationById(existingSession.organizationId),
    findUserById({
      userId: existingSession.userId,
    }),
  ]);

  if (
    !organization ||
    organization._id.toString() !== existingSession.organizationId.toString() ||
    organization.status !== ORGANIZATION_STATUSES.ACTIVE
  ) {
    await revokeRefreshSessionById({
      sessionId: existingSession._id,
      revokeReason: 'organization_not_active',
    });

    throw createHttpError({
      statusCode: 401,
      code: 'ORGANIZATION_NOT_ACTIVE',
      message: 'Organization is not active.',
    });
  }

  if (!user || user.status !== USER_STATUSES.ACTIVE) {
    await revokeRefreshSessionById({
      sessionId: existingSession._id,
      revokeReason: 'user_not_active',
    });

    throw createHttpError({
      statusCode: 401,
      code: 'USER_NOT_ACTIVE',
      message: 'User is not active.',
    });
  }

  let rotationResult;

  try {
    rotationResult = await runInTransaction(async (databaseSession) => {
      const authenticatedSession = await createAuthenticatedSession({
        organization,
        user,
        familyId: existingSession.familyId,
        ipAddress: requestContext?.ipAddress,
        userAgent: requestContext?.userAgent,
        session: databaseSession,
      });

      const rotatedSession = await markRefreshSessionRotated({
        sessionId: existingSession._id,
        replacedBySessionId: authenticatedSession.session._id,
        session: databaseSession,
      });

      if (!rotatedSession) {
        throw new RefreshRotationConflictError();
      }

      await createSafeAuditLog({
        organizationId: organization._id,
        eventType: AUDIT_EVENTS.AUTH_REFRESH_SUCCEEDED,
        actorId: user._id,
        targetUserId: user._id,
        sessionId: authenticatedSession.session._id,
        outcome: AUDIT_OUTCOMES.SUCCESS,
        reasonCode: 'refresh_success',
        requestContext,
        metadata: {
          source: 'auth-refresh',
          rotatedSessionId: rotatedSession._id.toString(),
        },
        session: databaseSession,
      });

      return {
        ...authenticatedSession,
        rotatedSession,
      };
    });
  } catch (error: unknown) {
    if (!(error instanceof RefreshRotationConflictError)) {
      throw error;
    }

    await runInTransaction(async (databaseSession) => {
      await revokeRefreshSessionFamily({
        familyId: existingSession.familyId,
        revokeReason: 'refresh_token_reuse_detected',
        markAsCompromised: true,
        session: databaseSession,
      });

      await createSafeAuditLog({
        organizationId: organization._id,
        eventType: AUDIT_EVENTS.AUTH_REFRESH_REUSE_DETECTED,
        actorId: user._id,
        targetUserId: user._id,
        sessionId: existingSession._id,
        outcome: AUDIT_OUTCOMES.FAILURE,
        reasonCode: 'refresh_token_reuse_detected',
        requestContext,
        metadata: {
          source: 'auth-refresh',
          detectedVia: 'rotation_conflict',
        },
        session: databaseSession,
      });
    });

    throw createHttpError({
      statusCode: 401,
      code: 'REFRESH_SESSION_NOT_ACTIVE',
      message: 'Refresh session is not active.',
    });
  }

  const { refreshToken: newRefreshToken, accessToken, session: newSession } = rotationResult;

  return {
    refreshToken: newRefreshToken,
    data: createAuthPayload({
      accessToken,
      user,
      organization,
      session: newSession,
    }),
  };
};

export interface LogoutCurrentSessionParams {
  refreshToken?: string | null;
  requestContext?: AuthRequestContext | null;
}

export const logoutCurrentSession = async ({
  refreshToken,
  requestContext,
}: LogoutCurrentSessionParams) => {
  if (!refreshToken) {
    return {
      sessionRevoked: false,
    };
  }

  const tokenHash = hashRefreshToken(refreshToken);

  const session = await findRefreshSessionByTokenHash({
    tokenHash,
  });

  if (!session) {
    return {
      sessionRevoked: false,
    };
  }

  if (session.status === REFRESH_SESSION_STATUSES.ACTIVE) {
    await runInTransaction(async (databaseSession) => {
      await revokeRefreshSessionById({
        sessionId: session._id,
        revokeReason: 'logout',
        session: databaseSession,
      });

      await createSafeAuditLog({
        organizationId: session.organizationId,
        eventType: AUDIT_EVENTS.AUTH_LOGOUT,
        actorId: session.userId,
        targetUserId: session.userId,
        sessionId: session._id,
        outcome: AUDIT_OUTCOMES.SUCCESS,
        reasonCode: 'logout',
        requestContext,
        metadata: {
          source: 'auth-logout',
        },
        session: databaseSession,
      });
    });

    return {
      sessionRevoked: true,
    };
  }

  return {
    sessionRevoked: false,
  };
};

export interface LogoutAllUserSessionsParams {
  user: HydratedDocument<UserDocument> | UserDocument;
  organization: HydratedDocument<OrganizationDocument> | OrganizationDocument;
  session: HydratedDocument<RefreshSessionDocument> | RefreshSessionDocument;
  requestContext?: AuthRequestContext | null;
}

export const logoutAllUserSessions = async ({
  user,
  organization,
  session,
  requestContext,
}: LogoutAllUserSessionsParams) => {
  await runInTransaction(async (databaseSession) => {
    await revokeActiveRefreshSessionsForUser({
      userId: user._id,
      revokeReason: 'logout_all',
      session: databaseSession,
    });

    await createSafeAuditLog({
      organizationId: organization._id,
      eventType: AUDIT_EVENTS.AUTH_LOGOUT_ALL,
      actorId: user._id,
      targetUserId: user._id,
      sessionId: session._id,
      outcome: AUDIT_OUTCOMES.SUCCESS,
      reasonCode: 'logout_all',
      requestContext,
      metadata: {
        source: 'auth-logout-all',
      },
      session: databaseSession,
    });
  });

  return {
    sessionsRevoked: true,
  };
};

/**
 * Lets a signed-in user set their own password. This is the only way to clear
 * `mustChangePassword`, so an admin-assigned temporary password cannot stay in use.
 * Every other session is revoked: the old password must not keep a login alive.
 */
export interface ChangeOwnPasswordParams {
  user: HydratedDocument<UserDocument> | UserDocument;
  organization: HydratedDocument<OrganizationDocument> | OrganizationDocument;
  session?: HydratedDocument<RefreshSessionDocument> | RefreshSessionDocument | null;
  currentPassword: string;
  newPassword: string;
  requestContext?: AuthRequestContext | null;
}

export const changeOwnPassword = async ({
  user,
  organization,
  session,
  currentPassword,
  newPassword,
  requestContext,
}: ChangeOwnPasswordParams) => {
  // `req.auth.user` is loaded without the hash, so re-read it with the hash for verification.
  const userWithPasswordHash = await findUserById({
    userId: user._id,
    organizationId: organization._id,
    includePasswordHash: true,
  });

  if (!userWithPasswordHash) {
    throw createHttpError({
      statusCode: 401,
      code: 'USER_NOT_ACTIVE',
      message: 'User is not active.',
    });
  }

  const currentPasswordMatches = await verifyPassword({
    password: currentPassword,
    passwordHash: userWithPasswordHash.passwordHash,
  });

  if (!currentPasswordMatches) {
    await createSafeAuditLog({
      organizationId: organization._id,
      eventType: AUDIT_EVENTS.AUTH_PASSWORD_CHANGED,
      actorId: user._id,
      targetUserId: user._id,
      sessionId: session?._id ?? null,
      outcome: AUDIT_OUTCOMES.FAILURE,
      reasonCode: 'invalid_current_password',
      requestContext,
      metadata: {
        source: 'auth-change-password',
      },
    });

    throw createHttpError({
      statusCode: 401,
      code: 'INVALID_CURRENT_PASSWORD',
      message: 'Current password is incorrect.',
    });
  }

  const passwordValidation = validatePlainPassword(newPassword);

  if (!passwordValidation.valid) {
    throw createHttpError({
      statusCode: 400,
      code: passwordValidation.reasonCode,
      message: 'New password does not meet the password policy.',
    });
  }

  const reusesCurrentPassword = await verifyPassword({
    password: newPassword,
    passwordHash: userWithPasswordHash.passwordHash,
  });

  if (reusesCurrentPassword) {
    throw createHttpError({
      statusCode: 400,
      code: 'PASSWORD_REUSED',
      message: 'New password must be different from the current password.',
    });
  }

  const passwordHash = await hashPassword(newPassword);

  const updatedUser = await runInTransaction(async (databaseSession) => {
    const updated = await updateUserById({
      userId: user._id,
      organizationId: organization._id,
      updateData: {
        passwordHash,
        mustChangePassword: false,
        passwordChangedAt: new Date(),
        updatedBy: user._id,
      },
      session: databaseSession,
    });

    // Every other session dies with the old password; the current one survives so the user
    // is not bounced to the login screen the moment they satisfy a forced change.
    await revokeActiveRefreshSessionsForUser({
      userId: user._id,
      revokeReason: 'password_changed',
      exceptSessionId: session?._id ?? null,
      session: databaseSession,
    });

    await createSafeAuditLog({
      organizationId: organization._id,
      eventType: AUDIT_EVENTS.AUTH_PASSWORD_CHANGED,
      actorId: user._id,
      targetUserId: user._id,
      sessionId: session?._id ?? null,
      outcome: AUDIT_OUTCOMES.SUCCESS,
      reasonCode: 'password_changed',
      requestContext,
      metadata: {
        source: 'auth-change-password',
      },
      session: databaseSession,
    });

    return updated;
  });

  return {
    passwordChanged: true,
    user: serializeUser(updatedUser),
  };
};

export interface BuildCurrentUserProfileParams {
  user: HydratedDocument<UserDocument> | UserDocument;
  organization: unknown;
  session: unknown;
}

export const buildCurrentUserProfile = ({
  user,
  organization,
  session,
}: BuildCurrentUserProfileParams) => ({
  organization: serializeOrganization(organization),
  user: serializeUser(user),
  permissions: resolveUserPermissions(user),
  session: serializeRefreshSession(session),
  accountAccessMode: user.accountAccessMode ?? ACCOUNT_ACCESS_MODES.SELECTED,
});
