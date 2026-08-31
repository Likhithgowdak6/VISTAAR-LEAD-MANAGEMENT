/**
 * Pure format checks for the approval-code generator - one letter A-Z immediately followed by
 * one digit 1-9. Collision-avoidance across currently-pending codes is a repository concern
 * (see ai-brain-approval.repository.test.ts's generateUniqueApprovalCode coverage).
 */
import { describe, expect, it } from 'vitest';

import { APPROVAL_CODE_PATTERN, generateApprovalCode, isValidApprovalCode } from './approval-code.js';

describe('generateApprovalCode', () => {
  it('always produces a code matching [A-Z][1-9]', () => {
    for (let i = 0; i < 500; i += 1) {
      const code = generateApprovalCode();
      expect(code).toMatch(APPROVAL_CODE_PATTERN);
    }
  });

  it('never produces the digit 0 (only 1-9)', () => {
    for (let i = 0; i < 500; i += 1) {
      const code = generateApprovalCode();
      expect(code[1]).not.toBe('0');
    }
  });
});

describe('isValidApprovalCode', () => {
  it('accepts well-formed codes', () => {
    expect(isValidApprovalCode('A7')).toBe(true);
    expect(isValidApprovalCode('Z1')).toBe(true);
  });

  it('rejects malformed input', () => {
    expect(isValidApprovalCode('a7')).toBe(false); // lowercase
    expect(isValidApprovalCode('A0')).toBe(false); // digit 0 not allowed
    expect(isValidApprovalCode('AA')).toBe(false);
    expect(isValidApprovalCode('7A')).toBe(false);
    expect(isValidApprovalCode('A17')).toBe(false);
    expect(isValidApprovalCode('')).toBe(false);
    expect(isValidApprovalCode(undefined)).toBe(false);
    expect(isValidApprovalCode(null)).toBe(false);
    expect(isValidApprovalCode(7)).toBe(false);
  });
});
