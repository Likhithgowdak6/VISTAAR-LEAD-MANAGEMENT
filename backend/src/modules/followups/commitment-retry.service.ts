/**
 * Re-runs commitment extraction for turns whose first attempt never got an answer.
 *
 * WHAT IT IS NOT. Not a second scheduler - this is called from the reminder runner's existing
 * tick, so there is one interval loop for both. Not a general job queue either: it does exactly
 * one kind of work, and the row it reads is deleted as soon as that work is settled.
 *
 * EXTRACTION IS CALLED THE SAME WAY THE LIVE PATH CALLS IT, deliberately. Every rule about
 * opt-out, confidence, time resolution, superseding an existing reminder and the
 * `lead-commit:<messageId>` idempotency key lives in lead-commitment.service.ts, and a retry
 * that reimplemented any of them would drift from the live path exactly when it mattered. The
 * only difference is `enqueueOnFailure: false`, so a retry that fails again updates its own row
 * rather than queueing a second one.
 *
 * FOUR OUTCOMES, and only one of them keeps the row:
 *
 *   settled      - extraction returned. A reminder was created, or there was no commitment, or
 *                  the time was unusable. All three are answers. Row deleted.
 *   transient    - the classifier failed again, inside the budget. Row kept, backed off.
 *   exhausted    - out of attempts. Logged loudly and deleted; nothing retries forever.
 *   terminal     - a failure that will not change. Deleted immediately rather than burning
 *                  three more LLM calls to confirm it.
 */
import { env, type Env } from '../../config/env.js';
import { logger as defaultLogger } from '../../config/logger.js';
import {
  abandonCommitmentRetry as defaultAbandonCommitmentRetry,
  claimCommitmentRetry as defaultClaimCommitmentRetry,
  deleteCommitmentRetry as defaultDeleteCommitmentRetry,
  MAX_COMMITMENT_RETRY_ATTEMPTS,
  rescheduleCommitmentRetry as defaultRescheduleCommitmentRetry,
} from './commitment-retry.repository.js';
import { createLeadCommitmentService, type LeadCommitmentService } from './lead-commitment.service.js';
import { describeFailure, isTransientAiFailure } from './transient-failure.js';

type Logger = { info?: (...args: unknown[]) => void; error?: (...args: unknown[]) => void };

export interface CreateCommitmentRetrySweepOptions {
  config?: Env;
  claimCommitmentRetry?: typeof defaultClaimCommitmentRetry;
  deleteCommitmentRetry?: typeof defaultDeleteCommitmentRetry;
  abandonCommitmentRetry?: typeof defaultAbandonCommitmentRetry;
  rescheduleCommitmentRetry?: typeof defaultRescheduleCommitmentRetry;
  extractLeadCommitment?: LeadCommitmentService['extractLeadCommitment'];
  now?: () => Date;
  logger?: Logger;
}

export interface CommitmentRetrySweepResult {
  claimed: number;
  created: number;
  settled: number;
  retrying: number;
  exhausted: number;
}

export const createCommitmentRetrySweepService = ({
  config = env,
  claimCommitmentRetry = defaultClaimCommitmentRetry,
  deleteCommitmentRetry = defaultDeleteCommitmentRetry,
  abandonCommitmentRetry = defaultAbandonCommitmentRetry,
  rescheduleCommitmentRetry = defaultRescheduleCommitmentRetry,
  // Built lazily and WITHOUT re-enqueueing, so a retry that fails again cannot queue a copy of
  // itself. Its own row already records the attempt.
  extractLeadCommitment = (params) =>
    createLeadCommitmentService({ enqueueOnFailure: false }).extractLeadCommitment(params),
  now = () => new Date(),
  logger = defaultLogger,
}: CreateCommitmentRetrySweepOptions = {}) => {
  /**
   * One pass. Bounded per tick so a backlog drains over several sweeps rather than firing a
   * burst of LLM calls at a service that has just finished being unwell.
   */
  const sweepOnce = async ({ limit = 10 }: { limit?: number } = {}): Promise<CommitmentRetrySweepResult> => {
    const result: CommitmentRetrySweepResult = {
      claimed: 0,
      created: 0,
      settled: 0,
      retrying: 0,
      exhausted: 0,
    };

    const handled = new Set<string>();

    for (let processed = 0; processed < limit; processed += 1) {
      const row = await claimCommitmentRetry({ now: now() });

      if (!row) {
        break;
      }

      const messageId = String(row.messageId);
      // Proof that this worker still owns the row. Every write below carries it, so a stalled
      // worker whose lease was reclaimed cannot destroy the new holder's claim.
      const claimToken = row.claimToken ?? null;

      // Belt and braces against re-handling one turn inside a single sweep, the same guard the
      // reminder sweep carries.
      if (handled.has(messageId)) {
        break;
      }

      handled.add(messageId);
      result.claimed += 1;

      // Out of attempts. Said loudly, because this is the point at which a commitment the
      // customer actually made is being abandoned, and nothing downstream will mention it again.
      if (row.attempts > MAX_COMMITMENT_RETRY_ATTEMPTS) {
        logger?.error?.(
          {
            conversationId: String(row.conversationId),
            attempts: row.attempts,
            lastError: row.lastError,
          },
          'REMINDER_EXTRACT: giving up on this turn after repeated classifier failures; no reminder will be created.',
        );

        await abandonCommitmentRetry({ messageId, claimToken, lastError: row.lastError });
        result.exhausted += 1;

        continue;
      }

      try {
        const outcome = await extractLeadCommitment({
          organizationId: row.organizationId,
          whatsappAccountId: row.whatsappAccountId ?? undefined,
          conversationId: row.conversationId,
          text: row.text,
          messageId,
          optedOut: row.optedOut,
        });

        // FAILED AGAIN, not answered. extractLeadCommitment swallows its own errors and
        // returns, so without this flag a classifier that timed out twice would look exactly
        // like "no commitment here" and the row would be dropped after one attempt - the retry
        // ladder would not exist.
        if (outcome?.retryable) {
          await rescheduleCommitmentRetry({
            messageId,
            claimToken,
            lastError: 'transient',
            attempts: row.attempts,
            now: now(),
          });

          result.retrying += 1;

          continue;
        }

        // SETTLED, whatever it decided. "No commitment in this turn" is an answer, and asking
        // again would cost an LLM call to be told the same thing.
        await deleteCommitmentRetry({ messageId, claimToken });
        result.settled += 1;

        if (outcome?.created || outcome?.updated) {
          result.created += 1;

          logger?.info?.(
            { conversationId: String(row.conversationId), attempts: row.attempts },
            'REMINDER_EXTRACT: recovered a commitment on retry.',
          );
        }
      } catch (error: unknown) {
        // extractLeadCommitment catches its own failures and returns, so reaching here means
        // something outside it broke. Treated with the same rule: ask again only if asking
        // again could plausibly work.
        if (!isTransientAiFailure(error)) {
          logger?.error?.(
            { conversationId: String(row.conversationId), reason: describeFailure(error) },
            'REMINDER_EXTRACT: retry failed terminally; abandoning this turn.',
          );

          await abandonCommitmentRetry({
            messageId,
            claimToken,
            lastError: describeFailure(error),
          });
          result.exhausted += 1;

          continue;
        }

        await rescheduleCommitmentRetry({
          messageId,
          claimToken,
          lastError: describeFailure(error),
          attempts: row.attempts,
          now: now(),
        });

        result.retrying += 1;
      }
    }

    if (result.claimed > 0) {
      logger?.info?.({ ...result }, 'COMMITMENT_RETRY_SWEEP');
    }

    return result;
  };

  return { sweepOnce, config };
};

export type CommitmentRetrySweepService = ReturnType<typeof createCommitmentRetrySweepService>;
