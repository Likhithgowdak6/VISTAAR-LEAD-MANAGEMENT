/**
 * The non-lead filter, which is only worth having if it is wrong in the right direction.
 *
 * The "must remain a lead" block below matters more than the "is a non-lead" one: a message
 * wrongly filtered is a paying customer the AI silently ignores, and nobody finds out. So the
 * real enquiries here are deliberately awkward - they contain `payment`, `invoice`, `offer` and
 * `transfer`, the exact words the negative rules look for.
 *
 * Pure module, no mocks, no env.
 */
import { describe, expect, it } from 'vitest';

import {
  ALL_NON_LEAD_PHRASES,
  classifyNonLead,
  isNonLeadMessage,
  looksLikeSalesEnquiry,
  NON_LEAD_REASONS,
} from './non-lead.js';

describe('classifyNonLead — obvious non-leads', () => {
  it.each([
    ['an OTP', '123456 is your OTP for login. Do not share this OTP with anyone.'],
    ['a bare OTP word', 'OTP'],
    ['a verification code', 'Your verification code is 884920'],
    [
      'a debit alert',
      'Rs.2500.00 has been debited from your A/c XX4471 on 02-10-26. Avl Bal Rs.14,208.22',
    ],
    ['a credit alert', 'INR 15,000 has been credited to your account. Ref No 300926163959'],
    ['a UPI notification', 'UPI transaction of Rs 499 successful. Transaction ID 3009261639591125'],
  ])('flags %s as banking', (_label, text) => {
    expect(classifyNonLead(text)).toEqual({
      isNonLead: true,
      reason: NON_LEAD_REASONS.BANKING,
    });
  });

  it.each([
    // Matched on the menu-bot language, not on the bank's name: a brand list would go stale and
    // would misfire on "I'll transfer from HDFC".
    ['an HDFC-style menu', 'Experience HDFC Bank Differently. Simply select from the options below.'],
    ['a menu footer', 'Reply with the number of your choice or type Main Menu'],
    ['a no-reply notice', 'This is an automated message, please do not reply'],
  ])('flags %s as automated', (_label, text) => {
    expect(classifyNonLead(text)).toEqual({
      isNonLead: true,
      reason: NON_LEAD_REASONS.AUTOMATED,
    });
  });

  it.each([
    ['a GST invoice', 'Please share the GST invoice for last month'],
    ['a GST number request', 'Can you send your GST number'],
    ['a bare invoice', 'Invoice'],
    ['a payment request', 'Payment request for the audio visual set up'],
    ['a bank-details request', 'Share your bank details for payment'],
    ['a TDS note', 'TDS deducted for this quarter, certificate attached'],
  ])('flags %s as vendor paperwork', (_label, text) => {
    expect(classifyNonLead(text)).toEqual({
      isNonLead: true,
      reason: NON_LEAD_REASONS.VENDOR,
    });
  });

  it.each([
    ['an unsubscribe footer', 'Thanks for being a valued customer! Type STOP to Unsubscribe'],
    ['a limited-time offer', 'Today only — limited time offer, flat discount on all plans'],
    ['a review request', 'Could you spare a moment to share your review?'],
    ['a buy-now blast', 'Buy now and save ₹1500. Hurry up, offer ends tonight!'],
    ['a coupon blast', 'Use coupon code SAVE20 at checkout'],
  ])('flags %s as marketing', (_label, text) => {
    expect(classifyNonLead(text)).toEqual({
      isNonLead: true,
      reason: NON_LEAD_REASONS.MARKETING,
    });
  });

  it.each([
    ['a bare link', 'https://example.com/promo/abc123'],
    ['a www link', 'www.example.com/offers'],
    ['a forwarded link with two words', 'check this https://example.com/a/b'],
  ])('flags %s as link-only', (_label, text) => {
    expect(classifyNonLead(text)).toEqual({
      isNonLead: true,
      reason: NON_LEAD_REASONS.LINK_ONLY,
    });
  });
});

describe('classifyNonLead — must remain eligible for the sales flow', () => {
  it.each([
    'wedding shoot price?',
    'how much for pre wedding?',
    'are you available in December?',
    'need photography and videography for wedding',
    'Price?',
    'kitna hoga bhai',
    '12 tarikh ko free ho?',
    'Hi, I need a photographer for my sister’s reception in Jayanagar',
    'do you do drone coverage for haldi and mehendi',
    'Baby shower shoot ke liye rate kya hai?',
  ])('leaves %j alone', (text) => {
    expect(classifyNonLead(text)).toEqual({ isNonLead: false, reason: null });
  });

  it.each([
    // The whole point of the positive override: every one of these trips a negative rule.
    ["wedding shoot price, I'll transfer payment today", 'payment'],
    ['Invoice for the wedding shoot?', 'invoice'],
    ['do you have any offer on wedding packages', 'offer'],
    ['can you share the GST invoice for the wedding shoot', 'gst invoice'],
    ['send me your bank details for payment, booking the shoot today', 'bank details for payment'],
  ])('keeps %j even though it contains %j', (text) => {
    expect(classifyNonLead(text).isNonLead).toBe(false);
  });

  it('keeps a link when the lead wrote a real question around it', () => {
    expect(
      classifyNonLead('hi is this the kind of album you make https://example.com/x').isNonLead,
    ).toBe(false);
  });
});

describe('classifyNonLead — input safety', () => {
  it.each([[null], [undefined], [''], ['   '], [42], [{}]])(
    'returns a clean verdict for %j',
    (value) => {
      expect(classifyNonLead(value)).toEqual({ isNonLead: false, reason: null });
    },
  );

  it('never flags media with no caption, which has its own escalation downstream', () => {
    // An uncaptioned photo reaches ingestion as an empty body. Swallowing it here would skip
    // the escalate-to-owner path ai-brain.service already runs for exactly this case.
    expect(isNonLeadMessage('')).toBe(false);
  });
});

describe('looksLikeSalesEnquiry', () => {
  it('recognises price and availability through lead-intent', () => {
    expect(looksLikeSalesEnquiry('how much')).toBe(true);
    expect(looksLikeSalesEnquiry('are you available on 12th')).toBe(true);
  });

  it('recognises the work by name', () => {
    expect(looksLikeSalesEnquiry('need a videographer')).toBe(true);
    expect(looksLikeSalesEnquiry('sangeet coverage')).toBe(true);
  });

  it('does not fire on an ordinary non-enquiry', () => {
    expect(looksLikeSalesEnquiry('ok thanks')).toBe(false);
    expect(looksLikeSalesEnquiry('Gst payment done.')).toBe(false);
  });
});

describe('the phrase lists themselves', () => {
  it('are normalised consistently, so no phrase can never match', () => {
    // A phrase with punctuation or capitals would be compared against normalised text and never
    // fire. Cheap guard against a future edit adding "T&C apply".
    ALL_NON_LEAD_PHRASES.forEach((phrase) => {
      expect(phrase).toBe(phrase.toLowerCase());
      expect(phrase).not.toMatch(/[^a-z0-9 ]/);
    });
  });

  it('contains no phrase that would swallow an ordinary enquiry word', () => {
    // `shoot`, `wedding`, `price` and `date` must never appear as negative triggers.
    const forbidden = ['shoot', 'wedding', 'price', 'date', 'photo', 'event'];

    ALL_NON_LEAD_PHRASES.forEach((phrase) => {
      forbidden.forEach((word) => {
        expect(phrase.split(' ')).not.toContain(word);
      });
    });
  });
});
