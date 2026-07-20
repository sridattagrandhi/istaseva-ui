import winston from 'winston';

/**
 * PII redaction backstop for all Winston output (SEC-013).
 *
 * Any metadata key on this deny-list has its VALUE replaced with '[REDACTED]'
 * before serialization, at any nesting depth. This is a safety net — call
 * sites should still avoid logging personal data in the first place (and must
 * never put it in the message string, which is not scanned).
 *
 * Matching is case-insensitive and ignores `_`/`-` so `documentNumber`,
 * `document_number` and `DOCUMENT-NUMBER` all match.
 */
const SENSITIVE_KEYS = [
  // location / free-text user input
  'address', 'lat', 'lng', 'latitude', 'longitude', 'query', 'trimmedquery', 'q',
  // contact identity
  'email', 'phone', 'phonenumber', 'fullname', 'firstname', 'lastname',
  // identity documents
  'documentnumber', 'aadhaar', 'pan',
  // credentials / secrets
  'password', 'otp', 'token', 'accesstoken', 'refreshtoken', 'idtoken',
  'ticket', 'authorization', 'apikey', 'secret', 'signature',
  // network identifiers
  'ip', 'ipaddress', 'useragent',
];

const SENSITIVE = new Set(SENSITIVE_KEYS);

// Winston/logform internals + fields we must never mangle.
const SKIP_KEYS = new Set(['level', 'message', 'timestamp', 'stack', 'service']);

const normalizeKey = (key: string): string => key.toLowerCase().replace(/[_-]/g, '');

const MAX_DEPTH = 6;

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  if (seen.has(value as object)) return '[CIRCULAR]';
  seen.add(value as object);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, seen));
  }
  if (value instanceof Error) {
    // Keep name/message/stack; errors rarely carry structured PII and losing
    // them would hurt triage more than it protects.
    return value;
  }
  if (value instanceof Date || Buffer.isBuffer(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE.has(normalizeKey(key))) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = redactValue(val, depth + 1, seen);
    }
  }
  return out;
}

/** Winston format that deep-redacts sensitive metadata keys. */
export const redactSensitive = winston.format((info) => {
  const seen = new WeakSet<object>();
  for (const [key, val] of Object.entries(info)) {
    if (typeof key === 'string' && SKIP_KEYS.has(key)) continue;
    if (typeof key === 'string' && SENSITIVE.has(normalizeKey(key))) {
      (info as Record<string, unknown>)[key] = '[REDACTED]';
    } else {
      (info as Record<string, unknown>)[key as string] = redactValue(val, 0, seen);
    }
  }
  return info;
});
