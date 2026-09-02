import { describe, expect, it } from 'vitest';

import { describeAccountReferences, describeAccountRemoval } from '../lib/account-removal';
import { type AccountRemoval } from '../types';

const removal = (overrides: Partial<AccountRemoval>): AccountRemoval =>
  ({
    outcome: 'hidden',
    account: { name: 'Support' },
    references: { conversations: 0, messages: 0, leadSources: 0, total: 0 },
    ...overrides,
  }) as AccountRemoval;

describe('describeAccountReferences', () => {
  it('names only the references that exist, and gets the singular right', () => {
    expect(
      describeAccountReferences({ conversations: 0, messages: 0, leadSources: 1, total: 1 }),
    ).toBe('1 lead source');
  });

  it('joins two kinds with "and"', () => {
    expect(
      describeAccountReferences({ conversations: 47, messages: 912, leadSources: 0, total: 959 }),
    ).toBe('47 conversations and 912 messages');
  });

  it('joins three kinds with commas and a final "and"', () => {
    expect(
      describeAccountReferences({ conversations: 2, messages: 5, leadSources: 1, total: 8 }),
    ).toBe('2 conversations, 5 messages and 1 lead source');
  });
});

describe('describeAccountRemoval', () => {
  it('is unambiguous that a deleted number is not coming back', () => {
    expect(
      describeAccountRemoval(
        removal({ outcome: 'deleted', account: { name: 'Likhith Gowda k' } as never }),
      ),
    ).toContain('Likhith Gowda k was deleted permanently.');
  });

  it('gives the reason a number was only hidden', () => {
    expect(
      describeAccountRemoval(
        removal({ references: { conversations: 47, messages: 0, leadSources: 0, total: 47 } }),
      ),
    ).toContain('because it still has 47 conversations');
  });

  it('falls back to a neutral subject when the account is missing from the response', () => {
    expect(describeAccountRemoval(removal({ outcome: 'deleted', account: null }))).toContain(
      'That number was deleted permanently.',
    );
  });
});
