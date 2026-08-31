import { randomBytes, randomUUID, createHash } from 'node:crypto';

import jwt, { type JwtPayload, type SignOptions } from 'jsonwebtoken';

import { env } from '../../config/env.js';
import { type ObjectIdLike } from '../../types/common.js';

export const ACCESS_TOKEN_TYPE = 'access';

/** The claims this service signs into, and requires back out of, an access token. */
export interface AccessTokenClaims extends JwtPayload {
  sub: string;
  sid: string;
  org: string;
  type: typeof ACCESS_TOKEN_TYPE;
}

export interface SignAccessTokenParams {
  userId?: ObjectIdLike;
  sessionId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  jwtId?: string;
}

export const signAccessToken = ({
  userId,
  sessionId,
  organizationId,
  jwtId = randomUUID(),
}: SignAccessTokenParams): string => {
  if (!userId || !sessionId || !organizationId) {
    throw new Error('ACCESS_TOKEN_REQUIRED_CLAIMS_MISSING');
  }

  return jwt.sign(
    {
      sub: userId.toString(),
      sid: sessionId.toString(),
      org: organizationId.toString(),
      type: ACCESS_TOKEN_TYPE,
    },
    env.JWT_ACCESS_SECRET,
    {
      algorithm: 'HS256',
      expiresIn: env.JWT_ACCESS_EXPIRES_IN,
      jwtid: jwtId,
    } as SignOptions,
  );
};

export const verifyAccessToken = (token: string): AccessTokenClaims => {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
    algorithms: ['HS256'],
  }) as AccessTokenClaims;

  if (decoded.type !== ACCESS_TOKEN_TYPE) {
    throw new Error('INVALID_ACCESS_TOKEN_TYPE');
  }

  return decoded;
};

export const generateRefreshToken = (): string =>
  randomBytes(env.REFRESH_TOKEN_BYTES).toString('base64url');

export const hashRefreshToken = (refreshToken: string): string => {
  if (!refreshToken) {
    throw new Error('REFRESH_TOKEN_REQUIRED');
  }

  return createHash('sha256').update(refreshToken).digest('hex');
};

export interface GetRefreshTokenExpiresAtParams {
  fromDate?: Date;
}

export const getRefreshTokenExpiresAt = ({
  fromDate = new Date(),
}: GetRefreshTokenExpiresAtParams = {}): Date => {
  const expiresAt = new Date(fromDate);
  expiresAt.setDate(expiresAt.getDate() + env.REFRESH_TOKEN_TTL_DAYS);

  return expiresAt;
};
