export interface LeadSourceErrorOptions {
  code?: string;
  cause?: unknown;
}

export class LeadSourceError extends Error {
  public readonly code: string;

  constructor(message: string, { code = 'LEAD_SOURCE_ERROR', cause }: LeadSourceErrorOptions = {}) {
    super(message);
    this.name = 'LeadSourceError';
    this.code = code;

    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/** The sheet could not be read: bad link, revoked sharing, or Google returning an error page. */
export class LeadSheetFetchError extends LeadSourceError {
  constructor(message: string, options: LeadSourceErrorOptions = {}) {
    super(message, { code: 'LEAD_SHEET_FETCH_FAILED', ...options });
    this.name = 'LeadSheetFetchError';
  }
}

/**
 * How the importer should react to a Graph API failure.
 *
 * - `transient` — a network blip or a Meta 5xx. Nothing is wrong with the configuration; the next
 *   tick will very likely succeed.
 * - `rate_limited` — Meta is throttling this app. Back off and let the next tick try; hammering
 *   it makes the block last longer.
 * - `needs_attention` — the token expired, was revoked, or never had the permission. No number of
 *   retries fixes that, so the source is flagged for a human instead of failing quietly forever.
 */
export const META_GRAPH_FAILURE_KINDS = Object.freeze({
  TRANSIENT: 'transient',
  RATE_LIMITED: 'rate_limited',
  NEEDS_ATTENTION: 'needs_attention',
} as const);

export type MetaGraphFailureKind =
  (typeof META_GRAPH_FAILURE_KINDS)[keyof typeof META_GRAPH_FAILURE_KINDS];

export interface MetaGraphErrorOptions extends LeadSourceErrorOptions {
  failureKind?: MetaGraphFailureKind;
  /** Meta's own `error.code`, kept for logs. Never a credential. */
  metaCode?: number | null;
  metaSubcode?: number | null;
  httpStatus?: number | null;
}

/**
 * A Graph API call the CRM could not complete. The message is written for the admin who will
 * read it off the dashboard, never Meta's raw prose — see `sanitizeLeadSourceErrorText`.
 */
export class MetaGraphError extends LeadSourceError {
  public readonly failureKind: MetaGraphFailureKind;
  public readonly metaCode: number | null;
  public readonly metaSubcode: number | null;
  public readonly httpStatus: number | null;

  constructor(
    message: string,
    {
      code = 'META_GRAPH_REQUEST_FAILED',
      failureKind = META_GRAPH_FAILURE_KINDS.TRANSIENT,
      metaCode = null,
      metaSubcode = null,
      httpStatus = null,
      cause,
    }: MetaGraphErrorOptions = {},
  ) {
    super(message, { code, cause });
    this.name = 'MetaGraphError';
    this.failureKind = failureKind;
    this.metaCode = metaCode;
    this.metaSubcode = metaSubcode;
    this.httpStatus = httpStatus;
  }
}

/** The source is a Meta source but has no usable token/page/form yet. */
export class MetaLeadSourceNotConfiguredError extends LeadSourceError {
  constructor(message = 'This Meta source has no access token yet.') {
    super(message, { code: 'META_SOURCE_NOT_CONFIGURED' });
    this.name = 'MetaLeadSourceNotConfiguredError';
  }
}

const URL_PATTERN = /\bhttps?:\/\/\S+/gi;
const TOKEN_QUERY_PATTERN = /\b(access_token|client_secret|token)=[^\s&"']+/gi;
// A Meta access token is a long opaque blob; matching on shape catches one that reached a
// message some other way than as a query parameter.
const BEARER_LIKE_PATTERN = /\b(EAA|EAAB)[A-Za-z0-9]{20,}\b/g;

export const LEAD_SOURCE_ERROR_MAX_LENGTH = 300;

/**
 * Last line of defence before anything is written to `LeadSource.lastError`, which is read back
 * by the dashboard and therefore by anyone with admin access.
 *
 * A fetch or driver error loves to echo the URL it was given, and for Meta that URL carries the
 * page access token as a query parameter. Redacting the token alone is not enough — the whole URL
 * goes, because a Graph URL also names the form and page ids. Truncated to the column's length so
 * the model's `maxlength` never silently rejects the write.
 */
export const sanitizeLeadSourceErrorText = (value: unknown): string => {
  const text = typeof value === 'string' ? value : String(value ?? '');

  const redacted = text
    .replace(TOKEN_QUERY_PATTERN, (_match, key: string) => `${key}=[redacted]`)
    .replace(URL_PATTERN, '[url]')
    .replace(BEARER_LIKE_PATTERN, '[redacted]')
    .trim();

  return redacted.length > LEAD_SOURCE_ERROR_MAX_LENGTH
    ? `${redacted.slice(0, LEAD_SOURCE_ERROR_MAX_LENGTH - 1)}…`
    : redacted;
};
