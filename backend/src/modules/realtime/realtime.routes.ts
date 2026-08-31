import { Router, type RequestHandler } from 'express';

import { authenticateRequest, requirePasswordChanged } from '../../middleware/auth.middleware.js';

import { registerClient, removeClient } from './realtime.hub.js';

const HEARTBEAT_INTERVAL_MS = 25000;

const realtimeRouter = Router();

realtimeRouter.use(authenticateRequest);
realtimeRouter.use(requirePasswordChanged);

const streamHandler: RequestHandler = (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write(': connected\n\n');
  res.flushHeaders?.();

  const auth = req.auth!;

  const client = registerClient({
    res,
    userId: auth.user._id,
    organizationId: auth.organization._id,
    permissions: auth.permissions,
  });

  const heartbeat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, HEARTBEAT_INTERVAL_MS);

  req.on('close', () => {
    clearInterval(heartbeat);
    removeClient(client);
  });
};

realtimeRouter.get('/stream', streamHandler);

export default realtimeRouter;
