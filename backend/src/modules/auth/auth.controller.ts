import { requireAuthContext } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';

import {
  buildClearRefreshTokenCookie,
  clearRefreshTokenCookie,
  getRefreshTokenFromRequest,
  setRefreshTokenCookie,
} from './auth-cookie.service.js';
import {
  buildCurrentUserProfile,
  changeOwnPassword,
  loginWithPassword,
  logoutAllUserSessions,
  logoutCurrentSession,
  refreshAuthenticatedSession,
} from './auth.service.js';
import { changePasswordBodySchema, loginBodySchema } from './auth.validation.js';

export const login = asyncHandler(async (req, res) => {
  const body = parseWithSchema({
    schema: loginBodySchema,
    value: req.body,
    source: 'Body',
  });

  const result = await loginWithPassword({
    organizationSlug: body.organizationSlug,
    email: body.email,
    password: body.password,
    requestContext: req.context,
  });

  setRefreshTokenCookie({
    res,
    refreshToken: result.refreshToken,
  });

  res.status(200).json({
    data: result.data,
  });
});

export const refresh = asyncHandler(async (req, res) => {
  const refreshToken = getRefreshTokenFromRequest(req);

  const result = await refreshAuthenticatedSession({
    refreshToken,
    requestContext: req.context,
  });

  setRefreshTokenCookie({
    res,
    refreshToken: result.refreshToken,
  });

  res.status(200).json({
    data: result.data,
  });
});

export const logout = asyncHandler(async (req, res) => {
  const refreshToken = getRefreshTokenFromRequest(req);

  const result = await logoutCurrentSession({
    refreshToken,
    requestContext: req.context,
  });

  clearRefreshTokenCookie(res);

  res.status(200).json({
    data: {
      loggedOut: true,
      sessionRevoked: result.sessionRevoked,
    },
  });
});

export const logoutAll = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);

  const result = await logoutAllUserSessions({
    user: auth.user,
    organization: auth.organization,
    session: auth.session,
    requestContext: req.context,
  });

  res.setHeader('Set-Cookie', buildClearRefreshTokenCookie());

  res.status(200).json({
    data: {
      loggedOut: true,
      sessionsRevoked: result.sessionsRevoked,
    },
  });
});

export const changePassword = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const body = parseWithSchema({
    schema: changePasswordBodySchema,
    value: req.body,
    source: 'Body',
  });

  const result = await changeOwnPassword({
    user: auth.user,
    organization: auth.organization,
    session: auth.session,
    currentPassword: body.currentPassword,
    newPassword: body.newPassword,
    requestContext: req.context,
  });

  res.status(200).json({
    data: {
      passwordChanged: result.passwordChanged,
      user: result.user,
    },
  });
});

export const me = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);

  res.status(200).json({
    data: buildCurrentUserProfile({
      user: auth.user,
      organization: auth.organization,
      session: auth.session,
    }),
  });
});
