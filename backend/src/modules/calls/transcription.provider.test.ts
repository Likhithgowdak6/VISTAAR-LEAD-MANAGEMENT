/**
 * The transcription seam, before any provider exists behind it.
 *
 * WHY THESE TESTS MATTER MORE THAN THEY LOOK. The single worst outcome for this feature is a
 * fabricated transcript - words attributed to a customer who never said them, or an Agent /
 * Customer split drawn over audio nobody diarised. A mock that invents plausible filler is
 * exactly how that ships: the pipeline goes green, the UI looks finished, and the fiction only
 * surfaces when somebody acts on it.
 *
 * So the mock is tested for what it REFUSES to produce as much as for what it returns.
 */
import { describe, expect, it } from 'vitest';

import {
  createMockTranscriptionProvider,
  createUnconfiguredTranscriptionProvider,
  TranscriptionNotConfiguredError,
  TRANSCRIPT_SPEAKERS,
} from './transcription.provider.js';

const audio = { audio: Buffer.from('not really audio'), mimeType: 'audio/mp4' };

describe('the mock provider', () => {
  it('returns exactly the fixture it was given', async () => {
    const provider = createMockTranscriptionProvider({
      segments: [
        { text: 'Hello, this is Vistaar.', speaker: TRANSCRIPT_SPEAKERS.AGENT, startSeconds: 0 },
        { text: 'Yes, tell me.', speaker: TRANSCRIPT_SPEAKERS.CUSTOMER, startSeconds: 3 },
      ],
      diarized: true,
      detectedLanguage: 'en-IN',
    });

    const result = await provider.transcribe(audio);

    expect(result.segments).toHaveLength(2);
    expect(result.text).toBe('Hello, this is Vistaar. Yes, tell me.');
    expect(result.detectedLanguage).toBe('en-IN');
    expect(result.diarized).toBe(true);
  });

  it('INVENTS NOTHING when given no fixture', async () => {
    // An empty transcript is the correct representation of "we ran, and there was nothing to
    // hear". Filler here is how fiction reaches a customer record.
    const result = await createMockTranscriptionProvider().transcribe(audio);

    expect(result.segments).toEqual([]);
    expect(result.text).toBe('');
    expect(result.detectedLanguage).toBeNull();
  });

  it('REFUSES TO CLAIM DIARIZATION when no segment carries a speaker', async () => {
    // The likely Kannada outcome: a usable transcript with no speaker labels. Reporting
    // `diarized: true` anyway would let the UI draw an Agent/Customer split over nothing.
    const result = await createMockTranscriptionProvider({
      segments: [{ text: 'ಒಂದು ನಿಮಿಷ' }, { text: 'ಸರಿ' }],
      diarized: true,
    }).transcribe(audio);

    expect(result.diarized).toBe(false);
    expect(result.segments.every((segment) => segment.speaker === undefined)).toBe(true);
  });

  it('carries timestamps when the fixture has them, and omits them when it does not', async () => {
    const withTimes = await createMockTranscriptionProvider({
      segments: [{ text: 'a', startSeconds: 0, endSeconds: 2 }],
    }).transcribe(audio);
    const without = await createMockTranscriptionProvider({
      segments: [{ text: 'a' }],
    }).transcribe(audio);

    expect(withTimes.segments[0]?.startSeconds).toBe(0);
    expect(without.segments[0]?.startSeconds).toBeUndefined();
  });

  it('can fail on demand, so the pipeline’s failure path is testable', async () => {
    const provider = createMockTranscriptionProvider({ failWith: new Error('BOOM') });

    await expect(provider.transcribe(audio)).rejects.toThrow('BOOM');
  });

  it('drops blank segments from the flat text rather than leaving double spaces', async () => {
    const result = await createMockTranscriptionProvider({
      segments: [{ text: 'one' }, { text: '   ' }, { text: 'two' }],
    }).transcribe(audio);

    expect(result.text).toBe('one two');
  });
});

describe('the unconfigured provider', () => {
  it('is the honest production default: it refuses rather than inventing', async () => {
    const provider = createUnconfiguredTranscriptionProvider();

    expect(provider.isConfigured()).toBe(false);
    await expect(provider.transcribe(audio)).rejects.toBeInstanceOf(
      TranscriptionNotConfiguredError,
    );
  });

  it('throws a code an operator can act on', async () => {
    await expect(createUnconfiguredTranscriptionProvider().transcribe(audio)).rejects.toThrow(
      'TRANSCRIPTION_NOT_CONFIGURED',
    );
  });
});
