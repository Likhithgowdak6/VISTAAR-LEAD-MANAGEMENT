/**
 * "Stop messaging me." Recognising that one sentence is the difference between a business that
 * annoys a few people and a WhatsApp number that gets reported and banned - once a lead asks to
 * be left alone, the nurture cadence must never chase them again.
 *
 * Pure and stateless, like allowlist.ts and quiet-hours.ts next to it: no database, no clock, no
 * side effects. Everything that acts on the answer lives in the ingestion path, the nurture
 * sweep's query, and the send gate.
 *
 * PRECISION OVER RECALL. A false positive silently kills a paying customer: the AI goes quiet,
 * the sweep skips them, and nobody finds out until the enquiry is long dead. A false negative
 * only costs one more follow-up. So the matcher is deliberately conservative:
 *
 *  - Short, ordinary words - `stop`, `not interested` - only count as an opt-out when they are
 *    the WHOLE message. "don't stop sending me updates" and "we can stop by the venue at 4" are
 *    both normal sales conversation and must stay untouched.
 *  - Only the long, unambiguous phrases - `unsubscribe`, `do not message me`, `band karo` - are
 *    allowed to match inside a longer sentence, because nobody types those by accident.
 */

/**
 * Lowercases, drops punctuation/emoji/apostrophes and collapses whitespace, so "STOP!!",
 * " stop 🙏" and "Stop." all reduce to the same "stop". Applied to the phrase lists too, which
 * is what lets them be written naturally ("don't message me") and still match "dont message me".
 */
export const normalizeOptOutText = (text: unknown): string => {
  if (typeof text !== 'string') {
    return '';
  }

  return text
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
};

/**
 * Opt-outs that are only an opt-out when they are the entire message. Every one of these is a
 * word a happy lead uses mid-sentence all the time.
 */
export const OPT_OUT_WHOLE_MESSAGE_PHRASES: readonly string[] = Object.freeze([
  'stop',
  'not interested',
  'nahi chahiye',
]);

/**
 * Opt-outs unambiguous enough to count anywhere in a message. Nobody writes "unsubscribe" or
 * "mat bhejo" as an aside while asking about wedding packages.
 */
export const OPT_OUT_PHRASES: readonly string[] = Object.freeze([
  'unsubscribe',
  'remove me',
  'dont message me',
  'do not message me',
  'leave me alone',
  'band karo',
  'mat bhejo',
  'mujhe nahi chahiye',
  // ADDED LATER, because the two commonest ways an Indian customer actually writes this both
  // fell through every rule above. "Please stop messaging me" is not the whole message, so the
  // `stop` entry does not fire; "don't contact me again" matches none of the `message`
  // spellings. Both were reaching the sales agent as ordinary enquiries.
  'stop messaging',
  'stop contacting',
  'stop sending me',
  'dont contact me',
  'do not contact me',
  'dont send me',
  'do not send me',
]);

/**
 * Phrases that LOOK like an opt-out only because an opt-out phrase is sitting inside them.
 *
 * "Don't stop sending me updates" contains "stop sending me". Silencing a customer who just
 * asked for MORE messages is the worst failure this module can produce - it is invisible, it
 * kills a live deal, and the customer's own words say the opposite. Checked before anything
 * else, so a negated phrase never reaches the matchers below.
 */
export const OPT_OUT_NEGATIONS: readonly string[] = Object.freeze([
  'dont stop',
  'do not stop',
  'never stop',
  'dont remove',
  'do not remove',
]);

/** Every phrase this module recognises, in the spelling a lead would actually type. */
export const ALL_OPT_OUT_PHRASES: readonly string[] = Object.freeze([
  ...OPT_OUT_WHOLE_MESSAGE_PHRASES,
  ...OPT_OUT_PHRASES,
  // The apostrophe spelling normalizes onto `dont message me` above; listed so tests enumerating
  // this array cover the form a real customer types.
  "don't message me",
]);

/** Shown in the dashboard (and in the owner's alert) as why automation went quiet. */
export const OPT_OUT_PAUSED_REASON = 'This lead asked to stop receiving messages.';

/**
 * True when `text` is a lead asking not to be contacted again. Safe for null/undefined/non-string
 * input, which is what an inbound message with no text at all (a photo, a sticker) arrives as.
 */
export const isOptOutRequest = (text: unknown): boolean => {
  const normalized = normalizeOptOutText(text);

  if (normalized === '') {
    return false;
  }

  // "Don't stop sending me updates" is a request for MORE contact. Precision over recall, as
  // above: refusing the whole message is cheaper than silencing a customer who asked to hear
  // from us. See OPT_OUT_NEGATIONS.
  if (OPT_OUT_NEGATIONS.some((phrase) => normalized.includes(normalizeOptOutText(phrase)))) {
    return false;
  }

  if (
    OPT_OUT_WHOLE_MESSAGE_PHRASES.some((phrase) => normalized === normalizeOptOutText(phrase))
  ) {
    return true;
  }

  // `includes` on the normalized (space-separated) form rather than a regex: every phrase here
  // is multi-word or long enough that a mid-word coincidence is not a realistic worry.
  return OPT_OUT_PHRASES.some((phrase) => normalized.includes(normalizeOptOutText(phrase)));
};
