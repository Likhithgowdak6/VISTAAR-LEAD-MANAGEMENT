import { logger } from '../../config/logger.js';
import { PROCESSING_STATUSES } from '../../constants/call-statuses.js';
import {
  mediaStorage as defaultMediaStorage,
  isValidMediaObjectKey,
  type MediaStorage,
} from '../media/media-storage.service.js';
import {
  claimCallForTranscription,
  saveTranscript,
  setSummaryStatus,
  setTranscriptionStatus,
} from './call-analysis.repository.js';
import {
  createUnconfiguredTranscriptionProvider,
  type TranscriptionProvider,
} from './transcription.provider.js';

/**
 * Turning an uploaded recording into words, one call per pass.
 *
 * THE DEFAULT PROVIDER REFUSES, and that is the intended production behaviour until a paid
 * service is chosen and approved. A call with audio then ends as `failed` with
 * `TRANSCRIPTION_NOT_CONFIGURED` - which is visible, actionable and true. The alternatives
 * were worse: silence would look like a stuck queue, and anything that produced text would be
 * inventing a customer's words.
 *
 * IDEMPOTENT BY CONSTRUCTION. The claim is a conditional update, so two workers cannot both
 * take the same call; the write is an upsert keyed on `callId`, so a retry replaces rather than
 * duplicates; and the summary is cleared with it, so a stale summary can never sit beside a
 * fresh transcript.
 *
 * NOTHING HERE LOGS WHAT WAS SAID. Not a segment, not a snippet, not the detected language
 * alongside an id that would make it identifying. Logs carry a call id, a provider name and a
 * failure code - enough to debug, nothing a customer would mind being in a log file.
 */

let provider: TranscriptionProvider = createUnconfiguredTranscriptionProvider();

/** Swapped by tests, and by configuration once a provider is approved. */
export const setTranscriptionProvider = (next: TranscriptionProvider): void => {
  provider = next;
};

export const getTranscriptionProvider = (): TranscriptionProvider => provider;

export interface ProcessNextTranscriptionParams {
  storage?: MediaStorage;
  now?: Date;
}

export type ProcessTranscriptionOutcome =
  | { processed: false; reason: 'idle' }
  | { processed: true; callId: string; status: 'completed' | 'failed' };

/**
 * Claims and transcribes at most one call.
 *
 * ONE PER PASS rather than draining the queue, matching the reminder sweep: a long batch holds
 * the lease on everything it took, and a crash halfway through strands all of it rather than one.
 */
export const processNextTranscription = async ({
  storage = defaultMediaStorage,
  now = new Date(),
}: ProcessNextTranscriptionParams = {}): Promise<ProcessTranscriptionOutcome> => {
  const call = await claimCallForTranscription({ now });

  if (!call) {
    return { processed: false, reason: 'idle' };
  }

  const callId = String(call._id);

  try {
    const objectKey = call.recordingObjectKey;

    if (!objectKey || !isValidMediaObjectKey(objectKey)) {
      // The row says it has audio and does not actually name any. Failed rather than retried
      // forever: no amount of waiting will produce a key.
      throw new Error('RECORDING_KEY_INVALID');
    }

    if (!provider.isConfigured()) {
      // Checked BEFORE reading the file: there is no point loading megabytes of audio into
      // memory to hand it to something that will refuse it.
      throw new Error('TRANSCRIPTION_NOT_CONFIGURED');
    }

    const audio = await storage.readMediaObject(objectKey);

    const result = await provider.transcribe({
      audio,
      mimeType: call.recordingMimeType ?? 'application/octet-stream',
    });

    await saveTranscript({
      organizationId: call.organizationId,
      conversationId: call.conversationId,
      callId: call._id,
      segments: result.segments.map((segment) => ({
        startSeconds: segment.startSeconds ?? null,
        endSeconds: segment.endSeconds ?? null,
        text: segment.text,
        // Carried only when the provider supplied it. Never derived from turn order - "the
        // first voice is the agent" is wrong the moment the customer speaks first.
        speaker: segment.speaker ?? null,
      })),
      text: result.text,
      detectedLanguage: result.detectedLanguage,
      diarized: result.diarized,
      provider: result.provider,
    });

    await setTranscriptionStatus({ callId: call._id, status: PROCESSING_STATUSES.COMPLETED });
    // Hands the call to the summariser. Pending, not running - the two are separate sweeps so
    // a summariser outage cannot cost a transcript that was paid for.
    await setSummaryStatus({ callId: call._id, status: PROCESSING_STATUSES.PENDING });

    logger.info({ callId, provider: result.provider }, 'Call transcript stored.');

    return { processed: true, callId, status: 'completed' };
  } catch (error: unknown) {
    const code = error instanceof Error ? error.message : 'TRANSCRIPTION_FAILED';

    await setTranscriptionStatus({
      callId: call._id,
      status: PROCESSING_STATUSES.FAILED,
      // A code, never a provider's raw error body - those have been known to echo the payload.
      error: code.slice(0, 200),
    });

    logger.warn({ callId, code }, 'Call transcription failed.');

    return { processed: true, callId, status: 'failed' };
  }
};
