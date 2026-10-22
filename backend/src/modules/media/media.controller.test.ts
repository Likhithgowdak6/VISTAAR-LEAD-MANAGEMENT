/**
 * Who may put bytes into a conversation, and who may read them back out.
 *
 * THE TWO FAILURES THIS FILE EXISTS TO PREVENT are both quiet ones. An upload route that
 * validates the file but not the caller's access to the thread lets any authenticated user
 * stage an attachment against any conversation in the organization. A download route that
 * checks the organization but not the actor's visibility hands an assignment-restricted staff
 * member a photo from a lead they are not allowed to open. Neither shows up in ordinary use.
 *
 * The handlers are called directly with fake req/res and injected modules, matching this
 * codebase's DI test style - no HTTP server, no Mongo, no filesystem.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as MediaStorageModule from './media-storage.service.js';

vi.mock('../../config/env.js', () => ({
  env: { MEDIA_MAX_UPLOAD_BYTES: 16 * 1024 * 1024, NODE_ENV: 'test' },
}));

const mocks = vi.hoisted(() => ({
  loadVisibleConversationForActor: vi.fn(),
  findMessageByIdForOrganization: vi.fn(),
  writeMediaObject: vi.fn(),
  statMediaObject: vi.fn(),
  openMediaObjectStream: vi.fn(),
  prepareVoiceNote: vi.fn(),
}));

vi.mock('../conversations/conversation.service.js', () => ({
  loadVisibleConversationForActor: mocks.loadVisibleConversationForActor,
}));

vi.mock('../messages/message.repository.js', () => ({
  findMessageByIdForOrganization: mocks.findMessageByIdForOrganization,
}));

vi.mock('./media-storage.service.js', async () => {
  // The key helpers are the real ones: a mocked `buildMediaObjectKey` would let the upload
  // test pass while minting keys that do not actually scope to the conversation.
  const actual: typeof MediaStorageModule = await vi.importActual('./media-storage.service.js');

  return {
    ...actual,
    mediaStorage: {
      writeMediaObject: mocks.writeMediaObject,
      statMediaObject: mocks.statMediaObject,
      openMediaObjectStream: mocks.openMediaObjectStream,
    },
  };
});

vi.mock('./voice-note.js', () => ({ prepareVoiceNote: mocks.prepareVoiceNote }));

const { downloadMessageMedia, uploadConversationMedia } = await import('./media.controller.js');

const ORG = '507f1f77bcf86cd799439011';
const CONVERSATION = '507f191e810c19729de860ea';
const MESSAGE = '507f191e810c19729de860ff';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);

const authedRequest = (overrides: Record<string, unknown> = {}) =>
  ({
    auth: {
      organization: { _id: ORG },
      user: { _id: 'user-1' },
      permissions: ['messages.send', 'conversations.read'],
    },
    params: { conversationId: CONVERSATION, messageId: MESSAGE },
    body: {},
    ...overrides,
  }) as never;

const fakeResponse = () => {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, unknown>,
    payload: undefined as unknown,
    status: vi.fn(function status(this: void, code: number) {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((value: unknown) => {
      res.payload = value;
      return res;
    }),
    setHeader: vi.fn((name: string, value: unknown) => {
      res.headers[name] = value;
    }),
    destroy: vi.fn(),
  };

  return res;
};

/** Runs a handler and returns whatever it threw, or undefined. */
const runAndCatch = async (
  handler: (req: never, res: never, next: never) => unknown,
  req: never,
  res: ReturnType<typeof fakeResponse>,
) => {
  const next = vi.fn();

  await handler(req, res as never, next as never);

  return next.mock.calls[0]?.[0] as { statusCode?: number; code?: string } | undefined;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadVisibleConversationForActor.mockResolvedValue({ _id: CONVERSATION });
  mocks.writeMediaObject.mockResolvedValue({ objectKey: 'k', sizeBytes: JPEG.length });
});

describe('uploading an attachment', () => {
  const uploadRequest = (file: Record<string, unknown> | undefined, body = {}) =>
    authedRequest({ file, body });

  it('stores a valid photo under this organization and conversation', async () => {
    const res = fakeResponse();

    const error = await runAndCatch(
      uploadConversationMedia as never,
      uploadRequest({ buffer: JPEG, mimetype: 'image/jpeg', originalname: 'venue.jpg' }),
      res,
    );

    expect(error).toBeUndefined();
    expect(res.statusCode).toBe(201);

    const data = (res.payload as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ type: 'image', mimeType: 'image/jpeg', fileName: 'venue.jpg' });
    expect(String(data.objectKey).startsWith(`${ORG}/${CONVERSATION}/`)).toBe(true);
  });

  it('CHECKS THE CALLER CAN SEE THE THREAD before storing anything', async () => {
    // The visibility rule is the conversation module's, and it throws. If this ever stopped
    // being awaited before the write, any authenticated user could stage a file against any
    // conversation in the org.
    mocks.loadVisibleConversationForActor.mockRejectedValue(new Error('CONVERSATION_ACCESS_DENIED'));
    const res = fakeResponse();

    const error = await runAndCatch(
      uploadConversationMedia as never,
      uploadRequest({ buffer: JPEG, mimetype: 'image/jpeg', originalname: 'venue.jpg' }),
      res,
    );

    expect(error).toBeInstanceOf(Error);
    expect(mocks.writeMediaObject).not.toHaveBeenCalled();
  });

  it('refuses a file whose bytes do not match its declared type', async () => {
    const res = fakeResponse();

    const error = await runAndCatch(
      uploadConversationMedia as never,
      uploadRequest({
        buffer: Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
        mimetype: 'image/png',
        originalname: 'photo.png',
      }),
      res,
    );

    expect(error).toMatchObject({ statusCode: 415, code: 'CONTENT_MISMATCH' });
    expect(mocks.writeMediaObject).not.toHaveBeenCalled();
  });

  it('refuses a type that is not on the allowlist', async () => {
    const res = fakeResponse();

    const error = await runAndCatch(
      uploadConversationMedia as never,
      uploadRequest({
        buffer: Buffer.from([0x4d, 0x5a]),
        mimetype: 'application/x-msdownload',
        originalname: 'setup.exe',
      }),
      res,
    );

    expect(error).toMatchObject({ statusCode: 415, code: 'UNSUPPORTED_TYPE' });
  });

  it('refuses a request with no file', async () => {
    const res = fakeResponse();

    const error = await runAndCatch(uploadConversationMedia as never, uploadRequest(undefined), res);

    expect(error).toMatchObject({ statusCode: 400, code: 'NO_FILE' });
  });

  it('converts a voice recording and marks it a voice note', async () => {
    const converted = Buffer.from('OggS-converted');
    mocks.prepareVoiceNote.mockResolvedValue({
      ok: true,
      bytes: converted,
      mimeType: 'audio/ogg',
      extension: '.ogg',
      converted: true,
    });
    const res = fakeResponse();

    const error = await runAndCatch(
      uploadConversationMedia as never,
      uploadRequest(
        {
          buffer: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(16)]),
          mimetype: 'audio/webm;codecs=opus',
          originalname: 'voice-note.webm',
        },
        { kind: 'voice' },
      ),
      res,
    );

    expect(error).toBeUndefined();

    const data = (res.payload as { data: Record<string, unknown> }).data;
    expect(data).toMatchObject({ type: 'audio', mimeType: 'audio/ogg', isVoiceNote: true });
    // The CONVERTED bytes are what gets stored, not the browser's original.
    expect(mocks.writeMediaObject).toHaveBeenCalledWith(
      expect.objectContaining({ bytes: converted }),
    );
  });

  it('refuses a voice note rather than storing one WhatsApp cannot play', async () => {
    mocks.prepareVoiceNote.mockResolvedValue({ ok: false, reason: 'transcode_unavailable' });
    const res = fakeResponse();

    const error = await runAndCatch(
      uploadConversationMedia as never,
      uploadRequest(
        {
          buffer: Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(16)]),
          mimetype: 'audio/webm',
          originalname: 'voice-note.webm',
        },
        { kind: 'voice' },
      ),
      res,
    );

    expect(error).toMatchObject({ statusCode: 503, code: 'TRANSCODE_UNAVAILABLE' });
    expect(mocks.writeMediaObject).not.toHaveBeenCalled();
  });

  it('does not run the voice-note path for an ordinary file', async () => {
    const res = fakeResponse();

    await runAndCatch(
      uploadConversationMedia as never,
      uploadRequest({ buffer: JPEG, mimetype: 'image/jpeg', originalname: 'venue.jpg' }),
      res,
    );

    expect(mocks.prepareVoiceNote).not.toHaveBeenCalled();
  });
});

describe('downloading an attachment', () => {
  const storedMessage = (overrides: Record<string, unknown> = {}) => ({
    _id: MESSAGE,
    conversationId: CONVERSATION,
    mediaObjectKey: `${ORG}/${CONVERSATION}/11111111-1111-1111-1111-111111111111.jpg`,
    media: {
      mimeType: 'image/jpeg',
      fileName: 'venue.jpg',
      sizeBytes: 1024,
      storageStatus: 'stored',
    },
    ...overrides,
  });

  const stream = () => ({ on: vi.fn(), pipe: vi.fn() });

  it('streams the file with its own content type', async () => {
    mocks.findMessageByIdForOrganization.mockResolvedValue(storedMessage());
    mocks.statMediaObject.mockResolvedValue({ exists: true, sizeBytes: 1024 });
    const piped = stream();
    mocks.openMediaObjectStream.mockReturnValue(piped);
    const res = fakeResponse();

    const error = await runAndCatch(downloadMessageMedia as never, authedRequest(), res);

    expect(error).toBeUndefined();
    expect(res.headers['Content-Type']).toBe('image/jpeg');
    expect(piped.pipe).toHaveBeenCalledWith(res);
  });

  it('scopes the lookup to the caller’s organization', async () => {
    // Tenancy is enforced in the query itself rather than by checking the row afterwards, so a
    // message id guessed from another tenant simply does not come back.
    mocks.findMessageByIdForOrganization.mockResolvedValue(null);
    const res = fakeResponse();

    const error = await runAndCatch(downloadMessageMedia as never, authedRequest(), res);

    expect(mocks.findMessageByIdForOrganization).toHaveBeenCalledWith({
      organizationId: ORG,
      messageId: MESSAGE,
    });
    expect(error).toMatchObject({ statusCode: 404, code: 'MESSAGE_NOT_FOUND' });
  });

  it('CHECKS THE ACTOR CAN SEE THE CONVERSATION, not just the organization', async () => {
    mocks.findMessageByIdForOrganization.mockResolvedValue(storedMessage());
    mocks.loadVisibleConversationForActor.mockRejectedValue(new Error('CONVERSATION_ACCESS_DENIED'));
    const res = fakeResponse();

    const error = await runAndCatch(downloadMessageMedia as never, authedRequest(), res);

    expect(error).toBeInstanceOf(Error);
    expect(mocks.openMediaObjectStream).not.toHaveBeenCalled();
  });

  it('404s when the row was never stored', async () => {
    mocks.findMessageByIdForOrganization.mockResolvedValue(
      storedMessage({ mediaObjectKey: null, media: { storageStatus: 'not_applicable' } }),
    );
    const res = fakeResponse();

    const error = await runAndCatch(downloadMessageMedia as never, authedRequest(), res);

    expect(error).toMatchObject({ statusCode: 404, code: 'MEDIA_NOT_AVAILABLE' });
  });

  it('404s when the row says stored but the disk disagrees', async () => {
    mocks.findMessageByIdForOrganization.mockResolvedValue(storedMessage());
    mocks.statMediaObject.mockResolvedValue({ exists: false, sizeBytes: 0 });
    const res = fakeResponse();

    const error = await runAndCatch(downloadMessageMedia as never, authedRequest(), res);

    expect(error).toMatchObject({ statusCode: 404, code: 'MEDIA_NOT_AVAILABLE' });
    expect(mocks.openMediaObjectStream).not.toHaveBeenCalled();
  });

  it('attaches a document rather than displaying it, with nosniff', async () => {
    // A document rendered inline would run on the API's own origin. Both headers matter.
    mocks.findMessageByIdForOrganization.mockResolvedValue(
      storedMessage({
        media: {
          mimeType: 'application/pdf',
          fileName: 'quote.pdf',
          storageStatus: 'stored',
        },
      }),
    );
    mocks.statMediaObject.mockResolvedValue({ exists: true, sizeBytes: 2048 });
    mocks.openMediaObjectStream.mockReturnValue(stream());
    const res = fakeResponse();

    await runAndCatch(downloadMessageMedia as never, authedRequest(), res);

    expect(res.headers['Content-Disposition']).toBe('attachment; filename="quote.pdf"');
    expect(res.headers['X-Content-Type-Options']).toBe('nosniff');
  });

  it('displays a photo inline, which is what makes the thread readable', async () => {
    mocks.findMessageByIdForOrganization.mockResolvedValue(storedMessage());
    mocks.statMediaObject.mockResolvedValue({ exists: true, sizeBytes: 1024 });
    mocks.openMediaObjectStream.mockReturnValue(stream());
    const res = fakeResponse();

    await runAndCatch(downloadMessageMedia as never, authedRequest(), res);

    expect(String(res.headers['Content-Disposition']).startsWith('inline;')).toBe(true);
    expect(res.headers['Cache-Control']).toContain('private');
  });

  it('strips quotes from the filename so the header cannot be broken', async () => {
    mocks.findMessageByIdForOrganization.mockResolvedValue(
      storedMessage({
        media: {
          mimeType: 'application/pdf',
          fileName: 'quote";attachment;x="y.pdf',
          storageStatus: 'stored',
        },
      }),
    );
    mocks.statMediaObject.mockResolvedValue({ exists: true, sizeBytes: 10 });
    mocks.openMediaObjectStream.mockReturnValue(stream());
    const res = fakeResponse();

    await runAndCatch(downloadMessageMedia as never, authedRequest(), res);

    expect(res.headers['Content-Disposition']).toBe(
      'attachment; filename="quote;attachment;x=y.pdf"',
    );
  });
});
