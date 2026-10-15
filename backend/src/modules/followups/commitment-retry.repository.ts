/**
 * The commitment-retry queue's four operations: enqueue, claim, back off, abandon.
 *
 * Every mutation is a conditional update rather than a read-then-write, the same way
 * realtime-outbox and the reminder claim work. Two backends sweeping the same queue is the
 * normal case during a rolling deploy, and a queue that needs them not to overlap is a queue
 * that will double-process the week nobody is watching.
 */
import { randomUUID } from 'node:crypto';

import { type UpdateQuery } from 'mongoose';

import { type ObjectIdLike } from '../../types/common.js';
import {
  COMMITMENT_RETRY_STATUSES,
  CommitmentRetry,
  type CommitmentRetryDocument,
} from './commitment-retry.model.js';

/** How many times a turn is re-classified before it is given up on. */
export const MAX_COMMITMENT_RETRY_ATTEMPTS = 4;

/** 1, 2, 4, 8 minutes. Long enough for a struggling service to recover, short enough to matter. */
export const COMMITMENT_RETRY_BASE_BACKOFF_MS = 60_000;

/** How long a claim is held before another sweep may take it - a crashed worker's lease. */
export const COMMITMENT_RETRY_LEASE_MS = 120_000;

export const backoffFor = (attempts: number): number =>
  COMMITMENT_RETRY_BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1);

export interface EnqueueCommitmentRetryParams {
  organizationId?: ObjectIdLike;
  whatsappAccountId?: ObjectIdLike | null;
  conversationId?: ObjectIdLike;
  messageId?: string;
  text?: string;
  optedOut?: boolean;
  now?: Date;
}

/**
 * Records that a turn still needs classifying.
 *
 * UPSERT ON messageId, which is what makes this idempotent. The same turn failing twice - the
 * live attempt and then a sweep attempt - must leave ONE row, because two rows would mean two
 * reminders racing for one idempotency key and one of them losing noisily.
 *
 * `$setOnInsert` for the payload: a row that already exists has the turn as the FIRST attempt
 * saw it, and that is the version to keep. Re-writing it from a later caller would be a chance
 * to overwrite the real turn with something shorter.
 */
export const enqueueCommitmentRetry = ({
  organizationId,
  whatsappAccountId = null,
  conversationId,
  messageId,
  text,
  optedOut = false,
  now = new Date(),
}: EnqueueCommitmentRetryParams = {}) =>
  CommitmentRetry.findOneAndUpdate(
    { messageId },
    {
      $setOnInsert: {
        organizationId,
        whatsappAccountId,
        conversationId,
        messageId,
        text,
        optedOut,
        status: COMMITMENT_RETRY_STATUSES.PENDING,
        attempts: 0,
        // The first retry waits one backoff rather than going straight back at a service that
        // has just failed.
        availableAt: new Date(now.getTime() + COMMITMENT_RETRY_BASE_BACKOFF_MS),
        claimedAt: null,
        claimToken: null,
        lastError: null,
      },
    } as UpdateQuery<CommitmentRetryDocument>,
    { upsert: true, returnDocument: 'after', runValidators: true },
  ).exec();

export interface ClaimCommitmentRetryParams {
  now?: Date;
  leaseMs?: number;
}

/**
 * Takes the next due turn, atomically.
 *
 * The filter is the lock: due, and either unclaimed or claimed so long ago that whoever took it
 * is gone. Exactly one sweep can win, so a second one running concurrently gets the next row or
 * nothing at all.
 */
export const claimCommitmentRetry = ({
  now = new Date(),
  leaseMs = COMMITMENT_RETRY_LEASE_MS,
}: ClaimCommitmentRetryParams = {}) => {
  const leaseExpiredBefore = new Date(now.getTime() - leaseMs);

  return CommitmentRetry.findOneAndUpdate(
    {
      status: {
        $in: [COMMITMENT_RETRY_STATUSES.PENDING, COMMITMENT_RETRY_STATUSES.CLAIMED],
      },
      availableAt: { $lte: now },
      $or: [{ claimedAt: null }, { claimedAt: { $lte: leaseExpiredBefore } }],
    },
    {
      // A FRESH TOKEN EVERY CLAIM. This is what makes the later writes safe: a previous
      // holder's token no longer matches, so its delete or backoff silently affects nothing
      // instead of destroying this worker's claim.
      $set: {
        status: COMMITMENT_RETRY_STATUSES.CLAIMED,
        claimedAt: now,
        claimToken: randomUUID(),
      },
      $inc: { attempts: 1 },
    } as UpdateQuery<CommitmentRetryDocument>,
    { sort: { availableAt: 1 }, returnDocument: 'after', runValidators: true },
  ).exec();
};

/**
 * Done with - whether it produced a reminder, produced nothing, or was terminal.
 *
 * DELETED RATHER THAN MARKED. The row exists only to make a retry possible; once there will be
 * no retry it is a customer's words sitting in a table for no reason.
 *
 * CONDITIONAL ON STILL OWNING IT. A worker that stalled past its lease, had the row reclaimed,
 * and then finished would otherwise delete the row the new holder is working on - and if that
 * holder later needed to back off, there would be no row to back off and the chain would end
 * without a word. With the token in the filter, the late delete matches nothing.
 */
export const deleteCommitmentRetry = ({
  messageId,
  claimToken,
}: { messageId?: string; claimToken?: string | null } = {}) =>
  CommitmentRetry.deleteOne({
    messageId,
    ...(claimToken ? { claimToken } : {}),
  }).exec();

export interface AbandonCommitmentRetryParams {
  messageId?: string;
  claimToken?: string | null;
  lastError?: string | null;
  now?: Date;
}

/**
 * Out of attempts: a commitment the customer really made will not be recorded.
 *
 * A BOUNDED DEAD LETTER rather than a silent delete. The row is kept so an operator can find
 * what was abandoned and why - but `text` is CLEARED, because the reason to keep it (retrying)
 * is gone and the reason not to (it is a customer's words) is not. What survives is the
 * conversation, the attempt count and an error code, which is enough to investigate and
 * nothing more. The TTL index removes it after seven days without anyone having to remember.
 */
export const abandonCommitmentRetry = ({
  messageId,
  claimToken,
  lastError = null,
  now = new Date(),
}: AbandonCommitmentRetryParams = {}) =>
  CommitmentRetry.findOneAndUpdate(
    { messageId, ...(claimToken ? { claimToken } : {}) },
    {
      $set: {
        status: COMMITMENT_RETRY_STATUSES.FAILED_PERMANENT,
        text: '',
        claimedAt: null,
        claimToken: null,
        lastError,
        // Pushed far out so a reclaim can never pick it up again - status alone would do it,
        // but a belt costs nothing here.
        availableAt: new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000),
      },
    } as UpdateQuery<CommitmentRetryDocument>,
    { returnDocument: 'after', runValidators: true },
  ).exec();

export interface RescheduleCommitmentRetryParams {
  messageId?: string;
  claimToken?: string | null;
  lastError?: string | null;
  attempts?: number;
  now?: Date;
}

/** Still transient, still inside the budget: hand it back for a later sweep, further out. */
export const rescheduleCommitmentRetry = ({
  messageId,
  claimToken,
  lastError = null,
  attempts = 1,
  now = new Date(),
}: RescheduleCommitmentRetryParams = {}) =>
  CommitmentRetry.findOneAndUpdate(
    // Same ownership condition as the delete: a late worker must not reset a claim it no
    // longer holds, which would hand the row to a third worker while the second is mid-call.
    { messageId, ...(claimToken ? { claimToken } : {}) },
    {
      $set: {
        status: COMMITMENT_RETRY_STATUSES.PENDING,
        claimedAt: null,
        claimToken: null,
        availableAt: new Date(now.getTime() + backoffFor(attempts)),
        lastError,
      },
    } as UpdateQuery<CommitmentRetryDocument>,
    { returnDocument: 'after', runValidators: true },
  ).exec();
