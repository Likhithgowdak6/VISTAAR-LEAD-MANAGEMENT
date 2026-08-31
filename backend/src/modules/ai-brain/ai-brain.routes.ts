import { Router } from 'express';

import {
  authenticateRequest,
  requireAiAutomationManage,
  requireAiGenerate,
  requireConversationsRead,
  requireMessagesSend,
  requirePasswordChanged,
} from '../../middleware/auth.middleware.js';

import {
  checkOutcome,
  generateProposal,
  getApproval,
  listPendingApprovals,
  renderProposal,
  resolveApproval,
  reviseProposal,
  setAutomation,
} from './ai-brain.controller.js';

// Mounted at /api/v1/ai-brain
const aiBrainRouter = Router();

aiBrainRouter.use(authenticateRequest);
aiBrainRouter.use(requirePasswordChanged);

// "Needs your review" list.
aiBrainRouter.get('/approvals', requireConversationsRead, listPendingApprovals);

// The one pending draft (if any) for a single conversation.
aiBrainRouter.get(
  '/conversations/:conversationId/approval',
  requireConversationsRead,
  getApproval,
);

// A human approves, edits, or skips the AI's drafted reply.
aiBrainRouter.post(
  '/conversations/:conversationId/approval/resolve',
  requireMessagesSend,
  resolveApproval,
);

// Turn the qualifying-chat automation on/off for one conversation.
aiBrainRouter.post(
  '/conversations/:conversationId/automation',
  requireAiAutomationManage,
  setAutomation,
);

// Ask the AI's won/lost/needs-attention classifier to re-read this conversation right now.
aiBrainRouter.post(
  '/conversations/:conversationId/outcome/check',
  requireAiAutomationManage,
  checkOutcome,
);

// Proposal drafting - generate content, revise it by instruction, then render it to a
// downloadable docx/pdf. Sending it to the lead is still a manual step from the CRM.
aiBrainRouter.post(
  '/conversations/:conversationId/proposal/generate',
  requireAiGenerate,
  generateProposal,
);

aiBrainRouter.post('/proposal/revise', requireAiGenerate, reviseProposal);

aiBrainRouter.post(
  '/conversations/:conversationId/proposal/render',
  requireAiGenerate,
  renderProposal,
);

export default aiBrainRouter;
