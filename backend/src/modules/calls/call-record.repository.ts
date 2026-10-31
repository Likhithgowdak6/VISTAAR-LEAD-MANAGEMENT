import { type QueryFilter, type UpdateQuery } from 'mongoose';

import {
  type CallStatus,
  type ProcessingStatus,
  type RecordingStatus,
} from '../../constants/call-statuses.js';
import { type ObjectIdLike, type PaginationParams, toObjectId } from '../../types/common.js';
import { CallRecord, type CallRecordDocument } from './call-record.model.js';

export interface CreateCallRecordParams {
  organizationId: ObjectIdLike;
  conversationId: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike | null;
  contactId?: ObjectIdLike | null;
  initiatedBy: ObjectIdLike;
  startedAt: Date;
  idempotencyKey?: string | null;
}

export const createCallRecord = ({
  organizationId,
  conversationId,
  whatsappAccountId = null,
  contactId = null,
  initiatedBy,
  startedAt,
  idempotencyKey = null,
}: CreateCallRecordParams) =>
  CallRecord.create({
    organizationId: toObjectId(organizationId),
    conversationId: toObjectId(conversationId),
    whatsappAccountId: whatsappAccountId ? toObjectId(whatsappAccountId) : null,
    contactId: contactId ? toObjectId(contactId) : null,
    initiatedBy: toObjectId(initiatedBy),
    startedAt,
    // Spread, so a call with no key has no FIELD rather than a null one - see the model on why
    // a null here collides in the sparse unique index.
    ...(idempotencyKey ? { idempotencyKey } : {}),
  });

export interface FindCallRecordByIdParams {
  callId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
}

/** Always org-scoped. A call id from another organisation is not found, not forbidden. */
export const findCallRecordById = ({ callId, organizationId }: FindCallRecordByIdParams = {}) =>
  CallRecord.findOne({ _id: callId, organizationId }).exec();

export interface FindCallRecordByIdempotencyKeyParams {
  organizationId?: ObjectIdLike;
  idempotencyKey?: string;
}

export const findCallRecordByIdempotencyKey = ({
  organizationId,
  idempotencyKey,
}: FindCallRecordByIdempotencyKeyParams = {}) =>
  CallRecord.findOne({ organizationId, idempotencyKey }).exec();

export interface FindCallRecordsByConversationParams extends PaginationParams {
  organizationId?: ObjectIdLike;
  conversationId?: ObjectIdLike;
}

/** Newest first: the call somebody is asking about is almost always the last one. */
export const findCallRecordsByConversation = ({
  organizationId,
  conversationId,
  limit = 25,
  skip = 0,
}: FindCallRecordsByConversationParams = {}) =>
  CallRecord.find({ organizationId, conversationId })
    // `_id` after `startedAt` makes the order TOTAL: two calls in the same second would
    // otherwise be free to swap between pages, so one shows twice and the other never.
    .sort({ startedAt: -1, _id: -1 })
    .skip(skip)
    .limit(limit)
    .exec();

export interface UpdateCallOutcomeParams {
  callId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  status: CallStatus;
  endedAt?: Date | null;
  durationSeconds?: number | null;
  awaySeconds?: number | null;
}

/**
 * Records what a human said happened.
 *
 * Org-scoped in the FILTER rather than checked beforehand, so there is no window between the
 * check and the write in which the row could belong to somebody else.
 */
export const updateCallOutcome = ({
  callId,
  organizationId,
  status,
  endedAt,
  durationSeconds,
  awaySeconds,
}: UpdateCallOutcomeParams) => {
  const update: UpdateQuery<CallRecordDocument> = { status };

  if (endedAt !== undefined) {
    update.endedAt = endedAt;
  }

  if (durationSeconds !== undefined) {
    update.durationSeconds = durationSeconds;
  }

  if (awaySeconds !== undefined) {
    update.awaySeconds = awaySeconds;
  }

  return CallRecord.findOneAndUpdate(
    { _id: callId, organizationId },
    { $set: update },
    { returnDocument: 'after', runValidators: true },
  ).exec();
};

export interface AttachCallRecordingParams {
  callId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  recordingObjectKey: string;
  recordingMimeType: string;
  recordingSizeBytes: number;
  recordingStatus: RecordingStatus;
  transcriptionStatus: ProcessingStatus;
}

/**
 * Points a call at stored audio and arms the pipeline behind it.
 *
 * ONE WRITE, not two. Attaching the bytes and marking the transcript pending have to land
 * together: a row that has audio but says `not_applicable` is invisible to the sweep forever,
 * and one that says `pending` with no audio is a job that can never succeed.
 */
export const attachCallRecording = ({
  callId,
  organizationId,
  recordingObjectKey,
  recordingMimeType,
  recordingSizeBytes,
  recordingStatus,
  transcriptionStatus,
}: AttachCallRecordingParams) =>
  CallRecord.findOneAndUpdate(
    { _id: callId, organizationId },
    {
      $set: {
        recordingObjectKey,
        recordingMimeType,
        recordingSizeBytes,
        recordingStatus,
        transcriptionStatus,
        transcriptionError: null,
      },
    },
    { returnDocument: 'after', runValidators: true },
  ).exec();

export interface ClearCallRecordingParams {
  callId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  /**
   * The key the caller believes it just deleted from storage.
   *
   * MATCHED IN THE FILTER, not just passed for reference. Between reading the row and clearing
   * it, somebody could have replaced the recording - and clearing unconditionally would wipe
   * the reference to a NEW file that is still on disk, orphaning it forever. Matching the key
   * means the update applies to the row we actually acted on, or to nothing.
   */
  expectedObjectKey: string;
  status: RecordingStatus;
}

/**
 * Forgets where a call's audio lived, after the bytes are already gone.
 *
 * ORDER MATTERS AND IT IS THE CALLER'S JOB: delete the object FIRST, clear the reference
 * second. Reversed, a storage failure leaves a row saying "deleted" beside a file that is still
 * there - which is the one outcome a retention feature must never produce, because nothing will
 * ever look at that file again.
 *
 * Returns null when nothing matched, which the caller reads as "somebody else already did it".
 */
export const clearCallRecording = ({
  callId,
  organizationId,
  expectedObjectKey,
  status,
}: ClearCallRecordingParams) =>
  CallRecord.findOneAndUpdate(
    { _id: callId, organizationId, recordingObjectKey: expectedObjectKey },
    {
      $set: {
        recordingObjectKey: null,
        recordingStatus: status,
        recordingMimeType: null,
        recordingSizeBytes: null,
        recordingDurationSeconds: null,
      },
    },
    { returnDocument: 'after', runValidators: true },
  ).exec();

export interface FindExpiredRecordingsParams {
  organizationId: ObjectIdLike;
  /** Calls that started before this moment have outlived the policy. */
  startedBefore: Date;
  limit?: number;
}

/**
 * Calls whose audio is past this organisation's retention period.
 *
 * SCOPED TO ONE ORGANISATION, ALWAYS. Retention is a per-studio setting, so a sweep that
 * queried across tenants would apply one studio's policy to another's recordings. The caller
 * resolves the policy first and only then asks for that organisation's rows.
 *
 * Only rows that ACTUALLY HAVE A KEY are returned, so a call whose audio is already gone is
 * never reconsidered - which is most of what makes the sweep idempotent.
 */
export const findExpiredRecordings = ({
  organizationId,
  startedBefore,
  limit = 25,
}: FindExpiredRecordingsParams) =>
  CallRecord.find({
    organizationId,
    recordingObjectKey: { $ne: null },
    startedAt: { $lt: startedBefore },
  })
    .sort({ startedAt: 1 })
    .limit(limit)
    .exec();

export interface CountExpiredRecordingsParams {
  organizationId: ObjectIdLike;
  startedBefore: Date;
}

export const countExpiredRecordings = ({
  organizationId,
  startedBefore,
}: CountExpiredRecordingsParams) =>
  CallRecord.countDocuments({
    organizationId,
    recordingObjectKey: { $ne: null },
    startedAt: { $lt: startedBefore },
  }).exec();

export interface CountCallRecordsParams {
  organizationId?: ObjectIdLike;
  conversationId?: ObjectIdLike;
}

export const countCallRecords = ({
  organizationId,
  conversationId,
}: CountCallRecordsParams = {}) => {
  const filter: QueryFilter<CallRecordDocument> = { organizationId, conversationId };

  return CallRecord.countDocuments(filter).exec();
};
