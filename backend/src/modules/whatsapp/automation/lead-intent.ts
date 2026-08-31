/**
 * Two things a lead DOES that say more about how warm they are than anything they fill into a
 * form: asking what it costs, and asking whether we are free on their date. Both feed
 * conversations/lead-score.ts, which cannot see messages and takes them as flags.
 *
 * Pure and stateless, exactly like opt-out.ts next door - no database, no clock, no side
 * effects. Whoever calls this decides what to do with the answer, and remembering that it ever
 * happened is the conversation's job, not this module's.
 *
 * PRECISION OVER RECALL, and the same two-tier shape opt-out.ts uses, for the same reason:
 *
 *  - Short, ordinary words - `price`, `rate`, `free`, `kitna` - only count when they are the
 *    WHOLE message. "we are free to talk tomorrow", "grateful for the quick reply" and "the
 *    venue rate card was fine" are all ordinary sales conversation, and `rate` is a substring of
 *    "grateful" and "decorate" besides.
 *  - Only the long, unambiguous phrases - `how much`, `send me a quote`, `are you available` -
 *    are allowed to match inside a longer sentence, because nobody types those by accident.
 *
 * A false positive here is cheap compared to opt-out's (a lead scores 15 points they did not
 * earn, and at worst the owner's phone buzzes about a lead who is not quite hot), but the score
 * is only worth reading if it is honest, so the bar stays high.
 *
 * Hinglish is first-class, not an afterthought: half of Bangalore types "kitna hoga bhai" and
 * "12 tarikh ko free ho?", and a matcher that only knows English scores those leads at zero.
 */

/**
 * The same normaliser opt-out.ts already applies - lowercase, apostrophes and punctuation gone,
 * whitespace collapsed - so "How much?!", "how much" and "HOW MUCH 🙏" all reduce to one string,
 * and the phrase lists below can be written the way a person writes them. Reused rather than
 * re-implemented: one spelling-and-punctuation rule for every phrase match on the inbound path
 * is one rule to keep right.
 */
import { normalizeOptOutText as normalizeLeadText } from './opt-out.js';

/**
 * "How much is it?" - only a price question when it is the entire message. Every one of these is
 * a word that turns up mid-sentence in a perfectly ordinary conversation.
 */
export const QUOTATION_WHOLE_MESSAGE_PHRASES: readonly string[] = Object.freeze([
  'price',
  'prices',
  'pricing',
  'rate',
  'rates',
  'cost',
  'costs',
  'quote',
  'quotation',
  'charges',
  'kitna',
  'kitne',
  'daam',
  'price please',
  'rate please',
  'rate kya hai',
  'price kya hai',
  'kitna hai',
  'kitne ka hai',
]);

/**
 * Price questions unambiguous enough to count anywhere in a message. Nobody writes "send me a
 * quote" or "kitna hoga" as an aside.
 */
export const QUOTATION_PHRASES: readonly string[] = Object.freeze([
  'how much',
  'what is the price',
  'whats the price',
  'what is the cost',
  'whats the cost',
  'what is the rate',
  'whats the rate',
  'what are your rates',
  'what are your charges',
  'your rates',
  'your charges',
  'price list',
  'rate card',
  'price range',
  'send me a quote',
  'send a quote',
  'send quote',
  'send me a quotation',
  'send quotation',
  'share a quote',
  'share the quote',
  'need a quote',
  'want a quote',
  'need a quotation',
  'quote for',
  'quotation for',
  // Hinglish. "kitna" alone is whole-message-only above; these carry their own verb.
  'kitna hoga',
  'kitne ka',
  'kitna lagega',
  'kitna charge',
  'kitne charge',
  'kitna padega',
  'price kya',
  'rate kya',
  'kya rate',
  'kya price',
  'price batao',
  'rate batao',
  'price bhejo',
  'rate bhej',
  'quotation bhej',
  'quote bhej',
  'charges kya',
  'charge kitna',
  'cost kitna',
]);

/**
 * "Are you free that day?" - whole-message only, for the same reason as above. `free` in
 * particular is a word this business's own leads use about parking, food and time.
 */
export const AVAILABILITY_WHOLE_MESSAGE_PHRASES: readonly string[] = Object.freeze([
  'available',
  'availability',
  'free',
  'khali',
  'are you available',
  'you available',
  'available or not',
]);

/**
 * Availability questions unambiguous enough to count mid-sentence.
 */
export const AVAILABILITY_PHRASES: readonly string[] = Object.freeze([
  'are you available',
  'are you free',
  'you free on',
  'you available on',
  'availability on',
  'availability for',
  'check availability',
  'check your availability',
  'do you have availability',
  'is the date available',
  'is that date available',
  'date available',
  'dates available',
  'slot available',
  'slots available',
  'are you booked',
  'still available',
  // Hinglish.
  'available ho',
  'available hai',
  'free ho',
  'free hai',
  'khali ho',
  'khali hai',
  'booked ho',
  'booking available',
  'date khali',
  'tarikh ko free',
  'us din free',
  'us din available',
]);

/** Every quotation phrase this module recognises, in the spelling a lead would actually type. */
export const ALL_QUOTATION_PHRASES: readonly string[] = Object.freeze([
  ...QUOTATION_WHOLE_MESSAGE_PHRASES,
  ...QUOTATION_PHRASES,
  // The apostrophe spellings normalize onto `whats the price` / `whats the cost` above; listed so
  // tests enumerating this array cover the form a real customer types.
  "what's the price",
  "what's the cost",
]);

/** Every availability phrase this module recognises. */
export const ALL_AVAILABILITY_PHRASES: readonly string[] = Object.freeze([
  ...AVAILABILITY_WHOLE_MESSAGE_PHRASES,
  ...AVAILABILITY_PHRASES,
]);

/**
 * The shared two-tier match: whole-message equality for the short phrases, substring for the
 * long ones. Safe for null/undefined/non-string input, which is what an inbound message with no
 * text at all (a photo, a sticker) arrives as.
 */
const matchesPhrases = (
  text: unknown,
  wholeMessagePhrases: readonly string[],
  anywherePhrases: readonly string[],
): boolean => {
  const normalized = normalizeLeadText(text);

  if (normalized === '') {
    return false;
  }

  if (wholeMessagePhrases.some((phrase) => normalized === normalizeLeadText(phrase))) {
    return true;
  }

  return anywherePhrases.some((phrase) => normalized.includes(normalizeLeadText(phrase)));
};

/** True when `text` is the lead asking what this will cost. */
export const isQuotationRequest = (text: unknown): boolean =>
  matchesPhrases(text, QUOTATION_WHOLE_MESSAGE_PHRASES, QUOTATION_PHRASES);

/** True when `text` is the lead asking whether we are free for their date. */
export const isAvailabilityQuestion = (text: unknown): boolean =>
  matchesPhrases(text, AVAILABILITY_WHOLE_MESSAGE_PHRASES, AVAILABILITY_PHRASES);
