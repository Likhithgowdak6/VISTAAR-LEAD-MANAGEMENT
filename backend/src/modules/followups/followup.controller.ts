import { requireAuthContext } from '../../middleware/auth.middleware.js';
import { asyncHandler } from '../../utils/async-handler.js';
import { createHttpError } from '../../utils/http-error.js';
import { parseWithSchema } from '../../utils/parse-with-schema.js';

import {
  cancelFollowUpForActor,
  completeFollowUpForActor,
  createFollowUpForActor,
  listConversationFollowUpsForActor,
  createPersonalReminderForActor,
  listMyFollowUps,
  listOrganizationTasksForActor,
  rescheduleFollowUpForActor,
} from './followup.service.js';
import { createReminderSyncService, type ReminderSyncService } from './reminder-sync.service.js';
import {
  conversationIdParamsSchema,
  createFollowUpBodySchema,
  createPersonalReminderBodySchema,
  listMyFollowUpsQuerySchema,
  listOrganizationTasksQuerySchema,
  rescheduleFollowUpBodySchema,
  syncRemindersBodySchema,
  taskIdParamsSchema,
} from './followup.validation.js';

let reminderSyncSingleton: ReminderSyncService | null = null;
const getReminderSyncService = (): ReminderSyncService => {
  reminderSyncSingleton ??= createReminderSyncService();
  return reminderSyncSingleton;
};

const followUpErrorMap = {
  CONVERSATION_NOT_FOUND: { statusCode: 404, message: 'Conversation not found.' },
  CONVERSATION_ACCESS_DENIED: {
    statusCode: 403,
    message: 'You do not have access to this conversation.',
  },
  FOLLOWUP_NOT_FOUND: { statusCode: 404, message: 'Follow-up task not found.' },
  FOLLOWUP_NOT_PENDING: {
    statusCode: 409,
    message: 'Only a pending follow-up task can change status.',
  },
  // 403 rather than 404: unlike a reminder id, the existence of a team view is not a secret,
  // and telling somebody "you do not have access" is more useful than pretending the tab is
  // not there when the UI has already shown it to them.
  TASKS_TEAM_ACCESS_DENIED: {
    statusCode: 403,
    message: 'You do not have access to the team task list.',
  },
} as const;

type FollowUpErrorCode = keyof typeof followUpErrorMap;

const mapFollowUpError = (error: unknown): never => {
  const message = error instanceof Error ? error.message : '';
  const mapped =
    message in followUpErrorMap ? followUpErrorMap[message as FollowUpErrorCode] : undefined;

  if (!mapped) {
    throw error;
  }

  throw createHttpError({
    statusCode: mapped.statusCode,
    code: message,
    message: mapped.message,
  });
};

export const createFollowUp = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: conversationIdParamsSchema,
    value: req.params,
    source: 'Params',
  });
  const body = parseWithSchema({
    schema: createFollowUpBodySchema,
    value: req.body,
    source: 'Body',
  });

  try {
    const task = await createFollowUpForActor({
      organizationId: auth.organization._id,
      conversationId: params.conversationId,
      actor: auth.user,
      permissions: auth.permissions,
      assignedTo: body.assignedTo,
      type: body.type,
      note: body.note,
      dueAt: body.dueAt,
      priority: body.priority,
    });

    res.status(201).json({ data: task });
  } catch (error: unknown) {
    mapFollowUpError(error);
  }
});

export const listConversationFollowUps = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: conversationIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const tasks = await listConversationFollowUpsForActor({
      organizationId: auth.organization._id,
      conversationId: params.conversationId,
      actor: auth.user,
      permissions: auth.permissions,
    });

    res.status(200).json({ data: tasks, meta: { count: tasks.length } });
  } catch (error: unknown) {
    mapFollowUpError(error);
  }
});

export const listMyFollowUpTasks = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const query = parseWithSchema({
    schema: listMyFollowUpsQuerySchema,
    value: req.query,
    source: 'Query',
  });

  const tasks = await listMyFollowUps({
    organizationId: auth.organization._id,
    actor: auth.user,
    dueBefore: query.dueBefore,
    limit: query.limit,
    skip: query.skip,
  });

  res.status(200).json({
    data: tasks,
    meta: { limit: query.limit, skip: query.skip, count: tasks.length },
  });
});

/**
 * GET /follow-ups/tasks - the centralised Tasks screen.
 *
 * ADDITIVE. `GET /follow-ups` keeps its existing meaning (my pending reminders, used by the
 * older list) and is untouched, because changing the shape of a live endpoint to serve a new
 * screen is how an app that was working yesterday stops working today.
 *
 * `meta` carries the counts as well as the pagination, in one round trip: the chips and the
 * list describe the same dataset, and fetching them separately would let them disagree.
 */
export const listOrganizationTasks = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const query = parseWithSchema({
    schema: listOrganizationTasksQuerySchema,
    value: req.query,
    source: 'Query',
  });

  try {
    const { tasks, matched, counts } = await listOrganizationTasksForActor({
      organizationId: auth.organization._id,
      actor: auth.user,
      permissions: auth.permissions,
      scope: query.scope,
      status: query.status ?? null,
      dueFrom: query.dueFrom ?? null,
      dueTo: query.dueTo ?? null,
      search: query.search ?? null,
      limit: query.limit,
      skip: query.skip,
    });

    res.status(200).json({
      data: tasks,
      meta: {
        scope: query.scope,
        limit: query.limit,
        skip: query.skip,
        count: tasks.length,
        matched,
        counts,
      },
    });
  } catch (error: unknown) {
    mapFollowUpError(error);
  }
});

export const completeFollowUp = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: taskIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const task = await completeFollowUpForActor({
      organizationId: auth.organization._id,
      taskId: params.taskId,
      actor: auth.user,
    });

    res.status(200).json({ data: task });
  } catch (error: unknown) {
    mapFollowUpError(error);
  }
});

export const cancelFollowUp = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: taskIdParamsSchema,
    value: req.params,
    source: 'Params',
  });

  try {
    const task = await cancelFollowUpForActor({
      organizationId: auth.organization._id,
      taskId: params.taskId,
      actor: auth.user,
    });

    res.status(200).json({ data: task });
  } catch (error: unknown) {
    mapFollowUpError(error);
  }
});

/**
 * POST /follow-ups/sync - what the Android app calls to arm its local alarms.
 *
 * POST rather than GET because the device sends up the ids it has already scheduled, and that
 * list is a write (it stamps `androidDelivery.syncedAt`). Everything about WHOSE reminders
 * these are comes from `requireAuthContext`, never from the body.
 */
export const syncReminders = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const body = parseWithSchema({
    schema: syncRemindersBodySchema,
    value: req.body ?? {},
    source: 'Body',
  });

  const data = await getReminderSyncService().syncRemindersForDevice({
    organizationId: auth.organization._id,
    userId: auth.user._id,
    since: body.since ?? null,
    acknowledgedIds: body.acknowledgedIds,
  });

  res.status(200).json({ data });
});

/** POST /follow-ups - a personal reminder, belonging to nobody but the person creating it. */
export const createPersonalReminder = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const body = parseWithSchema({
    schema: createPersonalReminderBodySchema,
    value: req.body ?? {},
    source: 'Body',
  });

  try {
    const task = await createPersonalReminderForActor({
      organizationId: auth.organization._id,
      actor: auth.user,
      title: body.title,
      dueAt: body.dueAt,
      timezone: body.timezone ?? null,
    });

    res.status(201).json({ data: task });
  } catch (error: unknown) {
    mapFollowUpError(error);
  }
});

/** PATCH /follow-ups/:taskId/reschedule - move it, and re-arm every channel. */
export const rescheduleFollowUp = asyncHandler(async (req, res) => {
  const auth = requireAuthContext(req);
  const params = parseWithSchema({
    schema: taskIdParamsSchema,
    value: req.params,
    source: 'Params',
  });
  const body = parseWithSchema({
    schema: rescheduleFollowUpBodySchema,
    value: req.body ?? {},
    source: 'Body',
  });

  try {
    const task = await rescheduleFollowUpForActor({
      organizationId: auth.organization._id,
      taskId: params.taskId,
      actor: auth.user,
      dueAt: body.dueAt,
      timezone: body.timezone ?? null,
    });

    res.status(200).json({ data: task });
  } catch (error: unknown) {
    mapFollowUpError(error);
  }
});

