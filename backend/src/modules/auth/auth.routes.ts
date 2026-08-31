import { Router } from 'express';

import { authenticateRequest } from '../../middleware/auth.middleware.js';

import { changePassword, login, logout, logoutAll, me, refresh } from './auth.controller.js';

const authRouter = Router();

authRouter.post('/login', login);
authRouter.post('/refresh', refresh);
authRouter.post('/logout', logout);
authRouter.post('/logout-all', authenticateRequest, logoutAll);
authRouter.get('/me', authenticateRequest, me);
// Deliberately not behind requirePasswordChanged: this is how a forced change is satisfied.
authRouter.post('/change-password', authenticateRequest, changePassword);

export default authRouter;
