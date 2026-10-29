import { Router } from 'express';

import {
  authenticateRequest,
  requireCrmTasksManage,
  requirePasswordChanged,
} from '../../middleware/auth.middleware.js';

import {
  cancelFollowUp,
  completeFollowUp,
  createFollowUp,
  listConversationFollowUps,
  createPersonalReminder,
  listMyFollowUpTasks,
  listOrganizationTasks,
  rescheduleFollowUp,
  syncReminders,
} from './followup.controller.js';

// Mounted under /conversations/:conversationId/follow-ups
export const conversationFollowUpRouter = Router({ mergeParams: true });

conversationFollowUpRouter.get('/', requireCrmTasksManage, listConversationFollowUps);
conversationFollowUpRouter.post('/', requireCrmTasksManage, createFollowUp);

// Mounted at /api/v1/follow-ups
const followUpRouter = Router();

followUpRouter.use(authenticateRequest);
followUpRouter.use(requirePasswordChanged);

followUpRouter.get('/', requireCrmTasksManage, listMyFollowUpTasks);
// The centralised Tasks screen. A literal path, so it is matched before anything could read
// "tasks" as an id - the same care '/sync' below is mounted with.
followUpRouter.get('/tasks', requireCrmTasksManage, listOrganizationTasks);
// The Android app's sync. Mounted before '/:taskId' routes so "sync" is never parsed as an id.
followUpRouter.post('/sync', requireCrmTasksManage, syncReminders);
followUpRouter.post('/', requireCrmTasksManage, createPersonalReminder);
followUpRouter.patch('/:taskId/reschedule', requireCrmTasksManage, rescheduleFollowUp);
followUpRouter.patch('/:taskId/complete', requireCrmTasksManage, completeFollowUp);
followUpRouter.patch('/:taskId/cancel', requireCrmTasksManage, cancelFollowUp);

export default followUpRouter;
