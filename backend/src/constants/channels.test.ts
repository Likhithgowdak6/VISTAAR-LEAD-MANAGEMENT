/**
 * The compatibility rule that keeps every pre-existing conversation visible.
 *
 * THE FAILURE THIS GUARDS AGAINST IS TOTAL AND SILENT. Every conversation written before the
 * `channel` field existed has no channel at all, and there are far more of those than there will
 * ever be Instagram threads. An inbox that filters on `{channel: 'whatsapp'}` matches none of
 * them — so the symptom is an empty inbox on a working database, which reads as data loss.
 *
 * So `channelOf` resolves absent to WhatsApp, and `WHATSAPP_CHANNEL_FILTER` matches null as well
 * as the literal value. Both are tested here rather than trusted.
 */

import { describe, expect, it } from 'vitest';

import {
  CONVERSATION_CHANNELS,
  CONVERSATION_CHANNEL_VALUES,
  INSTAGRAM_HUMAN_AGENT_WINDOW_MS,
  INSTAGRAM_SERVICE_WINDOW_MS,
  WHATSAPP_CHANNEL_FILTER,
  channelOf,
  isInstagram,
  isInstagramWindowOpen,
} from './channels.js';

describe('reading the channel of a conversation', () => {
  it('reads a conversation written before the field existed as WhatsApp', () => {
    // The whole point. These are all WhatsApp, and there are a lot of them.
    expect(channelOf({})).toBe(CONVERSATION_CHANNELS.WHATSAPP);
  });

  it('reads an explicit null as WhatsApp', () => {
    expect(channelOf({ channel: null })).toBe(CONVERSATION_CHANNELS.WHATSAPP);
  });

  it('reads a missing conversation as WhatsApp rather than throwing', () => {
    expect(channelOf(null)).toBe(CONVERSATION_CHANNELS.WHATSAPP);
    expect(channelOf(undefined)).toBe(CONVERSATION_CHANNELS.WHATSAPP);
  });

  it('reads an explicit whatsapp as WhatsApp', () => {
    expect(channelOf({ channel: 'whatsapp' })).toBe(CONVERSATION_CHANNELS.WHATSAPP);
  });

  it('reads instagram as Instagram', () => {
    expect(channelOf({ channel: 'instagram' })).toBe(CONVERSATION_CHANNELS.INSTAGRAM);
  });

  it('reads an unknown channel as WhatsApp rather than hiding the thread', () => {
    /**
     * A value this build does not recognise is far more likely to be a newer deployment's channel
     * seen during a rolling restart than a corruption. Showing such a thread as WhatsApp is a
     * cosmetic error; hiding it is a lost customer message.
     */
    expect(channelOf({ channel: 'telegram' })).toBe(CONVERSATION_CHANNELS.WHATSAPP);
    expect(channelOf({ channel: 42 })).toBe(CONVERSATION_CHANNELS.WHATSAPP);
  });

  it('only treats an exact instagram value as Instagram', () => {
    // A near-miss must not route a WhatsApp thread into the Instagram sender.
    expect(isInstagram({ channel: 'Instagram' })).toBe(false);
    expect(isInstagram({ channel: 'instagram ' })).toBe(false);
    expect(isInstagram({ channel: 'instagram' })).toBe(true);
  });
});

describe('the WhatsApp filter', () => {
  it('matches null as well as the literal value', () => {
    // `{channel: 'whatsapp'}` alone matches none of the historical data.
    expect(WHATSAPP_CHANNEL_FILTER).toEqual({
      channel: { $in: ['whatsapp', null] },
    });
  });

  it('includes null in the list, not just the value', () => {
    expect(WHATSAPP_CHANNEL_FILTER.channel.$in).toContain(null);
  });
});

describe('the channel enum', () => {
  it('carries both channels for the schema', () => {
    expect([...CONVERSATION_CHANNEL_VALUES].sort()).toEqual(['instagram', 'whatsapp']);
  });
});

describe('the Instagram messaging window', () => {
  const now = new Date('2026-11-24T12:00:00.000Z');
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1000);

  it('is twenty-four hours from the customer\'s last message', () => {
    expect(INSTAGRAM_SERVICE_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
    expect(isInstagramWindowOpen({ lastInboundAt: hoursAgo(23), now })).toBe(true);
    expect(isInstagramWindowOpen({ lastInboundAt: hoursAgo(25), now })).toBe(false);
  });

  it('extends to seven days for a human agent', () => {
    // The one tag that applies to a person answering a customer.
    expect(INSTAGRAM_HUMAN_AGENT_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(isInstagramWindowOpen({ lastInboundAt: hoursAgo(100), now, humanAgent: true })).toBe(
      true,
    );
    expect(isInstagramWindowOpen({ lastInboundAt: hoursAgo(200), now, humanAgent: true })).toBe(
      false,
    );
  });

  it('is closed when the customer has never written', () => {
    // Instagram has no template to open a conversation with. Never-contacted means never.
    expect(isInstagramWindowOpen({ lastInboundAt: null, now })).toBe(false);
  });

  it('is closed for an unparseable timestamp', () => {
    // Treating it as closed costs a refused send; treating it as open costs a message the agent
    // believed had gone.
    expect(isInstagramWindowOpen({ lastInboundAt: 'not-a-date', now })).toBe(false);
  });

  it('is its own constant, not shared with WhatsApp', async () => {
    /**
     * The two are the same number today and are set by different Meta policies. Sharing one
     * constant would mean a change to either silently moving the other.
     */
    const whatsapp = await import('./whatsapp-providers.js');

    expect(INSTAGRAM_SERVICE_WINDOW_MS).toBe(whatsapp.CLOUD_SERVICE_WINDOW_MS);
    expect(INSTAGRAM_SERVICE_WINDOW_MS).not.toBe(INSTAGRAM_HUMAN_AGENT_WINDOW_MS);
  });
});
