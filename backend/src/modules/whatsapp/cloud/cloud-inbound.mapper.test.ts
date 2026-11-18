/**
 * Meta's webhook payload, turned into the CRM's own message shape.
 *
 * Everything here is a pure function over untrusted input, so the tests are mostly about what the
 * mapper REFUSES: a payload for the wrong product, a message with no id, a media node with no
 * file behind it. The one that matters most is the `object` check — both the Lead Ads webhook and
 * this one are Meta deliveries over the same HMAC, and without it a misconfigured Meta console
 * would file a lead form submission into somebody's inbox as a WhatsApp message.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' },
}));

const {
  extractCloudChangeValues,
  normalizeCloudMessage,
  normalizeCloudStatuses,
  readCloudPhoneNumberId,
} = await import('./cloud-inbound.mapper.js');
const { MESSAGE_TYPES } = await import('../../../constants/message-types.js');

const value = (overrides: Record<string, unknown> = {}) => ({
  messaging_product: 'whatsapp',
  metadata: { display_phone_number: '+91 90000 00000', phone_number_id: '109876543210987' },
  contacts: [{ profile: { name: 'Riya Sharma' }, wa_id: '919876543210' }],
  ...overrides,
});

const body = (overrides: Record<string, unknown> = {}) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: '102233445566778', changes: [{ field: 'messages', value: value(overrides) }] }],
});

const textMessage = (overrides: Record<string, unknown> = {}) => ({
  from: '919876543210',
  id: 'wamid.ABC',
  timestamp: '1763424000',
  type: 'text',
  text: { body: 'Is the venue free on the 12th?' },
  ...overrides,
});

describe('extractCloudChangeValues', () => {
  it('flattens entries and changes into one list', () => {
    const values = extractCloudChangeValues({
      object: 'whatsapp_business_account',
      entry: [
        { changes: [{ field: 'messages', value: value() }, { field: 'messages', value: value() }] },
        { changes: [{ field: 'messages', value: value() }] },
      ],
    });

    expect(values).toHaveLength(3);
  });

  /**
   * THE tenancy guard against cross-product confusion. `page` is the Lead Ads webhook's object.
   */
  it('ignores a payload that is not for a WhatsApp Business Account', () => {
    expect(extractCloudChangeValues({ ...body(), object: 'page' })).toEqual([]);
  });

  it('ignores a change whose field is not messages', () => {
    expect(
      extractCloudChangeValues({
        object: 'whatsapp_business_account',
        entry: [{ changes: [{ field: 'account_update', value: value() }] }],
      }),
    ).toEqual([]);
  });

  it.each([null, undefined, {}, { object: 'whatsapp_business_account' }, 'nonsense'])(
    'returns nothing for %s rather than throwing',
    (input) => {
      expect(extractCloudChangeValues(input)).toEqual([]);
    },
  );
});

describe('readCloudPhoneNumberId', () => {
  it('reads the only tenant identifier Meta sends', () => {
    expect(readCloudPhoneNumberId(value())).toBe('109876543210987');
  });

  it('returns null when the metadata is missing', () => {
    expect(readCloudPhoneNumberId({} as never)).toBeNull();
  });
});

describe('normalizeCloudMessage', () => {
  it('normalizes a text message', () => {
    const normalized = normalizeCloudMessage({ value: value(), message: textMessage() });

    expect(normalized).toMatchObject({
      provider: 'cloud',
      normalized: true,
      messageId: 'wamid.ABC',
      remoteJid: '919876543210@s.whatsapp.net',
      senderJid: '919876543210@s.whatsapp.net',
      pushName: 'Riya Sharma',
      text: 'Is the venue free on the 12th?',
      messageType: MESSAGE_TYPES.TEXT,
      media: null,
    });
  });

  /**
   * Cloud API never echoes the business's own sends back as inbound, unlike Baileys. Set
   * explicitly rather than left undefined so the echo guard downstream reads a fact.
   */
  it('always reports fromMe as false', () => {
    expect(normalizeCloudMessage({ value: value(), message: textMessage() })?.fromMe).toBe(false);
  });

  it('parses Meta’s string timestamp into a Date', () => {
    const normalized = normalizeCloudMessage({ value: value(), message: textMessage() });

    expect(normalized?.timestamp).toBeInstanceOf(Date);
    expect((normalized?.timestamp as Date).toISOString()).toBe('2025-11-18T00:00:00.000Z');
  });

  it('falls back to now on a malformed timestamp rather than producing an invalid date', () => {
    const normalized = normalizeCloudMessage({
      value: value(),
      message: textMessage({ timestamp: 'not-a-number' }),
    });

    expect(Number.isNaN((normalized?.timestamp as Date).getTime())).toBe(false);
  });

  it.each([
    ['no sender', { id: 'wamid.X', timestamp: '1', type: 'text', text: { body: 'hi' } }],
    ['no message id', { from: '91987', timestamp: '1', type: 'text', text: { body: 'hi' } }],
  ])('returns null for a message with %s', (_label, message) => {
    // Nothing useful to file, and a message with no id cannot be deduplicated - so filing it
    // would double on Meta's first retry.
    expect(normalizeCloudMessage({ value: value(), message })).toBeNull();
  });

  it('reads the profile name only for the matching wa_id', () => {
    const normalized = normalizeCloudMessage({
      value: value({ contacts: [{ profile: { name: 'Someone Else' }, wa_id: '910000000000' }] }),
      message: textMessage(),
    });

    expect(normalized?.pushName).toBeNull();
  });

  describe('media', () => {
    it('reads image metadata and strips mime parameters', () => {
      const normalized = normalizeCloudMessage({
        value: value(),
        message: textMessage({
          type: 'image',
          text: undefined,
          image: { id: 'media-1', mime_type: 'image/jpeg', caption: 'The hall' },
        }),
      });

      expect(normalized?.messageType).toBe(MESSAGE_TYPES.IMAGE);
      expect(normalized?.media).toEqual({
        mimeType: 'image/jpeg',
        fileName: null,
        sizeBytes: null,
        isVoiceNote: false,
      });
      // A caption is the lead's own words and belongs in the thread.
      expect(normalized?.text).toBe('The hall');
    });

    it('drops the codec parameter Meta sends on voice notes', () => {
      const normalized = normalizeCloudMessage({
        value: value(),
        message: textMessage({
          type: 'audio',
          text: undefined,
          audio: { id: 'media-2', mime_type: 'audio/ogg; codecs=opus', voice: true },
        }),
      });

      expect(normalized?.media?.mimeType).toBe('audio/ogg');
      // Meta's own flag, unlike Baileys where it has to be inferred from the codec.
      expect(normalized?.media?.isVoiceNote).toBe(true);
    });

    it('attaches a download closure only when one was supplied', () => {
      const downloadMedia = vi.fn().mockResolvedValue(Buffer.from('x'));

      const withDownload = normalizeCloudMessage({
        value: value(),
        message: textMessage({ type: 'image', text: undefined, image: { id: 'media-1' } }),
        downloadMedia,
      });

      const withoutDownload = normalizeCloudMessage({
        value: value(),
        message: textMessage({ type: 'image', text: undefined, image: { id: 'media-1' } }),
      });

      expect(typeof withDownload?.downloadMedia).toBe('function');
      // Absent is the signal ingestion already reads to file a media message by metadata alone.
      expect(withoutDownload?.downloadMedia).toBeUndefined();
    });

    it('passes the right media id to the download closure', async () => {
      const downloadMedia = vi.fn().mockResolvedValue(Buffer.from('x'));

      const normalized = normalizeCloudMessage({
        value: value(),
        message: textMessage({ type: 'document', text: undefined, document: { id: 'media-9' } }),
        downloadMedia,
      });

      await normalized?.downloadMedia?.();

      expect(downloadMedia).toHaveBeenCalledWith('media-9');
    });

    it('treats a media node with no id as a message with no media', () => {
      const normalized = normalizeCloudMessage({
        value: value(),
        message: textMessage({ type: 'image', text: undefined, image: { mime_type: 'image/jpeg' } }),
      });

      expect(normalized?.media).toBeNull();
    });
  });

  describe('interactive replies', () => {
    it('files a button reply as text, keeping what the lead chose', () => {
      const normalized = normalizeCloudMessage({
        value: value(),
        message: textMessage({ type: 'button', text: undefined, button: { text: 'Yes, call me' } }),
      });

      expect(normalized?.messageType).toBe(MESSAGE_TYPES.TEXT);
      expect(normalized?.text).toBe('Yes, call me');
    });

    it('reads a list reply title', () => {
      const normalized = normalizeCloudMessage({
        value: value(),
        message: textMessage({
          type: 'interactive',
          text: undefined,
          interactive: { list_reply: { title: 'Weekend package' } },
        }),
      });

      expect(normalized?.text).toBe('Weekend package');
    });
  });

  it('maps an unknown Meta type to unsupported rather than guessing', () => {
    const normalized = normalizeCloudMessage({
      value: value(),
      message: textMessage({ type: 'order', text: undefined }),
    });

    expect(normalized?.messageType).toBe(MESSAGE_TYPES.UNSUPPORTED);
  });
});

describe('normalizeCloudStatuses', () => {
  it('normalizes a delivery receipt', () => {
    const statuses = normalizeCloudStatuses(
      value({
        statuses: [{ id: 'wamid.ABC', status: 'delivered', timestamp: '1763424000' }],
      }) as never,
    );

    expect(statuses).toEqual([
      {
        providerMessageId: 'wamid.ABC',
        status: 'delivered',
        timestamp: new Date('2025-11-18T00:00:00.000Z'),
        errorCode: null,
      },
    ]);
  });

  /**
   * The only place Meta reports a send that was accepted at the API and refused afterwards. The
   * code distinguishes "this customer blocked you" from "the window shut while it was queued".
   */
  it('keeps the error code off a failed receipt', () => {
    const statuses = normalizeCloudStatuses(
      value({
        statuses: [
          { id: 'wamid.ABC', status: 'failed', timestamp: '1', errors: [{ code: 131047 }] },
        ],
      }) as never,
    );

    expect(statuses[0]).toMatchObject({ status: 'failed', errorCode: 131047 });
  });

  it('ignores a status value it does not recognize', () => {
    expect(
      normalizeCloudStatuses(
        value({ statuses: [{ id: 'wamid.ABC', status: 'teleported', timestamp: '1' }] }) as never,
      ),
    ).toEqual([]);
  });

  it('returns nothing when there are no statuses', () => {
    expect(normalizeCloudStatuses(value() as never)).toEqual([]);
  });
});
