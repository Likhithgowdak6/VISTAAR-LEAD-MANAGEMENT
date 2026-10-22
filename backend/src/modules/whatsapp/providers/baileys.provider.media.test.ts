/**
 * The exact object handed to Baileys for each kind of attachment.
 *
 * WHY THE SHAPE IS THE TEST. Baileys decides what kind of WhatsApp message to build from which
 * KEY is present in the content object - `image`, `video`, `audio`, `document` - and ignores
 * everything it does not recognise. Pass `file` instead of `document` and nothing throws: the
 * send succeeds and an empty message arrives. So these assertions are against the installed
 * 7.0.0-rc14 contract (Types/Message.d.ts, AnyMediaMessageContent) and are the only thing
 * standing between a typo and a silently empty bubble on a customer's phone.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../config/env.js', () => ({
  env: { NODE_ENV: 'test', WHATSAPP_TRACE_ENABLED: false },
}));

const { createBaileysProvider } = await import('./baileys.provider.js');

const BYTES = Buffer.from('pretend this is a jpeg');

const createSocket = () => ({
  sendMessage: vi.fn().mockResolvedValue({ key: { id: 'wamid-1' } }),
});

const send = async (options: Record<string, unknown>) => {
  const socket = createSocket();
  const provider = createBaileysProvider();

  const result = await provider.sendMediaMessage!({
    socket,
    to: '919999999999',
    data: BYTES,
    ...options,
  } as never);

  return { socket, result, content: socket.sendMessage.mock.calls[0]?.[1] };
};

describe('the content object per kind', () => {
  it('builds an imageMessage with the caption', async () => {
    const { content } = await send({
      kind: 'image',
      mimeType: 'image/jpeg',
      caption: 'The hall',
    });

    expect(content).toEqual({ image: BYTES, mimetype: 'image/jpeg', caption: 'The hall' });
  });

  it('omits an empty caption rather than sending a blank one', async () => {
    const { content } = await send({ kind: 'image', mimeType: 'image/jpeg', caption: '  ' });

    expect(content).toEqual({ image: BYTES, mimetype: 'image/jpeg' });
    expect(content).not.toHaveProperty('caption');
  });

  it('builds a videoMessage', async () => {
    const { content } = await send({ kind: 'video', mimeType: 'video/mp4', caption: null });

    expect(content).toEqual({ video: BYTES, mimetype: 'video/mp4' });
  });

  it('builds a documentMessage WITH a filename', async () => {
    // Without `fileName` WhatsApp shows an unnamed blob, and the recipient's phone has nothing
    // to pick an app with.
    const { content } = await send({
      kind: 'document',
      mimeType: 'application/pdf',
      fileName: 'wedding-package.pdf',
    });

    expect(content).toEqual({
      document: BYTES,
      mimetype: 'application/pdf',
      fileName: 'wedding-package.pdf',
    });
  });

  it('falls back to a filename rather than sending a document without one', async () => {
    const { content } = await send({ kind: 'document', mimeType: 'application/pdf' });

    expect(content).toMatchObject({ fileName: 'attachment' });
  });

  it('builds an audioMessage with ptt for a voice note', async () => {
    const { content } = await send({
      kind: 'audio',
      mimeType: 'audio/ogg',
      isVoiceNote: true,
    });

    expect(content).toEqual({ audio: BYTES, mimetype: 'audio/ogg', ptt: true });
  });

  it('builds an audioMessage without ptt for an attached track', async () => {
    const { content } = await send({
      kind: 'audio',
      mimeType: 'audio/mpeg',
      isVoiceNote: false,
    });

    expect(content).toMatchObject({ ptt: false });
  });

  it('never puts a caption on audio, which WhatsApp would drop anyway', async () => {
    // Silently dropping it would leave the owner believing a note went with the recording.
    const { content } = await send({
      kind: 'audio',
      mimeType: 'audio/ogg',
      isVoiceNote: true,
      caption: 'have a listen',
    });

    expect(content).not.toHaveProperty('caption');
  });
});

describe('what it refuses', () => {
  it('throws when the socket is not ready', async () => {
    const provider = createBaileysProvider();

    await expect(
      provider.sendMediaMessage!({
        socket: null,
        to: '919999999999',
        kind: 'image',
        mimeType: 'image/jpeg',
        data: BYTES,
      } as never),
    ).rejects.toThrow(/not ready/i);
  });

  it('throws on empty data rather than sending an empty bubble', async () => {
    const provider = createBaileysProvider();

    await expect(
      provider.sendMediaMessage!({
        socket: createSocket(),
        to: '919999999999',
        kind: 'image',
        mimeType: 'image/jpeg',
        data: Buffer.alloc(0),
      } as never),
    ).rejects.toThrow(/no data/i);
  });

  it('throws on a kind it does not know', async () => {
    const provider = createBaileysProvider();

    await expect(
      provider.sendMediaMessage!({
        socket: createSocket(),
        to: '919999999999',
        kind: 'sticker',
        mimeType: 'image/webp',
        data: BYTES,
      } as never),
    ).rejects.toThrow(/unsupported media kind/i);
  });
});

describe('the result', () => {
  it('reports the provider message id, which the echo guard needs', async () => {
    const { result } = await send({ kind: 'image', mimeType: 'image/jpeg' });

    expect(result).toMatchObject({ sent: true, providerMessageId: 'wamid-1', recipientType: 'direct' });
  });

  it('survives a send that returns no key', async () => {
    const socket = { sendMessage: vi.fn().mockResolvedValue(undefined) };
    const provider = createBaileysProvider();

    const result = await provider.sendMediaMessage!({
      socket,
      to: '919999999999',
      kind: 'image',
      mimeType: 'image/jpeg',
      data: BYTES,
    } as never);

    expect(result).toMatchObject({ sent: true, providerMessageId: null });
  });
});
