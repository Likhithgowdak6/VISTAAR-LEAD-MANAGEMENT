/**
 * Meta's 24-hour customer service window, for the composer.
 *
 * Within 24 hours of the customer's last message a business may send anything. Outside it,
 * WhatsApp accepts ONLY an approved template and rejects everything else. This decides which of
 * those two the composer offers, which makes it the most visible piece of Cloud API behaviour in
 * the product.
 *
 * Mirrors backend/src/constants/whatsapp-providers.ts deliberately. The two are not shared code -
 * this is a Vite bundle and that is a Node service - but they must agree, and the duplication is
 * a dozen lines of arithmetic with tests on both sides rather than a build-time dependency
 * between two deployables.
 *
 * The browser's answer is only ever ADVISORY: the server re-checks on send and WhatsApp is the
 * real authority. A clock skewed by a few minutes shows a slightly wrong countdown, not a message
 * sent that should not have been.
 */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Under an hour left: warn the agent while they are still typing. */
export const SERVICE_WINDOW_WARNING_MS = 60 * 60 * 1000;

export type ServiceWindowState = 'open' | 'closing' | 'closed' | 'never-opened';

export interface ServiceWindow {
  state: ServiceWindowState;
  /** True when free text will be accepted. The single question the composer asks. */
  canSendFreeText: boolean;
  /** Milliseconds until it shuts, or null when it never opened. */
  remainingMs: number | null;
}

const toTime = (value: Date | string | null | undefined): number | null => {
  if (!value) {
    return null;
  }

  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();

  return Number.isNaN(time) ? null : time;
};

export const resolveServiceWindow = ({
  lastInboundAt,
  now = Date.now(),
}: {
  lastInboundAt: Date | string | null | undefined;
  now?: number;
}): ServiceWindow => {
  const last = toTime(lastInboundAt);

  // Never opened is deliberately its own state rather than folded into "closed". It is the Meta
  // Lead Ads case - the lead filled in a form and has never messaged - and the composer says
  // something different about it: not "the window has expired" but "they have not messaged you".
  if (last === null) {
    return { state: 'never-opened', canSendFreeText: false, remainingMs: null };
  }

  const remainingMs = Math.max(0, last + SERVICE_WINDOW_MS - now);

  if (remainingMs <= 0) {
    return { state: 'closed', canSendFreeText: false, remainingMs: 0 };
  }

  return {
    state: remainingMs <= SERVICE_WINDOW_WARNING_MS ? 'closing' : 'open',
    canSendFreeText: true,
    remainingMs,
  };
};

/** "3h 20m" / "14m" — short enough to sit inline above a text box. */
export const formatWindowRemaining = (remainingMs: number | null): string => {
  if (remainingMs === null || remainingMs <= 0) {
    return '';
  }

  const totalMinutes = Math.floor(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    // Under a minute still reads as "1m" rather than "0m", which looks like a bug.
    return `${Math.max(1, minutes)}m`;
  }

  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
};
