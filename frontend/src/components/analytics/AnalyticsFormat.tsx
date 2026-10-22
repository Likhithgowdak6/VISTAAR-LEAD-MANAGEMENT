/**
 * The vocabulary and the formatters, kept apart from the components that use them.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE: a zero and an absence are different things, and the
 * screen must never let the second impersonate the first. `0` is a finding - nobody enquired
 * today. `—` is an admission - the server did not report this, or the denominator was zero, so
 * there is no honest number to draw. Every formatter below therefore accepts
 * `number | null | undefined` rather than `number`: typing them narrowly would force each call
 * site to invent a fallback with `?? 0`, which is exactly the failure this screen guards
 * against.
 *
 * (No components live here. The file is split from AnalyticsPrimitives so that one only
 * exports components, which is what fast refresh requires.)
 */
import type {
  AiResponseStatus,
  DefinedCount,
  DefinedRate,
  EnquiryClass,
  ReminderSource,
} from '../../types/analytics';

/** What the screen prints when there is no number to print. Never used for a real zero. */
export const DASH = '—';

/** The six buckets, in the backend's own declaration order so the UI cannot reorder the truth. */
export const AI_STATUS_ORDER: readonly AiResponseStatus[] = [
  'ai_replied',
  'awaiting_ai_reply',
  'ai_paused',
  'ai_reply_failed',
  'ai_not_needed',
  'needs_review',
];

export const AI_STATUS_LABELS: Record<AiResponseStatus, string> = {
  ai_replied: 'AI replied',
  awaiting_ai_reply: 'Awaiting AI reply',
  ai_paused: 'AI paused',
  ai_reply_failed: 'AI reply failed',
  ai_not_needed: 'No reply owed',
  needs_review: 'Needs review',
};

/** Wording lifted from the backend's own doc comments, so two screens cannot drift apart. */
export const AI_STATUS_DEFINITIONS: Record<AiResponseStatus, string> = {
  ai_replied: 'A qualifying AI message was sent successfully, and nothing has come in since.',
  awaiting_ai_reply: 'An enquiry with an inbound message newer than the last successful AI reply.',
  ai_paused: 'Automation is off for this thread — paused, or a human took it over.',
  ai_reply_failed: 'The most recent AI send attempt failed and nothing succeeded after it.',
  ai_not_needed: 'Not a customer, or they asked us to stop. No reply is owed.',
  needs_review: 'Cannot be established from what is recorded. Legacy rows land here.',
};

export const ENQUIRY_CLASS_ORDER: readonly EnquiryClass[] = [
  'enquiry',
  'not_enquiry',
  'needs_review',
];

export const ENQUIRY_CLASS_LABELS: Record<EnquiryClass, string> = {
  enquiry: 'Enquiry',
  not_enquiry: 'Not an enquiry',
  needs_review: 'Needs review',
};

export const ENQUIRY_CLASS_DEFINITIONS: Record<EnquiryClass, string> = {
  enquiry: 'A genuine potential customer.',
  not_enquiry: 'Confidently identified as not a customer — a vendor, a bank, a wrong number.',
  needs_review:
    'Not enough evidence either way. The honest answer, and the default for legacy rows.',
};

/** A count, formatted - or the dash, if there is no count. */
export const formatCount = (value: number | null | undefined): string =>
  typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString() : DASH;

/**
 * A rate, formatted. `DefinedRate.value` is already 0-100 to one decimal (see the backend's
 * contract), so it is printed as-is and NOT multiplied by 100. Null means the denominator was
 * zero, which prints as the dash - never as "0%", which would claim nobody converted when in
 * truth nobody was counted.
 */
export const formatRate = (rate: DefinedRate | null | undefined): string =>
  rate && typeof rate.value === 'number' && Number.isFinite(rate.value) ? `${rate.value}%` : DASH;

/** "12 / 48" - the working behind a rate, shown next to it so the percentage can be checked. */
export const formatWorking = (rate: DefinedRate | null | undefined): string =>
  rate ? `${rate.numerator.toLocaleString()} / ${rate.denominator.toLocaleString()}` : DASH;

/** Pulls the number out of a DefinedCount without ever substituting one. */
export const countValue = (count: DefinedCount | null | undefined): number | null =>
  count && typeof count.value === 'number' && Number.isFinite(count.value) ? count.value : null;

/** Whole minutes rendered the way an owner reads a wait: "3h 20m", "2d", "4m". */
export const formatWaiting = (minutes: number | null | undefined): string => {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) return DASH;
  if (minutes < 60) return `${Math.round(minutes)}m`;

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    const rest = Math.round(minutes - hours * 60);
    return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  }

  const days = Math.floor(hours / 24);
  const restHours = hours - days * 24;

  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
};

/** Seconds as the owner would say them. Null stays null - it never becomes "0s". */
export const formatSeconds = (seconds: number | null | undefined): string => {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return DASH;
  if (seconds < 90) return `${Math.round(seconds)}s`;

  const minutes = seconds / 60;

  if (minutes < 90) return `${Math.round(minutes)}m`;

  return `${Math.round(minutes / 60)}h`;
};

/**
 * A short timestamp, or the dash. Never "Invalid Date".
 *
 * `timeZone` exists for one reason: a reminder's due time was set in the STUDIO's zone, and a
 * due time rendered in the reader's browser zone is simply the wrong time for anyone travelling
 * or working from elsewhere. Omitting it keeps the browser's own zone, which is right for
 * things that happened (a message arrived at a UTC instant) and wrong for things that are owed.
 */
export const formatStamp = (iso: string | null | undefined, timeZone?: string): string => {
  if (!iso) return DASH;

  const parsed = new Date(iso);

  if (Number.isNaN(parsed.getTime())) return DASH;

  return parsed.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  });
};

/** Who asked for a reminder, in the words the owner would use. */
export const REMINDER_SOURCE_LABELS: Record<ReminderSource, string> = {
  manual: 'Set by hand',
  lead_commitment: 'From what the lead said',
  owner_command: 'Asked for on WhatsApp',
};

/** The headline for a reminder whose title was never set. An absence, stated as one. */
export const UNTITLED_REMINDER = 'Untitled reminder';
