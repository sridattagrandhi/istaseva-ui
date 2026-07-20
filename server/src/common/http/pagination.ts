/**
 * Shared pagination parsers. Every user-facing list endpoint MUST pipe
 * its `limit` / `offset` / `page` query params through these — otherwise
 * a caller can pass `limit=1000000` and DOS the database with a full
 * table scan.
 *
 * Defaults match the conservative side of what a UI realistically needs;
 * `max` is the hard cap we enforce server-side.
 */

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;
export const MAX_OFFSET = 100_000;
export const MAX_PAGE = 10_000;

export function parseLimit(
  raw: unknown,
  opts: { def?: number; max?: number } = {}
): number {
  const def = opts.def ?? DEFAULT_LIMIT;
  const max = opts.max ?? MAX_LIMIT;
  const n = parseInt(String(raw ?? def), 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

export function parseOffset(raw: unknown, max: number = MAX_OFFSET): number {
  const n = parseInt(String(raw ?? 0), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, max);
}

export function parsePage(raw: unknown): number {
  const n = parseInt(String(raw ?? 1), 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_PAGE);
}
