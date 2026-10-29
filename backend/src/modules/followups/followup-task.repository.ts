import { type QueryFilter, type Types, type UpdateQuery } from 'mongoose';

import { FOLLOWUP_PRIORITIES, type FollowupPriority } from '../../constants/followup-priorities.js';
import { FOLLOWUP_STATUSES, type FollowupStatus } from '../../constants/followup-statuses.js';
import { type FollowupType } from '../../constants/followup-types.js';
import {
  REMINDER_CHANNELS,
  REMINDER_DELIVERY_STATUSES,
  REMINDER_SOURCES,
  type ReminderChannel,
  type ReminderDeliveryStatus,
  type ReminderSource,
} from '../../constants/reminder-channels.js';
import { type DatabaseSession } from '../../config/database.js';
import { type ObjectIdLike, type PaginationParams, toObjectId } from '../../types/common.js';
import { FollowUpTask, type FollowUpTaskDocument } from './followup-task.model.js';

export interface CreateFollowUpTaskParams {
  organizationId: ObjectIdLike;
  // Nullable since reminders: a personal one belongs to no lead and no account. See the model.
  whatsappAccountId?: ObjectIdLike | null;
  conversationId?: ObjectIdLike | null;
  assignedTo: ObjectIdLike;
  createdBy: ObjectIdLike;
  type: FollowupType;
  note?: string;
  dueAt: Date;
  priority?: FollowupPriority;
  // Reminder fields. All optional, so every existing caller is unaffected.
  title?: string | null;
  timezone?: string | null;
  source?: ReminderSource;
  sourceMessageId?: string | null;
  sourceQuote?: string | null;
  /** Unique per organisation. The duplicate guard for extracted and command-created reminders. */
  idempotencyKey?: string | null;
  session?: DatabaseSession;
}

export const createFollowUpTask = ({
  organizationId,
  whatsappAccountId,
  conversationId,
  assignedTo,
  createdBy,
  type,
  note,
  dueAt,
  priority = FOLLOWUP_PRIORITIES.NORMAL,
  title = null,
  timezone = null,
  source = REMINDER_SOURCES.MANUAL,
  sourceMessageId = null,
  sourceQuote = null,
  idempotencyKey = null,
  session,
}: CreateFollowUpTaskParams) =>
  FollowUpTask.create(
    [
      {
        organizationId: toObjectId(organizationId),
        whatsappAccountId: whatsappAccountId ? toObjectId(whatsappAccountId) : null,
        conversationId: conversationId ? toObjectId(conversationId) : null,
        assignedTo: toObjectId(assignedTo),
        createdBy: toObjectId(createdBy),
        type,
        note,
        dueAt,
        priority,
        title,
        timezone,
        source,
        sourceMessageId,
        sourceQuote,
        // Spread, so a reminder with no key has no FIELD rather than a null one. Writing null
        // here puts it in the sparse unique index and the next keyless reminder collides.
        ...(idempotencyKey ? { idempotencyKey } : {}),
      },
    ],
    { session },
  ).then(([task]) => task!);

export interface FindFollowUpTaskByIdParams {
  taskId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
}

export const findFollowUpTaskById = ({ taskId, organizationId }: FindFollowUpTaskByIdParams = {}) =>
  FollowUpTask.findOne({
    _id: taskId,
    organizationId,
  }).exec();

export interface FindFollowUpTasksByConversationParams extends PaginationParams {
  organizationId?: ObjectIdLike;
  conversationId?: ObjectIdLike;
  status?: FollowupStatus;
}

export const findFollowUpTasksByConversation = ({
  organizationId,
  conversationId,
  status,
  limit = 50,
  skip = 0,
}: FindFollowUpTasksByConversationParams = {}) => {
  const filter: QueryFilter<FollowUpTaskDocument> = {
    organizationId,
    conversationId,
  };

  if (status) {
    filter.status = status;
  }

  return FollowUpTask.find(filter)
    .sort({
      dueAt: 1,
    })
    .skip(skip)
    .limit(limit)
    .exec();
};

export interface FindPendingTasksByUserParams extends PaginationParams {
  organizationId?: ObjectIdLike;
  assignedTo?: ObjectIdLike;
  dueBefore?: Date;
}

export const findPendingTasksByUser = ({
  organizationId,
  assignedTo,
  dueBefore,
  limit = 50,
  skip = 0,
}: FindPendingTasksByUserParams = {}) => {
  const filter: QueryFilter<FollowUpTaskDocument> = {
    organizationId,
    assignedTo,
    status: FOLLOWUP_STATUSES.PENDING,
  };

  if (dueBefore) {
    filter.dueAt = {
      $lte: dueBefore,
    };
  }

  return FollowUpTask.find(filter)
    .sort({
      dueAt: 1,
    })
    .skip(skip)
    .limit(limit)
    .exec();
};

export interface FindDuePendingTasksParams {
  organizationId?: ObjectIdLike;
  dueAt?: Date;
  limit?: number;
}

export const findDuePendingTasks = ({
  organizationId,
  dueAt = new Date(),
  limit = 100,
}: FindDuePendingTasksParams = {}) =>
  FollowUpTask.find({
    organizationId,
    status: FOLLOWUP_STATUSES.PENDING,
    dueAt: {
      $lte: dueAt,
    },
  })
    .sort({
      dueAt: 1,
    })
    .limit(limit)
    .exec();

export interface UpdateTaskStatusParams {
  taskId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  status?: FollowupStatus;
  now?: Date;
  queueJobId?: string | null;
  lastNotificationAt?: Date | null;
  session?: DatabaseSession;
}

export const updateTaskStatus = ({
  taskId,
  organizationId,
  status,
  now = new Date(),
  queueJobId,
  lastNotificationAt,
  session,
}: UpdateTaskStatusParams = {}) => {
  const updateData: UpdateQuery<FollowUpTaskDocument> = {
    status,
  };

  if (status === FOLLOWUP_STATUSES.COMPLETED) {
    updateData.completedAt = now;
  }

  if (status === FOLLOWUP_STATUSES.CANCELLED) {
    updateData.cancelledAt = now;
  }

  if (status === FOLLOWUP_STATUSES.MISSED) {
    updateData.missedAt = now;
  }

  if (queueJobId !== undefined) {
    updateData.queueJobId = queueJobId;
  }

  if (lastNotificationAt !== undefined) {
    updateData.lastNotificationAt = lastNotificationAt;
  }

  return FollowUpTask.findOneAndUpdate(
    {
      _id: taskId,
      organizationId,
    },
    {
      $set: updateData,
    },
    {
      returnDocument: 'after',
      runValidators: true,
      session,
    },
  ).exec();
};

// --------------------------------------------------------------------------
// The reminder scheduler's half of this repository.
//
// Everything above serves the CRM's task list - "what does this user owe this lead". Below is
// what the sweep needs to actually FIRE a reminder at its due time, safely, from more than one
// worker, without ever sending the same reminder twice.
// --------------------------------------------------------------------------

export interface ClaimDueReminderParams {
  now?: Date;
  /** How long a claim is honoured before another worker may take it. */
  leaseMs?: number;
}

/**
 * Takes ONE due reminder and marks it as being worked on, atomically.
 *
 * This is the whole concurrency story, and it is a conditional update rather than a read
 * followed by a write for the obvious reason: two workers that both read "pending and due"
 * would both send. `findOneAndUpdate` lets exactly one of them match the filter, and the loser
 * gets null and moves on.
 *
 * `deliveryClaimedAt` doubles as a LEASE, not a permanent flag. A worker that claims a reminder
 * and then dies - OOM, redeploy, a thrown error nobody caught - would otherwise strand it as
 * pending-but-claimed forever, which is the silent-loss failure this whole feature is supposed
 * not to have. So the filter also reclaims anything whose claim is older than the lease. The
 * cost of that choice is honest: if the first worker was merely slow rather than dead, the
 * reminder can go out twice. The lease is therefore set well above a normal delivery.
 *
 * Sorted by dueAt so the most overdue goes first - after an outage the backlog drains in the
 * order the owner expected to hear about it.
 */
export const claimDueReminder = ({
  now = new Date(),
  leaseMs = 120_000,
}: ClaimDueReminderParams = {}) => {
  const leaseExpiredBefore = new Date(now.getTime() - leaseMs);

  return FollowUpTask.findOneAndUpdate(
    {
      status: FOLLOWUP_STATUSES.PENDING,
      dueAt: { $lte: now },
      // NEVER RE-CLAIM SOMETHING ALREADY ANNOUNCED. A reminder stays `pending` until the owner
      // completes it, so without this an announced-but-not-completed reminder matches the
      // filter forever: claimed, found to have been announced, released, claimed again next
      // minute. It burns the per-tick budget on work it immediately discards, and with enough
      // of them a genuinely new reminder never gets claimed at all.
      lastNotificationAt: null,
      $or: [{ deliveryClaimedAt: null }, { deliveryClaimedAt: { $lte: leaseExpiredBefore } }],
    },
    { $set: { deliveryClaimedAt: now } },
    { returnDocument: 'after', sort: { dueAt: 1 }, runValidators: true },
  ).exec();
};

export interface ReleaseReminderClaimParams {
  taskId?: ObjectIdLike;
}

/**
 * Hands a claim back without delivering.
 *
 * Used when a sweep decides it cannot act right now but the reminder is still valid - the
 * WhatsApp socket is down, say. Releasing is better than leaving the lease to expire: the next
 * sweep picks it up in seconds rather than minutes.
 */
export const releaseReminderClaim = ({ taskId }: ReleaseReminderClaimParams = {}) =>
  FollowUpTask.findOneAndUpdate(
    { _id: taskId },
    { $set: { deliveryClaimedAt: null } },
    { returnDocument: 'after' },
  ).exec();

export interface RecordReminderDeliveryParams {
  taskId?: ObjectIdLike;
  channel: ReminderChannel;
  status: ReminderDeliveryStatus;
  error?: string | null;
  now?: Date;
}

/**
 * Writes ONE channel's outcome, leaving the other channel's record untouched.
 *
 * The separation is the point. A WhatsApp send that fails must not mark the handset's alarm
 * failed - the two have nothing to do with each other, and an owner whose phone rang does not
 * care that the WhatsApp socket was down. Attempts increment per channel for the same reason.
 */
export const recordReminderDelivery = ({
  taskId,
  channel,
  status,
  error = null,
  now = new Date(),
}: RecordReminderDeliveryParams) => {
  const field = channel === REMINDER_CHANNELS.WHATSAPP ? 'whatsappDelivery' : 'androidDelivery';

  const update: UpdateQuery<FollowUpTaskDocument> = {
    $set: {
      [`${field}.status`]: status,
      [`${field}.error`]: error,
      ...(status === REMINDER_DELIVERY_STATUSES.SENT ? { [`${field}.deliveredAt`]: now } : {}),
    },
    $inc: { [`${field}.attempts`]: 1 },
  };

  return FollowUpTask.findOneAndUpdate({ _id: taskId }, update, {
    returnDocument: 'after',
    runValidators: true,
  }).exec();
};

export interface FinishReminderDeliveryParams {
  taskId?: ObjectIdLike;
  now?: Date;
}

/**
 * Closes out a reminder once its channels have been attempted.
 *
 * Deliberately leaves `status` as PENDING rather than inventing a "delivered" state: the task
 * is still outstanding work for the owner until THEY complete it, and the existing task list,
 * its statuses and its UI all depend on that meaning. What changes is `lastNotificationAt`,
 * which is what stops the sweep picking it up again, and the claim being dropped.
 */
export const finishReminderDelivery = ({
  taskId,
  now = new Date(),
}: FinishReminderDeliveryParams = {}) =>
  FollowUpTask.findOneAndUpdate(
    { _id: taskId },
    { $set: { lastNotificationAt: now, deliveryClaimedAt: null } },
    { returnDocument: 'after', runValidators: true },
  ).exec();

export interface FindRemindersForDeviceSyncParams {
  organizationId?: ObjectIdLike;
  assignedTo?: ObjectIdLike;
  /** Only reminders changed since the handset last synced. Omit for a full refresh. */
  since?: Date | null;
  limit?: number;
}

/**
 * What the Android app pulls down to arm its local alarms.
 *
 * Returns CANCELLED and COMPLETED rows too, on purpose: the handset needs to be told to cancel
 * an alarm it has already scheduled, and it can only learn that from a row that still comes
 * back. Filtering them out here is how a cancelled reminder still rings.
 */
export const findRemindersForDeviceSync = ({
  organizationId,
  assignedTo,
  since = null,
  limit = 200,
}: FindRemindersForDeviceSyncParams = {}) => {
  const filter: QueryFilter<FollowUpTaskDocument> = { organizationId, assignedTo };

  if (since) {
    filter.updatedAt = { $gt: since };
  }

  return FollowUpTask.find(filter).sort({ updatedAt: -1 }).limit(limit).exec();
};

export interface MarkReminderSyncedParams {
  taskIds?: ObjectIdLike[];
  organizationId?: ObjectIdLike;
  assignedTo?: ObjectIdLike;
  now?: Date;
}

/**
 * Records that the handset has the reminder and has armed it locally.
 *
 * Scoped by organisation AND assignee, not just by id: this is written from a device-supplied
 * list, so without both scopes a caller could stamp somebody else's reminders.
 */
export const markRemindersSynced = ({
  taskIds = [],
  organizationId,
  assignedTo,
  now = new Date(),
}: MarkReminderSyncedParams = {}) => {
  if (!Array.isArray(taskIds) || taskIds.length === 0) {
    return Promise.resolve({ modifiedCount: 0 });
  }

  return FollowUpTask.updateMany(
    { _id: { $in: taskIds.map((id) => toObjectId(id)) }, organizationId, assignedTo },
    { $set: { 'androidDelivery.syncedAt': now } },
  ).exec();
};

export interface BumpReminderVersionParams {
  taskId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
}

/**
 * Invalidates the handset's copy after a change that moves or kills the alarm.
 *
 * The device reschedules only when the server's version is higher than the one it armed, so
 * forgetting this call is precisely how a rescheduled reminder rings at the old time.
 */
export const bumpReminderVersion = ({ taskId, organizationId }: BumpReminderVersionParams = {}) =>
  FollowUpTask.findOneAndUpdate(
    { _id: taskId, organizationId },
    { $inc: { version: 1 } },
    { returnDocument: 'after' },
  ).exec();

export interface RescheduleReminderParams {
  taskId?: ObjectIdLike;
  organizationId?: ObjectIdLike;
  dueAt: Date;
  timezone?: string | null;
}

/**
 * Moves a reminder to a new time and makes it deliverable again.
 *
 * THREE THINGS HAVE TO HAPPEN TOGETHER, and missing any one is a silent failure:
 *
 *  - `lastNotificationAt` is cleared. The sweep refuses to announce a reminder that already
 *    went out, so a rescheduled reminder that kept its old stamp would never fire again.
 *  - the delivery records reset to pending, so a previous failure does not count against the
 *    new attempt and the owner sees the state of THIS delivery.
 *  - `version` increments, which is what tells the handset to cancel the local alarm it armed
 *    for the old time instead of leaving both to ring.
 *
 * Status is forced back to pending so rescheduling a cancelled reminder revives it, which is
 * what "move my report reminder to 7" means to the person typing it.
 */
export const rescheduleReminder = ({
  taskId,
  organizationId,
  dueAt,
  timezone = null,
}: RescheduleReminderParams) =>
  FollowUpTask.findOneAndUpdate(
    { _id: taskId, organizationId },
    {
      $set: {
        dueAt,
        status: FOLLOWUP_STATUSES.PENDING,
        lastNotificationAt: null,
        cancelledAt: null,
        missedAt: null,
        deliveryClaimedAt: null,
        'whatsappDelivery.status': REMINDER_DELIVERY_STATUSES.PENDING,
        'whatsappDelivery.attempts': 0,
        'whatsappDelivery.error': null,
        'whatsappDelivery.deliveredAt': null,
        'androidDelivery.status': REMINDER_DELIVERY_STATUSES.PENDING,
        'androidDelivery.deliveredAt': null,
        'androidDelivery.error': null,
        ...(timezone ? { timezone } : {}),
      },
      $inc: { version: 1 },
    },
    { returnDocument: 'after', runValidators: true },
  ).exec();


export interface FindEarliestPendingDueAtParams {
  organizationId?: ObjectIdLike;
  conversationId?: ObjectIdLike;
  status?: FollowupStatus;
}

/**
 * The soonest due time among a conversation's pending reminders, or null if it has none.
 *
 * Answered entirely from the `{organizationId, conversationId, status, dueAt}` index - sorted
 * ascending and limited to one, so MongoDB reads a single index entry and stops. That is what
 * makes it cheap enough to run on every reminder mutation rather than on a schedule.
 *
 * `lean()` because only the date is wanted; hydrating a full document to read one field is
 * waste on a path this hot.
 */
export const findEarliestPendingDueAt = async ({
  organizationId,
  conversationId,
  status = FOLLOWUP_STATUSES.PENDING,
}: FindEarliestPendingDueAtParams = {}): Promise<Date | null> => {
  if (!organizationId || !conversationId) {
    return null;
  }

  const [next] = await FollowUpTask.find({ organizationId, conversationId, status })
    .sort({ dueAt: 1 })
    .limit(1)
    .select({ dueAt: 1 })
    .lean();

  return (next?.dueAt as Date | undefined) ?? null;
};

export interface MarkReminderPushedParams {
  taskId?: ObjectIdLike;
  now?: Date;
}

/**
 * Records that the owner's handsets were told about this reminder.
 *
 * Its own field and its own write, separate from `recordReminderDelivery`: push and WhatsApp
 * retry independently, and a WhatsApp attempt that is still in its budget must not carry the
 * push stamp with it. Not organization-scoped for the same reason `disablePushDevice` is not -
 * this is the delivery path stamping a task it has already claimed, by id.
 */
export const markReminderPushed = ({ taskId, now = new Date() }: MarkReminderPushedParams = {}) =>
  FollowUpTask.findOneAndUpdate(
    { _id: taskId },
    { $set: { pushNotifiedAt: now } },
    { returnDocument: 'after' },
  ).exec();

export interface FindRemindersNeedingClockAlarmParams {
  now?: Date;
  windowMs?: number;
  limit?: number;
}

/**
 * Reminders that fall due soon enough to become a Clock alarm, and have not been asked for yet.
 *
 * THE WINDOW IS THE WHOLE QUERY. `ACTION_SET_ALARM` carries an hour and a minute and no date,
 * so the Clock app rings at the next occurrence of that time. Inside 24 hours that occurrence
 * IS the due instant; outside it, the alarm would ring up to a day early. So this deliberately
 * returns nothing for a reminder two days out - it becomes eligible on a later sweep, once it
 * has come inside the window.
 *
 * NOT ORGANISATION-SCOPED. This is a background sweep over every tenant, the same shape as the
 * delivery sweep; the organisation travels with each task to whoever acts on it.
 *
 * `dueAt: { $gt: now }` rather than `$gte`: a reminder already due does not want an alarm, it
 * wants the push that is about to fire.
 */
export const findRemindersNeedingClockAlarm = ({
  now = new Date(),
  windowMs = 24 * 60 * 60 * 1000,
  limit = 100,
}: FindRemindersNeedingClockAlarmParams = {}) =>
  FollowUpTask.find({
    status: FOLLOWUP_STATUSES.PENDING,
    clockAlarmArmedAt: null,
    dueAt: {
      $gt: now,
      $lte: new Date(now.getTime() + windowMs),
    },
  })
    .sort({ dueAt: 1 })
    .limit(limit)
    .exec();

export interface MarkClockAlarmArmedParams {
  taskId?: ObjectIdLike;
  now?: Date;
}

/**
 * Records that the owner's handsets were asked to create a Clock alarm.
 *
 * COMPARE-AND-SET on `clockAlarmArmedAt: null`, unlike `markReminderPushed`, which simply
 * stamps. The difference is what each protects: a duplicate push is a second buzz, while a
 * duplicate clock-arm is a second alarm in the Clock app that the platform gives us NO WAY to
 * delete - the owner has to remove it by hand. The returned document is null when another pass
 * got there first, which is the caller's signal that it must not send.
 */
export const markClockAlarmArmed = ({ taskId, now = new Date() }: MarkClockAlarmArmedParams = {}) =>
  FollowUpTask.findOneAndUpdate(
    { _id: taskId, clockAlarmArmedAt: null },
    { $set: { clockAlarmArmedAt: now } },
    { returnDocument: 'after' },
  ).exec();

// --------------------------------------------------------------------------
// The Tasks screen's query.
//
// Everything above answers "what does this ONE conversation owe" or "what is due RIGHT NOW
// across every tenant". The centralised Tasks screen asks a third question - "what does this
// person, or their team, owe across every lead" - and no existing query answers it:
// findFollowUpTasksByConversation is conversation-scoped, and findPendingTasksByUser is
// pending-only, assignee-only, and carries no lead name to put on a card.
//
// ONE AGGREGATION, NOT A FAN-OUT. Listing conversations and then fetching each one's reminders
// is N+1 against the database and - worse - cannot sort, filter or count across the whole set,
// so page 2 would be meaningless and the counts would describe only what had been fetched. It
// also could not search by customer name without pulling every task into memory first.
// --------------------------------------------------------------------------

/**
 * Regex-escapes a search term.
 *
 * NOT OPTIONAL. The term goes into a `$regex`. Unescaped, `(` is a syntax error that surfaces
 * as a 500, and something like `(a+)+$` is catastrophic backtracking executed inside the
 * database. Escaped, the string matches literally - which is also what somebody typing a
 * customer's name expects it to do.
 */
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Which slice the caller is asking for. See the service for who is allowed to ask for team. */
export type TaskListScope = 'mine' | 'team';

/** The chips on the Tasks screen. `late` is DERIVED, not a stored status - see below. */
export type TaskListStatusFilter = 'pending' | 'late' | 'completed' | 'cancelled';

export interface FindOrganizationTasksParams extends PaginationParams {
  organizationId: ObjectIdLike;
  /** The caller. `mine` filters on it, and `team` still uses it to protect their own privacy. */
  actorId: ObjectIdLike;
  scope: TaskListScope;
  status?: TaskListStatusFilter | null;
  dueFrom?: Date | null;
  dueTo?: Date | null;
  search?: string | null;
  now?: Date;
}

export interface OrganizationTaskCounts {
  total: number;
  pending: number;
  overdue: number;
  completed: number;
  cancelled: number;
}

export interface OrganizationTaskRow extends FollowUpTaskDocument {
  /** The lead this task is about. Absent on a personal reminder; three fields, never the lot. */
  conversation?: { _id: Types.ObjectId; displayName?: string; leadId?: string } | null;
}

export interface FindOrganizationTasksResult {
  rows: OrganizationTaskRow[];
  /** How many rows match AFTER the status chip. This is what pagination counts against. */
  matched: number;
  /** Counts across every status, so a chip can say "Done 112" while you view the pending list. */
  counts: OrganizationTaskCounts;
}

export const findOrganizationTasks = async ({
  organizationId,
  actorId,
  scope,
  status = null,
  dueFrom = null,
  dueTo = null,
  search = null,
  limit = 25,
  skip = 0,
  now = new Date(),
}: FindOrganizationTasksParams): Promise<FindOrganizationTasksResult> => {
  const organization = toObjectId(organizationId);
  const actor = toObjectId(actorId);

  /*
   * WHO IS IN THE SET, decided here rather than in the UI.
   *
   * `mine` is the actor's own assignments.
   *
   * `team` is every LEAD follow-up in the organisation, plus the actor's OWN personal
   * reminders - and deliberately NOT anybody else's personal reminders. That boundary already
   * exists and is documented in followup.service.ts: a reminder with no conversation ("call
   * the bank about the overdraft") belongs to one person, which is why `transitionTask`
   * refuses to let a colleague close one, and why the device-sync query is assignee-scoped. A
   * team list that included them would be a brand-new way to read private reminders, added by
   * a screen whose entire subject is shared work.
   */
  const scopeFilter: QueryFilter<FollowUpTaskDocument> =
    scope === 'mine'
      ? { assignedTo: actor }
      : { $or: [{ assignedTo: actor }, { conversationId: { $ne: null } }] };

  const baseMatch: QueryFilter<FollowUpTaskDocument> = {
    organizationId: organization,
    ...scopeFilter,
  };

  // A due-date window narrows the WHOLE set, counts included: it is the caller saying "I only
  // care about this period", so a count reaching outside it would answer a different question.
  if (dueFrom || dueTo) {
    baseMatch.dueAt = {
      ...(dueFrom ? { $gte: dueFrom } : {}),
      ...(dueTo ? { $lte: dueTo } : {}),
    };
  }

  const term = (search ?? '').trim();
  const searchStage = term
    ? [
        {
          $match: {
            $or: [
              { title: { $regex: escapeRegex(term), $options: 'i' } },
              { note: { $regex: escapeRegex(term), $options: 'i' } },
              { 'conversation.displayName': { $regex: escapeRegex(term), $options: 'i' } },
            ],
          },
        },
      ]
    : [];

  /*
   * OVERDUE IS COMPUTED, NOT STORED. `missed` exists in the status enum and NOTHING in this
   * codebase has ever written it - analytics.repository.ts states that outright - so "late"
   * has to mean "still pending, and the due instant has passed". Derived against a single
   * `now` fixed for the whole pipeline, because computing it twice would let the counts and
   * the page disagree about the same task.
   */
  const overdueRank = {
    $cond: [
      { $and: [{ $eq: ['$status', FOLLOWUP_STATUSES.PENDING] }, { $lte: ['$dueAt', now] }] },
      0,
      1,
    ],
  };

  const statusStage =
    status === 'late'
      ? [{ $match: { overdueRank: 0 } }]
      : status
        ? [{ $match: { status } }]
        : [];

  const [result] = await FollowUpTask.aggregate([
    { $match: baseMatch },
    {
      // Projected to two fields on purpose. A task card needs the customer's NAME; it has no
      // use for the thread's messages, AI facts or encrypted lead payload, and pulling them
      // would drag a whole conversation document through the pipeline for every row.
      $lookup: {
        from: 'conversations',
        localField: 'conversationId',
        foreignField: '_id',
        as: 'conversation',
        pipeline: [{ $project: { displayName: 1, leadId: 1 } }],
      },
    },
    // preserveNull, because a personal reminder has no conversation and must not vanish here.
    { $unwind: { path: '$conversation', preserveNullAndEmptyArrays: true } },
    ...searchStage,
    { $addFields: { overdueRank } },
    {
      $facet: {
        counts: [
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              pending: {
                $sum: { $cond: [{ $eq: ['$status', FOLLOWUP_STATUSES.PENDING] }, 1, 0] },
              },
              overdue: { $sum: { $cond: [{ $eq: ['$overdueRank', 0] }, 1, 0] } },
              completed: {
                $sum: { $cond: [{ $eq: ['$status', FOLLOWUP_STATUSES.COMPLETED] }, 1, 0] },
              },
              cancelled: {
                $sum: { $cond: [{ $eq: ['$status', FOLLOWUP_STATUSES.CANCELLED] }, 1, 0] },
              },
            },
          },
        ],
        matched: [...statusStage, { $count: 'value' }],
        rows: [
          ...statusStage,
          // Overdue first, then soonest-due. `_id` last is what makes the sort TOTAL: without
          // it, two tasks sharing a due instant can swap places between pages, so one is shown
          // twice and the other never appears at all.
          { $sort: { overdueRank: 1, dueAt: 1, _id: 1 } },
          { $skip: skip },
          { $limit: limit },
        ],
      },
    },
  ]);

  const counts = (result?.counts?.[0] ?? {}) as Partial<OrganizationTaskCounts>;

  return {
    rows: (result?.rows ?? []) as OrganizationTaskRow[],
    matched: (result?.matched?.[0]?.value as number | undefined) ?? 0,
    counts: {
      total: counts.total ?? 0,
      pending: counts.pending ?? 0,
      overdue: counts.overdue ?? 0,
      completed: counts.completed ?? 0,
      cancelled: counts.cancelled ?? 0,
    },
  };
};
