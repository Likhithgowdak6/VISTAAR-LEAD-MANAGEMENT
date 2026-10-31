/**
 * Storing and serving a call recording.
 *
 * THREE FAILURES THIS FILE EXISTS TO PREVENT.
 *
 * WRITING BEFORE AUTHORISING. If the bytes hit the disk before the conversation gate runs,
 * anyone who can reach the route can fill the server's storage with audio for calls they cannot
 * see - and the file persists even though the attach is refused.
 *
 * THE ORPHAN. If the write succeeds and the attach then fails, the bytes sit in storage with
 * nothing pointing at them: a customer's recorded conversation that the CRM does not know it
 * has, which nothing will ever read or delete.
 *
 * SERVING THE WRONG FILE. The stored key is re-validated on the way out as well as in, so a
 * corrupted or hand-edited row cannot point the reader at an arbitrary path on disk.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: { NODE_ENV: 'test', LOG_LEVEL: 'silent', MEDIA_STORAGE_DIR: 'var/media' },
}));

const mocks = vi.hoisted(() => ({
  getCallForActor: vi.fn(),
  attachRecordingForActor: vi.fn(),
}));

vi.mock('./call-record.service.js', () => ({
  getCallForActor: mocks.getCallForActor,
  attachRecordingForActor: mocks.attachRecordingForActor,
}));

const { CallRecordingError, openCallRecordingForActor, uploadCallRecordingForActor } =
  await import('./call-recording.service.js');

const ORG = '6ab4c2037469f65204cfe999';
const CONVERSATION = '68f1a2b3c4d5e6f708192a3b';
const CALL = '6adf2dd59f91cdd63f09e0f3';
const actor = { _id: '6ab4c2037469f65204cfe111' } as never;

/** A minimal but REAL ISO-BMFF header, so the magic-byte sniffer recognises audio/mp4. */
const m4aBytes = () =>
  Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from('ftypM4A '),
    Buffer.alloc(64),
  ]);

const pngBytes = () =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

const storage = () => ({
  writeMediaObject: vi.fn().mockResolvedValue({ objectKey: 'k', sizeBytes: 1 }),
  deleteMediaObject: vi.fn().mockResolvedValue(undefined),
  statMediaObject: vi.fn().mockResolvedValue({ exists: true, sizeBytes: 1024 }),
  openMediaObjectStream: vi.fn().mockReturnValue('stream'),
  readMediaObject: vi.fn(),
  root: '/tmp',
});

const call = (overrides: Record<string, unknown> = {}) => ({
  _id: CALL,
  organizationId: ORG,
  conversationId: CONVERSATION,
  recordingObjectKey: null,
  recordingMimeType: null,
  ...overrides,
});

const base = { organizationId: ORG, callId: CALL, actor, permissions: [] as never };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCallForActor.mockResolvedValue(call());
  mocks.attachRecordingForActor.mockResolvedValue({ id: CALL, recordingStatus: 'uploaded' });
});

describe('uploading', () => {
  it('AUTHORISES BEFORE A BYTE REACHES THE DISK', async () => {
    const store = storage();
    mocks.getCallForActor.mockRejectedValue(new Error('CONVERSATION_ACCESS_DENIED'));

    await expect(
      uploadCallRecordingForActor({
        ...base,
        bytes: m4aBytes(),
        declaredMimeType: 'audio/mp4',
        fileName: 'call.m4a',
        storage: store as never,
      }),
    ).rejects.toThrow('CONVERSATION_ACCESS_DENIED');

    expect(store.writeMediaObject).not.toHaveBeenCalled();
  });

  it('stores audio under the call’s own organisation and conversation', async () => {
    const store = storage();

    await uploadCallRecordingForActor({
      ...base,
      bytes: m4aBytes(),
      declaredMimeType: 'audio/mp4',
      fileName: 'call.m4a',
      storage: store as never,
    });

    const key = store.writeMediaObject.mock.calls[0]![0].objectKey as string;

    // The key encodes both scopes, so it cannot be replayed against another conversation.
    expect(key.startsWith(`${ORG}/${CONVERSATION}/`)).toBe(true);
    expect(key.endsWith('.m4a')).toBe(true);
  });

  it('REFUSES A NON-AUDIO FILE even when it really is what it claims', async () => {
    const store = storage();

    await expect(
      uploadCallRecordingForActor({
        ...base,
        bytes: pngBytes(),
        declaredMimeType: 'image/png',
        fileName: 'screenshot.png',
        storage: store as never,
      }),
    ).rejects.toBeInstanceOf(CallRecordingError);

    expect(store.writeMediaObject).not.toHaveBeenCalled();
  });

  it('refuses a file whose bytes contradict its content type', async () => {
    // A PNG renamed to .m4a. The declared type is audio, the magic bytes are not.
    const store = storage();

    await expect(
      uploadCallRecordingForActor({
        ...base,
        bytes: pngBytes(),
        declaredMimeType: 'audio/mp4',
        fileName: 'call.m4a',
        storage: store as never,
      }),
    ).rejects.toMatchObject({ reason: 'content_mismatch' });
  });

  it('refuses an empty file', async () => {
    const store = storage();

    await expect(
      uploadCallRecordingForActor({
        ...base,
        bytes: Buffer.alloc(0),
        declaredMimeType: 'audio/mp4',
        fileName: 'call.m4a',
        storage: store as never,
      }),
    ).rejects.toMatchObject({ reason: 'empty_file' });
  });

  it('DELETES THE ORPHAN when attaching fails after the write', async () => {
    // Otherwise a customer's recorded conversation sits in storage forever with nothing
    // pointing at it - unreadable, undeletable, and unknown to the CRM that is holding it.
    const store = storage();
    mocks.attachRecordingForActor.mockRejectedValue(new Error('CALL_NOT_FOUND'));

    await expect(
      uploadCallRecordingForActor({
        ...base,
        bytes: m4aBytes(),
        declaredMimeType: 'audio/mp4',
        fileName: 'call.m4a',
        storage: store as never,
      }),
    ).rejects.toThrow('CALL_NOT_FOUND');

    const written = store.writeMediaObject.mock.calls[0]![0].objectKey as string;
    expect(store.deleteMediaObject).toHaveBeenCalledWith(written);
  });

  it('does not let a failed cleanup hide the real error', async () => {
    const store = storage();
    mocks.attachRecordingForActor.mockRejectedValue(new Error('CALL_NOT_FOUND'));
    store.deleteMediaObject.mockRejectedValue(new Error('DISK_ON_FIRE'));

    await expect(
      uploadCallRecordingForActor({
        ...base,
        bytes: m4aBytes(),
        declaredMimeType: 'audio/mp4',
        fileName: 'call.m4a',
        storage: store as never,
      }),
      // The attach failure is what the agent needs to see, not the tidy-up's.
    ).rejects.toThrow('CALL_NOT_FOUND');
  });
});

describe('playing back', () => {
  it('streams audio for an authorised call', async () => {
    const store = storage();
    mocks.getCallForActor.mockResolvedValue(
      call({
        recordingObjectKey: `${ORG}/${CONVERSATION}/0199aa11-2233-4455-6677-8899aabbccdd.m4a`,
        recordingMimeType: 'audio/mp4',
      }),
    );

    const result = await openCallRecordingForActor({ ...base, storage: store as never });

    expect(result.mimeType).toBe('audio/mp4');
    expect(result.sizeBytes).toBe(1024);
  });

  it('applies the same authorisation as everything else', async () => {
    const store = storage();
    mocks.getCallForActor.mockRejectedValue(new Error('CALL_NOT_FOUND'));

    await expect(
      openCallRecordingForActor({ ...base, storage: store as never }),
    ).rejects.toThrow('CALL_NOT_FOUND');
    expect(store.openMediaObjectStream).not.toHaveBeenCalled();
  });

  it('REFUSES A MALFORMED KEY rather than reading what it points at', async () => {
    // Defence against a corrupted or hand-edited row: the key shape forbids traversal, and it
    // is checked on the way out as well as on the way in.
    const store = storage();
    mocks.getCallForActor.mockResolvedValue(
      call({ recordingObjectKey: '../../../etc/passwd', recordingMimeType: 'audio/mp4' }),
    );

    await expect(
      openCallRecordingForActor({ ...base, storage: store as never }),
    ).rejects.toThrow('RECORDING_UNAVAILABLE');
    expect(store.openMediaObjectStream).not.toHaveBeenCalled();
  });

  it('reports unavailable when the row claims audio the disk does not have', async () => {
    const store = storage();
    store.statMediaObject.mockResolvedValue({ exists: false, sizeBytes: 0 });
    mocks.getCallForActor.mockResolvedValue(
      call({
        recordingObjectKey: `${ORG}/${CONVERSATION}/0199aa11-2233-4455-6677-8899aabbccdd.m4a`,
      }),
    );

    await expect(
      openCallRecordingForActor({ ...base, storage: store as never }),
    ).rejects.toThrow('RECORDING_UNAVAILABLE');
  });

  it('reports unavailable for a call that has no recording at all', async () => {
    const store = storage();

    await expect(
      openCallRecordingForActor({ ...base, storage: store as never }),
    ).rejects.toThrow('RECORDING_UNAVAILABLE');
  });
});
