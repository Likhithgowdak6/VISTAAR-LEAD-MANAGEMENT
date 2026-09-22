import { Router } from 'express';

import {
  authenticateRequest,
  requireAiGenerate,
  requireConversationsAssign,
  requireConversationsDelete,
  requireConversationsRead,
  requireMessagesSend,
  requirePasswordChanged,
} from '../../middleware/auth.middleware.js';
import { generateAiDraft, recordAiDraftOutcome } from '../ai/ai-draft.controller.js';
import { conversationFollowUpRouter } from '../followups/followup.routes.js';
import noteRouter from '../notes/note.routes.js';
import { conversationTagRouter } from '../tags/tag.routes.js';

import {
  assignConversation,
  changeConversationCategory,
  changeConversationStage,
  createManualLead,
  deleteConversation,
  getConversation,
  listAiCategories,
  restoreConversationHandler,
  getConversationActivity,
  getConversationLeadSubmissions,
  getConversationMessages,
  getConversationSummary,
  listConversations,
  regenerateConversationSummary,
  sendConversationMessage,
} from './conversation.controller.js';

const conversationRouter = Router();

conversationRouter.use(authenticateRequest);
conversationRouter.use(requirePasswordChanged);

conversationRouter.get('/', requireConversationsRead, listConversations);
// Adding a lead by hand. Gated on MESSAGES_SEND rather than read: this creates a contact and can
// send an unsolicited opening message, so it belongs with the permissions that reach a customer.
conversationRouter.post('/', requireMessagesSend, createManualLead);
conversationRouter.get('/:conversationId', requireConversationsRead, getConversation);
conversationRouter.get(
  '/:conversationId/messages',
  requireConversationsRead,
  getConversationMessages,
);
conversationRouter.get(
  '/:conversationId/activity',
  requireConversationsRead,
  getConversationActivity,
);
conversationRouter.get(
  '/:conversationId/lead-submissions',
  requireConversationsRead,
  getConversationLeadSubmissions,
);
// The AI's catch-up read of the thread. GET only ever serves what is stored; POST is the
// explicit "(re)generate", which is the ONLY thing that spends an ai-brain-service call.
conversationRouter.get('/:conversationId/summary', requireConversationsRead, getConversationSummary);
conversationRouter.post(
  '/:conversationId/summary',
  requireAiGenerate,
  regenerateConversationSummary,
);
conversationRouter.patch(
  '/:conversationId/assignment',
  requireConversationsAssign,
  assignConversation,
);
conversationRouter.patch(
  '/:conversationId/stage',
  requireConversationsRead,
  changeConversationStage,
);
// The service-playbook picker and its options. Same gate as stage: anyone who can work a
// conversation can correct how it is being handled.
conversationRouter.get('/meta/ai-categories', requireConversationsRead, listAiCategories);
conversationRouter.patch(
  '/:conversationId/category',
  requireConversationsRead,
  changeConversationCategory,
);
// Delete hides the chat and stops every automation on it; restore brings it back with the AI
// still off. Gated separately from reading and assigning - `staff` deliberately cannot do this.
conversationRouter.delete('/:conversationId', requireConversationsDelete, deleteConversation);
conversationRouter.post(
  '/:conversationId/restore',
  requireConversationsDelete,
  restoreConversationHandler,
);
conversationRouter.post('/:conversationId/messages', requireMessagesSend, sendConversationMessage);
conversationRouter.post('/:conversationId/ai-draft', requireAiGenerate, generateAiDraft);
conversationRouter.patch(
  '/:conversationId/ai-draft/:draftId/outcome',
  requireAiGenerate,
  recordAiDraftOutcome,
);

// Conversation-scoped CRM sub-resources
conversationRouter.use('/:conversationId/notes', noteRouter);
conversationRouter.use('/:conversationId/follow-ups', conversationFollowUpRouter);
conversationRouter.use('/:conversationId/tags', conversationTagRouter);

export default conversationRouter;
