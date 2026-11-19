/**
 * Showing money without calculating it.
 *
 * THE INVARIANT THIS PROTECTS: the server does the arithmetic in integer paise and sends both
 * the integer and a formatted string. The browser renders the string. The moment a component
 * starts dividing paise by 100 to display a figure, the integer guarantee the whole backend was
 * built around stops being worth anything - and the symptom is a total that disagrees with its
 * own rows by a paisa on an invoice a client is reading.
 *
 * So these tests are mostly about `formatRupees` being a FORMATTER, and about `toAmountString`
 * refusing input the server would reject anyway.
 */

import { describe, expect, it } from 'vitest';

import {
  comparePaise,
  formatAmount,
  formatDate,
  formatRupees,
  isOverpaid,
  isSettled,
  toAmountString,
} from '../lib/money';

describe('formatRupees', () => {
  it('groups the Indian way, not in thousands', () => {
    // 4,78,100.00 — pairs after the first three digits. `toLocaleString()` with the wrong
    // locale gives 478,100.00, which is wrong on an invoice an Indian client reads.
    expect(formatRupees('478100')).toBe('₹4,78,100.00');
  });

  it('always shows two decimal places', () => {
    expect(formatRupees('1180')).toBe('₹1,180.00');
    expect(formatRupees('1180.5')).toBe('₹1,180.50');
  });

  it('handles a lakh and a crore', () => {
    expect(formatRupees('100000')).toBe('₹1,00,000.00');
    expect(formatRupees('10000000')).toBe('₹1,00,00,000.00');
  });

  it.each([null, undefined, ''])('renders %s as zero rather than blank', (value) => {
    expect(formatRupees(value)).toBe('₹0.00');
  });

  it('passes through something it cannot read rather than inventing a figure', () => {
    // Better to show an obviously wrong string than a confidently wrong number.
    expect(formatRupees('not-a-number')).toBe('not-a-number');
  });

  it('shows a negative balance as negative, because overpayment is real', () => {
    expect(formatRupees('-250')).toBe('₹-250.00');
  });

  it('strips the symbol when asked', () => {
    expect(formatAmount('1180')).toBe('1,180.00');
  });
});

describe('comparePaise', () => {
  it('compares integers exactly', () => {
    expect(comparePaise(118000, 118000)).toBe(0);
    expect(comparePaise(117999, 118000)).toBe(-1);
    expect(comparePaise(118001, 118000)).toBe(1);
  });

  it('settles on zero with no tolerance', () => {
    // The reason the backend stores paise: `balance === 0` is reliable, where a float balance
    // needed a "small tolerance for rounding" that let genuinely unpaid invoices settle.
    expect(isSettled(0)).toBe(true);
    expect(isSettled(1)).toBe(false);
    expect(isSettled(-1)).toBe(true);
  });

  it('recognises an overpayment', () => {
    expect(isOverpaid(-1)).toBe(true);
    expect(isOverpaid(0)).toBe(false);
  });
});

describe('toAmountString', () => {
  it.each(['0', '1500', '1500.5', '1500.50', '1500.1234'])('accepts %s', (value) => {
    expect(toAmountString(value)).toBe(value);
  });

  it('trims surrounding space', () => {
    expect(toAmountString('  1500  ')).toBe('1500');
  });

  it.each(['', '   ', 'abc', '-500', '1e3', '1500.123456'])('refuses %s', (value) => {
    expect(toAmountString(value)).toBeNull();
  });

  it('refuses a pasted figure with separators rather than silently reading 1', () => {
    // "1,500" parsed loosely becomes 1. Refusing it makes the mistake visible.
    expect(toAmountString('1,500')).toBeNull();
  });
});

describe('formatDate', () => {
  it('renders a readable day', () => {
    expect(formatDate('2026-11-18T00:00:00.000Z')).toMatch(/Nov 2026/);
  });

  it.each([null, undefined, '', 'nonsense'])('renders %s as an em dash', (value) => {
    expect(formatDate(value)).toBe('—');
  });
});
