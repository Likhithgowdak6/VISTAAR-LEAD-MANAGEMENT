import { Router } from 'express';

import {
  authenticateRequest,
  requireAiKnowledgeManage,
  requirePasswordChanged,
} from '../../middleware/auth.middleware.js';

import { archiveKnowledge, createKnowledge, listKnowledge } from './ai-knowledge.controller.js';

// Mounted at /api/v1/ai/knowledge. Unlike Tags, every route here — including GET — is
// admin-only: this is business-sensitive configuration (pricing, policy) that grounds AI
// drafts, not something to expose to every conversation-reading role.
const aiKnowledgeRouter = Router();

aiKnowledgeRouter.use(authenticateRequest);
aiKnowledgeRouter.use(requirePasswordChanged);

aiKnowledgeRouter.get('/', requireAiKnowledgeManage, listKnowledge);
aiKnowledgeRouter.post('/', requireAiKnowledgeManage, createKnowledge);
aiKnowledgeRouter.patch('/:knowledgeId/archive', requireAiKnowledgeManage, archiveKnowledge);

export default aiKnowledgeRouter;
