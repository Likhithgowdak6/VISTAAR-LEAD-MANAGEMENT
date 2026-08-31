import { getRedisClient } from '../../config/redis.js';

const LOGIN_WINDOW_SECONDS = 15 * 60;
const IP_LIMIT = 20;
const EMAIL_IP_LIMIT = 5;

const normalizeLimiterValue = (value: unknown): string =>
  String(value ?? 'unknown')
    .trim()
    .toLowerCase()
    .replaceAll(/\s+/g, '-');

export interface GetLoginRateLimitKeysParams {
  email?: string | null;
  ipAddress?: string | null;
}

const getLoginRateLimitKeys = ({ email, ipAddress }: GetLoginRateLimitKeysParams) => {
  const normalizedIp = normalizeLimiterValue(ipAddress);
  const normalizedEmail = normalizeLimiterValue(email);

  return {
    ipKey: `auth:login:ip:${normalizedIp}`,
    emailIpKey: `auth:login:email-ip:${normalizedEmail}:${normalizedIp}`,
  };
};

export interface IncrementWindowCounterParams {
  key: string;
  windowSeconds: number;
}

const incrementWindowCounter = async ({
  key,
  windowSeconds,
}: IncrementWindowCounterParams): Promise<number> => {
  const redisClient = getRedisClient();

  const count = await redisClient.incr(key);

  if (count === 1) {
    await redisClient.expire(key, windowSeconds);
  }

  return count;
};

export interface CheckLoginRateLimitParams {
  email?: string | null;
  ipAddress?: string | null;
}

export interface LoginRateLimitResult {
  limited: boolean;
  retryAfterSeconds: number;
  counters: {
    ipCount: number;
    emailIpCount: number;
    ipLimit: number;
    emailIpLimit: number;
  };
}

export const checkLoginRateLimit = async ({
  email,
  ipAddress,
}: CheckLoginRateLimitParams): Promise<LoginRateLimitResult> => {
  const { ipKey, emailIpKey } = getLoginRateLimitKeys({
    email,
    ipAddress,
  });

  const [ipCount, emailIpCount] = await Promise.all([
    incrementWindowCounter({
      key: ipKey,
      windowSeconds: LOGIN_WINDOW_SECONDS,
    }),
    incrementWindowCounter({
      key: emailIpKey,
      windowSeconds: LOGIN_WINDOW_SECONDS,
    }),
  ]);

  const limited = ipCount > IP_LIMIT || emailIpCount > EMAIL_IP_LIMIT;

  return {
    limited,
    retryAfterSeconds: LOGIN_WINDOW_SECONDS,
    counters: {
      ipCount,
      emailIpCount,
      ipLimit: IP_LIMIT,
      emailIpLimit: EMAIL_IP_LIMIT,
    },
  };
};

export interface ClearLoginRateLimitParams {
  email?: string | null;
  ipAddress?: string | null;
}

export const clearLoginRateLimit = async ({
  email,
  ipAddress,
}: ClearLoginRateLimitParams): Promise<void> => {
  const redisClient = getRedisClient();
  const { ipKey, emailIpKey } = getLoginRateLimitKeys({
    email,
    ipAddress,
  });

  await Promise.all([redisClient.del(ipKey), redisClient.del(emailIpKey)]);
};

export const clearLoginRateLimitForTest = clearLoginRateLimit;
