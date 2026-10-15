/**
 * Deciding what is worth asking again.
 *
 * BOTH DIRECTIONS COST SOMETHING, which is why this is tested exhaustively rather than
 * casually. Call a timeout terminal and a commitment the customer made is silently lost. Call
 * a 400 transient and the queue spends four LLM calls, over fifteen minutes, confirming that
 * the request is still malformed - every time one arrives.
 *
 * The default is NO. Anything not positively recognised here is terminal, and the last test
 * in each block is about exactly that.
 */
import { describe, expect, it } from 'vitest';

import { describeFailure, isTransientAiFailure } from './transient-failure.js';

/** The real thing: ai-brain.client.ts aborts the fetch after AI_BRAIN_INTENT_TIMEOUT_MS. */
const abortError = () =>
  Object.assign(new Error('This operation was aborted'), { name: 'AbortError', code: 20 });

describe('worth retrying', () => {
  it('recognises the production AbortError', () => {
    // code 20, name AbortError - exactly what was logged when /v1/commitment took over 8s.
    expect(isTransientAiFailure(abortError())).toBe(true);
  });

  it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_SOCKET'])(
    'recognises %s',
    (code) => {
      expect(isTransientAiFailure(Object.assign(new Error('boom'), { code }))).toBe(true);
    },
  );

  it('recognises a code hidden on `cause`, where undici puts it', () => {
    const error = Object.assign(new Error('fetch failed'), {
      cause: { code: 'ECONNREFUSED' },
    });

    expect(isTransientAiFailure(error)).toBe(true);
  });

  it('recognises a bare "fetch failed" with no code at all', () => {
    expect(isTransientAiFailure(new Error('fetch failed'))).toBe(true);
  });

  it.each([500, 502, 503, 504, 429])('retries HTTP %i', (statusCode) => {
    // The service answered, badly, in a way that may not be true in a minute. 429 especially:
    // that is the provider asking us to wait, not refusing.
    expect(isTransientAiFailure(Object.assign(new Error('x'), { statusCode }))).toBe(true);
  });
});

describe('not worth retrying', () => {
  it.each([400, 401, 403, 404, 422])('does not retry HTTP %i', (statusCode) => {
    // You asked wrong. Asking the same wrong thing again fails identically.
    expect(isTransientAiFailure(Object.assign(new Error('x'), { statusCode }))).toBe(false);
  });

  it('does not retry a plain error', () => {
    expect(isTransientAiFailure(new Error('something went wrong'))).toBe(false);
  });

  it('does not retry a duplicate-key collision', () => {
    // The idempotency guard doing its job. The reminder already exists.
    expect(isTransientAiFailure(Object.assign(new Error('E11000'), { code: 11000 }))).toBe(false);
  });

  it('does not retry an error whose MESSAGE merely mentions a timeout', () => {
    // THE TRAP. Matching on message text would make any provider error containing the word
    // "timeout" retryable, including a 400 complaining about a timeout parameter.
    expect(isTransientAiFailure(new Error('ETIMEDOUT'))).toBe(false);
  });

  it.each([null, undefined, 'a string', 42])('does not retry %j', (value) => {
    expect(isTransientAiFailure(value)).toBe(false);
  });
});

describe('describeFailure', () => {
  it('keeps the name and code', () => {
    expect(describeFailure(abortError())).toBe('AbortError:20');
  });

  it('keeps an HTTP status', () => {
    expect(
      describeFailure(Object.assign(new Error('x'), { name: 'AiBrainRequestError', statusCode: 503 })),
    ).toBe('AiBrainRequestError:503');
  });

  it('NEVER includes the error message', () => {
    // The message is the one field that can echo the request - which on this path is a
    // customer's own words. This string is written to a database row and a log line, both of
    // which outlive the request.
    const error = Object.assign(new Error('failed parsing "call me on 9876543210"'), {
      name: 'AbortError',
    });

    const described = describeFailure(error);

    expect(described).not.toContain('9876543210');
    expect(described).not.toContain('call me');
  });

  it('says "unknown" rather than throwing on junk', () => {
    expect(describeFailure(null)).toBe('unknown');
    expect(describeFailure({})).toBe('unknown');
  });
});
