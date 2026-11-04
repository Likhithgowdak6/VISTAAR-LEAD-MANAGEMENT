import { Router } from 'express';

import {
  authenticateRequest,
  requireConversationsRead,
  requireCrmTasksManage,
  requirePasswordChanged,
} from '../../middleware/auth.middleware.js';

import {
  getCall,
  listConversationCalls,
  recordCallOutcome,
  startCall,
} from './call-record.controller.js';
import { recordCallOutcome as recordConversationCallOutcome } from './call-outcome.controller.js';

/**
 * NO NEW PERMISSION, deliberately.
 *
 * A call is a thing that happened on a lead, exactly like a message, a note or a reminder - so
 * seeing one is seeing the lead, and CONVERSATIONS_READ is already the permission that decides
 * that. The service then applies the same per-actor visibility rule the thread does, so an
 * assignment-restricted agent cannot reach a call on a lead they cannot open.
 *
 * Writing is gated on the same permission rather than on MESSAGES_SEND: opening the dialler
 * sends nothing and costs nothing, and recording what happened afterwards is a note about a
 * conversation you can already read. The customer's NUMBER is the sensitive part, and that is
 * guarded separately by CLIENT_PII_REVEAL on the existing reveal route - which the client calls
 * before this one.
 */

// Mounted under /conversations/:conversationId/calls
export const conversationCallRouter = Router({ mergeParams: true });

conversationCallRouter.get('/', requireConversationsRead, listConversationCalls);
conversationCallRouter.post('/', requireConversationsRead, startCall);

/**
 * The owner's account of a call, and everything that follows from it.
 *
 * Mounted on the CONVERSATION rather than on a call - see the controller for why. Carries
 * `crm_tasks.manage` on top of the read gate because it completes or moves a reminder, which is
 * the permission that already means "may schedule work on a lead" in this codebase.
 */
export const conversationCallOutcomeRouter = Router({ mergeParams: true });

conversationCallOutcomeRouter.post(
  '/',
  requireConversationsRead,
  requireCrmTasksManage,
  recordConversationCallOutcome,
);

// Mounted at /api/v1/calls
const callRouter = Router();

callRouter.use(authenticateRequest);
callRouter.use(requirePasswordChanged);

callRouter.get('/:callId', requireConversationsRead, getCall);
callRouter.patch('/:callId/outcome', requireConversationsRead, recordCallOutcome);

export default callRouter;
