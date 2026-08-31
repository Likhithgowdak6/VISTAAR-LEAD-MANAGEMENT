import { type NextFunction, type Request, type RequestHandler, type Response } from 'express';

/**
 * A route handler that may return a promise. Express 5 forwards rejected promises on its own,
 * but wrapping keeps the behaviour explicit and identical across handler styles.
 */
export type AsyncRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown> | unknown;

export const asyncHandler =
  (handler: AsyncRequestHandler): RequestHandler =>
  async (req, res, next) => {
    try {
      await handler(req, res, next);
    } catch (error) {
      next(error);
    }
  };
