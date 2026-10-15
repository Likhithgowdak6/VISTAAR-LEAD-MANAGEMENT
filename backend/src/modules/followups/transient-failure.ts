/**
 * Is this failure worth trying again, or is trying again just a slower way to fail?
 *
 * THE DISTINCTION IS THE WHOLE POINT OF RETRYING AT ALL. A classifier that timed out would
 * probably answer if asked in a minute, and the commitment it never saw is a reminder the owner
 * never got. A classifier that answered "no commitment here" has already done its job, and
 * asking again costs an LLM call to be told the same thing. Retrying the second kind is how a
 * recovery mechanism turns into a bill.
 *
 * SO THE DEFAULT IS NO. Anything this file does not positively recognise as a network or
 * availability problem is terminal. A permissive default here is worse than a missed reminder:
 * it would re-run extraction against malformed input, a revoked service key or a 400 forever,
 * until the attempt budget runs out, every time.
 */

/** Node and undici put the useful part in `code`; `cause` holds it for a wrapped fetch error. */
const TRANSIENT_CODES: readonly string[] = Object.freeze([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * `AbortError` is the one that matters most here, and it is why this file exists.
 *
 * ai-brain.client.ts gives `/v1/commitment` an 8-second budget and aborts the fetch when it
 * runs out, which rejects with a DOMException named AbortError (code 20). That is what was
 * seen in production: not a crash, just a classifier that took too long once.
 */
const TRANSIENT_NAMES: readonly string[] = Object.freeze([
  'AbortError',
  'TimeoutError',
  'FetchError',
]);

interface MaybeError {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  statusCode?: unknown;
  cause?: { code?: unknown; name?: unknown } | null;
}

export const isTransientAiFailure = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const err = error as MaybeError;

  if (typeof err.name === 'string' && TRANSIENT_NAMES.includes(err.name)) {
    return true;
  }

  const codes = [err.code, err.cause?.code, err.cause?.name];

  if (codes.some((code) => typeof code === 'string' && TRANSIENT_CODES.includes(code))) {
    return true;
  }

  // The service answered, badly. 5xx and 429 are "ask again"; every 4xx is "you asked wrong",
  // and asking the same wrong thing again will fail identically.
  if (typeof err.statusCode === 'number') {
    return err.statusCode === 429 || err.statusCode >= 500;
  }

  // undici's generic wrapper for a connection that never got off the ground. The code lives on
  // `cause` and is covered above; this catches the shape where it does not.
  return err.message === 'fetch failed';
};

/**
 * A short, PII-free description of a failure, safe to persist and log.
 *
 * Deliberately NOT `error.message`. A provider message can echo the request - which for this
 * path is a customer's own words - and anything written here lands in a database row and a log
 * line that both outlive the request.
 */
export const describeFailure = (error: unknown): string => {
  if (!error || typeof error !== 'object') {
    return 'unknown';
  }

  const err = error as MaybeError;
  const parts = [err.name, err.code, err.statusCode].filter(
    (part) => typeof part === 'string' || typeof part === 'number',
  );

  return parts.length > 0 ? parts.join(':').slice(0, 120) : 'unknown';
};
