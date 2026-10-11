/**
 * The two independent ways a reminder reaches its owner, and the state of each.
 *
 * SEPARATE ON PURPOSE. The backend sends a WhatsApp message; the Android app rings a local
 * alarm it scheduled on the handset. Neither can stand in for the other: WhatsApp needs a live
 * socket and a phone with data, while the device alarm needs the app to have synced the
 * reminder before the moment arrived - and to have been granted notification permission. So a
 * reminder that went out on WhatsApp but never reached the handset is a PARTIAL success, and
 * the record has to be able to say that rather than collapsing to one boolean.
 *
 * The practical consequence, which the scheduler relies on: a WhatsApp failure must never mark
 * the Android side delivered, and vice versa. Each channel owns its own status, attempts and
 * error.
 */
export const REMINDER_CHANNELS = Object.freeze({
  WHATSAPP: 'whatsapp',
  ANDROID: 'android',
} as const);

export type ReminderChannel = (typeof REMINDER_CHANNELS)[keyof typeof REMINDER_CHANNELS];

export const REMINDER_CHANNEL_VALUES = Object.freeze(Object.values(REMINDER_CHANNELS)) as readonly [
  ReminderChannel,
  ...ReminderChannel[],
];

/**
 * Per-channel delivery state.
 *
 * `pending` - not attempted yet. `sent` - handed to the channel successfully. `failed` - every
 * permitted attempt was used up; the error is kept. `skipped` - deliberately not attempted, and
 * that is not a failure: the owner has no WhatsApp session configured, or the device reported
 * that notification permission was denied. Keeping `skipped` distinct from `failed` is what
 * stops the retry logic hammering a channel that was never going to work.
 */
export const REMINDER_DELIVERY_STATUSES = Object.freeze({
  PENDING: 'pending',
  SENT: 'sent',
  FAILED: 'failed',
  SKIPPED: 'skipped',
} as const);

export type ReminderDeliveryStatus =
  (typeof REMINDER_DELIVERY_STATUSES)[keyof typeof REMINDER_DELIVERY_STATUSES];

export const REMINDER_DELIVERY_STATUS_VALUES = Object.freeze(
  Object.values(REMINDER_DELIVERY_STATUSES),
) as readonly [ReminderDeliveryStatus, ...ReminderDeliveryStatus[]];

/**
 * Who or what asked for this reminder. Audit-grade, and it also decides what the owner is told:
 * a lead-linked follow-up names the lead, a personal one does not.
 */
export const REMINDER_SOURCES = Object.freeze({
  /** Typed into the CRM by a person. */
  MANUAL: 'manual',
  /** Extracted from something a LEAD said ("call me tomorrow at 5"). */
  LEAD_COMMITMENT: 'lead_commitment',
  /** Asked for by the owner in their own WhatsApp self-chat ("remind me at 5 to call Rahul"). */
  OWNER_COMMAND: 'owner_command',
} as const);

export type ReminderSource = (typeof REMINDER_SOURCES)[keyof typeof REMINDER_SOURCES];

export const REMINDER_SOURCE_VALUES = Object.freeze(Object.values(REMINDER_SOURCES)) as readonly [
  ReminderSource,
  ...ReminderSource[],
];

/**
 * How many times a channel is retried before it is called failed.
 *
 * Three is chosen against the thing that actually breaks: the WhatsApp socket dropping for a
 * minute or two. The runner's interval spaces the attempts out, so this is roughly "keep trying
 * for the next few sweeps, then stop and make the failure visible" rather than a tight loop.
 */
export const REMINDER_MAX_DELIVERY_ATTEMPTS = 3;
