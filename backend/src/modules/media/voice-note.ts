/**
 * Turning a browser recording into something WhatsApp will actually play as a voice note.
 *
 * THE PROBLEM, STATED PLAINLY. Marking an audio message `ptt: true` is necessary but nowhere
 * near sufficient. WhatsApp plays voice notes as Ogg/Opus; a WebM/Opus recording - which is what
 * Chrome's MediaRecorder produces, and Chrome is most of the traffic here - carries the same
 * Opus frames in a container WhatsApp does not open. It uploads, it sends, it arrives, and it
 * will not play. Baileys does not help: its media pipeline only *reads* audio (duration via
 * music-metadata, a waveform for the little bars) and that whole block is wrapped in a
 * `try/catch` that merely warns, so a file it cannot parse still goes out looking fine from here.
 *
 * SO THE BYTES HAVE TO BE CONVERTED, and the only converter available is ffmpeg - which Baileys
 * already shells out to for video thumbnails, so it is a dependency this deployment half has
 * already. When it is missing we refuse the voice note with a message that says why, rather than
 * sending a file that arrives silent on the recipient's phone. A clear error beats a mystery.
 *
 * Firefox records Ogg/Opus natively and skips all of this.
 */
import { spawn } from 'node:child_process';

import { baseMimeType } from './media-kinds.js';

const OGG_MAGIC = 'OggS';
const OPUS_HEAD = 'OpusHead';

/** Opus at 32 kbit mono 48 kHz: what a phone records a voice note at, and small on the wire. */
const FFMPEG_ARGS = [
  '-hide_banner',
  '-loglevel',
  'error',
  '-i',
  'pipe:0',
  '-vn',
  '-map_metadata',
  '-1',
  '-ac',
  '1',
  '-ar',
  '48000',
  '-c:a',
  'libopus',
  '-b:a',
  '32k',
  '-f',
  'ogg',
  'pipe:1',
];

const TRANSCODE_TIMEOUT_MS = 30_000;

/**
 * True only for Ogg carrying an Opus stream. An Ogg/Vorbis file is still Ogg and still fails on
 * the recipient's phone, so the codec header is checked rather than just the container.
 */
export const isOggOpus = (bytes: Buffer): boolean => {
  if (bytes.subarray(0, 4).toString('ascii') !== OGG_MAGIC) {
    return false;
  }

  // OpusHead lives in the first Ogg page; 1 KiB is generous for a page header plus segment table.
  return bytes.subarray(0, 1024).includes(OPUS_HEAD);
};

export interface FfmpegRunner {
  (args: readonly string[], input: Buffer, timeoutMs: number): Promise<
    { ok: true; output: Buffer } | { ok: false; reason: 'missing' | 'failed' }
  >;
}

/** Runs ffmpeg with the input on stdin and the result on stdout; nothing touches the disk. */
export const runFfmpeg: FfmpegRunner = (args, input, timeoutMs) =>
  new Promise((resolve) => {
    let child;

    try {
      child = spawn('ffmpeg', [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch {
      resolve({ ok: false, reason: 'missing' });
      return;
    }

    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (result: { ok: true; output: Buffer } | { ok: false; reason: 'missing' | 'failed' }) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, reason: 'failed' });
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    // Drained and discarded: ffmpeg's stderr can quote the input's metadata, and this runs on
    // customer audio. A full pipe would also block the process.
    child.stderr.resume();

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({ ok: false, reason: error?.code === 'ENOENT' ? 'missing' : 'failed' });
    });

    child.on('close', (code) => {
      const output = Buffer.concat(chunks);

      finish(code === 0 && output.length > 0 ? { ok: true, output } : { ok: false, reason: 'failed' });
    });

    child.stdin.on('error', () => {
      // Broken pipe when ffmpeg exits early; the close handler reports the real outcome.
    });
    child.stdin.end(input);
  });

export type PrepareVoiceNoteResult =
  | { ok: true; bytes: Buffer; mimeType: string; extension: string; converted: boolean }
  | { ok: false; reason: 'transcode_unavailable' | 'transcode_failed' };

export interface PrepareVoiceNoteParams {
  bytes: Buffer;
  mimeType: string;
  ffmpeg?: FfmpegRunner;
  timeoutMs?: number;
}

/**
 * Returns bytes that WhatsApp will play as a voice note, converting only when it has to.
 *
 * Refusing is a deliberate outcome, not a failure to handle one: the alternative is an audio
 * message the owner believes they sent and the lead cannot hear.
 */
export const prepareVoiceNote = async ({
  bytes,
  mimeType,
  ffmpeg = runFfmpeg,
  timeoutMs = TRANSCODE_TIMEOUT_MS,
}: PrepareVoiceNoteParams): Promise<PrepareVoiceNoteResult> => {
  const base = baseMimeType(mimeType);

  if ((base === 'audio/ogg' || base === 'audio/opus') && isOggOpus(bytes)) {
    return { ok: true, bytes, mimeType: 'audio/ogg', extension: '.ogg', converted: false };
  }

  const result = await ffmpeg(FFMPEG_ARGS, bytes, timeoutMs);

  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason === 'missing' ? 'transcode_unavailable' : 'transcode_failed',
    };
  }

  // ffmpeg exiting 0 on bytes that are not actually Ogg/Opus would defeat the point of all this.
  if (!isOggOpus(result.output)) {
    return { ok: false, reason: 'transcode_failed' };
  }

  return {
    ok: true,
    bytes: result.output,
    mimeType: 'audio/ogg',
    extension: '.ogg',
    converted: true,
  };
};

/** Whether ffmpeg is callable at all, for the startup log and the upload error message. */
export const probeFfmpegAvailable = async (ffmpeg: FfmpegRunner = runFfmpeg): Promise<boolean> => {
  const result = await ffmpeg(['-hide_banner', '-version'], Buffer.alloc(0), 5_000);

  return result.ok;
};
