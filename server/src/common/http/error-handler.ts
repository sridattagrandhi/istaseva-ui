import { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/app-error.js';
import { logger } from '../logging/logger.js';
import { config } from '../config/index.js';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        message: err.message,
        code: err.code,
        ...(err.details !== undefined ? { details: err.details } : {}),
      },
    });
    return;
  }

  logger.error('Unhandled error', { error: err.message, stack: err.stack });

  res.status(500).json({
    error: {
      message: config.app.exposeErrors ? err.message : 'Internal server error',
      code: 'INTERNAL_ERROR',
    },
  });
}
