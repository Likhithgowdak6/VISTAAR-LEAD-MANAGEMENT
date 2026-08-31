import { type Request, type Response } from 'express';

import { env } from '../../config/env.js';
import { parseCookies, serializeCookie } from '../../utils/cookies.js';

export const REFRESH_COOKIE_NAME = 'wam_refresh';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

const getRefreshCookieMaxAgeSeconds = (): number => env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60;

export const getRefreshTokenFromRequest = (req: Request): string | null => {
  const cookies = parseCookies(req.headers.cookie);

  return cookies[REFRESH_COOKIE_NAME] ?? null;
};

export const buildRefreshTokenCookie = (refreshToken: string): string =>
  serializeCookie({
    name: REFRESH_COOKIE_NAME,
    value: refreshToken,
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'Lax',
    path: REFRESH_COOKIE_PATH,
    maxAge: getRefreshCookieMaxAgeSeconds(),
  });

export const buildClearRefreshTokenCookie = (): string =>
  serializeCookie({
    name: REFRESH_COOKIE_NAME,
    value: '',
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'Lax',
    path: REFRESH_COOKIE_PATH,
    maxAge: 0,
  });

export interface SetRefreshTokenCookieParams {
  res: Response;
  refreshToken: string;
}

export const setRefreshTokenCookie = ({ res, refreshToken }: SetRefreshTokenCookieParams): void => {
  res.setHeader('Set-Cookie', buildRefreshTokenCookie(refreshToken));
};

export const clearRefreshTokenCookie = (res: Response): void => {
  res.setHeader('Set-Cookie', buildClearRefreshTokenCookie());
};
