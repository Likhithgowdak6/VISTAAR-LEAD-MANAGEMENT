import { z } from 'zod';

import {
  FOLLOWUP_PRIORITIES,
  FOLLOWUP_PRIORITY_VALUES,
} from '../../constants/followup-priorities.js';
import { FOLLOWUP_TYPES, FOLLOWUP_TYPE_VALUES } from '../../constants/followup-types.js';

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i);

export const conversationIdParamsSchema = z.object({
  conversationId: objectIdSchema,
});

export const taskIdParamsSchema = z.object({
  taskId: objectIdSchema,
});

export const listMyFollowUpsQuerySchema = z.object({
  dueBefore: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  skip: z.coerce.number().int().min(0).default(0),
});

/**
 * The centralised Tasks screen's query.
 *
 * Note what is NOT here, for the same reason the sync body documents it: no organisation id,
 * no user id, no assignee. `scope` says MINE or TEAM and the server resolves both from the
 * auth context, so there is no field here that could point the query at somebody else.
 *
 * `limit` caps at 100 like every other list in this module - a screen that asks for ten
 * thousand rows is a mistake or an attack, and either way the answer is the same.
 */
export const listOrganizationTasksQuerySchema = z.object({
  scope: z.enum(['mine', 'team']).default('mine'),
  /** `late` is derived (pending + past due), not a stored status. See the repository. */
  status: z.enum(['pending', 'late', 'completed', 'cancelled']).optional(),
  dueFrom: z.coerce.date().optional(),
  dueTo: z.coerce.date().optional(),
  /** Matched against task title, note and the lead's display name. Regex-escaped server-side. */
  search: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  skip: z.coerce.number().int().min(0).default(0),
});

export const createFollowUpBodySchema = z.object({
  assignedTo: objectIdSchema.optional(),
  type: z.enum(FOLLOWUP_TYPE_VALUES).default(FOLLOWUP_TYPES.CUSTOM),
  note: z.string().trim().min(1).max(1000).optional(),
  dueAt: z.coerce.date(),
  priority: z.enum(FOLLOWUP_PRIORITY_VALUES).default(FOLLOWUP_PRIORITIES.NORMAL),
});

/**
 * The device's sync request.
 *
 * Note what is NOT here: no user id, no organisation id, no assignee. Those come from the auth
 * context, so there is no field a device could set to read somebody else's reminders. The
 * acknowledged ids are re-scoped server-side before anything is written.
 */
export const syncRemindersBodySchema = z.object({
  /** The `syncedAt` from the device's previous sync. Omit for a full bounded refresh. */
  since: z.coerce.date().optional(),
  /** Reminder ids the device has armed locally, capped so one request cannot be unbounded. */
  acknowledgedIds: z.array(objectIdSchema).max(500).default([]),
});

/** A personal reminder: a title and a moment, nothing else. */
export const createPersonalReminderBodySchema = z.object({
  title: z.string().trim().min(1).max(200),
  dueAt: z.coerce.date(),
  timezone: z.string().trim().max(64).optional(),
});

export const rescheduleFollowUpBodySchema = z.object({
  dueAt: z.coerce.date(),
  /**
   * The zone the new time was CHOSEN in.
   *
   * Optional, and when it is sent the reminder adopts it - which keeps one invariant true for
   * every path: a reminder is displayed in the zone whoever set it was standing in. Without
   * this, rescheduling kept the original zone, so an owner in London moving an Asia/Kolkata
   * reminder to "6 PM" stored the right instant and then listed it as 10:30 PM.
   */
  timezone: z.string().trim().max(64).optional(),
});

