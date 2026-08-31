import { requireAuthContext } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { createHttpError } from '../../utils/http-error.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';

import {
  createUserBodySchema,
  listUsersQuerySchema,
  resetUserPasswordBodySchema,
  updateUserBodySchema,
  userIdParamsSchema,
} from './user.validation.js';
import {
  createOrganizationUser,
  disableOrganizationUser,
  enableOrganizationUser,
  getOrganizationUser,
  listOrganizationUsers,
  resetOrganizationUserPassword,
  updateOrganizationUser,
} from './user-management.service.js';

const USER_MANAGEMENT_ERROR_MAP = {
  USER_NOT_FOUND: {
    statusCode: 404,
    message: 'User not found.',
  },
  USER_EMAIL_ALREADY_EXISTS: {
    statusCode: 409,
    message: 'A user with this email already exists.',
  },
  USER_CANNOT_MANAGE_SELF: {
    statusCode: 400,
    message: 'You cannot perform this action on your own user.',
  },
  SUPER_ADMIN_CANNOT_BE_MANAGED: {
    statusCode: 403,
    message: 'The seed-only super admin cannot be managed by this API.',
  },
  SUPER_ADMIN_CANNOT_BE_CREATED_BY_API: {
    statusCode: 403,
    message: 'Super admin users can only be created by the seed command.',
  },
  SUPER_ADMIN_CANNOT_BE_ASSIGNED_BY_API: {
    statusCode: 403,
    message: 'Super admin role cannot be assigned by this API.',
  },
  PASSWORD_REQUIRED: {
    statusCode: 400,
    message: 'Password is required.',
  },
  PASSWORD_TOO_SHORT: {
    statusCode: 400,
    message: 'Password is too short.',
  },
  PASSWORD_TOO_LONG: {
    statusCode: 400,
    message: 'Password is too long.',
  },
  PASSWORD_HAS_SURROUNDING_WHITESPACE: {
    statusCode: 400,
    message: 'Password must not start or end with whitespace.',
  },
} as const;

type UserManagementErrorCode = keyof typeof USER_MANAGEMENT_ERROR_MAP;

const mapUserManagementError = (error: unknown): never => {
  const message = error instanceof Error ? error.message : '';
  const mappedError =
    message in USER_MANAGEMENT_ERROR_MAP
      ? USER_MANAGEMENT_ERROR_MAP[message as UserManagementErrorCode]
      : undefined;

  if (!mappedError) {
    throw error;
  }

  throw createHttpError({
    statusCode: mappedError.statusCode,
    code: message,
    message: mappedError.message,
  });
};

export const listUsers = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const query = parseWithSchema({
    schema: listUsersQuerySchema,
    value: req.query,
    source: 'Query',
  });

  const users = await listOrganizationUsers({
    organizationId: auth.organization._id,
    role: query.role,
    status: query.status,
    limit: query.limit,
    skip: query.skip,
  });

  res.status(200).json({
    data: users,
    meta: {
      limit: query.limit,
      skip: query.skip,
    },
  });
});

export const getUser = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: userIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const user = await getOrganizationUser({
      organizationId: auth.organization._id,
      userId: params.userId,
    });

    res.status(200).json({
      data: user,
    });
  } catch (error) {
    mapUserManagementError(error);
  }
});

export const createUser = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const body = parseWithSchema({
    schema: createUserBodySchema,
    value: req.body,
    source: 'Body',
  });

  try {
    const user = await createOrganizationUser({
      organizationId: auth.organization._id,
      actor: auth.user,
      userData: body,
      requestContext: req.context,
    });

    res.status(201).json({
      data: user,
    });
  } catch (error) {
    mapUserManagementError(error);
  }
});

export const updateUser = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: userIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  const body = parseWithSchema({
    schema: updateUserBodySchema,
    value: req.body,
    source: 'Body',
  });

  try {
    const user = await updateOrganizationUser({
      organizationId: auth.organization._id,
      actor: auth.user,
      userId: params.userId,
      updateData: body,
      requestContext: req.context,
    });

    res.status(200).json({
      data: user,
    });
  } catch (error) {
    mapUserManagementError(error);
  }
});

export const disableUser = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: userIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const user = await disableOrganizationUser({
      organizationId: auth.organization._id,
      actor: auth.user,
      userId: params.userId,
      requestContext: req.context,
    });

    res.status(200).json({
      data: user,
    });
  } catch (error) {
    mapUserManagementError(error);
  }
});

export const enableUser = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: userIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const user = await enableOrganizationUser({
      organizationId: auth.organization._id,
      actor: auth.user,
      userId: params.userId,
      requestContext: req.context,
    });

    res.status(200).json({
      data: user,
    });
  } catch (error) {
    mapUserManagementError(error);
  }
});

export const resetUserPassword = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: userIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  const body = parseWithSchema({
    schema: resetUserPasswordBodySchema,
    value: req.body,
    source: 'Body',
  });

  try {
    const user = await resetOrganizationUserPassword({
      organizationId: auth.organization._id,
      actor: auth.user,
      userId: params.userId,
      password: body.password,
      mustChangePassword: body.mustChangePassword,
      requestContext: req.context,
    });

    res.status(200).json({
      data: user,
    });
  } catch (error) {
    mapUserManagementError(error);
  }
});
