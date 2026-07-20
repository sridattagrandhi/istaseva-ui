// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

const cacheGet = vi.fn(async (): Promise<string | null> => null);
const cacheSet = vi.fn(async () => undefined);
const upsertDeviceLink = vi.fn(async () => ({ rows: [] }));
const setAcquisitionChannelOnce = vi.fn(async () => ({ rows: [] }));

vi.mock('../../../common/cache/redis.js', () => ({
  cacheGet: (...a: unknown[]) => cacheGet(...(a as [])),
  cacheSet: (...a: unknown[]) => cacheSet(...(a as [])),
}));
vi.mock('../../../common/logging/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../repositories/analytics-identity.repository.js', () => ({
  analyticsIdentityRepository: {
    upsertDeviceLink: (...a: unknown[]) => upsertDeviceLink(...(a as [])),
    setAcquisitionChannelOnce: (...a: unknown[]) => setAcquisitionChannelOnce(...(a as [])),
  },
}));

const { identityStitchService } = await import('./identity-stitch.service.js');

beforeEach(() => {
  cacheGet.mockReset().mockResolvedValue(null);
  cacheSet.mockClear();
  upsertDeviceLink.mockClear();
  setAcquisitionChannelOnce.mockClear();
});

describe('IdentityStitchService.handleAuthEvent', () => {
  it('links the device and sets the channel once on signup', async () => {
    await identityStitchService.handleAuthEvent({ eventType: 'signup', userId: 'u1', deviceId: 'd1', channel: 'google' });
    expect(upsertDeviceLink).toHaveBeenCalledWith('d1', 'u1');
    expect(setAcquisitionChannelOnce).toHaveBeenCalledWith('u1', 'google');
    expect(cacheSet).toHaveBeenCalled();
  });

  it('links the device but never touches the channel on login', async () => {
    await identityStitchService.handleAuthEvent({ eventType: 'login', userId: 'u1', deviceId: 'd1', channel: 'instagram' });
    expect(upsertDeviceLink).toHaveBeenCalledWith('d1', 'u1');
    expect(setAcquisitionChannelOnce).not.toHaveBeenCalled();
  });

  it('skips a repeat login when the Redis marker is present', async () => {
    cacheGet.mockResolvedValue('1');
    await identityStitchService.handleAuthEvent({ eventType: 'login', userId: 'u1', deviceId: 'd1' });
    expect(upsertDeviceLink).not.toHaveBeenCalled();
  });

  it('always writes on signup even when the marker is present (set-once channel rides on it)', async () => {
    cacheGet.mockResolvedValue('1');
    await identityStitchService.handleAuthEvent({ eventType: 'signup', userId: 'u1', deviceId: 'd1', channel: 'direct' });
    expect(upsertDeviceLink).toHaveBeenCalledWith('d1', 'u1');
    expect(setAcquisitionChannelOnce).toHaveBeenCalledWith('u1', 'direct');
  });

  it('ignores non-auth events, anonymous users, and missing deviceIds', async () => {
    await identityStitchService.handleAuthEvent({ eventType: 'listing_viewed', userId: 'u1', deviceId: 'd1' });
    await identityStitchService.handleAuthEvent({ eventType: 'signup', userId: 'anonymous', deviceId: 'd1' });
    await identityStitchService.handleAuthEvent({ eventType: 'signup', userId: 'u1' });
    expect(upsertDeviceLink).not.toHaveBeenCalled();
  });

  it('never throws when the repository fails', async () => {
    upsertDeviceLink.mockRejectedValueOnce(new Error('db down'));
    await expect(
      identityStitchService.handleAuthEvent({ eventType: 'signup', userId: 'u1', deviceId: 'd1', channel: 'google' }),
    ).resolves.toBeUndefined();
  });
});
