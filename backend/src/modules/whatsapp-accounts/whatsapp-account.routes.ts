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
  connectCloudAccount,
  createAccount,
  disconnectAccount,
  disconnectCloudAccount,
  getAccount,
  getAccountQr,
  listAccounts,
  listAccountTemplates,
  listSendableAccounts,
  pauseAccount,
  removeAccount,
  resetAccount,
  resumeAccount,
  syncAccountTemplates,
  testCloudAccount,
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
// Cloud API connection management. Gated on accounts.manage like every other credential
// operation: pasting a token is how a number starts sending, and it is not a staff action.
whatsappAccountRouter.post('/:accountId/cloud', requireAccountsManage, connectCloudAccount);
whatsappAccountRouter.post('/:accountId/cloud/test', requireAccountsManage, testCloudAccount);
whatsappAccountRouter.delete('/:accountId/cloud', requireAccountsManage, disconnectCloudAccount);
// Reading templates is gated on messages.send, not accounts.manage: staff hold no accounts
// permission at all, and outside the 24-hour window a template is the ONLY way they can reply.
// Syncing stays on accounts.manage because it spends a Meta API call.
whatsappAccountRouter.get('/:accountId/templates', requireMessagesSend, listAccountTemplates);
whatsappAccountRouter.post(
  '/:accountId/templates/sync',
  requireAccountsManage,
  syncAccountTemplates,
);
whatsappAccountRouter.post('/:accountId/pause', requireAccountsManage, pauseAccount);
whatsappAccountRouter.post('/:accountId/resume', requireAccountsManage, resumeAccount);
whatsappAccountRouter.post('/:accountId/reset', requireAccountsManage, resetAccount);
whatsappAccountRouter.post('/:accountId/disconnect', requireAccountsManage, disconnectAccount);
whatsappAccountRouter.delete('/:accountId', requireAccountsManage, removeAccount);

export default whatsappAccountRouter;
