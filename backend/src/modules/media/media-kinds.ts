/**
 * What the CRM is willing to accept as an attachment, and how it decides.
 *
 * TWO INDEPENDENT ANSWERS MUST AGREE. The browser tells us a MIME type, and the first bytes of
 * the file tell us a container format. Either on its own is a bad gate: the declared type is
 * attacker-controlled (a `.exe` announced as `image/png`), and a signature alone cannot tell a
 * .docx from a .xlsx because both are zip archives. So the declared type must be on the
 * allowlist below, AND the bytes must be a container that type is actually stored in. A
 * disagreement is refused rather than guessed at.
 *
 * WHAT THIS IS NOT. It is not a virus scanner and does not claim to be. Nothing here is ever
 * executed, rendered as HTML, or served from the app's own origin as an inline document - the
 * download route sets a non-negotiable Content-Type and attaches rather than displays anything
 * that is not an image, a video or an audio file.
 */
import { MESSAGE_TYPES, type MessageType } from '../../constants/message-types.js';

/** Container formats recognisable from the first bytes of a file. */
export type MediaSignature =
  | 'jpeg'
  | 'png'
  | 'gif'
  | 'webp'
  | 'wav'
  | 'isobmff'
  | 'matroska'
  | 'ogg'
  | 'mp3'
  | 'amr'
  | 'pdf'
  | 'zip'
  | 'ole2';

export interface AcceptedMediaFormat {
  /** The CRM message type this format becomes once stored. */
  messageType: MessageType;
  /**
   * Container formats whose bytes legitimately carry this MIME type. Empty means the format has
   * no reliable magic number (plain text, CSV) and is accepted on its declared type alone - safe
   * only because those types are stored as documents and never interpreted.
   */
  signatures: readonly MediaSignature[];
  /** Canonical extension, forced onto the stored filename so `cv.pdf.exe` cannot survive. */
  extension: string;
}

/**
 * The allowlist. Deliberately short: these are the formats WhatsApp itself carries well, which
 * makes "we accepted it but it arrived broken" much less likely than a generous list would.
 */
export const ACCEPTED_MEDIA_FORMATS: Readonly<Record<string, AcceptedMediaFormat>> = Object.freeze({
  'image/jpeg': { messageType: MESSAGE_TYPES.IMAGE, signatures: ['jpeg'], extension: '.jpg' },
  'image/png': { messageType: MESSAGE_TYPES.IMAGE, signatures: ['png'], extension: '.png' },
  'image/webp': { messageType: MESSAGE_TYPES.IMAGE, signatures: ['webp'], extension: '.webp' },
  'image/gif': { messageType: MESSAGE_TYPES.IMAGE, signatures: ['gif'], extension: '.gif' },

  'video/mp4': { messageType: MESSAGE_TYPES.VIDEO, signatures: ['isobmff'], extension: '.mp4' },
  'video/quicktime': {
    messageType: MESSAGE_TYPES.VIDEO,
    signatures: ['isobmff'],
    extension: '.mov',
  },
  'video/3gpp': { messageType: MESSAGE_TYPES.VIDEO, signatures: ['isobmff'], extension: '.3gp' },
  'video/webm': { messageType: MESSAGE_TYPES.VIDEO, signatures: ['matroska'], extension: '.webm' },

  'audio/mpeg': { messageType: MESSAGE_TYPES.AUDIO, signatures: ['mp3'], extension: '.mp3' },
  'audio/mp4': { messageType: MESSAGE_TYPES.AUDIO, signatures: ['isobmff'], extension: '.m4a' },
  'audio/x-m4a': { messageType: MESSAGE_TYPES.AUDIO, signatures: ['isobmff'], extension: '.m4a' },
  'audio/ogg': { messageType: MESSAGE_TYPES.AUDIO, signatures: ['ogg'], extension: '.ogg' },
  'audio/opus': { messageType: MESSAGE_TYPES.AUDIO, signatures: ['ogg'], extension: '.opus' },
  // A browser recording. Accepted for upload, but see voice-note.ts - as a voice note it has to
  // be repackaged into Ogg/Opus first, because WhatsApp will not play a WebM voice note.
  'audio/webm': { messageType: MESSAGE_TYPES.AUDIO, signatures: ['matroska'], extension: '.webm' },
  'audio/wav': { messageType: MESSAGE_TYPES.AUDIO, signatures: ['wav'], extension: '.wav' },
  'audio/x-wav': { messageType: MESSAGE_TYPES.AUDIO, signatures: ['wav'], extension: '.wav' },
  'audio/amr': { messageType: MESSAGE_TYPES.AUDIO, signatures: ['amr'], extension: '.amr' },

  'application/pdf': {
    messageType: MESSAGE_TYPES.DOCUMENT,
    signatures: ['pdf'],
    extension: '.pdf',
  },
  'application/msword': {
    messageType: MESSAGE_TYPES.DOCUMENT,
    signatures: ['ole2'],
    extension: '.doc',
  },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
    messageType: MESSAGE_TYPES.DOCUMENT,
    signatures: ['zip'],
    extension: '.docx',
  },
  'application/vnd.ms-excel': {
    messageType: MESSAGE_TYPES.DOCUMENT,
    signatures: ['ole2'],
    extension: '.xls',
  },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    messageType: MESSAGE_TYPES.DOCUMENT,
    signatures: ['zip'],
    extension: '.xlsx',
  },
  'application/vnd.ms-powerpoint': {
    messageType: MESSAGE_TYPES.DOCUMENT,
    signatures: ['ole2'],
    extension: '.ppt',
  },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': {
    messageType: MESSAGE_TYPES.DOCUMENT,
    signatures: ['zip'],
    extension: '.pptx',
  },
  'text/plain': { messageType: MESSAGE_TYPES.DOCUMENT, signatures: [], extension: '.txt' },
  'text/csv': { messageType: MESSAGE_TYPES.DOCUMENT, signatures: [], extension: '.csv' },
});

const matchesAt = (bytes: Buffer, signature: readonly number[], offset: number): boolean => {
  if (bytes.length < offset + signature.length) {
    return false;
  }

  return signature.every((byte, index) => bytes[offset + index] === byte);
};

const ascii = (text: string): readonly number[] => [...text].map((char) => char.charCodeAt(0));

/**
 * The container format of a buffer, or null if it is not one we recognise.
 *
 * Only the first few bytes are read, so this is cheap enough to run on every upload before
 * anything is written to disk.
 */
export const sniffMediaSignature = (bytes: Buffer): MediaSignature | null => {
  if (matchesAt(bytes, [0xff, 0xd8, 0xff], 0)) {
    return 'jpeg';
  }

  if (matchesAt(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)) {
    return 'png';
  }

  if (matchesAt(bytes, ascii('GIF8'), 0)) {
    return 'gif';
  }

  // RIFF is a family, not a format: the four bytes at offset 8 say which member it is.
  if (matchesAt(bytes, ascii('RIFF'), 0)) {
    if (matchesAt(bytes, ascii('WEBP'), 8)) {
      return 'webp';
    }

    if (matchesAt(bytes, ascii('WAVE'), 8)) {
      return 'wav';
    }

    return null;
  }

  // MP4, MOV, M4A and 3GP all share the ISO base media format; the brand that follows `ftyp`
  // distinguishes them, but not reliably enough to gate on, so the declared MIME type picks.
  if (matchesAt(bytes, ascii('ftyp'), 4)) {
    return 'isobmff';
  }

  if (matchesAt(bytes, [0x1a, 0x45, 0xdf, 0xa3], 0)) {
    return 'matroska';
  }

  if (matchesAt(bytes, ascii('OggS'), 0)) {
    return 'ogg';
  }

  if (matchesAt(bytes, ascii('ID3'), 0)) {
    return 'mp3';
  }

  // A bare MPEG frame sync: 11 set bits. Catches an MP3 with no ID3 tag.
  if (bytes.length >= 2 && bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) {
    return 'mp3';
  }

  if (matchesAt(bytes, ascii('#!AMR'), 0)) {
    return 'amr';
  }

  if (matchesAt(bytes, ascii('%PDF-'), 0)) {
    return 'pdf';
  }

  if (matchesAt(bytes, [0x50, 0x4b, 0x03, 0x04], 0)) {
    return 'zip';
  }

  if (matchesAt(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0)) {
    return 'ole2';
  }

  return null;
};

/**
 * Strips parameters off a MIME type: `audio/webm;codecs=opus` is the same format as `audio/webm`,
 * and MediaRecorder always sends the codec along.
 */
export const baseMimeType = (mimeType: string | null | undefined): string =>
  (mimeType ?? '').split(';')[0]!.trim().toLowerCase();

/**
 * A filename safe to store, to put in a Content-Disposition header, and to hand to WhatsApp.
 *
 * Directory parts are dropped rather than escaped - nothing upstream has any business sending a
 * path - and the canonical extension for the resolved format is forced on, so a document cannot
 * arrive on the recipient's phone announcing itself as something executable.
 */
export const toSafeFileName = (rawName: string | null | undefined, extension: string): string => {
  const withoutPath = (rawName ?? '').replace(/^.*[\\/]/, '');
  const base = withoutPath
    .replace(/\.[^.]*$/, '')
    // Control characters, quotes and separators out; everything else a filesystem and a
    // Content-Disposition header can both carry stays.
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f"'`\\/:*?<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

  return `${base === '' ? 'attachment' : base}${extension}`;
};

export interface ResolveMediaFormatParams {
  declaredMimeType: string | null | undefined;
  fileName: string | null | undefined;
  bytes: Buffer;
}

export type ResolveMediaFormatResult =
  | {
      ok: true;
      mimeType: string;
      messageType: MessageType;
      fileName: string;
      signature: MediaSignature | null;
    }
  | { ok: false; reason: 'unsupported_type' | 'content_mismatch' | 'empty_file' };

/**
 * Decides what an uploaded buffer actually is, refusing anything the two answers disagree about.
 */
export const resolveMediaFormat = ({
  declaredMimeType,
  fileName,
  bytes,
}: ResolveMediaFormatParams): ResolveMediaFormatResult => {
  if (bytes.length === 0) {
    return { ok: false, reason: 'empty_file' };
  }

  const mimeType = baseMimeType(declaredMimeType);
  const format = ACCEPTED_MEDIA_FORMATS[mimeType];

  if (!format) {
    return { ok: false, reason: 'unsupported_type' };
  }

  const signature = sniffMediaSignature(bytes);

  // A format with no magic number is taken on its word; everything else has to prove it.
  if (format.signatures.length > 0 && (!signature || !format.signatures.includes(signature))) {
    return { ok: false, reason: 'content_mismatch' };
  }

  return {
    ok: true,
    mimeType,
    messageType: format.messageType,
    fileName: toSafeFileName(fileName, format.extension),
    signature,
  };
};

/**
 * Whether a stored file may be shown inline by the download route. Anything else is sent as an
 * attachment, so a document can never be rendered as a page on the API's own origin.
 */
export const isInlineSafeMediaType = (mimeType: string | null | undefined): boolean => {
  const base = baseMimeType(mimeType);
  const format = ACCEPTED_MEDIA_FORMATS[base];

  if (!format) {
    return false;
  }

  return (
    format.messageType === MESSAGE_TYPES.IMAGE ||
    format.messageType === MESSAGE_TYPES.VIDEO ||
    format.messageType === MESSAGE_TYPES.AUDIO
  );
};
