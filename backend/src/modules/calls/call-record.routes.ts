import { Router } from 'express';

import {
  authenticateRequest,
  requireConversationsDelete,
  requireConversationsRead,
  requireCrmTasksManage,
  requirePasswordChanged,
} from '../../middleware/auth.middleware.js';

import {
  confirmCallSuggestion,
  deleteCallAnalysisHandler,
  deleteCallRecording,
  getRetentionPreview,
  dismissCallSuggestion,
  downloadCallRecording,
  getCall,
  getCallAnalysis,
  listConversationCalls,
  receiveCallRecordingFile,
  recordCallOutcome,
  startCall,
  uploadCallRecording,
} from './call-record.controller.js';

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

// Mounted at /api/v1/calls
const callRouter = Router();

callRouter.use(authenticateRequest);
callRouter.use(requirePasswordChanged);

/*
 * A LITERAL PATH, mounted before '/:callId' so "retention" can never be parsed as a call id -
 * the same care '/sync' is mounted with in the follow-up router.
 */
callRouter.get('/retention/preview', requireConversationsRead, getRetentionPreview);

callRouter.get('/:callId', requireConversationsRead, getCall);
callRouter.patch('/:callId/outcome', requireConversationsRead, recordCallOutcome);

// `receiveCallRecordingFile` runs AFTER the auth middleware above, so an unauthenticated
// request is refused before multer reads a single byte of the body.
callRouter.post(
  '/:callId/recording',
  requireConversationsRead,
  receiveCallRecordingFile,
  uploadCallRecording,
);
callRouter.get('/:callId/recording', requireConversationsRead, downloadCallRecording);

/*
 * DESTRUCTIVE AND IRREVERSIBLE, so both carry conversations.delete on top of the read gate.
 *
 * That permission already means "may remove a lead's data" in this codebase and is deliberately
 * withheld from `staff`. Destroying the recording of a customer conversation belongs with it:
 * an agent who can read a lead should not be able to erase the evidence of what was said on it.
 */
callRouter.delete(
  '/:callId/recording',
  requireConversationsRead,
  requireConversationsDelete,
  deleteCallRecording,
);
callRouter.delete(
  '/:callId/analysis',
  requireConversationsRead,
  requireConversationsDelete,
  deleteCallAnalysisHandler,
);

callRouter.get('/:callId/analysis', requireConversationsRead, getCallAnalysis);

/*
 * Confirming a suggestion CREATES A REMINDER, so it carries the task permission as well as the
 * conversation one. Reading a lead and scheduling work on it are different privileges, and
 * `staff` holds one without necessarily holding the other.
 *
 * Dismissing creates nothing and needs only the read gate - refusing to let somebody clear a
 * suggestion they can see would leave it on screen forever.
 */
callRouter.post(
  '/:callId/suggestions/:commitmentId/confirm',
  requireConversationsRead,
  requireCrmTasksManage,
  confirmCallSuggestion,
);
callRouter.post(
  '/:callId/suggestions/:commitmentId/dismiss',
  requireConversationsRead,
  dismissCallSuggestion,
);

export default callRouter;
