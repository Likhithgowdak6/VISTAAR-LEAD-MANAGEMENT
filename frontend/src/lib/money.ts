/**
 * Showing money, without ever doing arithmetic on it.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE: the browser formats, the server calculates. Every
 * monetary figure arrives twice - `totalPaise: 478100` and `total: "4781.00"` - and the string
 * is already correct. Nothing here divides paise by 100, because `478100 / 100` is fine and
 * `0.1 + 0.2` is not, and the moment one component starts doing its own sums the integer
 * guarantee the backend was built around stops being worth anything.
 *
 * So these take the STRING the API supplied and decorate it. The only function that touches
 * paise is `comparePaise`, which compares integers and never converts them.
 */

/**
 * Indian digit grouping: 4,78,100.00 — pairs after the first three digits, not thousands.
 *
 * `en-IN` gets this right natively; writing it by hand is how a lakh ends up rendered as
 * 478,100 on an invoice a client reads.
 */
const GROUPER = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * A decimal string from the API as grouped rupees, with the symbol.
 *
 * Parsed with `Number` only for GROUPING, never for arithmetic, and only ever on a value the
 * server already rounded to two places - so the float round-trip cannot change what is shown.
 */
export const formatRupees = (value: string | null | undefined): string => {
  if (value === null || value === undefined || value === '') {
    return '₹0.00';
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    // Not a number we recognise. Show it unchanged rather than inventing a figure.
    return String(value);
  }

  return `₹${GROUPER.format(parsed)}`;
};

/** The same, without the symbol — for inputs and table cells that carry their own heading. */
export const formatAmount = (value: string | null | undefined): string =>
  formatRupees(value).replace('₹', '');

/**
 * Compares two paise figures.
 *
 * Integers in, integer comparison out. "Is this settled" is `comparePaise(balance, 0) <= 0`
 * with no tolerance, which is the whole point of the backend storing paise.
 */
export const comparePaise = (a: number, b: number): number => (a === b ? 0 : a < b ? -1 : 1);

export const isSettled = (balancePaise: number): boolean => balancePaise <= 0;

export const isOverpaid = (balancePaise: number): boolean => balancePaise < 0;

/**
 * What the user typed, as a decimal string the API will accept.
 *
 * Returns null when it is not a usable amount, so a caller can refuse before sending. The server
 * validates the same shape; this only avoids a round trip to be told so.
 */
export const toAmountString = (input: string): string | null => {
  const trimmed = input.trim();

  if (trimmed === '') {
    return null;
  }

  // Digits with at most four decimal places, matching the server's own pattern. No sign, no
  // exponent, no separators - a pasted "1,500" is rejected here rather than silently becoming 1.
  if (!/^\d{1,12}(\.\d{1,4})?$/.test(trimmed)) {
    return null;
  }

  return trimmed;
};

/** A date string from the API as `18 Nov 2026`, or an em dash when absent. */
export const formatDate = (value: string | null | undefined): string => {
  if (!value) {
    return '—';
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime())) {
    return '—';
  }

  return parsed.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
};
