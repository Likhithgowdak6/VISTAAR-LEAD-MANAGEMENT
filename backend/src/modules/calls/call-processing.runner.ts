import { logger } from '../../config/logger.js';
import { summariseNextCall } from './call-summary.service.js';
import { processNextTranscription } from './call-transcription.service.js';

/**
 * The background pass that turns uploaded recordings into transcripts and summaries.
 *
 * A `setInterval` RUNNER, matching nurture-runner.ts, delivery-runner.ts and the reminder
 * sweep. This project has no job queue and adding one for two sweeps would be a new piece of
 * infrastructure to operate, monitor and back up - the existing pattern already survives
 * restarts (work is claimed from the database, not from memory) and that is the property that
 * actually matters.
 *
 * SLOWER THAN THE REMINDER SWEEP, deliberately. Reminders tick every five seconds because a
 * late one is a missed customer call. Nothing here is time-critical: a transcript that lands a
 * minute after the call is indistinguishable from one that lands instantly, and each pass can
 * spend real money with a transcription provider. One call per tick also bounds the blast
 * radius of a provider having a bad day.
 *
 * ONE ITEM PER PASS, PER STAGE. Draining a queue in a single tick holds leases on everything it
 * took, so a crash halfway strands all of it rather than one row.
 */

const DEFAULT_INTERVAL_MS = 60_000;

export interface CallProcessingRunner {
  /** True when this call started the timer, false when it was already running. */
  start: () => boolean;
  stop: () => void;
  /** Runs one pass immediately. The seam tests use instead of waiting on a timer. */
  runOnce: () => Promise<void>;
}

export interface CreateCallProcessingRunnerOptions {
  intervalMs?: number;
  transcribe?: typeof processNextTranscription;
  summarise?: typeof summariseNextCall;
}

export const createCallProcessingRunner = ({
  intervalMs = DEFAULT_INTERVAL_MS,
  transcribe = processNextTranscription,
  summarise = summariseNextCall,
}: CreateCallProcessingRunnerOptions = {}): CallProcessingRunner => {
  let timer: ReturnType<typeof setInterval> | null = null;
  /** Stops a slow pass from overlapping the next tick and double-claiming work. */
  let running = false;

  const runOnce = async (): Promise<void> => {
    if (running) {
      return;
    }

    running = true;

    try {
      await transcribe();
      // Summarising runs in the SAME pass but is independently claimed, so a call transcribed
      // on a previous tick is picked up here without waiting for a new recording to arrive.
      await summarise();
    } catch (error: unknown) {
      // A pass must never be able to kill the interval. Both services already handle their own
      // failures and mark the row; anything reaching here is a bug, logged without detail.
      logger.warn(
        { code: error instanceof Error ? error.message : 'UNKNOWN' },
        'Call processing pass failed.',
      );
    } finally {
      running = false;
    }
  };

  return {
    start: () => {
      if (timer) {
        return false;
      }

      timer = setInterval(() => {
        void runOnce();
      }, intervalMs);

      // `unref` so a pending tick cannot hold the process open during a shutdown, matching the
      // other runners in this codebase.
      timer.unref?.();

      logger.info({ intervalMs }, 'Call processing runner started.');

      return true;
    },
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    runOnce,
  };
};
