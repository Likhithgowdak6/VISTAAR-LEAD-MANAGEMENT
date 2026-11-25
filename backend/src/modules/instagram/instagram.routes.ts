/**
 * Authenticated Instagram settings routes.
 *
 * SEPARATE FROM `instagram-public.routes.ts`, which carries the Meta webhook and must never sit
 * behind authentication. Keeping them in two files means a future `use(authenticateRequest)` in
 * the wrong place cannot silence every inbound DM.
 *
 * Everything here needs `settings.manage` except the takeover, which is an inbox action staff
 * take on a thread they are already allowed to read and answer.
 */
import { Router } from 'express';

import {
  authenticateRequest,
  requireMessagesSend,
  requirePasswordChanged,
  requirePermissions,
} from '../../middleware/auth.middleware.js';
import { PERMISSIONS } from '../../constants/permissions.js';
import {
  connectInstagramAccount,
  disconnectInstagramAccount,
  listAvailableInstagramAccounts,
  listInstagramAccounts,
  setInstagramTakeover,
  updateInstagramAutomation,
} from './instagram.controller.js';

const instagramRouter = Router();

instagramRouter.use(authenticateRequest, requirePasswordChanged);

const requireSettingsManage = requirePermissions(PERMISSIONS.SETTINGS_MANAGE);

instagramRouter.get('/accounts', requireSettingsManage, listInstagramAccounts);
instagramRouter.get('/available', requireSettingsManage, listAvailableInstagramAccounts);
instagramRouter.post('/accounts', requireSettingsManage, connectInstagramAccount);
instagramRouter.patch('/accounts/:id/automation', requireSettingsManage, updateInstagramAutomation);
instagramRouter.post('/accounts/:id/disconnect', requireSettingsManage, disconnectInstagramAccount);

// Taking over a thread is an inbox action, not workspace configuration: whoever may answer a
// customer may also stop the automation from answering over them.
instagramRouter.post('/threads/:conversationId/takeover', requireMessagesSend, setInstagramTakeover);

export default instagramRouter;
