import { Router } from 'express';

import {
  authenticateRequest,
  requireLeadSourcesManage,
  requirePasswordChanged,
} from '../../middleware/auth.middleware.js';

import {
  createLeadSource,
  listLeadSources,
  removeLeadSource,
  syncLeadSource,
  updateLeadSource,
} from './lead-source.controller.js';

// Mounted at /api/v1/lead-sources. Admin-only throughout, like the AI knowledge base: a sheet
// link is business configuration, and the leads it produces are read through the inbox.
const leadSourceRouter = Router();

leadSourceRouter.use(authenticateRequest);
leadSourceRouter.use(requirePasswordChanged);

leadSourceRouter.get('/', requireLeadSourcesManage, listLeadSources);
leadSourceRouter.post('/', requireLeadSourcesManage, createLeadSource);
leadSourceRouter.patch('/:leadSourceId', requireLeadSourcesManage, updateLeadSource);
leadSourceRouter.post('/:leadSourceId/sync', requireLeadSourcesManage, syncLeadSource);
leadSourceRouter.delete('/:leadSourceId', requireLeadSourcesManage, removeLeadSource);

export default leadSourceRouter;
