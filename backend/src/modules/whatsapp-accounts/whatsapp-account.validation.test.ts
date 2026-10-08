/**
 * The query flag that turns Remove destructive.
 *
 * Worth its own file because the failure mode is silent and expensive: anything that quietly
 * coerces a stray value to `true` deletes a number's entire history on a request that never
 * asked for it. `z.coerce.boolean()` does exactly that - it is `Boolean(value)`, so the strings
 * 'false' and '0' both come out true - which is why this schema is an enum instead, and why
 * that choice is pinned here rather than left to a comment.
 */
import { describe, expect, it } from 'vitest';

import { removeAccountQuerySchema } from './whatsapp-account.validation.js';

const parse = (query: unknown) => removeAccountQuerySchema.parse(query);

describe('removeAccountQuerySchema', () => {
  it('defaults to false when the flag is absent', () => {
    expect(parse({})).toEqual({ purgeHistory: false });
  });

  it('enables the purge only for the literal string "true"', () => {
    expect(parse({ purgeHistory: 'true' })).toEqual({ purgeHistory: true });
  });

  it('treats an explicit "false" as false', () => {
    expect(parse({ purgeHistory: 'false' })).toEqual({ purgeHistory: false });
  });

  it.each(['1', 'yes', 'TRUE', 'True', 'on', '', 'purge'])(
    'rejects %p rather than guessing what it meant',
    (value) => {
      // A 400 is the right answer here. Silently reading an unrecognised value as "no" would
      // also be safe, but it would hide a broken client that believes it is purging.
      expect(() => parse({ purgeHistory: value })).toThrow();
    },
  );

  it('ignores unrelated query parameters', () => {
    expect(parse({ purgeHistory: 'true', limit: '50' })).toEqual({ purgeHistory: true });
  });
});
