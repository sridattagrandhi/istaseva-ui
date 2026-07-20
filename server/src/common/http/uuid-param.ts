import { z } from 'zod';
import { ValidationError } from '../errors/app-error.js';

const uuidSchema = z.string().uuid();

/**
 * Validate that a route param is a well-formed UUID before it reaches a
 * repository. Without this, a malformed id (e.g. `/api/listings/not-a-uuid`)
 * flows straight into a parameterized query and Postgres throws
 * `invalid input syntax for type uuid: "not-a-uuid"`, which the error handler
 * surfaces as a 500 with the raw DB message. A bad id in the URL is a client
 * error, so fail fast with a clean 400 instead.
 */
export function requireUuidParam(value: unknown, field = 'id'): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    throw new ValidationError(`Invalid ${field}: must be a UUID`);
  }
  return parsed.data;
}
