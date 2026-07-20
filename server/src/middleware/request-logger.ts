import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { getEventProvider } from '../common/providers/registry.js';
import { RETENTION_DAYS } from '../common/config/retention.js';

// CERT-In (LEG-004): request/access logs must be retained >= 180 days.
const REQUEST_LOG_TTL_SECONDS = RETENTION_DAYS.apiRequestLogs * 24 * 60 * 60;

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const startTime = Date.now();

  res.on('finish', () => {
    void getEventProvider()
      .then((eventProvider) => eventProvider.putEvent('api_request_logs', {
        userId: req.user?.id || 'anonymous',
        date: new Date().toISOString().slice(0, 10),
        requestId: crypto.randomUUID(),
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        expiresAt: Math.floor(Date.now() / 1000) + REQUEST_LOG_TTL_SECONDS,
      }))
      .catch(() => {});
  });

  next();
}
