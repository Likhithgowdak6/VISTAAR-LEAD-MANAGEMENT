import { type HydratedDocument } from 'mongoose';

import { logger } from '../../config/logger.js';
import { ACTIVITY_EVENTS } from '../../constants/activity-events.js';
import { RECORDING_STATUSES, PROCESSING_STATUSES } from '../../constants/call-statuses.js';
import { type Permission } from '../../constants/permissions.js';
import { type ObjectIdLike } from '../../types/common.js';
import { createActivity } from '../activity/activity-log.repository.js';
import {
  isValidMediaObjectKey,
  mediaStorage as defaultMediaStorage,
  type MediaStorage,
} from '../media/media-storage.service.js';
import { type UserDocument } from '../users/user.model.js';
import {
  deleteCallAnalysis,
  setSummaryStatus,
  setTranscriptionStatus,
} from './call-analysis.repository.js';
import { clearCallRecording } from './call-record.repository.js';
import { getCallForActor } from './call-record.service.js';
import { serializeCallRecord } from './call-record.serializer.js';

/**
 * Destroying call data on purpose.
 *
 * THE ORDER IS THE WHOLE SAFETY STORY, and it is: delete the bytes first, clear the reference
 * second. Reversed - or done in parallel - a storage failure leaves a row saying the recording
 * is gone beside a file that is still on disk. Nothing would ever look at that file again: it
 * would not appear in any UI, no retention sweep would reconsider it, and no one would know
 * the studio was still holding a customer's recorded conversation. A visible failure is
 * strictly better than a silent orphan.
 *
 * SO A STORAGE FAILURE IS NOT SWALLOWED. If the object cannot be removed, this throws and the
 * row is left exactly as it was. The agent sees an error, the recording still plays, and a
 * retry does the whole thing again - which is safe, because removing an already-removed file
 * succeeds.
 *
 * WHAT DELETION DOES NOT TOUCH: follow-up tasks. A task an agent confirmed is ordinary CRM
 * work by the time it exists, created by a human decision rather than by the transcript. If
 * they want it gone they cancel it in Tasks, where the action says what it does.
 */

export class RecordingDeletionFailedError extends Error {
  constructor() {
    super('RECORDING_DELETE_FAILED');
    this.name = 'RecordingDeletionFailedError';
  }
}

export interface DeleteCallRecordingParams {
  organizationId: ObjectIdLike;
  callId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
  permissions: readonly Permission[];
  storage?: MediaStorage;
}

export const deleteCallRecordingForActor = async ({
  organizationId,
  callId,
  actor,
  permissions,
  storage = defaultMediaStorage,
}: DeleteCallRecordingParams) => {
  // The same conversation gate as every other call operation. The ROUTE additionally requires
  // conversations.delete, so a staff member who can read a lead cannot destroy its recordings.
  const call = await getCallForActor({ organizationId, callId, actor, permissions });

  const objectKey = call.recordingObjectKey;

  if (!objectKey) {
    // Already gone, or never there. Reported as success rather than as an error: the caller
    // asked for the recording to not exist, and it does not. That is what makes a retry safe.
    return serializeCallRecord(call);
  }

  if (!isValidMediaObjectKey(objectKey)) {
    /*
     * A malformed key must never be handed to the filesystem - the key shape is what stops a
     * `..` escaping the storage root. The reference is cleared so the row stops claiming audio
     * it cannot name, and this is logged because it means a row was corrupted somehow.
     */
    logger.warn({ callId: String(call._id) }, 'Call recording key was malformed; reference cleared.');
  } else {
    try {
      await storage.deleteMediaObject(objectKey);
    } catch (error: unknown) {
      // NOT swallowed and NOT reported as success. The row keeps its reference so a retry can
      // try again, and so nobody believes the audio is gone when it is not.
      logger.error(
        { callId: String(call._id), code: error instanceof Error ? error.name : 'UNKNOWN' },
        'Call recording object could not be deleted.',
      );
      throw new RecordingDeletionFailedError();
    }
  }

  const updated = await clearCallRecording({
    callId: call._id,
    organizationId,
    // Matched in the filter: if somebody replaced the recording between the read and here, we
    // must not clear the reference to a NEW file that is still on disk.
    expectedObjectKey: objectKey,
    status: RECORDING_STATUSES.DELETED,
  });

  if (call.whatsappAccountId) {
    await createActivity({
      organizationId,
      whatsappAccountId: call.whatsappAccountId,
      conversationId: call.conversationId,
      actorId: actor._id,
      eventType: ACTIVITY_EVENTS.CALL_RECORDING_DELETED,
      summary: 'The recording for this call was deleted.',
      // Who and which call. NEVER the storage key, the size, or anything the audio contained.
      metadata: { callId: String(call._id), reason: 'manual' },
    });
  }

  // `updated` is null when a concurrent delete won the race - the bytes are gone either way,
  // which is the outcome that was asked for.
  return serializeCallRecord(updated ?? call);
};

export interface DeleteCallAnalysisParams {
  organizationId: ObjectIdLike;
  callId: ObjectIdLike;
  actor: HydratedDocument<UserDocument>;
  permissions: readonly Permission[];
}

/**
 * Destroys a call's transcript, summary and suggestions.
 *
 * THE RECORDING IS LEFT ALONE. They are separate decisions with separate retention settings,
 * and somebody deleting an inaccurate AI summary almost never means "and destroy the evidence
 * of what was actually said".
 *
 * CONFIRMED TASKS SURVIVE. Deleting the suggestion records does not cancel the reminders they
 * became - see call-analysis.repository.ts.
 */
export const deleteCallAnalysisForActor = async ({
  organizationId,
  callId,
  actor,
  permissions,
}: DeleteCallAnalysisParams) => {
  const call = await getCallForActor({ organizationId, callId, actor, permissions });

  const result = await deleteCallAnalysis({ organizationId, callId: call._id });

  // Statuses go back to "nothing to do". Without this the call would still read as having a
  // completed transcript that no longer exists, and the sweep would never reconsider it.
  await setTranscriptionStatus({
    callId: call._id,
    status: call.recordingObjectKey
      ? // Audio is still here, so it can be transcribed again. Pending, not completed.
        PROCESSING_STATUSES.PENDING
      : PROCESSING_STATUSES.NOT_APPLICABLE,
  });
  await setSummaryStatus({ callId: call._id, status: PROCESSING_STATUSES.NOT_APPLICABLE });

  // Only logged when something was actually destroyed, so a retry does not fill the timeline
  // with repeated deletions of nothing.
  if (result.deletedCount > 0 && call.whatsappAccountId) {
    await createActivity({
      organizationId,
      whatsappAccountId: call.whatsappAccountId,
      conversationId: call.conversationId,
      actorId: actor._id,
      eventType: ACTIVITY_EVENTS.CALL_ANALYSIS_DELETED,
      summary: 'The transcript and AI summary for this call were deleted.',
      // No transcript text, no summary text, no commitment titles.
      metadata: { callId: String(call._id), reason: 'manual' },
    });
  }

  return { deleted: result.deletedCount > 0 };
};
