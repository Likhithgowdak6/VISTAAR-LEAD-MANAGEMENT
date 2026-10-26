/**
 * Push notification vocabulary.
 *
 * Separate from the WhatsApp reminder channel on purpose: the two are independent delivery
 * paths for the same reminder, and neither reports the other's success. A failed push must
 * never mark a reminder undelivered, and a failed WhatsApp send must never suppress a push.
 */

export const PUSH_PLATFORMS = Object.freeze({
  ANDROID: 'android',
  IOS: 'ios',
  WEB: 'web',
} as const);

export type PushPlatform = (typeof PUSH_PLATFORMS)[keyof typeof PUSH_PLATFORMS];

export const PUSH_PLATFORM_VALUES = Object.freeze(Object.values(PUSH_PLATFORMS)) as readonly [
  PushPlatform,
  ...PushPlatform[],
];

/**
 * FCM errors that mean "this token is dead, stop using it".
 *
 * EVERYTHING ELSE IS TRANSIENT and must not disable a device. A quota error or a 503 from
 * Google is a reason to try later, not a reason to stop ringing somebody's phone forever -
 * treating them alike is how an outage silently un-registers an entire team.
 */
export const PUSH_DEAD_TOKEN_CODES: readonly string[] = Object.freeze([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
  'UNREGISTERED',
  'INVALID_ARGUMENT',
]);

/**
 * What a reminder push is allowed to say on a lock screen.
 *
 * DELIBERATELY SAYS ALMOST NOTHING. A lock-screen notification is visible to whoever is
 * holding the phone, and the reminder it is about names a real customer. The title is fixed,
 * the body is the reminder's own short title - never the lead's name, their number, their
 * message, or anything the AI extracted from it. The owner opens the app to see who it is.
 */
export const PUSH_REMINDER_TITLE = 'Vistaar reminder';

/**
 * The Android notification channel a reminder push rings on.
 *
 * MUST MATCH `ReminderChannel.ID` in the Android app and `REMINDER_CHANNEL_ID` in the
 * frontend. The channel is created natively at app launch with `USAGE_ALARM` audio, so a push
 * on it plays at ALARM volume and is not silenced by the ringer being off - which is the only
 * way to wake somebody whose app is closed, because a Clock-app alarm cannot be created from
 * the background on Android 10+.
 *
 * SENDING TO A CHANNEL ID THAT DOES NOT EXIST IS NOT AN ERROR - Android quietly falls back to
 * the app's default channel and the notification arrives, just quietly. That is why this is a
 * named constant with a test either side rather than a literal in the sender: a typo here
 * produces a working-but-silent notification, which is the hardest kind of bug to notice.
 */
export const PUSH_REMINDER_CHANNEL_ID = 'vistaar-reminders-alarm';

/** Cut to a length that fits a notification shade without the OS truncating mid-sentence. */
export const PUSH_BODY_MAX_LENGTH = 120;
