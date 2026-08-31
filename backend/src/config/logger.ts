import pino from 'pino';

import { env } from './env.js';

/**
 * Paths scrubbed before anything reaches a log sink. Credentials and contact
 * PII must never be persisted in plaintext logs (see the Phase 0 retention
 * register), and logger-level redaction is the backstop for call sites that
 * forget.
 */
const REDACTED_PATHS = [
  'password',
  'currentPassword',
  'newPassword',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'refreshTokenHash',
  'authorization',
  'cookie',
  'apiKey',
  'phone',
  'phoneNumber',
  'email',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.refreshTokenHash',
  '*.apiKey',
  '*.phone',
  '*.phoneNumber',
  '*.email',
  'req.headers.authorization',
  'req.headers.cookie',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'wam-crm-ai-backend', env: env.NODE_ENV },
  redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  // Emit the level name rather than pino's numeric code so log search tooling
  // does not need a lookup table.
  formatters: {
    level: (label: string) => ({ level: label }),
  },
});

export type Logger = typeof logger;
