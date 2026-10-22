/**
 * The gate every byte that enters the system passes through.
 *
 * This is the file that decides whether a thing a browser (or a stranger on WhatsApp) handed us
 * is allowed to be stored and later handed back to someone's phone. The tests that matter are
 * therefore the refusals, not the acceptances: a `.exe` wearing an `image/png` label, a type
 * nobody asked for, a filename carrying a path.
 */
import { describe, expect, it } from 'vitest';

import {
  isInlineSafeMediaType,
  resolveMediaFormat,
  sniffMediaSignature,
  toSafeFileName,
} from './media-kinds.js';

const bytes = (...values: number[]): Buffer => Buffer.from(values);
const withAscii = (text: string, padding = 0): Buffer =>
  Buffer.concat([Buffer.from(text, 'ascii'), Buffer.alloc(padding)]);

const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00);
const PDF = withAscii('%PDF-1.7\n', 8);
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04, 0x14, 0x00);
const OGG = withAscii('OggS', 24);
const MATROSKA = bytes(0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00);
const MP4 = Buffer.concat([bytes(0x00, 0x00, 0x00, 0x18), Buffer.from('ftypmp42', 'ascii')]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  bytes(0x00, 0x00, 0x00, 0x00),
  Buffer.from('WEBP', 'ascii'),
]);
const WAV = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  bytes(0x00, 0x00, 0x00, 0x00),
  Buffer.from('WAVE', 'ascii'),
]);
/** MZ - a Windows executable. The thing the content check exists to catch. */
const EXECUTABLE = bytes(0x4d, 0x5a, 0x90, 0x00, 0x03);

describe('sniffMediaSignature', () => {
  it.each([
    ['jpeg', JPEG],
    ['png', PNG],
    ['pdf', PDF],
    ['zip', ZIP],
    ['ogg', OGG],
    ['matroska', MATROSKA],
    ['isobmff', MP4],
    ['webp', WEBP],
    ['wav', WAV],
  ])('recognises %s', (expected, input) => {
    expect(sniffMediaSignature(input)).toBe(expected);
  });

  it('tells WebP and WAV apart, which share the RIFF header', () => {
    // Both start with the same four bytes. Reading only the first four would make either one
    // pass as the other, and an audio file announced as an image is a broken bubble.
    expect(sniffMediaSignature(WEBP)).toBe('webp');
    expect(sniffMediaSignature(WAV)).toBe('wav');
  });

  it('returns null for an unrecognised file rather than guessing', () => {
    expect(sniffMediaSignature(EXECUTABLE)).toBeNull();
    expect(sniffMediaSignature(Buffer.alloc(0))).toBeNull();
  });
});

describe('resolveMediaFormat', () => {
  it('accepts a photo whose bytes match its declared type', () => {
    const result = resolveMediaFormat({
      declaredMimeType: 'image/jpeg',
      fileName: 'venue.jpg',
      bytes: JPEG,
    });

    expect(result).toMatchObject({ ok: true, mimeType: 'image/jpeg', messageType: 'image' });
  });

  it('REFUSES an executable dressed up as a photo', () => {
    // The whole reason the declared type is not trusted on its own. A browser can claim
    // anything; the first bytes cannot.
    const result = resolveMediaFormat({
      declaredMimeType: 'image/png',
      fileName: 'totally-a-photo.png',
      bytes: EXECUTABLE,
    });

    expect(result).toEqual({ ok: false, reason: 'content_mismatch' });
  });

  it('refuses a type that is not on the allowlist, however real the file is', () => {
    const result = resolveMediaFormat({
      declaredMimeType: 'application/x-msdownload',
      fileName: 'setup.exe',
      bytes: EXECUTABLE,
    });

    expect(result).toEqual({ ok: false, reason: 'unsupported_type' });
  });

  it('refuses an empty file', () => {
    expect(
      resolveMediaFormat({ declaredMimeType: 'image/jpeg', fileName: 'x.jpg', bytes: Buffer.alloc(0) }),
    ).toEqual({ ok: false, reason: 'empty_file' });
  });

  it('strips codec parameters off the declared type', () => {
    // MediaRecorder always sends `audio/webm;codecs=opus`, which is the same format as
    // `audio/webm` and must not fall through to "unsupported".
    const result = resolveMediaFormat({
      declaredMimeType: 'audio/webm;codecs=opus',
      fileName: 'note.webm',
      bytes: MATROSKA,
    });

    expect(result).toMatchObject({ ok: true, mimeType: 'audio/webm', messageType: 'audio' });
  });

  it('accepts a docx, whose bytes are only ever a zip', () => {
    const result = resolveMediaFormat({
      declaredMimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      fileName: 'brief.docx',
      bytes: ZIP,
    });

    expect(result).toMatchObject({ ok: true, messageType: 'document', fileName: 'brief.docx' });
  });

  it('takes plain text on its word, having no signature to check', () => {
    const result = resolveMediaFormat({
      declaredMimeType: 'text/plain',
      fileName: 'notes.txt',
      bytes: Buffer.from('just words', 'utf8'),
    });

    expect(result).toMatchObject({ ok: true, messageType: 'document' });
  });

  it('forces the canonical extension, so a double extension cannot survive', () => {
    const result = resolveMediaFormat({
      declaredMimeType: 'application/pdf',
      fileName: 'invoice.pdf.exe',
      bytes: PDF,
    });

    expect(result).toMatchObject({ ok: true, fileName: 'invoice.pdf.pdf' });
  });
});

describe('toSafeFileName', () => {
  it('drops any directory part', () => {
    expect(toSafeFileName('../../etc/passwd', '.txt')).toBe('passwd.txt');
    expect(toSafeFileName('C:\\Users\\x\\secret.pdf', '.pdf')).toBe('secret.pdf');
  });

  it('removes quotes, which would otherwise break the Content-Disposition header', () => {
    expect(toSafeFileName('a"weird\'name.pdf', '.pdf')).toBe('a weird name.pdf');
  });

  it('falls back to a name when there is nothing usable left', () => {
    expect(toSafeFileName('', '.pdf')).toBe('attachment.pdf');
    expect(toSafeFileName('///', '.pdf')).toBe('attachment.pdf');
  });

  it('keeps the name short enough for a filesystem and a header', () => {
    expect(toSafeFileName('a'.repeat(400), '.pdf')).toHaveLength(124);
  });
});

describe('isInlineSafeMediaType', () => {
  it('allows the three kinds a browser can render harmlessly', () => {
    expect(isInlineSafeMediaType('image/png')).toBe(true);
    expect(isInlineSafeMediaType('video/mp4')).toBe(true);
    expect(isInlineSafeMediaType('audio/ogg')).toBe(true);
  });

  it('refuses documents, which must download rather than display', () => {
    // An HTML-ish document rendered inline would run on the API's own origin. Documents are
    // always an attachment, and the download route sets nosniff on top of that.
    expect(isInlineSafeMediaType('application/pdf')).toBe(false);
    expect(isInlineSafeMediaType('text/plain')).toBe(false);
    expect(isInlineSafeMediaType('application/octet-stream')).toBe(false);
    expect(isInlineSafeMediaType(null)).toBe(false);
  });
});
