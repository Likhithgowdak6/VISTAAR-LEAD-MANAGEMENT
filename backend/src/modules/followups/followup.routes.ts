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
  listMyFollowUpTasks,
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
followUpRouter.patch('/:taskId/complete', requireCrmTasksManage, completeFollowUp);
followUpRouter.patch('/:taskId/cancel', requireCrmTasksManage, cancelFollowUp);

export default followUpRouter;
