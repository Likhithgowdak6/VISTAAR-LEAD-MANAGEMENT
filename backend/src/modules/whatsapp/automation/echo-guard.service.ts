import { getRedisClient } from '../../../config/redis.js';
import { type ObjectIdLike } from '../../../types/common.js';

const DEFAULT_TTL_SECONDS = 3600;

const echoKey = (accountId: ObjectIdLike, providerMessageId: string): string =>
  `wam:echo:${accountId.toString()}:${providerMessageId}`;

export interface RememberSentMessageParams {
  accountId?: ObjectIdLike;
  providerMessageId?: string | null;
}

export interface IsOwnMessageParams {
  accountId?: ObjectIdLike;
  providerMessageId?: string | null;
}

export interface CreateEchoGuardServiceOptions {
  redisClient?: ReturnType<typeof getRedisClient>;
  logger?: { error?: (...args: unknown[]) => void };
  ttlSeconds?: number;
}

/**
 * Short-TTL "did we just send this" store. Every message this account sends is remembered here
 * by its provider message id; the inbound router checks it before treating a `fromMe` message as
 * something new, so the bot never mistakes its own just-sent message for the owner typing.
 *
 * Fails safe in both directions: `remember` never throws (a Redis outage must never break a
 * send), and `isOwnMessage` returns `true` on any error or missing argument - "unknown" is
 * treated as "assume it's ours, stay quiet" rather than risk reacting to our own echo.
 */
export const createEchoGuardService = ({
  redisClient = getRedisClient(),
  logger = console,
  ttlSeconds = DEFAULT_TTL_SECONDS,
}: CreateEchoGuardServiceOptions = {}) => {
  const remember = async ({ accountId, providerMessageId }: RememberSentMessageParams = {}) => {
    if (!accountId || !providerMessageId) {
      return;
    }

    try {
      await redisClient.set(echoKey(accountId, providerMessageId), '1', { EX: ttlSeconds });
    } catch (error: unknown) {
      logger?.error?.('Echo-guard remember failed safely.', error);
    }
  };

  const isOwnMessage = async ({ accountId, providerMessageId }: IsOwnMessageParams = {}) => {
    if (!accountId || !providerMessageId) {
      return true;
    }

    try {
      const count = await redisClient.exists(echoKey(accountId, providerMessageId));
      return count >= 1;
    } catch (error: unknown) {
      logger?.error?.('Echo-guard isOwnMessage failed safely.', error);
      return true;
    }
  };

  return {
    remember,
    isOwnMessage,
  };
};

export type EchoGuardService = ReturnType<typeof createEchoGuardService>;
