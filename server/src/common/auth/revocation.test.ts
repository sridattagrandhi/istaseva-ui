// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

const cacheGet = vi.fn();
const cacheSet = vi.fn();
const getTokensValidAfterTime = vi.fn();
let provider: any;
const getAuthProvider = vi.fn(async () => provider);

vi.mock('../cache/redis.js', () => ({ cacheGet, cacheSet }));
vi.mock('../providers/registry.js', () => ({ getAuthProvider }));
vi.mock('../logging/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

// A token authenticated "now". Revocations are expressed as cutoffs after this.
const NOW = 1_700_000_000_000;

describe('assertNotRevoked', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    provider = { getTokensValidAfterTime };
    cacheSet.mockResolvedValue(undefined);
  });

  it('no-ops when the token carries no auth_time (nothing to compare)', async () => {
    const { assertNotRevoked } = await import('./revocation.js');
    await expect(assertNotRevoked('u1', undefined)).resolves.toBeUndefined();
    expect(cacheGet).not.toHaveBeenCalled();
    expect(getAuthProvider).not.toHaveBeenCalled();
  });

  it('allows a token authenticated AFTER the cutoff (cache hit)', async () => {
    cacheGet.mockResolvedValue(String(NOW - 60_000)); // cutoff is in the past
    const { assertNotRevoked } = await import('./revocation.js');
    await expect(assertNotRevoked('u1', NOW)).resolves.toBeUndefined();
    expect(getTokensValidAfterTime).not.toHaveBeenCalled(); // served from cache
  });

  it('rejects a token authenticated BEFORE the cutoff (revoked)', async () => {
    cacheGet.mockResolvedValue(String(NOW + 60_000)); // cutoff after this token
    const { assertNotRevoked } = await import('./revocation.js');
    await expect(assertNotRevoked('u1', NOW)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('tolerates a small clock skew around the cutoff', async () => {
    cacheGet.mockResolvedValue(String(NOW + 2_000)); // 2s after → within 5s skew
    const { assertNotRevoked } = await import('./revocation.js');
    await expect(assertNotRevoked('u1', NOW)).resolves.toBeUndefined();
  });

  it('fetches + caches the cutoff from the provider on a cache miss', async () => {
    cacheGet.mockResolvedValue(null);
    getTokensValidAfterTime.mockResolvedValue(NOW + 60_000);
    const { assertNotRevoked } = await import('./revocation.js');

    await expect(assertNotRevoked('u1', NOW)).rejects.toMatchObject({ statusCode: 401 });
    expect(getTokensValidAfterTime).toHaveBeenCalledWith('u1');
    expect(cacheSet).toHaveBeenCalledWith('auth:revoked-after:u1', String(NOW + 60_000), 60);
  });

  it("caches 'none' and allows when the provider reports no cutoff", async () => {
    cacheGet.mockResolvedValue(null);
    getTokensValidAfterTime.mockResolvedValue(null);
    const { assertNotRevoked } = await import('./revocation.js');

    await expect(assertNotRevoked('u1', NOW)).resolves.toBeUndefined();
    expect(cacheSet).toHaveBeenCalledWith('auth:revoked-after:u1', 'none', 60);
  });

  it('no-ops (fail-open) when the provider cannot supply the cutoff', async () => {
    cacheGet.mockResolvedValue(null);
    provider = {}; // no getTokensValidAfterTime (e.g. default provider)
    const { assertNotRevoked } = await import('./revocation.js');
    await expect(assertNotRevoked('u1', NOW)).resolves.toBeUndefined();
  });

  it('fails open (no throw) when the provider lookup errors', async () => {
    cacheGet.mockResolvedValue(null);
    getTokensValidAfterTime.mockRejectedValue(new Error('IdP down'));
    const { assertNotRevoked } = await import('./revocation.js');
    await expect(assertNotRevoked('u1', NOW)).resolves.toBeUndefined();
  });
});

describe('setRevokedNowCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheSet.mockResolvedValue(undefined);
  });

  it('writes the cutoff to Redis with the 60s TTL', async () => {
    const { setRevokedNowCache } = await import('./revocation.js');
    await setRevokedNowCache('u1', NOW);
    expect(cacheSet).toHaveBeenCalledWith('auth:revoked-after:u1', String(NOW), 60);
  });

  it('swallows a cache-write failure', async () => {
    cacheSet.mockRejectedValue(new Error('redis down'));
    const { setRevokedNowCache } = await import('./revocation.js');
    await expect(setRevokedNowCache('u1', NOW)).resolves.toBeUndefined();
  });
});
