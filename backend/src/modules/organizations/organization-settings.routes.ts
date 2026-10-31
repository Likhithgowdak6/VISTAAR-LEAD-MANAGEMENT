import { Router } from 'express';

import {
  authenticateRequest,
  requirePasswordChanged,
  requireSettingsManage,
} from '../../middleware/auth.middleware.js';

import {
  getSettings,
  updateCallRetentionSettings,
  updateSettings,
} from './organization-settings.controller.js';

// Mounted at /api/v1/settings
const organizationSettingsRouter = Router();

organizationSettingsRouter.use(authenticateRequest);
organizationSettingsRouter.use(requirePasswordChanged);

// Read is gated the same as the write: there is no settings.read permission, and the owner's
// personal phone is org-configuration rather than something the whole team needs to see.
organizationSettingsRouter.get('/', requireSettingsManage, getSettings);
organizationSettingsRouter.patch('/', requireSettingsManage, updateSettings);

// Same permission as everything else here. Retention decides when customer recordings are
// destroyed, which is squarely an owner/admin decision rather than an agent's - and
// settings.manage is already the permission that means exactly that in this codebase.
organizationSettingsRouter.patch(
  '/call-retention',
  requireSettingsManage,
  updateCallRetentionSettings,
);

export default organizationSettingsRouter;
