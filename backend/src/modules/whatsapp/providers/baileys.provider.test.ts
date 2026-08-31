/**
 * Exercises the pure inbound-message helpers in baileys.provider.ts: which raw Baileys messages
 * get dropped before normalization, what normalizeBaileysInboundMessage sets for
 * fromMe/isSelfChat given the linked account's own JID, and how each media payload maps onto the
 * CRM's own message types and metadata (without anything ever being downloaded).
 */
import { describe, expect, it } from 'vitest';

import { MESSAGE_TYPES } from '../../../constants/message-types.js';
import {
  extractBaileysMedia,
  isSelfChatJid,
  normalizeBaileysInboundMessage,
  resolveBaileysMessageType,
  shouldIgnoreBaileysInboundMessage,
} from './baileys.provider.js';

const textMessage = (text = 'hi') => ({
  conversation: text,
});

describe('shouldIgnoreBaileysInboundMessage', () => {
  it('no longer drops a fromMe message', () => {
    expect(
      shouldIgnoreBaileysInboundMessage({
        key: { id: 'm1', remoteJid: '911234567890@s.whatsapp.net', fromMe: true },
        message: textMessage(),
      }),
    ).toBe(false);
  });

  it('still drops a message with no message payload', () => {
    expect(
      shouldIgnoreBaileysInboundMessage({
        key: { id: 'm1', remoteJid: '911234567890@s.whatsapp.net', fromMe: false },
      }),
    ).toBe(true);
  });

  it('still drops a message with no remoteJid', () => {
    expect(
      shouldIgnoreBaileysInboundMessage({
        key: { id: 'm1', fromMe: false },
        message: textMessage(),
      }),
    ).toBe(true);
  });

  it('still drops a group message', () => {
    expect(
      shouldIgnoreBaileysInboundMessage({
        key: { id: 'm1', remoteJid: '123456-789@g.us', fromMe: false },
        message: textMessage(),
      }),
    ).toBe(true);
  });

  it('still drops the status broadcast pseudo-chat', () => {
    expect(
      shouldIgnoreBaileysInboundMessage({
        key: { id: 'm1', remoteJid: 'status@broadcast', fromMe: false },
        message: textMessage(),
      }),
    ).toBe(true);
  });

  it('drops a WhatsApp Channel post - a followed news/job feed is not a lead', () => {
    expect(
      shouldIgnoreBaileysInboundMessage({
        key: { id: 'm1', remoteJid: '120363000000000000@newsletter', fromMe: false },
        message: textMessage(),
      }),
    ).toBe(true);
  });

  it('drops broadcast-list traffic', () => {
    expect(
      shouldIgnoreBaileysInboundMessage({
        key: { id: 'm1', remoteJid: '1234567890@broadcast', fromMe: false },
        message: textMessage(),
      }),
    ).toBe(true);
  });

  it('does not drop a normal inbound lead message', () => {
    expect(
      shouldIgnoreBaileysInboundMessage({
        key: { id: 'm1', remoteJid: '911234567890@s.whatsapp.net', fromMe: false },
        message: textMessage(),
      }),
    ).toBe(false);
  });
});

describe('isSelfChatJid', () => {
  it('matches bare-number JIDs regardless of device suffix', () => {
    expect(isSelfChatJid('911234567890:5@s.whatsapp.net', '911234567890@s.whatsapp.net')).toBe(
      true,
    );
  });

  it('does not match a different number', () => {
    expect(isSelfChatJid('919999999999@s.whatsapp.net', '911234567890@s.whatsapp.net')).toBe(
      false,
    );
  });

  it('is false for missing input', () => {
    expect(isSelfChatJid(undefined, '911234567890@s.whatsapp.net')).toBe(false);
    expect(isSelfChatJid('911234567890@s.whatsapp.net', undefined)).toBe(false);
  });
});

describe('normalizeBaileysInboundMessage', () => {
  const ownJid = '911234567890:12@s.whatsapp.net';

  it('sets fromMe=false and isSelfChat=false for a normal inbound lead message', () => {
    const normalized = normalizeBaileysInboundMessage(
      {
        key: { id: 'm1', remoteJid: '919999999999@s.whatsapp.net', fromMe: false },
        message: textMessage('Hello'),
        pushName: 'Lead One',
      },
      { ownJid },
    );

    expect(normalized).toMatchObject({ fromMe: false, isSelfChat: false });
  });

  it('sets fromMe=true and isSelfChat=true for a message in the owner self-chat', () => {
    const normalized = normalizeBaileysInboundMessage(
      {
        key: { id: 'm2', remoteJid: '911234567890@s.whatsapp.net', fromMe: true },
        message: textMessage('note to self'),
      },
      { ownJid },
    );

    expect(normalized).toMatchObject({ fromMe: true, isSelfChat: true });
  });

  it('sets fromMe=true and isSelfChat=false for a fromMe message to a different direct chat', () => {
    const normalized = normalizeBaileysInboundMessage(
      {
        key: { id: 'm3', remoteJid: '919999999999@s.whatsapp.net', fromMe: true },
        message: textMessage('manual reply to a lead'),
      },
      { ownJid },
    );

    expect(normalized).toMatchObject({ fromMe: true, isSelfChat: false });
  });

  it('defaults isSelfChat to false when ownJid is not passed', () => {
    const normalized = normalizeBaileysInboundMessage({
      key: { id: 'm4', remoteJid: '911234567890@s.whatsapp.net', fromMe: true },
      message: textMessage('note to self'),
    });

    expect(normalized).toMatchObject({ fromMe: true, isSelfChat: false });
  });
});

describe('resolveBaileysMessageType', () => {
  const normalizedTypeOf = (payload: Record<string, unknown>) =>
    normalizeBaileysInboundMessage({
      key: { id: 'm1', remoteJid: '919999999999@s.whatsapp.net', fromMe: false },
      message: payload as never,
    })?.messageType;

  it.each([
    ['imageMessage', MESSAGE_TYPES.IMAGE],
    ['videoMessage', MESSAGE_TYPES.VIDEO],
    ['audioMessage', MESSAGE_TYPES.AUDIO],
    ['documentMessage', MESSAGE_TYPES.DOCUMENT],
    ['stickerMessage', MESSAGE_TYPES.STICKER],
    ['contactMessage', MESSAGE_TYPES.CONTACT],
    ['contactsArrayMessage', MESSAGE_TYPES.CONTACT],
    ['locationMessage', MESSAGE_TYPES.LOCATION],
  ])('maps %s onto "%s"', (key, expected) => {
    expect(resolveBaileysMessageType({ message: { [key]: {} } as never })).toBe(expected);
    expect(normalizedTypeOf({ [key]: {} })).toBe(expected);
  });

  it('leaves plain text as text, in both payload shapes', () => {
    expect(resolveBaileysMessageType({ message: { conversation: 'hi' } })).toBe(MESSAGE_TYPES.TEXT);
    expect(
      resolveBaileysMessageType({ message: { extendedTextMessage: { text: 'hi' } } }),
    ).toBe(MESSAGE_TYPES.TEXT);
  });

  it('falls back to text for an unrecognised payload rather than escalating it as media', () => {
    expect(resolveBaileysMessageType({ message: { protocolMessage: {} } as never })).toBe(
      MESSAGE_TYPES.TEXT,
    );
    expect(resolveBaileysMessageType({})).toBe(MESSAGE_TYPES.TEXT);
  });
});

describe('extractBaileysMedia', () => {
  it('reads mimetype, filename and size off a document without downloading it', () => {
    expect(
      extractBaileysMedia({
        message: {
          documentMessage: {
            mimetype: 'application/pdf',
            fileName: 'competitor-quote.pdf',
            fileLength: '284913',
          },
        },
      }),
    ).toEqual({
      mimeType: 'application/pdf',
      fileName: 'competitor-quote.pdf',
      sizeBytes: 284913,
      isVoiceNote: false,
    });
  });

  it('flags a push-to-talk audio message as a voice note', () => {
    expect(
      extractBaileysMedia({
        message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus', fileLength: 8321, ptt: true } },
      }),
    ).toMatchObject({ isVoiceNote: true, mimeType: 'audio/ogg; codecs=opus', sizeBytes: 8321 });
  });

  it('does not flag an ordinary attached audio file as a voice note', () => {
    expect(
      extractBaileysMedia({ message: { audioMessage: { mimetype: 'audio/mp4', ptt: false } } }),
    ).toMatchObject({ isVoiceNote: false });
  });

  it('coerces a protobuf Long fileLength, and refuses an unreadable one', () => {
    expect(
      extractBaileysMedia({
        message: { imageMessage: { fileLength: { toString: () => '90000' } } },
      }),
    ).toMatchObject({ sizeBytes: 90_000 });

    expect(
      extractBaileysMedia({ message: { imageMessage: { fileLength: 'not-a-number' } } }),
    ).toMatchObject({ sizeBytes: null });
  });

  it('returns null for text, and for media nodes with no file behind them', () => {
    expect(extractBaileysMedia({ message: { conversation: 'hi' } })).toBeNull();
    expect(extractBaileysMedia({ message: { locationMessage: { degreesLatitude: 18.5 } } })).toBeNull();
    expect(extractBaileysMedia({})).toBeNull();
  });
});

describe('normalizeBaileysInboundMessage - media', () => {
  const normalize = (payload: Record<string, unknown>) =>
    normalizeBaileysInboundMessage({
      key: { id: 'm1', remoteJid: '919999999999@s.whatsapp.net', fromMe: false },
      message: payload as never,
      pushName: 'Lead One',
    });

  it('keeps an image caption as the message body', () => {
    const normalized = normalize({
      imageMessage: { caption: 'This is the venue', mimetype: 'image/jpeg', fileLength: 90_000 },
    });

    expect(normalized).toMatchObject({
      text: 'This is the venue',
      messageType: MESSAGE_TYPES.IMAGE,
      media: { mimeType: 'image/jpeg', sizeBytes: 90_000, isVoiceNote: false },
    });
    expect(normalized?.safe.textPreview).toBe('This is the venue');
  });

  it('keeps a document caption as the message body too', () => {
    expect(
      normalize({ documentMessage: { caption: 'their quote', fileName: 'quote.pdf' } }),
    ).toMatchObject({ text: 'their quote', messageType: MESSAGE_TYPES.DOCUMENT });
  });

  it('leaves the body empty for a voice note and says so in the flag', () => {
    expect(normalize({ audioMessage: { mimetype: 'audio/ogg', ptt: true } })).toMatchObject({
      text: '',
      messageType: MESSAGE_TYPES.AUDIO,
      media: { isVoiceNote: true },
    });
  });

  it('carries no media block for a plain text message', () => {
    expect(normalize({ conversation: 'Hello' })).toMatchObject({
      text: 'Hello',
      messageType: MESSAGE_TYPES.TEXT,
      media: null,
    });
  });
});
