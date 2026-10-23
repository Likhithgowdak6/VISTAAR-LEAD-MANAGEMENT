import { Router } from 'express';

import {
  authenticateRequest,
  requirePasswordChanged,
} from '../../middleware/auth.middleware.js';

import { getPushStatus, registerDevice, removeDevice } from './push.controller.js';

// Mounted at /api/v1/push
const pushRouter = Router();

// AUTHENTICATED, AND NO PERMISSION BEYOND THAT. Registering your own handset is not a
// privileged act - every role that can sign in has reminders assigned to them and should be
// able to receive one. The scoping that matters is to the SESSION, done in the controller.
pushRouter.use(authenticateRequest);
pushRouter.use(requirePasswordChanged);

pushRouter.post('/devices', registerDevice);
pushRouter.delete('/devices', removeDevice);
pushRouter.get('/status', getPushStatus);

export default pushRouter;
