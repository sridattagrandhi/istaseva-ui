// Shared k6 helpers. Keep this file dependency-free — k6 runs a Go-embedded
// JS runtime, so no npm, no node:fs, no TypeScript.

import http from 'k6/http';
import { check } from 'k6';

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
export const ID_TOKEN = __ENV.ID_TOKEN || '';
export const RECEIVER_ID = __ENV.RECEIVER_ID || 'e2e-test-receiver-uid';

export function authHeaders() {
  return ID_TOKEN ? { Authorization: `Bearer ${ID_TOKEN}` } : {};
}

export function jsonHeaders() {
  return { 'Content-Type': 'application/json', ...authHeaders() };
}

/**
 * GET with standard checks. Returns the response so callers can chain
 * additional assertions. Marks the request as failed if status is not 2xx
 * or response time exceeds `slowMs` (for k6's thresholds).
 */
export function get(path, { tag, slowMs = 1000 } = {}) {
  const res = http.get(`${BASE_URL}${path}`, {
    headers: authHeaders(),
    tags: tag ? { name: tag } : undefined,
  });
  check(res, {
    [`${tag || path} status 2xx`]: (r) => r.status >= 200 && r.status < 300,
    [`${tag || path} fast`]: (r) => r.timings.duration < slowMs,
  });
  return res;
}

export function post(path, body, { tag, slowMs = 2000 } = {}) {
  const res = http.post(`${BASE_URL}${path}`, JSON.stringify(body), {
    headers: jsonHeaders(),
    tags: tag ? { name: tag } : undefined,
  });
  check(res, {
    [`${tag || path} status 2xx`]: (r) => r.status >= 200 && r.status < 300,
    [`${tag || path} fast`]: (r) => r.timings.duration < slowMs,
  });
  return res;
}
