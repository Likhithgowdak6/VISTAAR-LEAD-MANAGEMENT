import { logger } from '../../config/logger.js';
import { ACTIVITY_EVENTS } from '../../constants/activity-events.js';
import {
  RECORDING_STATUSES,
  type CallRetentionPolicy,
} from '../../constants/call-statuses.js';
import { type ObjectIdLike } from '../../types/common.js';
import { createActivity } from '../activity/activity-log.repository.js';
import {
  isValidMediaObjectKey,
  mediaStorage as defaultMediaStorage,
  type MediaStorage,
} from '../media/media-storage.service.js';
import { Organization } from '../organizations/organization.model.js';
import {
  clearCallSummary,
  countExpiredAnalyses,
  deleteCallAnalysis,
  findExpiredAnalyses,
} from './call-analysis.repository.js';
import {
  clearCallRecording,
  countExpiredRecordings,
  findExpiredRecordings,
} from './call-record.repository.js';

/**
 * Deleting old call data on a schedule, once somebody has asked for that.
 *
 * NOTHING HAPPENS UNTIL A NUMBER IS SET. Every retention field defaults to null and null means
 * keep forever. This sweep resolves an organisation's policy first and returns immediately if
 * there is none - so deploying this code to a database full of existing customer calls deletes
 * exactly nothing until the owner makes a decision. That is deliberate: the alternative is a
 * default period silently destroying recordings nobody agreed to destroy, and deletion cannot
 * be undone.
 *
 * THE DRY RUN IS NOT A COURTESY. "Show me what this would delete" is the only way to make an
 * irreversible scheduled job safe to turn on, and it reports COUNTS AND IDS ONLY - never a
 * transcript, a summary line, or anything the audio contained.
 *
 * ONE ORGANISATION, ONE ITEM, ONE PASS. Retention is a per-studio setting, so a cross-tenant
 * query would apply one studio's policy to another's data. And draining a whole backlog in a
 * single tick means a crash halfway leaves an unknown amount done; one at a time is slower and
 * always resumable.
 *
 * WHAT THIS CAN REACH, exhaustively: a CallRecord's own audio object, and a CallAnalysis
 * document. It never touches conversations, messages, message attachments, contacts or tasks -
 * the queries are on the two call collections and the only file it deletes is the key stored
 * on the row it is processing.
 */

const DAY_MS = 86_400_000;

/** Null, zero and nonsense all mean "no policy". Only a positive number is a policy. */
const cutoffFor = (days: number | null | undefined, now: Date): Date | null =>
  typeof days === 'number' && Number.isFinite(days) && days > 0
    ? new Date(now.getTime() - days * DAY_MS)
    : null;

export interface ResolveRetentionPolicyParams {
  organizationId: ObjectIdLike;
}

export const resolveRetentionPolicy = async ({
  organizationId,
}: ResolveRetentionPolicyParams): Promise<CallRetentionPolicy> => {
  const organization = await Organization.findById(organizationId).select({ callRetention: 1 }).lean();
  const configured = (organization as { callRetention?: Partial<CallRetentionPolicy> } | null)
    ?.callRetention;

  return {
    recordingDays: configured?.recordingDays ?? null,
    transcriptDays: configured?.transcriptDays ?? null,
    summaryDays: configured?.summaryDays ?? null,
  };
};

export interface RetentionPreview {
  policy: CallRetentionPolicy;
  /** True when every field is null - nothing will ever be deleted. */
  unconfigured: boolean;
  recordings: { count: number; cutoff: string | null };
  transcripts: { count: number; cutoff: string | null };
  summaries: { count: number; cutoff: string | null };
}

export interface PreviewRetentionParams {
  organizationId: ObjectIdLike;
  now?: Date;
}

/**
 * What the sweep WOULD delete, without deleting anything.
 *
 * Counts only. No ids of individual customers, no transcript excerpts, no file names - a
 * preview that leaked content would be a new way to read the data it is about to destroy.
 */
export const previewRetention = async ({
  organizationId,
  now = new Date(),
}: PreviewRetentionParams): Promise<RetentionPreview> => {
  const policy = await resolveRetentionPolicy({ organizationId });

  const recordingCutoff = cutoffFor(policy.recordingDays, now);
  const transcriptCutoff = cutoffFor(policy.transcriptDays, now);
  const summaryCutoff = cutoffFor(policy.summaryDays, now);

  const [recordings, transcripts, summaries] = await Promise.all([
    recordingCutoff
      ? countExpiredRecordings({ organizationId, startedBefore: recordingCutoff })
      : Promise.resolve(0),
    transcriptCutoff
      ? countExpiredAnalyses({ organizationId, createdBefore: transcriptCutoff })
      : Promise.resolve(0),
    summaryCutoff
      ? countExpiredAnalyses({
          organizationId,
          createdBefore: summaryCutoff,
          requireSummary: true,
        })
      : Promise.resolve(0),
  ]);

  return {
    policy,
    unconfigured: !recordingCutoff && !transcriptCutoff && !summaryCutoff,
    recordings: { count: recordings, cutoff: recordingCutoff?.toISOString() ?? null },
    transcripts: { count: transcripts, cutoff: transcriptCutoff?.toISOString() ?? null },
    summaries: { count: summaries, cutoff: summaryCutoff?.toISOString() ?? null },
  };
};

export interface RunRetentionParams {
  organizationId: ObjectIdLike;
  storage?: MediaStorage;
  now?: Date;
  /** How many of each kind to process in one pass. Bounded so a tick cannot run away. */
  batchSize?: number;
}

export interface RetentionRunResult {
  recordingsDeleted: number;
  analysesDeleted: number;
  summariesCleared: number;
  failures: number;
}

/**
 * Applies one organisation's policy, once.
 *
 * IDEMPOTENT BY QUERY SHAPE rather than by a claim flag. Each query only matches rows that
 * still hold the thing being deleted - a recording with a key, an analysis that exists, a
 * summary that is non-null - so a row that has already been processed cannot be selected
 * again. Re-running the sweep immediately finds nothing and does nothing.
 *
 * A FAILURE SKIPS, IT DOES NOT MARK. When a storage delete fails the reference is left intact
 * so the next pass retries, and so nothing claims the audio is gone while it is still there.
 */
export const runRetentionForOrganization = async ({
  organizationId,
  storage = defaultMediaStorage,
  now = new Date(),
  batchSize = 25,
}: RunRetentionParams): Promise<RetentionRunResult> => {
  const result: RetentionRunResult = {
    recordingsDeleted: 0,
    analysesDeleted: 0,
    summariesCleared: 0,
    failures: 0,
  };

  const policy = await resolveRetentionPolicy({ organizationId });

  const recordingCutoff = cutoffFor(policy.recordingDays, now);
  const transcriptCutoff = cutoffFor(policy.transcriptDays, now);
  const summaryCutoff = cutoffFor(policy.summaryDays, now);

  if (!recordingCutoff && !transcriptCutoff && !summaryCutoff) {
    // THE DEFAULT PATH. No policy, no deletion, no log line - this is the normal state of an
    // organisation that has not opted in, and it must stay silent rather than look like work.
    return result;
  }

  if (recordingCutoff) {
    const expired = await findExpiredRecordings({
      organizationId,
      startedBefore: recordingCutoff,
      limit: batchSize,
    });

    for (const call of expired) {
      const objectKey = call.recordingObjectKey;

      if (!objectKey) {
        continue;
      }

      try {
        if (isValidMediaObjectKey(objectKey)) {
          // The ONLY file this sweep ever removes: the key stored on the row in hand. It does
          // not walk directories and cannot reach a message attachment.
          await storage.deleteMediaObject(objectKey);
        }

        const updated = await clearCallRecording({
          callId: call._id,
          organizationId,
          expectedObjectKey: objectKey,
          status: RECORDING_STATUSES.DELETED,
        });

        if (updated) {
          result.recordingsDeleted += 1;

          if (call.whatsappAccountId) {
            await createActivity({
              organizationId,
              whatsappAccountId: call.whatsappAccountId,
              conversationId: call.conversationId,
              // No actor: this was the policy, not a person.
              actorId: null,
              eventType: ACTIVITY_EVENTS.CALL_RECORDING_DELETED,
              summary: 'The recording for this call was deleted by the retention policy.',
              metadata: { callId: String(call._id), reason: 'retention' },
            });
          }
        }
      } catch (error: unknown) {
        result.failures += 1;
        logger.warn(
          { callId: String(call._id), code: error instanceof Error ? error.name : 'UNKNOWN' },
          'Retention could not delete a call recording.',
        );
      }
    }
  }

  if (transcriptCutoff) {
    const expired = await findExpiredAnalyses({
      organizationId,
      createdBefore: transcriptCutoff,
      limit: batchSize,
    });

    for (const analysis of expired) {
      // Deletes the summary with it. A summary whose transcript is gone is an unverifiable
      // claim about a customer conversation, which is worse than having neither.
      const deleted = await deleteCallAnalysis({ organizationId, callId: analysis.callId });

      if (deleted.deletedCount > 0) {
        result.analysesDeleted += 1;
      }
    }
  } else if (summaryCutoff) {
    /*
     * ONLY when transcripts are kept longer than summaries, which is the case this branch
     * exists for. Running both would mean deleting a summary and then deleting the document it
     * lived in, counting one deletion twice.
     */
    const expired = await findExpiredAnalyses({
      organizationId,
      createdBefore: summaryCutoff,
      requireSummary: true,
      limit: batchSize,
    });

    for (const analysis of expired) {
      await clearCallSummary({ organizationId, callId: analysis.callId });
      result.summariesCleared += 1;
    }
  }

  if (result.recordingsDeleted + result.analysesDeleted + result.summariesCleared > 0) {
    logger.info({ organizationId: String(organizationId), ...result }, 'Call retention pass.');
  }

  return result;
};
