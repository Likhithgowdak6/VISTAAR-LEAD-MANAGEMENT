import { randomBytes } from 'node:crypto';

const LEAD_ID_PREFIX = 'LEAD';
const LEAD_ID_RANDOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LEAD_ID_RANDOM_LENGTH = 6;
const DEFAULT_MAX_ATTEMPTS = 10;

type RandomBytesFn = (size: number) => Buffer;

const formatLeadDate = (date: Date): string => date.toISOString().slice(0, 10).replaceAll('-', '');

export interface CreateRandomSuffixParams {
  randomBytesFn?: RandomBytesFn;
}

const createRandomSuffix = ({
  randomBytesFn = randomBytes,
}: CreateRandomSuffixParams = {}): string => {
  const bytes = randomBytesFn(LEAD_ID_RANDOM_LENGTH);

  return Array.from(
    bytes,
    (byte: number) => LEAD_ID_RANDOM_ALPHABET[byte % LEAD_ID_RANDOM_ALPHABET.length],
  ).join('');
};

export interface GenerateLeadIdParams {
  now?: Date;
  randomBytesFn?: RandomBytesFn;
}

export const generateLeadId = ({
  now = new Date(),
  randomBytesFn = randomBytes,
}: GenerateLeadIdParams = {}): string =>
  `${LEAD_ID_PREFIX}-${formatLeadDate(now)}-${createRandomSuffix({ randomBytesFn })}`;

export type LeadIdExistsCheck = (leadId: string) => boolean | Promise<boolean>;

export interface CreateUniqueLeadIdParams {
  exists: LeadIdExistsCheck;
  now?: Date;
  randomBytesFn?: RandomBytesFn;
  maxAttempts?: number;
}

export const createUniqueLeadId = async ({
  exists,
  now = new Date(),
  randomBytesFn = randomBytes,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
}: CreateUniqueLeadIdParams): Promise<string> => {
  if (typeof exists !== 'function') {
    throw new Error('LEAD_ID_EXISTS_CHECK_REQUIRED');
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const leadId = generateLeadId({
      now,
      randomBytesFn,
    });

    const alreadyExists = await exists(leadId);

    if (!alreadyExists) {
      return leadId;
    }
  }

  throw new Error('LEAD_ID_COLLISION_RETRY_EXHAUSTED');
};
