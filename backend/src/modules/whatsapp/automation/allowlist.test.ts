/**
 * The test-phase number allowlist, in both directions. The inbound half is what keeps a
 * personal number's real chats out of the dashboard while testing, so its fail-closed
 * behaviour on an unreadable JID is the important case here, not an edge case.
 */
import { describe, expect, it } from 'vitest';

import {
  createNumberAllowlist,
  parseTestAllowedNumbers,
  phoneDigitsFromJid,
} from './allowlist.js';

describe('parseTestAllowedNumbers', () => {
  it('splits a CSV and keeps only digits', () => {
    expect([...parseTestAllowedNumbers('8183003081, +91 98765-43210')]).toEqual([
      '8183003081',
      '919876543210',
    ]);
  });

  it('is empty for an empty or junk-only string', () => {
    expect(parseTestAllowedNumbers('').size).toBe(0);
    expect(parseTestAllowedNumbers(' , , ').size).toBe(0);
  });
});

describe('phoneDigitsFromJid', () => {
  it('reads the number out of a normal WhatsApp JID', () => {
    expect(phoneDigitsFromJid('918183003081@s.whatsapp.net')).toBe('918183003081');
  });

  it('strips the device suffix', () => {
    expect(phoneDigitsFromJid('918183003081:12@s.whatsapp.net')).toBe('918183003081');
  });

  it('returns nothing for a @lid, whose digits are an opaque id and not a phone', () => {
    expect(phoneDigitsFromJid('123456789012345@lid')).toBe('');
  });

  it('returns nothing for empty or non-string input', () => {
    expect(phoneDigitsFromJid('')).toBe('');
    expect(phoneDigitsFromJid(null)).toBe('');
    expect(phoneDigitsFromJid(undefined)).toBe('');
  });
});

describe('createNumberAllowlist - inactive (production default)', () => {
  const allowlist = createNumberAllowlist('');

  it('reports itself inactive', () => {
    expect(allowlist.active).toBe(false);
  });

  it('permits every recipient', () => {
    expect(allowlist.permits('919999999999')).toBe(true);
  });

  it('permits every inbound sender, including an unreadable @lid', () => {
    expect(allowlist.permitsInboundJid('919999999999@s.whatsapp.net')).toBe(true);
    expect(allowlist.permitsInboundJid('123@lid')).toBe(true);
    expect(allowlist.permitsInboundJid(null, undefined)).toBe(true);
  });
});

describe('createNumberAllowlist - active (test mode)', () => {
  const allowlist = createNumberAllowlist('8183003081');

  it('reports itself active', () => {
    expect(allowlist.active).toBe(true);
  });

  it('permits the allowed recipient and refuses everyone else', () => {
    expect(allowlist.permits('8183003081')).toBe(true);
    expect(allowlist.permits('919999999999')).toBe(false);
  });

  it('matches the country-coded form WhatsApp actually delivers', () => {
    expect(allowlist.permits('918183003081')).toBe(true);
    expect(allowlist.permitsInboundJid('918183003081@s.whatsapp.net')).toBe(true);
  });

  it('refuses an inbound message from any other number', () => {
    expect(allowlist.permitsInboundJid('919876543210@s.whatsapp.net')).toBe(false);
  });

  it('fails closed on a JID carrying no readable phone', () => {
    expect(allowlist.permitsInboundJid('123456789012345@lid')).toBe(false);
    expect(allowlist.permitsInboundJid(null, undefined, '')).toBe(false);
  });

  it('accepts when any one of the candidate JIDs matches', () => {
    // The resolved phone JID is checked alongside the raw @lid sender.
    expect(
      allowlist.permitsInboundJid('918183003081@s.whatsapp.net', '123456789012345@lid'),
    ).toBe(true);
  });

  it('permits a send addressed to an opaque @lid when the contact phone is allowed', () => {
    // The real regression: resolveRecipient prefers the stored providerJid, which is usually a
    // `<id>@lid`. Reading that id's digits as a phone blocked the allowed test number outright.
    expect(allowlist.permits('123456789012345@lid', '918183003081')).toBe(true);
  });

  it('still refuses a @lid send when the contact phone is not allowed', () => {
    expect(allowlist.permits('123456789012345@lid', '919876543210')).toBe(false);
  });

  it('refuses a @lid send when no phone is known for the contact', () => {
    expect(allowlist.permits('123456789012345@lid', null)).toBe(false);
  });

  it('permits a plain phone-JID recipient', () => {
    expect(allowlist.permits('918183003081@s.whatsapp.net', null)).toBe(true);
  });

  it('does not let a short allowlist entry match unrelated numbers by suffix', () => {
    const short = createNumberAllowlist('081');

    expect(short.permits('918183003081')).toBe(false);
    expect(short.permits('081')).toBe(true);
  });
});
