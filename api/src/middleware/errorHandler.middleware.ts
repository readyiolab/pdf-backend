import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '../lib/logger';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly isOperational: boolean;

  constructor(message: string, statusCode: number, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
}

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // If headers already sent, delegate to default Express handler
  if (res.headersSent) {
    return next(err);
  }

  // Zod Validation Error
  if (err instanceof ZodError) {
    logger.warn({ err: err.errors, url: req.url }, 'Validation error');
    return res.status(400).json({
      status: 'error',
      message: 'Validation failed',
      errors: err.errors.map((e) => ({
        path: e.path.map(String).filter((p) => p !== 'body' && p !== 'query' && p !== 'params').join('.'),
        message: e.message,
      })),
    });
  }

  // Operational AppError
  if (err instanceof AppError) {
    logger.warn({ err, url: req.url }, 'Operational error');
    return res.status(err.statusCode).json({
      status: 'error',
      message: err.message,
    });
  }

  // Redis/queue outage (e.g. connection down, or provider quota exceeded like
  // Upstash's "max requests limit exceeded"). Surfaced as a distinct 503 so
  // clients can retry instead of treating it as an opaque server bug.
  const errName = (err as { name?: string }).name;
  const errCode = (err as { code?: string }).code;
  if (
    errName === 'ReplyError' ||
    errName === 'MaxRetriesPerRequestError' ||
    errCode === 'ECONNREFUSED' ||
    errCode === 'ETIMEDOUT'
  ) {
    logger.error({ err, url: req.url, method: req.method }, 'Redis unavailable');
    return res.status(503).json({
      status: 'error',
      message: 'Service temporarily unavailable. Please try again in a few minutes.',
    });
  }

  // Fallback Generic Error (e.g. database error)
  // NOTE: request body is intentionally NOT logged — it can contain passwords,
  // tokens, and other PII. Log only non-sensitive request metadata.
  logger.error({ err, url: req.url, method: req.method }, 'Unhandled server error');

  return res.status(500).json({
    status: 'error',
    message: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
  });
};
