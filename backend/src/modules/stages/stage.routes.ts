import { Router } from 'express';

import {
  authenticateRequest,
  requireConversationsRead,
  requireCrmStageManage,
  requirePasswordChanged,
} from '../../middleware/auth.middleware.js';

import { archiveStage, createStage, deleteStage, listStages } from './stage.controller.js';

// Mounted at /api/v1/stages
const stageRouter = Router();

stageRouter.use(authenticateRequest);
stageRouter.use(requirePasswordChanged);

stageRouter.get('/', requireConversationsRead, listStages);
stageRouter.post('/', requireCrmStageManage, createStage);
stageRouter.patch('/:stageId/archive', requireCrmStageManage, archiveStage);
stageRouter.delete('/:stageId', requireCrmStageManage, deleteStage);

export default stageRouter;
