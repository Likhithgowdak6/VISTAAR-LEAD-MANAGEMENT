import { Router } from 'express';

import {
  authenticateRequest,
  requirePasswordChanged,
  requireAccountsManage,
  requireAccountsRead,
  requireMessagesSend,
} from '../../middleware/auth.middleware.js';

import {
  connectAccount,
  createAccount,
  disconnectAccount,
  getAccount,
  getAccountQr,
  listAccounts,
  listSendableAccounts,
  pauseAccount,
  removeAccount,
  resetAccount,
  resumeAccount,
} from './whatsapp-account.controller.js';

const whatsappAccountRouter = Router();

whatsappAccountRouter.use(authenticateRequest);
whatsappAccountRouter.use(requirePasswordChanged);

whatsappAccountRouter.get('/', requireAccountsRead, listAccounts);
// Gated on messages.send, not accounts.read: staff hold no accounts permission at all, and
// they still need to choose which number a reply goes out from. Mounted before `/:accountId`
// so "sendable" is never parsed as an id.
whatsappAccountRouter.get('/sendable', requireMessagesSend, listSendableAccounts);
whatsappAccountRouter.post('/', requireAccountsManage, createAccount);
whatsappAccountRouter.get('/:accountId', requireAccountsRead, getAccount);
whatsappAccountRouter.get('/:accountId/qr', requireAccountsManage, getAccountQr);
whatsappAccountRouter.post('/:accountId/connect', requireAccountsManage, connectAccount);
whatsappAccountRouter.post('/:accountId/pause', requireAccountsManage, pauseAccount);
whatsappAccountRouter.post('/:accountId/resume', requireAccountsManage, resumeAccount);
whatsappAccountRouter.post('/:accountId/reset', requireAccountsManage, resetAccount);
whatsappAccountRouter.post('/:accountId/disconnect', requireAccountsManage, disconnectAccount);
whatsappAccountRouter.delete('/:accountId', requireAccountsManage, removeAccount);

export default whatsappAccountRouter;
