import { Router } from 'express';

import { getHealth, getReadiness } from './health.controller.js';

const healthRouter = Router();

healthRouter.get('/readiness', getReadiness);
healthRouter.get('/', getHealth);

export default healthRouter;
