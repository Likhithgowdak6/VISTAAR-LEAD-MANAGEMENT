import { type QueryFilter, type UpdateQuery } from 'mongoose';

import { type CallStatus } from '../../constants/call-statuses.js';
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
