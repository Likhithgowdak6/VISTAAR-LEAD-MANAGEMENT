import { type Request, type Response } from 'express';

import { env } from '../../config/env.js';
import { parseCookies, serializeCookie } from '../../utils/cookies.js';

export const REFRESH_COOKIE_NAME = 'wam_refresh';
export const REFRESH_COOKIE_PATH = '/api/v1/auth';

const getRefreshCookieMaxAgeSeconds = (): number => env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60;

/**
 * `Lax` for a browser on the same origin, `None` for the mobile app.
 *
 * A Capacitor WebView runs on `capacitor://localhost` (Android) or `capacitor://` (iOS), so every
 * call it makes to the API is CROSS-SITE. A `SameSite=Lax` cookie is simply not sent on those, and
 * the failure is quiet and confusing: signing in works, then the first token refresh finds no
 * cookie and the user is thrown out - which reads as a broken login rather than a cookie policy.
 *
 * `None` is only honoured alongside `Secure`, i.e. over HTTPS, which is why this is opt-in rather
 * than the default: switching it on without TLS gets the cookie rejected outright and produces the
 * same symptom from the opposite direction.
 */
const getRefreshCookieSameSite = (): 'Lax' | 'None' =>
  env.AUTH_COOKIE_CROSS_SITE ? 'None' : 'Lax';

/** `None` requires `Secure`, so cross-site mode forces it on regardless of NODE_ENV. */
const getRefreshCookieSecure = (): boolean =>
  env.AUTH_COOKIE_CROSS_SITE || env.NODE_ENV === 'production';

export const getRefreshTokenFromRequest = (req: Request): string | null => {
  const cookies = parseCookies(req.headers.cookie);

  return cookies[REFRESH_COOKIE_NAME] ?? null;
};

export const buildRefreshTokenCookie = (refreshToken: string): string =>
  serializeCookie({
    name: REFRESH_COOKIE_NAME,
    value: refreshToken,
    httpOnly: true,
    secure: getRefreshCookieSecure(),
    sameSite: getRefreshCookieSameSite(),
    path: REFRESH_COOKIE_PATH,
    maxAge: getRefreshCookieMaxAgeSeconds(),
  });

export const buildClearRefreshTokenCookie = (): string =>
  serializeCookie({
    name: REFRESH_COOKIE_NAME,
    value: '',
    httpOnly: true,
    secure: getRefreshCookieSecure(),
    sameSite: getRefreshCookieSameSite(),
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
