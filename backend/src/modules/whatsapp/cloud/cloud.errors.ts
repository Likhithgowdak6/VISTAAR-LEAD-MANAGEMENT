import { WhatsAppProviderError } from '../whatsapp.errors.js';

/**
 * What the delivery queue should do about a failed Cloud send.
 *
 * The queue's default rule is "retry until maxAttempts, then give up", which is right for a
 * dropped socket and wrong for most of Meta's refusals. A closed service window will still be
 * closed in thirty seconds, and a revoked token will still be revoked; burning three attempts and
 * fifteen minutes before telling the agent is worse than telling them immediately.
 */
export const CLOUD_FAILURE_KINDS = Object.freeze({
  /** Try again later: a throttle, a blip, Meta being briefly unwell. */
  TRANSIENT: 'transient',
  /** Never going to work as sent. Fail the message now and say why. */
  PERMANENT: 'permanent',
  /** Correct request, too many of them. Transient, but worth backing off harder. */
  RATE_LIMITED: 'rate_limited',
  /** A human must fix the connection - a dead token, a number that is not registered. */
  NEEDS_ATTENTION: 'needs_attention',
} as const);

export type CloudFailureKind = (typeof CLOUD_FAILURE_KINDS)[keyof typeof CLOUD_FAILURE_KINDS];

export interface WhatsAppCloudErrorOptions {
  code?: string;
  failureKind?: CloudFailureKind;
  metaCode?: number | null;
  metaSubcode?: number | null;
  httpStatus?: number | null;
  cause?: unknown;
}

/**
 * Every failure that leaves the Cloud client, in one shape.
 *
 * Extends WhatsAppProviderError so the existing delivery and session code - which already catches
 * that type - keeps working without knowing the Cloud API exists.
 *
 * `permanent` is the field the delivery queue reads. It is deliberately a plain boolean rather
 * than asking callers to interpret `failureKind`, because the queue's question is binary and a
 * mis-read enum there means a message retried forever or abandoned on its first throttle.
 */
export class WhatsAppCloudError extends WhatsAppProviderError {
  readonly failureKind: CloudFailureKind;
  readonly metaCode: number | null;
  readonly metaSubcode: number | null;
  readonly httpStatus: number | null;

  constructor(
    message: string,
    {
      code = 'WHATSAPP_CLOUD_ERROR',
      failureKind = CLOUD_FAILURE_KINDS.TRANSIENT,
      metaCode = null,
      metaSubcode = null,
      httpStatus = null,
      cause,
    }: WhatsAppCloudErrorOptions = {},
  ) {
    super(message, { code, cause });
    this.name = 'WhatsAppCloudError';
    this.failureKind = failureKind;
    this.metaCode = metaCode;
    this.metaSubcode = metaSubcode;
    this.httpStatus = httpStatus;
  }

  /**
   * True when retrying cannot help. Read by the outbound delivery queue to fail a message on its
   * first attempt instead of walking the backoff ladder to the same conclusion.
   */
  get permanent(): boolean {
    return (
      this.failureKind === CLOUD_FAILURE_KINDS.PERMANENT ||
      this.failureKind === CLOUD_FAILURE_KINDS.NEEDS_ATTENTION
    );
  }
}

/** The error code for the one refusal the UI has a specific answer to. */
export const CLOUD_WINDOW_CLOSED_CODE = 'WHATSAPP_CLOUD_WINDOW_CLOSED';
