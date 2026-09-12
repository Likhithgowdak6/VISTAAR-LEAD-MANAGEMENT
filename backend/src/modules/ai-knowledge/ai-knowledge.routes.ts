import { Router } from 'express';

import {
  authenticateRequest,
  requireAiKnowledgeManage,
  requirePasswordChanged,
} from '../../middleware/auth.middleware.js';

import {
  archiveKnowledge,
  createKnowledge,
  deleteKnowledge,
  listKnowledge,
  optimizeKnowledge,
  updateKnowledge,
} from './ai-knowledge.controller.js';

// Mounted at /api/v1/ai/knowledge. Unlike Tags, every route here — including GET — is
// admin-only: this is business-sensitive configuration (pricing, policy) that grounds AI
// drafts, not something to expose to every conversation-reading role.
const aiKnowledgeRouter = Router();

aiKnowledgeRouter.use(authenticateRequest);
aiKnowledgeRouter.use(requirePasswordChanged);

aiKnowledgeRouter.get('/', requireAiKnowledgeManage, listKnowledge);
aiKnowledgeRouter.post('/', requireAiKnowledgeManage, createKnowledge);
// Costs an LLM call and writes nothing, so it sits behind the same admin gate as the writes.
aiKnowledgeRouter.post('/optimize', requireAiKnowledgeManage, optimizeKnowledge);
// The more specific /archive is declared first so it can never be shadowed by the edit route.
aiKnowledgeRouter.patch('/:knowledgeId/archive', requireAiKnowledgeManage, archiveKnowledge);
aiKnowledgeRouter.patch('/:knowledgeId', requireAiKnowledgeManage, updateKnowledge);
// Irreversible, unlike archive. The UI confirms before calling this.
aiKnowledgeRouter.delete('/:knowledgeId', requireAiKnowledgeManage, deleteKnowledge);

export default aiKnowledgeRouter;
