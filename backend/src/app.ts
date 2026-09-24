import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';

import { env } from './config/env.js';
import { notFoundHandler, errorHandler } from './middleware/error.middleware.js';
import { rateLimitMiddleware } from './middleware/rate-limit.middleware.js';
import { requestContextMiddleware } from './middleware/request-context.middleware.js';
import aiBrainRouter from './modules/ai-brain/ai-brain.routes.js';
import aiKnowledgeRouter from './modules/ai-knowledge/ai-knowledge.routes.js';
import authRouter from './modules/auth/auth.routes.js';
import contactRouter from './modules/contacts/contact.routes.js';
import conversationRouter from './modules/conversations/conversation.routes.js';
import testDataRouter from './modules/dev-tools/test-data.routes.js';
import followUpRouter from './modules/followups/followup.routes.js';
import healthRouter from './modules/health/health.routes.js';
import leadSourceRouter from './modules/lead-sources/lead-source.routes.js';
import messageTemplateRouter from './modules/message-templates/message-template.routes.js';
import organizationSettingsRouter from './modules/organizations/organization-settings.routes.js';
import realtimeRouter from './modules/realtime/realtime.routes.js';
import stageRouter from './modules/stages/stage.routes.js';
import tagRouter from './modules/tags/tag.routes.js';
import userRouter from './modules/users/user.routes.js';
import whatsappAccountRouter from './modules/whatsapp-accounts/whatsapp-account.routes.js';

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', env.TRUST_PROXY_HOPS);

app.use(
  helmet({
    // The SPA is served from a different origin than the API, so helmet's
    // same-origin default would be wrong here.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);

app.use((req: Request, res: Response, next: NextFunction) => {
  // Credentialed CORS forbids a wildcard, so echo back the request origin only when it is on
  // the allowlist. Falls back to the first configured origin for non-browser callers.
  const requestOrigin = req.headers.origin;
  const allowedOrigin =
    requestOrigin !== undefined && env.FRONTEND_ORIGIN.includes(requestOrigin)
      ? requestOrigin
      : env.FRONTEND_ORIGIN[0];

  res.header('Access-Control-Allow-Origin', allowedOrigin);
  res.header('Vary', 'Origin');
  res.header('Access-Control-Allow-Credentials', 'true');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Request-Id');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');

  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }

  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(requestContextMiddleware);
app.use(rateLimitMiddleware);

app.use('/api/v1/health', healthRouter);
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/users', userRouter);
app.use('/api/v1/conversations', conversationRouter);
app.use('/api/v1/contacts', contactRouter);
app.use('/api/v1/tags', tagRouter);
app.use('/api/v1/stages', stageRouter);
app.use('/api/v1/ai/knowledge', aiKnowledgeRouter);
app.use('/api/v1/templates', messageTemplateRouter);
app.use('/api/v1/ai-brain', aiBrainRouter);
app.use('/api/v1/follow-ups', followUpRouter);
app.use('/api/v1/lead-sources', leadSourceRouter);
app.use('/api/v1/whatsapp-accounts', whatsappAccountRouter);
app.use('/api/v1/realtime', realtimeRouter);
app.use('/api/v1/settings', organizationSettingsRouter);
// NEVER in production. This router can wipe every conversation, contact and message in the
// organization in one request, and it can place real phone calls. It is genuinely useful while
// testing, so it is gated rather than deleted - but the gate is here, at the mount, so that in
// production the path does not exist at all and there is no permission check left to get wrong.
//
// Checked against NODE_ENV rather than a dedicated flag on purpose: an extra DEV_TOOLS_ENABLED
// variable is one more thing to copy to the server and forget to turn off, and "forgot to turn it
// off" is exactly the failure this is preventing.
if (env.NODE_ENV !== 'production') {
  app.use('/api/v1/dev-tools', testDataRouter);
}

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
