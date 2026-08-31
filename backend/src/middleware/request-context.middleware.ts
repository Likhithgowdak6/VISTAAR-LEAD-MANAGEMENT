import { randomUUID } from 'node:crypto';

import { type RequestHandler } from 'express';

export const requestContextMiddleware: RequestHandler = (req, res, next) => {
  const requestId = req.get('x-request-id') || randomUUID();

  req.context = {
    requestId,
    ipAddress: req.ip || req.socket?.remoteAddress || null,
    userAgent: req.get('user-agent') || null,
  };

  res.setHeader('x-request-id', requestId);

  next();
};
