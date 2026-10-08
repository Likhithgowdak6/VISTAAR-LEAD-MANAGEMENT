/**
 * Messages that are plainly not a customer enquiry - a bank OTP, a vendor's GST invoice, a
 * marketing blast - arriving on the same number leads use. Recognising them is what stops the
 * sales agent asking a bank bot which occasion it is shooting for.
 *
 * Pure and stateless, like opt-out.ts and lead-intent.ts beside it: no database, no clock, no
 * side effects. Whoever calls this decides what to do with the answer.
 *
 * PRECISION OVER RECALL, harder here than anywhere else on this path. A false positive is a
 * real customer the AI goes silent on; a false negative is one embarrassing reply the owner can
 * see and correct in the inbox. Those are not symmetrical, so the matcher is built to let
 * through anything it is not sure about. Three defences, in order:
 *
 *  1. A POSITIVE OVERRIDE runs first. If the message asks a price, asks about a date, or names
 *     the work (wedding, shoot, photography), no negative rule below can touch it. "Wedding
 *     shoot price? I'll transfer payment today" contains `payment`, and is obviously a lead.
 *  2. Short, ordinary words only count as the WHOLE message. `invoice`, `otp`, `offer` all turn
 *     up mid-sentence in real enquiries.
 *  3. Only long, unambiguous phrases - `type stop to unsubscribe`, `has been debited`,
 *     `limited time offer` - may match inside a longer sentence, because nobody writes those by
 *     accident while asking about a wedding.
 *
 * Deliberately NOT attempted: classifying ordinary personal conversation. There is no keyword
 * that separates "can we talk tomorrow" the friend from "can we talk tomorrow" the bride, and
 * guessing would cost real leads. That gap is for the intent gate, not for this module.
 */

import { normalizeOptOutText as normalizeText } from './opt-out.js';
import { isAvailabilityQuestion, isQuotationRequest } from './lead-intent.js';

/**
 * Words that mean somebody wants this studio to film something.
 *
 * Kept here rather than added to lead-intent.ts on purpose: that module's two exports feed the
 * lead SCORE, and widening what counts as intent there would silently move every lead's number.
 * These phrases exist only to veto the negative rules below, which is this module's business.
 *
 * Substring matches, all of them - "shoot", "wedding" and "photography" are nouns this business
 * exists for, and a message containing one is an enquiry until proven otherwise.
 */
export const SERVICE_ENQUIRY_PHRASES: readonly string[] = Object.freeze([
  'shoot',
  'shooting',
  'photography',
  'photographer',
  'videography',
  'videographer',
  'photoshoot',
  'photo shoot',
  'wedding',
  'prewedding',
  'pre wedding',
  'engagement',
  'haldi',
  'mehendi',
  'sangeet',
  'reception',
  'birthday',
  'anniversary',
  'baby shower',
  'maternity',
  'naming ceremony',
  'housewarming',
  'griha pravesh',
  'portfolio',
  'candid',
  'drone',
  'album',
  'event coverage',
  'corporate shoot',
  'book a shoot',
  'shoot karna',
  'shoot karwana',
  'photo karwana',
]);

/**
 * One-time passwords and bank/UPI notifications. `otp` and `upi` are whole-message only; a lead
 * could mention either while sorting out a booking payment.
 */
export const BANKING_WHOLE_MESSAGE_PHRASES: readonly string[] = Object.freeze([
  'otp',
  'upi',
]);

export const BANKING_PHRASES: readonly string[] = Object.freeze([
  'one time password',
  'your otp',
  'otp is',
  'otp for',
  'do not share this otp',
  'never share your otp',
  'do not share your otp',
  'verification code',
  'security code',
  'authentication code',
  'has been debited',
  'has been credited',
  'debited from your',
  'credited to your',
  'debited from a c',
  'credited to a c',
  'available balance',
  'avl bal',
  'transaction alert',
  'txn alert',
  'upi transaction',
  'transaction id',
  'ref no',
  'a c xx',
  'ac xx',
  'net banking',
  'netbanking',
  'credit card statement',
  'minimum amount due',
  'emi is due',
  'kyc update',
  'rekyc',
]);

/**
 * Vendors and back-office paperwork. `invoice`, `gst` and `bill` are whole-message only: a lead
 * absolutely does say "invoice?" meaning "send me one for the shoot".
 */
export const VENDOR_WHOLE_MESSAGE_PHRASES: readonly string[] = Object.freeze([
  'invoice',
  'gst',
  'bill',
  'tds',
  'po',
  'purchase order',
]);

export const VENDOR_PHRASES: readonly string[] = Object.freeze([
  'gst invoice',
  'gst number',
  'gst no',
  'gstin',
  'gst payment',
  'gst filing',
  'gst return',
  'tax invoice',
  'e invoice',
  'einvoice',
  'proforma invoice',
  'raise an invoice',
  'share the invoice',
  'invoice attached',
  'payment request',
  'tds deducted',
  'tds certificate',
  'form 16',
  'pan card number',
  'vendor code',
  'vendor registration',
  'purchase order number',
  'bank details for payment',
  'share your bank details',
  'account number for payment',
]);

/**
 * Bulk marketing. Every phrase here is the language of a broadcast tool, not of a person.
 */
export const MARKETING_WHOLE_MESSAGE_PHRASES: readonly string[] = Object.freeze([]);

export const MARKETING_PHRASES: readonly string[] = Object.freeze([
  'type stop',
  'reply stop',
  'to unsubscribe',
  'unsubscribe',
  'opt out',
  'limited time offer',
  'limited period offer',
  'offer valid till',
  'offer ends',
  'hurry up',
  'buy now',
  'shop now',
  'order now',
  'click here to',
  'claim your',
  'exclusive offer',
  'special discount',
  'flat discount',
  'use coupon',
  'coupon code',
  'promo code',
  'biggest sale',
  'mega sale',
  'flash sale',
  't c apply',
  'terms and conditions apply',
  'this is a promotional message',
  'you have won',
  'congratulations you have',
  'refer and earn',
  'download our app',
  'rate your experience',
  'share your review',
  'share your feedback',
  'valued customer',
]);

/**
 * The furniture of a menu bot, whoever runs it.
 *
 * Matched instead of bank brand names on purpose. A list of "hdfc", "icici", "axis" would be
 * endless, would go stale, and would misfire on "I'll transfer from HDFC" - whereas nobody
 * asking about a wedding has ever written "select from the options below".
 */
/**
 * A whole message that is nothing but hello, thanks, or a nod.
 *
 * WHOLE-MESSAGE ONLY, and that is the entire safety argument: "hi" alone says nothing about
 * wanting a photographer, but "hi, what do you charge for a wedding?" is a lead and must not be
 * swallowed because it opens politely. Matching these as substrings would eat every enquiry that
 * starts with a greeting, which is most of them.
 *
 * Silence here is also cheap to be wrong about. Someone who opens with "hi" and means business
 * says what they want in the next message, and THAT one reaches the AI - automation is never
 * paused, so nothing is lost but a few seconds.
 */
export const PLEASANTRY_WHOLE_MESSAGE_PHRASES: readonly string[] = Object.freeze([
  'hi',
  'hii',
  'hiii',
  'hey',
  'heyy',
  'hello',
  'helo',
  'hi there',
  'hey there',
  'hello there',
  'good morning',
  'good afternoon',
  'good evening',
  'gm',
  'ge',
  'namaste',
  'namaskara',
  'vanakkam',
  'salaam',
  'assalamualaikum',
  'thanks',
  'thank you',
  'thank u',
  'thanx',
  'thx',
  'tq',
  'dhanyavad',
  'ok',
  'okay',
  'okk',
  'k',
  'kk',
  'fine',
  'sure',
  'got it',
  'noted',
  'alright',
  'cool',
  'nice',
  'great',
  'yes',
  'yeah',
  'yep',
  'no',
  'nope',
  'hmm',
  'hmmm',
  'welcome',
  'bye',
  'good night',
  'gn',
  'who is this',
  'whos this',
  'who r u',
  'who are you',
  'whats up',
  'wassup',
  'sup',
]);

export const AUTOMATED_PHRASES: readonly string[] = Object.freeze([
  'select from the options below',
  'choose from the options below',
  'select from the menu',
  'main menu',
  'reply with the option',
  'reply with the number',
  'reply with your option',
  'type the number',
  'this is an automated message',
  'this is a system generated message',
  'system generated',
  'do not reply to this message',
  'please do not reply',
  'no reply',
  'noreply',
  'powered by',
]);

/** Every phrase this module recognises, grouped the way the matcher applies them. */
export const ALL_NON_LEAD_PHRASES: readonly string[] = Object.freeze([
  ...BANKING_WHOLE_MESSAGE_PHRASES,
  ...BANKING_PHRASES,
  ...VENDOR_WHOLE_MESSAGE_PHRASES,
  ...VENDOR_PHRASES,
  ...MARKETING_WHOLE_MESSAGE_PHRASES,
  ...MARKETING_PHRASES,
  ...AUTOMATED_PHRASES,
]);

/**
 * Why automation went quiet, shown in the dashboard exactly as OPT_OUT_PAUSED_REASON is.
 *
 * Written for the owner reading their inbox, not for a log: it has to say what the CRM thought
 * and leave no doubt that turning the switch back on is theirs to do.
 */
export const NON_LEAD_REASONS = Object.freeze({
  BANKING: 'This looks like a bank or OTP message, so the AI did not reply.',
  VENDOR: 'This looks like vendor or billing paperwork, so the AI did not reply.',
  MARKETING: 'This looks like a promotional message, so the AI did not reply.',
  LINK_ONLY: 'This message was only a link, so the AI did not reply.',
  AUTOMATED: 'This looks like an automated message, so the AI did not reply.',
  PLEASANTRY: 'This was a greeting with no enquiry in it, so the AI did not reply.',
});

export type NonLeadReason = (typeof NON_LEAD_REASONS)[keyof typeof NON_LEAD_REASONS];

export interface NonLeadVerdict {
  isNonLead: boolean;
  /** One of NON_LEAD_REASONS when `isNonLead`, otherwise null. */
  reason: string | null;
}

const NOT_A_NON_LEAD: NonLeadVerdict = Object.freeze({ isNonLead: false, reason: null });

/** The two-tier match opt-out.ts and lead-intent.ts both use: equality for short, substring for long. */
const matches = (
  normalized: string,
  wholeMessagePhrases: readonly string[],
  anywherePhrases: readonly string[],
): boolean => {
  if (wholeMessagePhrases.some((phrase) => normalized === normalizeText(phrase))) {
    return true;
  }

  return anywherePhrases.some((phrase) => normalized.includes(normalizeText(phrase)));
};

/**
 * True when the message names the work, asks a price, or asks about a date.
 *
 * Exported because the ingestion path wants to say in its trace WHY a message that tripped a
 * negative rule was let through anyway, and because it is the single most important thing in
 * this module to be able to test on its own.
 */
export const looksLikeSalesEnquiry = (text: unknown): boolean => {
  const normalized = normalizeText(text);

  if (normalized === '') {
    return false;
  }

  if (isQuotationRequest(text) || isAvailabilityQuestion(text)) {
    return true;
  }

  return SERVICE_ENQUIRY_PHRASES.some((phrase) => normalized.includes(normalizeText(phrase)));
};

/**
 * A message that is nothing but a URL.
 *
 * Counted separately from the phrase lists because it is structural, not lexical. The bar is
 * "the words around the link carry no question": a bare forward is noise, but "is this your
 * work? <link>" is a lead pointing at a reference photo, and the word count keeps it.
 */
const isLinkOnly = (text: unknown): boolean => {
  const raw = typeof text === 'string' ? text.trim() : '';

  if (raw === '' || !/https?:\/\/|www\./i.test(raw)) {
    return false;
  }

  const withoutLinks = raw
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/www\.\S+/gi, ' ')
    .trim();

  // Three words of context is enough to be a person saying something. Below that it is a
  // forward, a share card, or an automated notification with a tracking link.
  return normalizeText(withoutLinks).split(' ').filter(Boolean).length < 3;
};

/**
 * Whether this inbound text is obviously not a sales enquiry.
 *
 * Safe for null/undefined/non-string input, which is what a photo or a sticker arrives as - and
 * those return `false`, because media with no caption is already handled further down the path
 * by its own escalation and must not be swallowed here.
 */
export const classifyNonLead = (text: unknown): NonLeadVerdict => {
  const normalized = normalizeText(text);

  if (normalized === '') {
    return NOT_A_NON_LEAD;
  }

  // Defence 1. Nothing below may override a message that reads like an enquiry.
  if (looksLikeSalesEnquiry(text)) {
    return NOT_A_NON_LEAD;
  }

  if (matches(normalized, BANKING_WHOLE_MESSAGE_PHRASES, BANKING_PHRASES)) {
    return { isNonLead: true, reason: NON_LEAD_REASONS.BANKING };
  }

  if (matches(normalized, VENDOR_WHOLE_MESSAGE_PHRASES, VENDOR_PHRASES)) {
    return { isNonLead: true, reason: NON_LEAD_REASONS.VENDOR };
  }

  if (matches(normalized, MARKETING_WHOLE_MESSAGE_PHRASES, MARKETING_PHRASES)) {
    return { isNonLead: true, reason: NON_LEAD_REASONS.MARKETING };
  }

  if (matches(normalized, [], AUTOMATED_PHRASES)) {
    return { isNonLead: true, reason: NON_LEAD_REASONS.AUTOMATED };
  }

  // Whole-message only - see PLEASANTRY_WHOLE_MESSAGE_PHRASES. Deliberately last of the phrase
  // rules so a greeting that also carries a real question has already been let through above.
  if (matches(normalized, PLEASANTRY_WHOLE_MESSAGE_PHRASES, [])) {
    return { isNonLead: true, reason: NON_LEAD_REASONS.PLEASANTRY };
  }

  if (isLinkOnly(text)) {
    return { isNonLead: true, reason: NON_LEAD_REASONS.LINK_ONLY };
  }

  return NOT_A_NON_LEAD;
};

/** Convenience predicate for callers that do not need the reason. */
export const isNonLeadMessage = (text: unknown): boolean => classifyNonLead(text).isNonLead;
