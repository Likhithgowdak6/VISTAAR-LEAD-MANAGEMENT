/**
 * The states a tracked cellular call can be in.
 *
 * WHY `unknown` IS A FIRST-CLASS VALUE AND NOT A GAP. Vistaar opens the phone's dialler with
 * `Intent.ACTION_DIAL` and then loses sight of what happens: Android gives an ordinary app no
 * reliable evidence of whether the agent pressed the green button, whether the customer picked
 * up, or how long they spoke. Detecting that needs `READ_PHONE_STATE` plus a foreground service
 * to survive the app being backgrounded during the call - a permission and a Play-policy
 * commitment this app deliberately does not make.
 *
 * So opening the dialler records `initiated` and NOTHING ELSE. It is not a completed call, it is
 * not a connected call, and it is not a missed one. The outcome is `unknown` until a human says
 * otherwise. Anything else would be the CRM inventing a fact about a customer conversation.
 *
 * THERE IS NO RECORDING OR PROCESSING STATUS HERE, BY DESIGN. Vistaar does not capture call
 * audio, does not accept uploaded audio, and derives nothing from it - no transcript, no
 * summary, no suggested follow-up. A call record is what a human says happened on a call, and
 * that is the whole of it.
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
