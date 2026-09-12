import { type Request, type RequestHandler } from 'express';

import { PERMISSIONS, type Permission } from '../constants/permissions.js';
import { ORGANIZATION_STATUSES } from '../constants/organization-statuses.js';
import { REFRESH_SESSION_STATUSES } from '../constants/refresh-session-statuses.js';
import { USER_STATUSES } from '../constants/user-statuses.js';
import {
  resolveUserPermissions,
  userHasAnyPermission,
  userHasEveryPermission,
} from '../modules/auth/permission.service.js';
import {
  findActiveRefreshSessionByFamily,
  findRefreshSessionById,
} from '../modules/auth/refresh-session.repository.js';
import { verifyAccessToken } from '../modules/auth/token.service.js';
import { findOrganizationById } from '../modules/organizations/organization.repository.js';
import { findUserById } from '../modules/users/user.repository.js';
import { createHttpError } from '../utils/http-error.js';

const getErrorCode = (error: unknown): string => {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }

  if (error instanceof Error && error.message) {
    return error.message;
  }

  return 'AUTHENTICATION_FAILED';
};

const getBearerToken = (req: Request): string | null => {
  const authorizationHeader = req.get('authorization');

  if (!authorizationHeader?.startsWith('Bearer ')) {
    return null;
  }

  return authorizationHeader.slice('Bearer '.length).trim();
};

export const authenticateRequest: RequestHandler = async (req, _res, next) => {
  try {
    const token = getBearerToken(req);

    if (!token) {
      throw createHttpError({
        statusCode: 401,
        code: 'AUTH_TOKEN_MISSING',
        message: 'Authentication token is required.',
      });
    }

    const decodedToken = verifyAccessToken(token);

    const [user, organization, session] = await Promise.all([
      findUserById({
        userId: decodedToken.sub,
      }),
      findOrganizationById(decodedToken.org),
      findRefreshSessionById({
        sessionId: decodedToken.sid,
      }),
    ]);

    if (!organization || organization.status !== ORGANIZATION_STATUSES.ACTIVE) {
      throw createHttpError({
        statusCode: 401,
        code: 'ORGANIZATION_NOT_ACTIVE',
        message: 'Organization is not active.',
      });
    }

    if (!user || user.status !== USER_STATUSES.ACTIVE) {
      throw createHttpError({
        statusCode: 401,
        code: 'USER_NOT_ACTIVE',
        message: 'User is not active.',
      });
    }

    if (
      !session ||
      session.userId.toString() !== user._id.toString() ||
      session.organizationId.toString() !== organization._id.toString()
    ) {
      throw createHttpError({
        statusCode: 401,
        code: 'SESSION_NOT_ACTIVE',
        message: 'Session is not active.',
      });
    }

    const activeSession =
      session.status === REFRESH_SESSION_STATUSES.ACTIVE
        ? session
        : session.status === REFRESH_SESSION_STATUSES.ROTATED
          ? await findActiveRefreshSessionByFamily({
              familyId: session.familyId,
              userId: user._id,
              organizationId: organization._id,
            })
          : null;

    if (!activeSession) {
      throw createHttpError({
        statusCode: 401,
        code: 'SESSION_NOT_ACTIVE',
        message: 'Session is not active.',
      });
    }

    req.auth = {
      token: decodedToken,
      user,
      organization,
      session: activeSession,
      permissions: resolveUserPermissions(user),
    };

    next();
  } catch (error: unknown) {
    next(
      createHttpError({
        statusCode: 401,
        code: getErrorCode(error),
        message: 'Authentication failed.',
      }),
    );
  }
};

export const requirePermissions =
  (...permissions: Permission[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.auth?.user) {
      next(
        createHttpError({
          statusCode: 401,
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication is required.',
        }),
      );
      return;
    }

    if (
      !userHasEveryPermission({
        user: req.auth.user,
        permissions,
      })
    ) {
      next(
        createHttpError({
          statusCode: 403,
          code: 'PERMISSION_DENIED',
          message: 'You do not have permission to perform this action.',
          details: {
            requiredPermissions: permissions,
          },
        }),
      );
      return;
    }

    next();
  };

export const requireAnyPermission =
  (...permissions: Permission[]): RequestHandler =>
  (req, _res, next) => {
    if (!req.auth?.user) {
      next(
        createHttpError({
          statusCode: 401,
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication is required.',
        }),
      );
      return;
    }

    if (
      !userHasAnyPermission({
        user: req.auth.user,
        permissions,
      })
    ) {
      next(
        createHttpError({
          statusCode: 403,
          code: 'PERMISSION_DENIED',
          message: 'You do not have permission to perform this action.',
          details: {
            requiredAnyPermissions: permissions,
          },
        }),
      );
      return;
    }

    next();
  };

/**
 * Blocks the product API while a user still owes a password change. Enforced server-side on
 * purpose: a frontend-only gate could be stepped around by calling the API directly. The
 * `/auth` routes stay open so the user can still read their profile, change the password and
 * log out.
 */
export const requirePasswordChanged: RequestHandler = (req, _res, next) => {
  if (!req.auth?.user) {
    next(
      createHttpError({
        statusCode: 401,
        code: 'AUTHENTICATION_REQUIRED',
        message: 'Authentication is required.',
      }),
    );
    return;
  }

  if (req.auth.user.mustChangePassword) {
    next(
      createHttpError({
        statusCode: 403,
        code: 'PASSWORD_CHANGE_REQUIRED',
        message: 'You must change your password before using the application.',
      }),
    );
    return;
  }

  next();
};

export const requireUsersRead = requirePermissions(PERMISSIONS.USERS_READ);

export const requireUsersManage = requirePermissions(PERMISSIONS.USERS_MANAGE);

export const requireConversationsRead = requireAnyPermission(
  PERMISSIONS.CONVERSATIONS_READ_ASSIGNED,
  PERMISSIONS.CONVERSATIONS_READ_ALL,
);

export const requireConversationsAssign = requirePermissions(PERMISSIONS.CONVERSATIONS_ASSIGN);

export const requireMessagesSend = requirePermissions(PERMISSIONS.MESSAGES_SEND);

export const requireClientPiiReveal = requirePermissions(PERMISSIONS.CLIENT_PII_REVEAL);

export const requireCrmTasksManage = requirePermissions(PERMISSIONS.CRM_TASKS_MANAGE);

export const requireCrmTagsManage = requirePermissions(PERMISSIONS.CRM_TAGS_MANAGE);

export const requireCrmStageManage = requirePermissions(PERMISSIONS.CRM_STAGE_MANAGE);

export const requireAiGenerate = requirePermissions(PERMISSIONS.AI_GENERATE);

export const requireAiKnowledgeManage = requirePermissions(PERMISSIONS.AI_KNOWLEDGE_MANAGE);

export const requireAiAutomationManage = requirePermissions(PERMISSIONS.AI_AUTOMATION_MANAGE);

export const requireTemplatesManage = requirePermissions(PERMISSIONS.TEMPLATES_MANAGE);

export const requireLeadSourcesManage = requirePermissions(PERMISSIONS.LEAD_SOURCES_MANAGE);

export const requireAccountsRead = requirePermissions(PERMISSIONS.ACCOUNTS_READ);

export const requireAccountsManage = requirePermissions(PERMISSIONS.ACCOUNTS_MANAGE);

export const requireSettingsManage = requirePermissions(PERMISSIONS.SETTINGS_MANAGE);

/** Narrow helper for typed handlers that assume `authenticateRequest` already ran. */
export const requireAuthContext = (req: Request): Express.AuthContext => {
  if (!req.auth) {
    throw createHttpError({
      statusCode: 401,
      code: 'AUTHENTICATION_REQUIRED',
      message: 'Authentication is required.',
    });
  }

  return req.auth;
};
