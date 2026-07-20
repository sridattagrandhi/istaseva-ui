import winston from 'winston';
import { config } from '../config/index.js';
import { redactSensitive } from './redact.js';

const { combine, timestamp, errors, json, colorize, simple } = winston.format;

export const logger = winston.createLogger({
  level: config.app.logLevel,
  format: combine(
    // PII backstop first, so every downstream format/transport sees redacted meta (SEC-013).
    redactSensitive(),
    timestamp(),
    errors({ stack: true }),
    json()
  ),
  defaultMeta: { service: 'instaserve-api' },
  transports: [
    new winston.transports.Console({
      format: config.app.nodeEnv === 'production'
        ? combine(timestamp(), json())
        : combine(colorize(), simple()),
    }),
  ],
});
