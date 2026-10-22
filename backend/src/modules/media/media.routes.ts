import { Router } from 'express';

import {
  authenticateRequest,
  requireConversationsRead,
  requirePasswordChanged,
} from '../../middleware/auth.middleware.js';
import { downloadMessageMedia } from './media.controller.js';

/**
 * Reading an attachment back.
 *
 * Mounted at /messages rather than under the conversation, because the message id is the thing
 * the thread actually has in hand - and the handler re-derives the conversation from the row it
 * loads instead of trusting a conversation id from the URL to match it.
 *
 * Gated on CONVERSATIONS_READ: seeing the attachment is seeing the message. The handler then
 * applies the same per-actor visibility rule the thread does, so assignment-restricted staff
 * cannot reach a photo from a lead they cannot open.
 */
const messageRouter = Router();

messageRouter.use(authenticateRequest);
messageRouter.use(requirePasswordChanged);

messageRouter.get('/:messageId/media', requireConversationsRead, downloadMessageMedia);

export default messageRouter;
