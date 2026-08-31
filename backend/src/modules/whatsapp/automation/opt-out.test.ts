/**
 * Exercises opt-out detection. Two halves matter equally: every phrase a real lead types must be
 * recognised, and the near-misses that share those words must NOT be - a false positive silently
 * mutes a paying customer, which is far more expensive than one extra follow-up. Pure module, so
 * nothing is mocked here.
 */
import { describe, expect, it } from 'vitest';

import {
  ALL_OPT_OUT_PHRASES,
  isOptOutRequest,
  normalizeOptOutText,
  OPT_OUT_PHRASES,
  OPT_OUT_WHOLE_MESSAGE_PHRASES,
} from './opt-out.js';

describe('isOptOutRequest - every listed phrase', () => {
  it.each([...ALL_OPT_OUT_PHRASES])('matches "%s" as a whole message', (phrase) => {
    expect(isOptOutRequest(phrase)).toBe(true);
  });

  it.each([...ALL_OPT_OUT_PHRASES])('matches "%s" whatever the case', (phrase) => {
    expect(isOptOutRequest(phrase.toUpperCase())).toBe(true);
  });

  it.each([...ALL_OPT_OUT_PHRASES])(
    'matches "%s" with surrounding punctuation and whitespace',
    (phrase) => {
      expect(isOptOutRequest(`  ${phrase}!!  `)).toBe(true);
    },
  );

  it('covers the English and Hindi/Hinglish wording an Indian customer actually types', () => {
    for (const phrase of [
      'stop',
      'unsubscribe',
      'remove me',
      "don't message me",
      'do not message me',
      'leave me alone',
      'not interested',
      'band karo',
      'mat bhejo',
      'mujhe nahi chahiye',
      'nahi chahiye',
    ]) {
      expect(isOptOutRequest(phrase)).toBe(true);
    }
  });

  it('tolerates a trailing emoji, which is how people soften a refusal', () => {
    expect(isOptOutRequest('stop 🙏')).toBe(true);
    expect(isOptOutRequest('Not interested. 🙂')).toBe(true);
  });
});

describe('isOptOutRequest - long phrases inside a longer sentence', () => {
  it.each([...OPT_OUT_PHRASES])('matches "%s" mid-sentence', (phrase) => {
    expect(isOptOutRequest(`hi there please ${phrase} thanks`)).toBe(true);
  });

  it('reads a real sentence asking to be left alone', () => {
    expect(isOptOutRequest('Hi, please do not message me again, thanks.')).toBe(true);
    expect(isOptOutRequest('bhai band karo ye messages')).toBe(true);
  });
});

describe('isOptOutRequest - false positives that must not fire', () => {
  it('does not treat "stop" inside a sentence as an opt-out', () => {
    expect(isOptOutRequest("don't stop sending me updates")).toBe(false);
    expect(isOptOutRequest('we can stop by the venue at 4')).toBe(false);
    expect(isOptOutRequest('the shoot will stop around 9pm')).toBe(false);
  });

  it('does not fire on an ordinary "not interested in X" aside', () => {
    expect(isOptOutRequest('I am not interested in drone shots, just stills please')).toBe(false);
  });

  it('does not fire on a normal enquiry', () => {
    expect(isOptOutRequest('Hi, do you shoot house-warmings in Pune?')).toBe(false);
    expect(isOptOutRequest('Please send me the wedding package rates')).toBe(false);
  });

  it('keeps every whole-message-only phrase whole-message-only', () => {
    for (const phrase of OPT_OUT_WHOLE_MESSAGE_PHRASES) {
      expect(isOptOutRequest(`I was wondering whether ${phrase} works for the album`)).toBe(false);
    }
  });
});

describe('isOptOutRequest - empty and non-string input', () => {
  it('is safe for nothing at all, which is what a photo arrives as', () => {
    expect(isOptOutRequest('')).toBe(false);
    expect(isOptOutRequest('   ')).toBe(false);
    expect(isOptOutRequest(null)).toBe(false);
    expect(isOptOutRequest(undefined)).toBe(false);
    expect(isOptOutRequest(42)).toBe(false);
    expect(isOptOutRequest({})).toBe(false);
  });

  it('is safe for punctuation-only and emoji-only messages', () => {
    expect(isOptOutRequest('!!!')).toBe(false);
    expect(isOptOutRequest('👍')).toBe(false);
  });
});

describe('normalizeOptOutText', () => {
  it('folds case, punctuation, apostrophes and whitespace onto one comparable form', () => {
    expect(normalizeOptOutText("  DON'T   Message  Me!! ")).toBe('dont message me');
    expect(normalizeOptOutText('Stop.')).toBe('stop');
  });

  it('returns an empty string for anything that is not a string', () => {
    expect(normalizeOptOutText(null)).toBe('');
    expect(normalizeOptOutText(7)).toBe('');
  });
});
