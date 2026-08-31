/**
 * Exercises the two behavioural predicates that feed lead scoring: the phrasings an English- and
 * a Hinglish-typing lead in Bangalore actually uses must match, the near-misses that read like
 * them must not, and neither may throw on the empty/absent text an image-only message arrives as.
 *
 * Pure module, nothing mocked - same shape as opt-out.test.ts next door.
 */
import { describe, expect, it } from 'vitest';

import {
  ALL_AVAILABILITY_PHRASES,
  ALL_QUOTATION_PHRASES,
  isAvailabilityQuestion,
  isQuotationRequest,
  QUOTATION_WHOLE_MESSAGE_PHRASES,
} from './lead-intent.js';

describe('isQuotationRequest - English', () => {
  it.each([
    'how much',
    'How much?',
    'how much for a wedding shoot?',
    "what's the price for two days",
    'what is the cost of the candid package',
    'Please send me a quote',
    'can you send a quotation for the reception',
    'I need a quote for 12th December',
    'do you have a price list?',
    'share your rate card please',
    'what are your charges',
    'Price',
    'RATE?',
    'Quotation.',
    'costs',
  ])('reads %j as asking for a price', (text) => {
    expect(isQuotationRequest(text)).toBe(true);
  });
});

describe('isQuotationRequest - Hinglish', () => {
  it.each([
    'kitna hoga bhai',
    'Kitne ka padega?',
    'kitna lagega for 1 day',
    'price kya hai aapka',
    'rate batao',
    'quotation bhej dijiye',
    'kitna charge karte ho',
    'kitna',
    'daam?',
  ])('reads %j as asking for a price', (text) => {
    expect(isQuotationRequest(text)).toBe(true);
  });
});

describe('isQuotationRequest - near misses', () => {
  it.each([
    'grateful for the quick reply',
    'we will decorate the hall ourselves',
    'the costume change happens at 7pm',
    'my brother rates you very highly',
    'we loved the quotes on your website',
    'can you come at 4pm',
    'how many photographers will come?',
    'ok thanks, see you at the venue',
    'the venue is confirmed, Taj MG Road',
    'yes please go ahead',
  ])('does not read %j as asking for a price', (text) => {
    expect(isQuotationRequest(text)).toBe(false);
  });

  it('never lets a bare single word count mid-sentence', () => {
    // The whole-message list is whole-message-only, exactly like opt-out.ts's. Only the
    // single-word entries are checked here: a multi-word entry like "kitne ka hai" contains
    // "kitne ka", which is on the long list and is meant to match anywhere.
    const singleWords = QUOTATION_WHOLE_MESSAGE_PHRASES.filter((phrase) => !phrase.includes(' '));

    expect(singleWords.length).toBeGreaterThan(5);

    for (const phrase of singleWords) {
      expect(isQuotationRequest(`we already discussed the ${phrase} with your team last week`)).toBe(
        false,
      );
    }
  });
});

describe('isAvailabilityQuestion - English', () => {
  it.each([
    'are you free on the 12th',
    'Are you available?',
    'is that date available',
    'is the date available for a morning shoot',
    'do you have availability in December',
    'just checking availability for 4 Nov',
    'are you booked that weekend?',
    'is the 12th still available',
    'available',
    'availability',
    'free?',
  ])('reads %j as an availability question', (text) => {
    expect(isAvailabilityQuestion(text)).toBe(true);
  });
});

describe('isAvailabilityQuestion - Hinglish', () => {
  it.each([
    '12 tarikh ko free ho?',
    'us din available ho kya',
    'aap us din free ho na',
    'date khali hai aapki?',
    'khali ho 3rd ko',
    'booking available hai',
    'khali',
  ])('reads %j as an availability question', (text) => {
    expect(isAvailabilityQuestion(text)).toBe(true);
  });
});

describe('isAvailabilityQuestion - near misses', () => {
  it.each([
    'the parking is free at the venue',
    'we are freeing up the hall by 9pm',
    'feel free to call me anytime',
    'the album booklet was lovely',
    'we booked the caterer already',
    'how many hours will you shoot',
    'thanks, that works',
  ])('does not read %j as an availability question', (text) => {
    expect(isAvailabilityQuestion(text)).toBe(false);
  });
});

describe('both predicates - empty and non-string input', () => {
  it.each([null, undefined, '', '   ', 42, {}, [], true])(
    'answers false rather than throwing for %j',
    (text) => {
      expect(isQuotationRequest(text)).toBe(false);
      expect(isAvailabilityQuestion(text)).toBe(false);
    },
  );

  it('is unbothered by emoji and punctuation around the phrase', () => {
    expect(isQuotationRequest('How much?? 🙏🙏')).toBe(true);
    expect(isAvailabilityQuestion('Are you available??! 🤔')).toBe(true);
  });
});

describe('the phrase lists', () => {
  it('recognises every quotation phrase it publishes', () => {
    for (const phrase of ALL_QUOTATION_PHRASES) {
      expect(isQuotationRequest(phrase)).toBe(true);
    }
  });

  it('recognises every availability phrase it publishes', () => {
    for (const phrase of ALL_AVAILABILITY_PHRASES) {
      expect(isAvailabilityQuestion(phrase)).toBe(true);
    }
  });

  it('keeps the two apart - a price question is not an availability question', () => {
    expect(isAvailabilityQuestion('how much for a wedding shoot')).toBe(false);
    expect(isQuotationRequest('are you free on the 12th')).toBe(false);
  });
});
