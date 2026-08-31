import { Router } from 'express';

import {
  authenticateRequest,
  requirePasswordChanged,
  requireConversationsRead,
  requireCrmTagsManage,
} from '../../middleware/auth.middleware.js';

import { archiveTag, attachTag, createTag, detachTag, listTags } from './tag.controller.js';

// Mounted at /api/v1/tags
const tagRouter = Router();

tagRouter.use(authenticateRequest);
tagRouter.use(requirePasswordChanged);

tagRouter.get('/', requireConversationsRead, listTags);
tagRouter.post('/', requireCrmTagsManage, createTag);
tagRouter.patch('/:tagId/archive', requireCrmTagsManage, archiveTag);

// Mounted under /conversations/:conversationId/tags
export const conversationTagRouter = Router({ mergeParams: true });

conversationTagRouter.post('/', requireCrmTagsManage, attachTag);
conversationTagRouter.delete('/:tagId', requireCrmTagsManage, detachTag);

export default tagRouter;
