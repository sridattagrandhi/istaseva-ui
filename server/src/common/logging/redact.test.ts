// @vitest-environment node

import { describe, it, expect } from 'vitest';
import winston from 'winston';
import Transport from 'winston-transport';
import { redactSensitive } from './redact.js';

/** Capture the final info objects a logger emits. */
class CaptureTransport extends Transport {
  public entries: Record<string, unknown>[] = [];
  log(info: Record<string, unknown>, callback: () => void) {
    this.entries.push(info);
    callback();
  }
}

function makeLogger() {
  const capture = new CaptureTransport();
  const logger = winston.createLogger({
    level: 'debug',
    format: winston.format.combine(redactSensitive(), winston.format.json()),
    transports: [capture],
  });
  return { logger, capture };
}

describe('redactSensitive', () => {
  it('redacts top-level sensitive keys and keeps safe ones', () => {
    const { logger, capture } = makeLogger();
    logger.info('booking: geocoded job address', {
      address: '12 MG Road, Bengaluru',
      lat: 12.9716,
      lng: 77.5946,
      bookingId: 'b-1',
    });
    const entry = capture.entries[0];
    expect(entry.address).toBe('[REDACTED]');
    expect(entry.lat).toBe('[REDACTED]');
    expect(entry.lng).toBe('[REDACTED]');
    expect(entry.bookingId).toBe('b-1');
    expect(entry.message).toBe('booking: geocoded job address');
  });

  it('redacts nested keys and is case/underscore-insensitive', () => {
    const { logger, capture } = makeLogger();
    logger.info('kyc', {
      doc: { document_number: '1234-5678-9012', documentType: 'aadhaar' },
      user: { Email: 'a@b.c', phone_number: '+919999999999', id: 'u1' },
    });
    const entry = capture.entries[0] as any;
    expect(entry.doc.document_number).toBe('[REDACTED]');
    expect(entry.doc.documentType).toBe('aadhaar');
    expect(entry.user.Email).toBe('[REDACTED]');
    expect(entry.user.phone_number).toBe('[REDACTED]');
    expect(entry.user.id).toBe('u1');
  });

  it('redacts secrets/tokens and geocode query keys', () => {
    const { logger, capture } = makeLogger();
    logger.warn('geocode failed', {
      query: 'my home address',
      trimmedQuery: 'my home',
      token: 'abc',
      ip: '1.2.3.4',
      status: 500,
    });
    const entry = capture.entries[0];
    expect(entry.query).toBe('[REDACTED]');
    expect(entry.trimmedQuery).toBe('[REDACTED]');
    expect(entry.token).toBe('[REDACTED]');
    expect(entry.ip).toBe('[REDACTED]');
    expect(entry.status).toBe(500);
  });

  it('handles arrays, circular refs and depth without throwing', () => {
    const { logger, capture } = makeLogger();
    const circular: Record<string, unknown> = { name: 'x' };
    circular.self = circular;
    logger.info('weird', {
      list: [{ email: 'a@b.c' }, { ok: 1 }],
      circular,
    });
    const entry = capture.entries[0] as any;
    expect(entry.list[0].email).toBe('[REDACTED]');
    expect(entry.list[1].ok).toBe(1);
    expect(entry.circular.self).toBe('[CIRCULAR]');
  });

  it('keeps Error objects intact for triage', () => {
    const { logger, capture } = makeLogger();
    const err = new Error('boom');
    logger.error('failed', { err });
    const entry = capture.entries[0] as any;
    expect(entry.err).toBe(err);
  });
});
