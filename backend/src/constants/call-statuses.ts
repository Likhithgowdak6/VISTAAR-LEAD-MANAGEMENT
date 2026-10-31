/**
 * The states a tracked cellular call can be in, and the states its processing pipeline can be in.
 *
 * WHY `unknown` IS A FIRST-CLASS VALUE AND NOT A GAP. Vistaar opens the phone's dialler with
 * `Intent.ACTION_DIAL` and then loses sight of what happens: Android gives an ordinary app no
 * reliable evidence of whether the agent pressed the green button, whether the customer picked
 * up, or how long they spoke. Detecting that needs `READ_PHONE_STATE` plus a foreground service
 * to survive the app being backgrounded during the call - a permission and a Play-policy
 * commitment this phase deliberately does not make.
 *
 * So opening the dialler records `initiated` and NOTHING ELSE. It is not a completed call, it is
 * not a connected call, and it is not a missed one. The outcome is `unknown` until a human says
 * otherwise. Anything else would be the CRM inventing a fact about a customer conversation.
 */

export const CALL_DIRECTIONS = Object.freeze({
  OUTBOUND: 'outbound',
  /**
   * Reserved. Nothing writes this yet: matching an INCOMING call to a lead needs the caller's
   * number, which on Android 10+ means READ_CALL_LOG - a permission Google Play restricts to
   * default-dialler apps. Declared so the model does not have to change when that is resolved.
   */
  INBOUND: 'inbound',
} as const);

export type CallDirection = (typeof CALL_DIRECTIONS)[keyof typeof CALL_DIRECTIONS];

export const CALL_DIRECTION_VALUES = Object.freeze(Object.values(CALL_DIRECTIONS)) as readonly [
  CallDirection,
  ...CallDirection[],
];

export const CALL_STATUSES = Object.freeze({
  /** The dialler was opened with this lead's number. The ONLY thing the app can actually witness. */
  INITIATED: 'initiated',
  /** A human confirmed they spoke to the customer. */
  COMPLETED: 'completed',
  /** A human confirmed the call did not connect - no answer, busy, or cut off. */
  FAILED: 'failed',
  /** A human confirmed they backed out of the dialler without calling. */
  CANCELLED: 'cancelled',
  /** Asked, not answered. Distinct from `initiated`: the agent was prompted and dismissed it. */
  UNKNOWN: 'unknown',
} as const);

export type CallStatus = (typeof CALL_STATUSES)[keyof typeof CALL_STATUSES];

export const CALL_STATUS_VALUES = Object.freeze(Object.values(CALL_STATUSES)) as readonly [
  CallStatus,
  ...CallStatus[],
];

/** The statuses a human may set. `initiated` is written by the system and cannot be re-asserted. */
export const CALL_OUTCOME_VALUES = Object.freeze([
  CALL_STATUSES.COMPLETED,
  CALL_STATUSES.FAILED,
  CALL_STATUSES.CANCELLED,
  CALL_STATUSES.UNKNOWN,
]) as readonly [CallStatus, ...CallStatus[]];

/**
 * Whether audio exists for this call.
 *
 * `unavailable` is the DEFAULT and the common case. Android gives no third-party app the two
 * sides of a cellular call - see the feasibility report - so audio only ever exists here because
 * a human attached a recording the phone's own dialler made. A call with no audio is normal and
 * the UI must say so plainly rather than looking broken.
 */
export const RECORDING_STATUSES = Object.freeze({
  UNAVAILABLE: 'unavailable',
  /** A recording is expected - the agent said one exists - but the bytes have not arrived. */
  PENDING: 'pending',
  UPLOADED: 'uploaded',
  FAILED: 'failed',
  /**
   * There WAS audio and it has been destroyed - by a person, or by the retention sweep.
   *
   * ITS OWN STATE, NOT A RETURN TO `unavailable`. The two are different facts and a reader has
   * to be able to tell them apart: "this call was never recorded" and "this call was recorded
   * and the recording is gone" lead to different conversations with a customer asking what
   * happened to it. Reverting to `unavailable` would quietly erase the second one.
   */
  DELETED: 'deleted',
} as const);

export type RecordingStatus = (typeof RECORDING_STATUSES)[keyof typeof RECORDING_STATUSES];

export const RECORDING_STATUS_VALUES = Object.freeze(Object.values(RECORDING_STATUSES)) as readonly [
  RecordingStatus,
  ...RecordingStatus[],
];

/**
 * One shape for both derived artefacts - the transcript and the summary.
 *
 * Shared because they are the same kind of thing: a background job that has not started, is
 * running, finished, or failed. Two parallel enums that mean the same thing is how one of them
 * grows a fifth state the other does not have.
 */
export const PROCESSING_STATUSES = Object.freeze({
  /** Nothing to do - there is no recording, so there is nothing to transcribe or summarise. */
  NOT_APPLICABLE: 'not_applicable',
  PENDING: 'pending',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const);

export type ProcessingStatus = (typeof PROCESSING_STATUSES)[keyof typeof PROCESSING_STATUSES];

export const PROCESSING_STATUS_VALUES = Object.freeze(
  Object.values(PROCESSING_STATUSES),
) as readonly [ProcessingStatus, ...ProcessingStatus[]];

/**
 * How long call data is kept, per organisation.
 *
 * NULL MEANS UNCONFIGURED, AND UNCONFIGURED MEANS KEEP FOREVER. That is the single most
 * important decision in this file, and it is deliberately the opposite of what a "retention
 * policy" usually implies.
 *
 * The reasoning: this feature is being added to a system that already holds real customer
 * calls. Shipping a default of, say, 90 days would mean the first time the sweep runs it
 * silently destroys every recording older than that - data nobody agreed to delete, on a
 * schedule nobody chose. Deletion is irreversible and the bytes are a record of a conversation
 * with a real person.
 *
 * SO THERE IS NO DEFAULT PERIOD, AND THERE IS NO LEGALLY-CORRECT ONE HERE EITHER. What Indian
 * law, a customer contract or an insurer requires is not something this codebase can know. The
 * owner sets a number; until they do, the sweep finds nothing and does nothing.
 */
export const CALL_RETENTION_DEFAULTS = Object.freeze({
  recordingDays: null,
  transcriptDays: null,
  summaryDays: null,
} as const);

export interface CallRetentionPolicy {
  /** Days to keep the audio. Null = keep indefinitely. */
  recordingDays: number | null;
  transcriptDays: number | null;
  summaryDays: number | null;
}

/** A day is the smallest sensible unit, and ten years is longer than this business has existed. */
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;
