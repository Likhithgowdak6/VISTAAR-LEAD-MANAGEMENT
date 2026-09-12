import { Router } from 'express';

import {
  authenticateRequest,
  requireAiGenerate,
  requireMessagesSend,
  requirePasswordChanged,
  requireTemplatesManage,
} from '../../middleware/auth.middleware.js';

import {
  createTemplate,
  deleteTemplate,
  generateTemplates,
  listTemplates,
} from './message-template.controller.js';

/**
 * Mounted at /api/v1/templates.
 *
 * Reading is gated on MESSAGES_SEND rather than on TEMPLATES_MANAGE: the point of a saved quote
 * is that whoever is answering the lead can reach for it. Writing and deleting need
 * TEMPLATES_MANAGE, because these go out verbatim under the studio's name and contain its prices.
 * Generating costs an LLM call, so it needs AI_GENERATE - which staff have.
 */
const messageTemplateRouter = Router();

messageTemplateRouter.use(authenticateRequest);
messageTemplateRouter.use(requirePasswordChanged);

messageTemplateRouter.get('/', requireMessagesSend, listTemplates);
messageTemplateRouter.post('/generate', requireAiGenerate, generateTemplates);
messageTemplateRouter.post('/', requireTemplatesManage, createTemplate);
messageTemplateRouter.delete('/:templateId', requireTemplatesManage, deleteTemplate);

export default messageTemplateRouter;
