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
leadSourceRouter.patch('/:leadSourceId', requireLeadSourcesManage, updateLeadSource);
leadSourceRouter.post('/:leadSourceId/sync', requireLeadSourcesManage, syncLeadSource);
leadSourceRouter.delete('/:leadSourceId', requireLeadSourcesManage, removeLeadSource);

export default leadSourceRouter;
