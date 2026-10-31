/**
 * The seam between "we have audio" and "some paid service turns it into words".
 *
 * NO PROVIDER IS CHOSEN OR CALLED HERE, and that is the point of the file. Picking one is a
 * decision with real money and real privacy consequences attached - customer audio leaving the
 * server - and it has not been made. So this defines the shape the pipeline needs, ships a mock
 * that satisfies it, and leaves exactly one configuration step for later.
 *
 * WHAT THE EVIDENCE SAYS ABOUT THAT CHOICE, recorded here so it is not re-litigated from memory:
 *
 *   - Speaker labels are the PROVIDER'S capability, never ours. Nothing in this interface may
 *     invent them. `speaker` is optional on every segment and a transcript without labels is a
 *     valid, complete transcript - not a degraded one.
 *   - Kannada is the hard constraint for this business. Google Cloud STT v2 lists kn-IN support
 *     but NOT speaker diarization for it; Deepgram's Kannada support could not be confirmed;
 *     Whisper covers it with materially worse quality than Hindi or English. So for Kannada the
 *     likely outcome is an unlabelled transcript, and the model above is built to express that
 *     rather than to pretend otherwise.
 *
 * NOTHING IN THIS FILE PERFORMS NETWORK I/O. The mock is synchronous and deterministic, which is
 * what lets the whole pipeline - upload, transcribe, summarise, extract commitments - be tested
 * end to end with no account, no key, and no customer audio.
 */

/** IETF-ish tags the UI and the providers both understand. */
export const TRANSCRIPTION_LANGUAGES = Object.freeze({
  ENGLISH_IN: 'en-IN',
  HINDI: 'hi-IN',
  KANNADA: 'kn-IN',
  /** Let the provider decide. The honest default for code-switched Indian speech. */
  AUTO: 'auto',
} as const);

export type TranscriptionLanguage =
  (typeof TRANSCRIPTION_LANGUAGES)[keyof typeof TRANSCRIPTION_LANGUAGES];

/** Who a segment is attributed to. `unknown` is a real answer, not a placeholder. */
export const TRANSCRIPT_SPEAKERS = Object.freeze({
  AGENT: 'agent',
  CUSTOMER: 'customer',
  UNKNOWN: 'unknown',
} as const);

export type TranscriptSpeaker = (typeof TRANSCRIPT_SPEAKERS)[keyof typeof TRANSCRIPT_SPEAKERS];

export interface TranscriptSegment {
  /** Seconds from the start of the audio. Omitted when the provider gives no timings. */
  startSeconds?: number;
  endSeconds?: number;
  text: string;
  /**
   * ABSENT unless the provider actually diarised. Never guessed from turn order - "the first
   * voice is the agent" is wrong as soon as the customer speaks first, and a confidently wrong
   * label is worse than none.
   */
  speaker?: TranscriptSpeaker;
}

export interface TranscriptionResult {
  segments: TranscriptSegment[];
  /** Flat text, derived from the segments. Convenience for the summariser and for search. */
  text: string;
  /** What the provider says it heard. Null when it does not report one. */
  detectedLanguage: string | null;
  /** True only when the provider returned per-speaker attribution. */
  diarized: boolean;
  provider: string;
}

export interface TranscribeParams {
  /** The audio itself. Buffers rather than a path, so no provider needs filesystem access. */
  audio: Buffer;
  mimeType: string;
  languageHint?: TranscriptionLanguage;
}

export interface TranscriptionProvider {
  readonly name: string;
  /** Whether this provider is configured enough to be called. The mock is always ready. */
  isConfigured(): boolean;
  transcribe(params: TranscribeParams): Promise<TranscriptionResult>;
}

export class TranscriptionNotConfiguredError extends Error {
  constructor() {
    super('TRANSCRIPTION_NOT_CONFIGURED');
    this.name = 'TranscriptionNotConfiguredError';
  }
}

export interface MockTranscriptionProviderOptions {
  /** Canned segments. Fixture-driven, so a test states exactly what the audio "said". */
  segments?: TranscriptSegment[];
  detectedLanguage?: string | null;
  diarized?: boolean;
  /** Makes the provider throw, so the pipeline's failure path is testable. */
  failWith?: Error;
}

/**
 * A provider that invents nothing.
 *
 * It returns the fixture it was given and NOTHING ELSE - no plausible-sounding filler, no
 * synthesised speaker labels, no made-up language detection. A mock that fabricates content is
 * how a pipeline passes its tests and then produces fiction in production, and the one thing
 * this feature must never do is put words in a customer's mouth.
 *
 * With no fixture it returns an EMPTY transcript, which is the correct representation of "we
 * ran, and there was nothing to hear".
 */
export const createMockTranscriptionProvider = ({
  segments = [],
  detectedLanguage = null,
  diarized = false,
  failWith,
}: MockTranscriptionProviderOptions = {}): TranscriptionProvider => ({
  name: 'mock',
  isConfigured: () => true,
  transcribe: async () => {
    if (failWith) {
      throw failWith;
    }

    return {
      segments,
      text: segments
        .map((segment) => segment.text.trim())
        .filter((text) => text !== '')
        .join(' '),
      detectedLanguage,
      // Reported from the data, not from the flag alone: claiming diarization while no segment
      // carries a speaker would let the UI draw an Agent/Customer split over nothing.
      diarized: diarized && segments.some((segment) => Boolean(segment.speaker)),
      provider: 'mock',
    };
  },
});

/**
 * A provider that refuses, politely.
 *
 * THE PRODUCTION DEFAULT, deliberately. Until a provider is chosen and configured, the correct
 * behaviour for a call with audio is `transcriptionStatus: failed` with a reason an operator can
 * read - not silence, and certainly not a fabricated transcript. Swapping this out is the one
 * remaining configuration step.
 */
export const createUnconfiguredTranscriptionProvider = (): TranscriptionProvider => ({
  name: 'unconfigured',
  isConfigured: () => false,
  transcribe: async () => {
    throw new TranscriptionNotConfiguredError();
  },
});
