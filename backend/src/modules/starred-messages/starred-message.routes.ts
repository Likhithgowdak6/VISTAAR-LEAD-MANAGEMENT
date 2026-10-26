import { Router } from 'express';

import {
  authenticateRequest,
  requireMessagesSend,
  requirePasswordChanged,
} from '../../middleware/auth.middleware.js';

import {
  createStarredMessage,
  deleteStarredMessageById,
  listStarredMessages,
  updateStarredMessageById,
} from './starred-message.controller.js';

/**
 * Mounted at /api/v1/starred-messages.
 *
 * EVERY ROUTE IS MESSAGES_SEND, INCLUDING THE WRITES - which is the opposite of the templates
 * router, where writing needs TEMPLATES_MANAGE. The reason is what each thing is. A template is
 * the studio's: one copy, shared, sent verbatim under the business's name, so changing one
 * changes what the whole team says. A starred message is one person's own, invisible to
 * everyone else, and saving one changes nothing for anybody but them.
 *
 * Requiring TEMPLATES_MANAGE here would have locked staff out of their own scratchpad - staff
 * hold MESSAGES_SEND and deliberately not TEMPLATES_MANAGE - which would have excluded exactly
 * the people who answer the most leads.
 *
 * Ownership is not enforced here. It is in the queries, which filter on the authenticated
 * user's id; see starred-message.repository.ts.
 */
const starredMessageRouter = Router();

starredMessageRouter.use(authenticateRequest);
starredMessageRouter.use(requirePasswordChanged);

starredMessageRouter.get('/', requireMessagesSend, listStarredMessages);
starredMessageRouter.post('/', requireMessagesSend, createStarredMessage);
starredMessageRouter.patch('/:starredMessageId', requireMessagesSend, updateStarredMessageById);
starredMessageRouter.delete('/:starredMessageId', requireMessagesSend, deleteStarredMessageById);

export default starredMessageRouter;
