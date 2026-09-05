import { Router } from 'express';

import {
  authenticateRequest,
  requirePasswordChanged,
  requireSettingsManage,
} from '../../middleware/auth.middleware.js';

import { clearTestData, getTestModeStatus } from './test-data.controller.js';

// Mounted at /api/v1/dev-tools. TEST-PHASE ONLY - see test-data.service.ts. Delete this whole
// module before production.
const testDataRouter = Router();

testDataRouter.use(authenticateRequest);
testDataRouter.use(requirePasswordChanged);

testDataRouter.get('/test-mode', requireSettingsManage, getTestModeStatus);
testDataRouter.post('/clear-test-data', requireSettingsManage, clearTestData);

export default testDataRouter;
