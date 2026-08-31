/**
 * Short, human-typeable codes for WhatsApp approval cards - one letter A-Z followed by one
 * digit 1-9 (26 * 9 = 234 possibilities), e.g. "A7". Pure and side-effect free: collision
 * avoidance against other currently-pending codes lives in ai-brain-approval.repository.ts,
 * which is the only place that knows what's already pending.
 */
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const DIGITS = '123456789';

export const APPROVAL_CODE_PATTERN = /^[A-Z][1-9]$/;

export const generateApprovalCode = (): string => {
  const letter = LETTERS[Math.floor(Math.random() * LETTERS.length)];
  const digit = DIGITS[Math.floor(Math.random() * DIGITS.length)];
  return `${letter}${digit}`;
};

export const isValidApprovalCode = (value: unknown): value is string =>
  typeof value === 'string' && APPROVAL_CODE_PATTERN.test(value);
