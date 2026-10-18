/**
 * The call-scheduling queue's operations: register, cancel on reply, claim, settle.
 *
 * Every mutation is a conditional update rather than a read-then-write, matching
 * commitment-retry and the reminder claim. Two backends sweeping during a rolling deploy is
 * ordinary, and a queue that needs them not to overlap is a queue that double-messages
 * customers the week nobody is watching.
 */
import { randomUUID } from 'node:crypto';

import { type UpdateQuery } from 'mongoose';

import { type ObjectIdLike } from '../../types/common.js';
import {
  CALL_SCHEDULING_STATUSES,
  CallSchedulingAttempt,
  type CallSchedulingAttemptDocument,
  type CallSchedulingStatus,
} from './call-scheduling-attempt.model.js';

/** How long the customer has to answer before the owner is told to ring them. */
export const NO_RESPONSE_WINDOW_MS = 60 * 60 * 1000;

/** How many sweeps may try to settle one attempt before it is left alone. */
export const MAX_CALL_SCHEDULING_ATTEMPTS = 4;

/** A crashed worker's lease. Long enough to outlast a slow send, short enough to recover. */
export const CALL_SCHEDULING_LEASE_MS = 120_000;

export interface RegisterCallSchedulingAttemptParams {
  organizationId?: ObjectIdLike;
  leadSubmissionId?: ObjectIdLike;
  conversationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike | null;
  initialMessageId?: ObjectIdLike;
  sentAt?: Date;
  windowMs?: number;
}

/**
 * Starts the clock, at most once per Meta submission.
 *
 * UPSERT ON leadSubmissionId with `$setOnInsert` only. A redelivered webhook, a re-import or two
 * delivery workers finishing together all converge on one row, and none of them can move the
 * deadline of an attempt that already exists - which would quietly extend the customer's hour
 * every time something retried.
 *
 * `sentAt` is the moment the greeting actually reached WhatsApp, supplied by the caller at the
 * point of delivery. Nothing here reads the clock, so a sweep that runs late cannot shorten or
 * lengthen somebody's window.
 */
export const registerCallSchedulingAttempt = ({
  organizationId,
  leadSubmissionId,
  conversationId,
  whatsappAccountId = null,
  initialMessageId,
  sentAt = new Date(),
  windowMs = NO_RESPONSE_WINDOW_MS,
}: RegisterCallSchedulingAttemptParams = {}) =>
  CallSchedulingAttempt.findOneAndUpdate(
    { leadSubmissionId },
    {
      $setOnInsert: {
        organizationId,
        leadSubmissionId,
        conversationId,
        whatsappAccountId,
        initialMessageId,
        sentAt,
        deadlineAt: new Date(sentAt.getTime() + windowMs),
        status: CALL_SCHEDULING_STATUSES.WAITING,
        repliedAt: null,
        ownerReminderTaskId: null,
        followUpMessageId: null,
        followUpClaimedAt: null,
        attempts: 0,
        claimedAt: null,
        claimToken: null,
        lastError: null,
      },
    } as UpdateQuery<CallSchedulingAttemptDocument>,
    { upsert: true, returnDocument: 'after', runValidators: true },
  ).exec();

export interface MarkCallSchedulingRepliedParams {
  organizationId?: ObjectIdLike;
  conversationId?: ObjectIdLike;
  repliedAt?: Date;
}

/**
 * The customer wrote back. Stops the chase.
 *
 * `status: WAITING` is in the FILTER, which is what makes this safe against the race the whole
 * feature turns on: the reply handler and the deadline sweep can run at the same instant, and
 * whichever claims the row first wins. A reply landing after the sweep has already claimed it
 * finds nothing to update and correctly does not undo a chase that is already underway.
 *
 * Scoped to the conversation AND the organization. A reply can only ever cancel an attempt on
 * its own thread, in its own tenant.
 */
export const markCallSchedulingReplied = ({
  organizationId,
  conversationId,
  repliedAt = new Date(),
}: MarkCallSchedulingRepliedParams = {}) =>
  CallSchedulingAttempt.findOneAndUpdate(
    {
      organizationId,
      conversationId,
      status: CALL_SCHEDULING_STATUSES.WAITING,
    },
    {
      $set: { status: CALL_SCHEDULING_STATUSES.REPLIED, repliedAt },
    } as UpdateQuery<CallSchedulingAttemptDocument>,
    // Newest first: if a lead somehow has two open attempts, the reply answers the latest ask.
    { sort: { sentAt: -1 }, returnDocument: 'after', runValidators: true },
  ).exec();

export interface ClaimDueCallSchedulingAttemptParams {
  now?: Date;
  leaseMs?: number;
}

/** Takes the next attempt whose hour has passed, atomically, with a fresh ownership token. */
export const claimDueCallSchedulingAttempt = ({
  now = new Date(),
  leaseMs = CALL_SCHEDULING_LEASE_MS,
}: ClaimDueCallSchedulingAttemptParams = {}) => {
  const leaseExpiredBefore = new Date(now.getTime() - leaseMs);

  return CallSchedulingAttempt.findOneAndUpdate(
    {
      status: CALL_SCHEDULING_STATUSES.WAITING,
      deadlineAt: { $lte: now },
      $or: [{ claimedAt: null }, { claimedAt: { $lte: leaseExpiredBefore } }],
    },
    {
      $set: { claimedAt: now, claimToken: randomUUID() },
      $inc: { attempts: 1 },
    } as UpdateQuery<CallSchedulingAttemptDocument>,
    { sort: { deadlineAt: 1 }, returnDocument: 'after', runValidators: true },
  ).exec();
};

export interface RecordCallSchedulingActionParams {
  attemptId?: ObjectIdLike;
  claimToken?: string | null;
  ownerReminderTaskId?: ObjectIdLike | null;
  followUpMessageId?: ObjectIdLike | null;
}

/**
 * Records that one of the two no-response actions has happened.
 *
 * WRITTEN THE MOMENT EACH ACTION SUCCEEDS, not once both do. The owner reminder and the customer
 * message are separate failures with separate retries; recording them together would mean a
 * sweep that created the reminder and then failed to send would create a second reminder next
 * time round.
 *
 * Conditional on the claim token, so a worker whose lease expired cannot stamp a row another
 * worker now owns.
 */
export const recordCallSchedulingAction = ({
  attemptId,
  claimToken,
  ownerReminderTaskId,
  followUpMessageId,
}: RecordCallSchedulingActionParams = {}) => {
  const update: Record<string, unknown> = {};

  if (ownerReminderTaskId !== undefined) {
    update.ownerReminderTaskId = ownerReminderTaskId;
  }

  if (followUpMessageId !== undefined) {
    update.followUpMessageId = followUpMessageId;
  }

  return CallSchedulingAttempt.findOneAndUpdate(
    { _id: attemptId, ...(claimToken ? { claimToken } : {}) },
    { $set: update } as UpdateQuery<CallSchedulingAttemptDocument>,
    { returnDocument: 'after', runValidators: true },
  ).exec();
};

export interface SettleCallSchedulingAttemptParams {
  attemptId?: ObjectIdLike;
  claimToken?: string | null;
  status?: CallSchedulingStatus;
  lastError?: string | null;
}

/** Both actions done, or given up on. Releases the claim either way. */
export const settleCallSchedulingAttempt = ({
  attemptId,
  claimToken,
  status = CALL_SCHEDULING_STATUSES.COMPLETED,
  lastError = null,
}: SettleCallSchedulingAttemptParams = {}) =>
  CallSchedulingAttempt.findOneAndUpdate(
    { _id: attemptId, ...(claimToken ? { claimToken } : {}) },
    {
      $set: { status, claimedAt: null, claimToken: null, lastError },
    } as UpdateQuery<CallSchedulingAttemptDocument>,
    { returnDocument: 'after', runValidators: true },
  ).exec();

export interface ReleaseCallSchedulingClaimParams {
  attemptId?: ObjectIdLike;
  claimToken?: string | null;
  lastError?: string | null;
}

/** Transient failure: hand the row back so a later sweep retries it, still WAITING. */
export const releaseCallSchedulingClaim = ({
  attemptId,
  claimToken,
  lastError = null,
}: ReleaseCallSchedulingClaimParams = {}) =>
  CallSchedulingAttempt.findOneAndUpdate(
    { _id: attemptId, ...(claimToken ? { claimToken } : {}) },
    {
      $set: { claimedAt: null, claimToken: null, lastError },
    } as UpdateQuery<CallSchedulingAttemptDocument>,
    { returnDocument: 'after', runValidators: true },
  ).exec();


export interface ClaimFollowUpSendParams {
  attemptId?: ObjectIdLike;
  claimToken?: string | null;
  now?: Date;
}

/**
 * The right to tell this customer we never heard from them.
 *
 * A COMPARE-AND-SET, not a read. `status: WAITING` is in the filter, so if a reply flipped the
 * attempt to `replied` in the moments since the sweep read the conversation, this matches
 * nothing and the send is skipped. Without it that window is real: measured against MongoDB, a
 * reply and a sweep claim both succeed in every contended round, because the claim leaves the
 * row waiting precisely so a reply can still cancel it.
 *
 * Also guards against two sweeps: `followUpClaimedAt: null` means only the first gets through,
 * even before either has an outbound message id to record.
 */
export const claimFollowUpSend = ({
  attemptId,
  claimToken,
  now = new Date(),
}: ClaimFollowUpSendParams = {}) =>
  CallSchedulingAttempt.findOneAndUpdate(
    {
      _id: attemptId,
      ...(claimToken ? { claimToken } : {}),
      status: CALL_SCHEDULING_STATUSES.WAITING,
      followUpMessageId: null,
      followUpClaimedAt: null,
    },
    { $set: { followUpClaimedAt: now } } as UpdateQuery<CallSchedulingAttemptDocument>,
    { returnDocument: 'after', runValidators: true },
  ).exec();

/** Releases the send gate so a later sweep may retry after a transient failure. */
export const releaseFollowUpSendClaim = ({
  attemptId,
  claimToken,
}: { attemptId?: ObjectIdLike; claimToken?: string | null } = {}) =>
  CallSchedulingAttempt.findOneAndUpdate(
    { _id: attemptId, ...(claimToken ? { claimToken } : {}) },
    { $set: { followUpClaimedAt: null } } as UpdateQuery<CallSchedulingAttemptDocument>,
    { returnDocument: 'after', runValidators: true },
  ).exec();
