import { z } from 'zod';

/**
 * Env-string boolean parser. Use this instead of z.coerce.boolean() for any
 * env-sourced flag: coerce runs Boolean(value), so the string "false" would
 * coerce to TRUE. This parses "true"/"false" (trimmed, case-insensitive)
 * explicitly and rejects anything else, so a typo fails loudly at startup
 * instead of silently enabling the flag.
 */
export const booleanish = z.preprocess((value) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return value;
}, z.boolean());
