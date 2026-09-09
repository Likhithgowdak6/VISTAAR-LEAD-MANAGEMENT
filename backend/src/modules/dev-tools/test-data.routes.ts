import { Router } from 'express';

import {
  authenticateRequest,
  requirePasswordChanged,
  requireSettingsManage,
} from '../../middleware/auth.middleware.js';

import {
  callOwnerForTest,
  clearTestData,
  getTestModeStatus,
  readTestCallOutcome,
} from './test-data.controller.js';

// Mounted at /api/v1/dev-tools. TEST-PHASE ONLY - see test-data.service.ts. Delete this whole
// module before production.
const testDataRouter = Router();

testDataRouter.use(authenticateRequest);
testDataRouter.use(requirePasswordChanged);

testDataRouter.get('/test-mode', requireSettingsManage, getTestModeStatus);
testDataRouter.post('/clear-test-data', requireSettingsManage, clearTestData);

// Ring the owner's own number on demand, and read back what became of it. Same permission as the
// rest of this router: placing real phone calls is an admin action, not something a staff login
// should be able to do from a settings page.
testDataRouter.post('/call-owner', requireSettingsManage, callOwnerForTest);
testDataRouter.get('/call-outcome/:callId', requireSettingsManage, readTestCallOutcome);

export default testDataRouter;
