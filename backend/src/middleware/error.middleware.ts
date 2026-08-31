import { type ErrorRequestHandler, type RequestHandler } from 'express';

import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

/** The shape `createHttpError` produces; plain `Error`s fall back to a 500. */
interface HttpErrorLike extends Error {
  statusCode?: number;
  code?: string;
  details?: unknown;
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json({
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: `Route ${req.method} ${req.originalUrl} not found.`,
    },
  });
};

export const errorHandler: ErrorRequestHandler = (error: HttpErrorLike, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  const statusCode = error.statusCode ?? 500;
  const requestId = req.context?.requestId ?? null;

  const logPayload = {
    requestId,
    method: req.method,
    url: req.originalUrl,
    statusCode,
    code: error.code ?? 'INTERNAL_SERVER_ERROR',
  };

  // Production hides 5xx detail from the client, so the server log is the only
  // remaining record of what actually failed.
  if (statusCode >= 500) {
    logger.error({ ...logPayload, err: error }, 'Request failed.');
  } else {
    logger.warn(logPayload, 'Request rejected.');
  }

  res.status(statusCode).json({
    error: {
      code: error.code ?? 'INTERNAL_SERVER_ERROR',
      message:
        statusCode >= 500 && env.NODE_ENV === 'production'
          ? 'Internal server error.'
          : error.message,
      details: error.details ?? null,
      requestId,
    },
  });
};
