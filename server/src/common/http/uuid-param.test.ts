// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { requireUuidParam } from './uuid-param.js';
import { AppError } from '../errors/app-error.js';

describe('requireUuidParam', () => {
  it('returns the value unchanged for a well-formed UUID', () => {
    const id = '26cc09ac-ef03-4594-8976-bc10f3a6bf28';
    expect(requireUuidParam(id)).toBe(id);
  });

  // Regression: `GET /api/listings/not-a-uuid` used to reach the DB and throw
  // `invalid input syntax for type uuid`, surfacing as a 500 with the raw
  // Postgres message. A malformed id must fail fast as a 400 instead.
  it('throws a 400 ValidationError for a malformed id', () => {
    let caught: unknown;
    try {
      requireUuidParam('not-a-uuid');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).statusCode).toBe(400);
    expect((caught as AppError).code).toBe('VALIDATION_ERROR');
  });

  it('rejects empty string, undefined, and non-string values', () => {
    for (const bad of ['', undefined, null, 123, {}]) {
      expect(() => requireUuidParam(bad)).toThrow(AppError);
    }
  });

  it('names the field in the error message', () => {
    expect(() => requireUuidParam('nope', 'bookingId')).toThrow(/bookingId/);
  });
});
