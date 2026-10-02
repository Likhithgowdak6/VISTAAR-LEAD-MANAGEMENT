import { Router } from 'express';

import {
  authenticateRequest,
  requireLeadSourcesManage,
  requirePasswordChanged,
} from '../../middleware/auth.middleware.js';

import {
  createLeadSource,
  listLeadSources,
  listMetaForms,
  removeLeadSource,
  syncLeadSource,
  testMetaConnection,
  updateLeadSource,
} from './lead-source.controller.js';
import {
  createMetaOauthLeadSource,
  getMetaConnection,
  listConnectedMetaFormFields,
  listConnectedMetaForms,
  listConnectedMetaPages,
  listMetaFieldKeys,
  removeMetaConnection,
  retryMetaWebhookSubscription,
  runMetaDiagnostics,
  startMetaOauth,
} from './meta-oauth.controller.js';

// Mounted at /api/v1/lead-sources. Admin-only throughout, like the AI knowledge base: a sheet
// link is business configuration, and the leads it produces are read through the inbox.
const leadSourceRouter = Router();

leadSourceRouter.use(authenticateRequest);
leadSourceRouter.use(requirePasswordChanged);

leadSourceRouter.get('/', requireLeadSourcesManage, listLeadSources);
leadSourceRouter.post('/', requireLeadSourcesManage, createLeadSource);

// POST, not GET: both carry a pasted Page access token in the body, and a token in a query string
// ends up in access logs, proxy logs and browser history. Neither writes anything.
leadSourceRouter.post('/meta/test-connection', requireLeadSourcesManage, testMetaConnection);
leadSourceRouter.post('/meta/forms', requireLeadSourcesManage, listMetaForms);

// ---- Facebook Login, so nobody has to paste a token ----
//
// The OAuth CALLBACK is deliberately not here - it arrives from Meta with no session and lives in
// meta-public.routes.ts. Everything below is the authenticated half the wizard drives.
leadSourceRouter.get('/meta/oauth/start', requireLeadSourcesManage, startMetaOauth);
leadSourceRouter.get('/meta/connection', requireLeadSourcesManage, getMetaConnection);
leadSourceRouter.delete('/meta/connection', requireLeadSourcesManage, removeMetaConnection);
leadSourceRouter.get('/meta/pages', requireLeadSourcesManage, listConnectedMetaPages);
leadSourceRouter.get(
  '/meta/pages/:pageId/forms',
  requireLeadSourcesManage,
  listConnectedMetaForms,
);
leadSourceRouter.get(
  '/meta/pages/:pageId/forms/:formId/fields',
  requireLeadSourcesManage,
  listConnectedMetaFormFields,
);
// The override choices for the mapping step. Static, and above /:leadSourceId so the literal
// path is not swallowed by the parameterised one.
leadSourceRouter.get('/meta/field-keys', requireLeadSourcesManage, listMetaFieldKeys);
// Activate: create the source, subscribe the page, go live. No token in the body - the Page token
// is minted server-side from the stored connection.
leadSourceRouter.post('/meta/sources', requireLeadSourcesManage, createMetaOauthLeadSource);
leadSourceRouter.post(
  '/meta/sources/:leadSourceId/subscribe',
  requireLeadSourcesManage,
  retryMetaWebhookSubscription,
);
leadSourceRouter.get('/meta/diagnostics', requireLeadSourcesManage, runMetaDiagnostics);
leadSourceRouter.patch('/:leadSourceId', requireLeadSourcesManage, updateLeadSource);
leadSourceRouter.post('/:leadSourceId/sync', requireLeadSourcesManage, syncLeadSource);
leadSourceRouter.delete('/:leadSourceId', requireLeadSourcesManage, removeLeadSource);

export default leadSourceRouter;
