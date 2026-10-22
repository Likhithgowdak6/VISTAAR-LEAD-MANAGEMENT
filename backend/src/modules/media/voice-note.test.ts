/**
 * The voice-note conversion decision.
 *
 * WHY THIS IS WORTH TESTING CAREFULLY. Marking an audio message `ptt: true` is cheap and makes
 * the bubble look right in the CRM; whether the lead can actually HEAR it depends entirely on
 * the container being Ogg/Opus, and nothing in the send path fails when it is not. Baileys
 * wraps its own audio inspection in a `try/catch` that only warns. So a bug here is invisible
 * from this side of WhatsApp and shows up as a silent bubble on a customer's phone.
 *
 * ffmpeg itself is injected. These tests prove the decisions - convert, skip, refuse - not that
 * ffmpeg can transcode, which is ffmpeg's business and is not installed on every machine.
 */
import { describe, expect, it, vi } from 'vitest';

import { isOggOpus, prepareVoiceNote, probeFfmpegAvailable, type FfmpegRunner } from './voice-note.js';

const oggOpus = (): Buffer =>
  Buffer.concat([
    Buffer.from('OggS', 'ascii'),
    Buffer.alloc(24),
    Buffer.from('OpusHead', 'ascii'),
    Buffer.alloc(8),
  ]);

/** Ogg carrying Vorbis rather than Opus: the right container, the wrong codec. */
const oggVorbis = (): Buffer =>
  Buffer.concat([
    Buffer.from('OggS', 'ascii'),
    Buffer.alloc(24),
    Buffer.from('vorbis', 'ascii'),
    Buffer.alloc(8),
  ]);

const webmOpus = (): Buffer => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64)]);

describe('isOggOpus', () => {
  it('accepts Ogg carrying Opus', () => {
    expect(isOggOpus(oggOpus())).toBe(true);
  });

  it('rejects Ogg carrying something else', () => {
    // The container alone is not the question - WhatsApp plays Opus, and an Ogg/Vorbis voice
    // note is just as silent on the recipient's phone as a WebM one.
    expect(isOggOpus(oggVorbis())).toBe(false);
  });

  it('rejects WebM, which is what Chrome records', () => {
    expect(isOggOpus(webmOpus())).toBe(false);
  });
});

describe('prepareVoiceNote', () => {
  it('sends Ogg/Opus straight through without calling ffmpeg', async () => {
    // Firefox records this natively. Transcoding it would cost a process spawn and a
    // generation of quality for no reason at all.
    const ffmpeg = vi.fn() as unknown as FfmpegRunner;

    const result = await prepareVoiceNote({
      bytes: oggOpus(),
      mimeType: 'audio/ogg; codecs=opus',
      ffmpeg,
    });

    expect(result).toMatchObject({ ok: true, mimeType: 'audio/ogg', converted: false });
    expect(ffmpeg).not.toHaveBeenCalled();
  });

  it('converts a Chrome WebM recording', async () => {
    const ffmpeg = vi.fn().mockResolvedValue({ ok: true, output: oggOpus() });

    const result = await prepareVoiceNote({
      bytes: webmOpus(),
      mimeType: 'audio/webm;codecs=opus',
      ffmpeg: ffmpeg as unknown as FfmpegRunner,
    });

    expect(result).toMatchObject({ ok: true, mimeType: 'audio/ogg', extension: '.ogg', converted: true });
    expect(ffmpeg).toHaveBeenCalledTimes(1);

    // The arguments are the contract with WhatsApp, not a detail: libopus in an ogg container.
    const args = (ffmpeg.mock.calls[0]?.[0] ?? []) as string[];
    expect(args).toEqual(expect.arrayContaining(['-c:a', 'libopus', '-f', 'ogg']));
  });

  it('converts an Ogg file that is not Opus, rather than trusting the extension', async () => {
    const ffmpeg = vi.fn().mockResolvedValue({ ok: true, output: oggOpus() });

    const result = await prepareVoiceNote({
      bytes: oggVorbis(),
      mimeType: 'audio/ogg',
      ffmpeg: ffmpeg as unknown as FfmpegRunner,
    });

    expect(result).toMatchObject({ ok: true, converted: true });
    expect(ffmpeg).toHaveBeenCalledTimes(1);
  });

  it('REFUSES when ffmpeg is not installed, instead of sending an unplayable note', async () => {
    // The decision this whole module exists for. Sending the WebM anyway would "work" at every
    // layer we can see and fail only on the lead's phone, where nobody is watching.
    const ffmpeg = vi.fn().mockResolvedValue({ ok: false, reason: 'missing' });

    const result = await prepareVoiceNote({
      bytes: webmOpus(),
      mimeType: 'audio/webm',
      ffmpeg: ffmpeg as unknown as FfmpegRunner,
    });

    expect(result).toEqual({ ok: false, reason: 'transcode_unavailable' });
  });

  it('reports a failed conversion separately from a missing ffmpeg', async () => {
    // Different causes, different advice: one needs an install, the other is a bad recording.
    const ffmpeg = vi.fn().mockResolvedValue({ ok: false, reason: 'failed' });

    const result = await prepareVoiceNote({
      bytes: webmOpus(),
      mimeType: 'audio/webm',
      ffmpeg: ffmpeg as unknown as FfmpegRunner,
    });

    expect(result).toEqual({ ok: false, reason: 'transcode_failed' });
  });

  it('refuses output that ffmpeg claimed to produce but is not Ogg/Opus', async () => {
    // ffmpeg exiting 0 is not proof. Without this check a misconfigured build (no libopus)
    // could hand back something else entirely and we would mark it a voice note.
    const ffmpeg = vi.fn().mockResolvedValue({ ok: true, output: webmOpus() });

    const result = await prepareVoiceNote({
      bytes: webmOpus(),
      mimeType: 'audio/webm',
      ffmpeg: ffmpeg as unknown as FfmpegRunner,
    });

    expect(result).toEqual({ ok: false, reason: 'transcode_failed' });
  });
});

describe('probeFfmpegAvailable', () => {
  it('is true when ffmpeg answers', async () => {
    const ffmpeg = vi.fn().mockResolvedValue({ ok: true, output: Buffer.from('ffmpeg version') });

    await expect(probeFfmpegAvailable(ffmpeg as unknown as FfmpegRunner)).resolves.toBe(true);
  });

  it('is false when it does not', async () => {
    const ffmpeg = vi.fn().mockResolvedValue({ ok: false, reason: 'missing' });

    await expect(probeFfmpegAvailable(ffmpeg as unknown as FfmpegRunner)).resolves.toBe(false);
  });
});
