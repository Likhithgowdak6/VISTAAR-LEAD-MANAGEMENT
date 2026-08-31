import bcrypt from 'bcryptjs';

import { env } from '../../config/env.js';

export const PASSWORD_POLICY = Object.freeze({
  MIN_LENGTH: 12,
  MAX_LENGTH: 128,
});

export type PasswordValidationResult =
  { valid: true; reasonCode: null } | { valid: false; reasonCode: string };

export const validatePlainPassword = (password: unknown): PasswordValidationResult => {
  if (typeof password !== 'string') {
    return {
      valid: false,
      reasonCode: 'PASSWORD_REQUIRED',
    };
  }

  if (password.trim() !== password) {
    return {
      valid: false,
      reasonCode: 'PASSWORD_HAS_SURROUNDING_WHITESPACE',
    };
  }

  if (password.length < PASSWORD_POLICY.MIN_LENGTH) {
    return {
      valid: false,
      reasonCode: 'PASSWORD_TOO_SHORT',
    };
  }

  if (password.length > PASSWORD_POLICY.MAX_LENGTH) {
    return {
      valid: false,
      reasonCode: 'PASSWORD_TOO_LONG',
    };
  }

  return {
    valid: true,
    reasonCode: null,
  };
};

export const hashPassword = async (password: string): Promise<string> => {
  const validation = validatePlainPassword(password);

  if (!validation.valid) {
    throw new Error(validation.reasonCode);
  }

  return bcrypt.hash(password, env.BCRYPT_ROUNDS);
};

export interface VerifyPasswordParams {
  password?: string | null;
  passwordHash?: string | null;
}

export const verifyPassword = async ({
  password,
  passwordHash,
}: VerifyPasswordParams): Promise<boolean> => {
  if (!password || !passwordHash) {
    return false;
  }

  return bcrypt.compare(password, passwordHash);
};

/**
 * A hash no submitted password can match. Derived from BCRYPT_ROUNDS so it
 * always costs the same as a real verification, and memoised so a process pays
 * for it once.
 */
const DECOY_PASSWORD = 'decoy-password-that-is-never-a-valid-credential';

let decoyPasswordHashPromise: Promise<string> | null = null;

const getDecoyPasswordHash = (): Promise<string> => {
  decoyPasswordHashPromise ??= bcrypt.hash(DECOY_PASSWORD, env.BCRYPT_ROUNDS);

  return decoyPasswordHashPromise;
};

/**
 * Verifies a password when the account may not exist.
 *
 * Skipping bcrypt for an unknown account would return far faster than a real
 * check, letting an attacker tell valid accounts from invalid ones by response
 * time even though both return the same error. Hashing against a decoy keeps
 * the two paths equally expensive.
 */
export const verifyPasswordOrDecoy = async ({
  password,
  passwordHash,
}: VerifyPasswordParams): Promise<boolean> => {
  if (!passwordHash) {
    await bcrypt.compare(password ?? DECOY_PASSWORD, await getDecoyPasswordHash());

    return false;
  }

  return verifyPassword({ password, passwordHash });
};
