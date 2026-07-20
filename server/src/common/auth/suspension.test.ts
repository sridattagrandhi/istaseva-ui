// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ForbiddenError } from '../errors/app-error.js';

const cacheGet = vi.fn();
const cacheSet = vi.fn();
const dbQuery = vi.fn();

vi.mock('../cache/redis.js', () => ({
  cacheGet: (key: string) => cacheGet(key),
  cacheSet: (key: string, value: unknown, ttl: number) => cacheSet(key, value, ttl),
}));

vi.mock('../repositories/database.js', () => ({
  dbQuery: (sql: string, params: unknown[]) => dbQuery(sql, params),
}));

vi.mock('../logging/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('assertNotSuspended', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheSet.mockResolvedValue(undefined);
  });

  it('throws on a cached suspended flag without touching the DB', async () => {
    cacheGet.mockResolvedValue('suspended');
    const { assertNotSuspended } = await import('./suspension.js');

    await expect(assertNotSuspended('u1')).rejects.toBeInstanceOf(ForbiddenError);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('passes on a cached ok flag without touching the DB', async () => {
    cacheGet.mockResolvedValue('ok');
    const { assertNotSuspended } = await import('./suspension.js');

    await expect(assertNotSuspended('u1')).resolves.toBeUndefined();
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it('falls back to the DB on cache miss and caches the result', async () => {
    cacheGet.mockResolvedValue(null);
    dbQuery.mockResolvedValue({ rows: [{ is_suspended: true }] });
    const { assertNotSuspended } = await import('./suspension.js');

    await expect(assertNotSuspended('u1')).rejects.toBeInstanceOf(ForbiddenError);
    expect(dbQuery).toHaveBeenCalledTimes(1);
    expect(cacheSet).toHaveBeenCalledWith(expect.stringContaining('u1'), 'suspended', expect.any(Number));
  });

  it('treats a missing profile row as not suspended', async () => {
    cacheGet.mockResolvedValue(null);
    dbQuery.mockResolvedValue({ rows: [] });
    const { assertNotSuspended } = await import('./suspension.js');

    await expect(assertNotSuspended('u1')).resolves.toBeUndefined();
    expect(cacheSet).toHaveBeenCalledWith(expect.stringContaining('u1'), 'ok', expect.any(Number));
  });

  it('fails open when both cache and DB are unavailable', async () => {
    cacheGet.mockRejectedValue(new Error('redis down'));
    dbQuery.mockRejectedValue(new Error('pg down'));
    const { assertNotSuspended } = await import('./suspension.js');

    await expect(assertNotSuspended('u1')).resolves.toBeUndefined();
  });
});

describe('setSuspensionCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes suspended/ok markers', async () => {
    cacheSet.mockResolvedValue(undefined);
    const { setSuspensionCache } = await import('./suspension.js');

    await setSuspensionCache('u1', true);
    expect(cacheSet).toHaveBeenCalledWith(expect.stringContaining('u1'), 'suspended', expect.any(Number));

    await setSuspensionCache('u1', false);
    expect(cacheSet).toHaveBeenCalledWith(expect.stringContaining('u1'), 'ok', expect.any(Number));
  });

  it('swallows cache write failures (DB remains source of truth)', async () => {
    cacheSet.mockRejectedValue(new Error('redis down'));
    const { setSuspensionCache } = await import('./suspension.js');

    await expect(setSuspensionCache('u1', true)).resolves.toBeUndefined();
  });
});
