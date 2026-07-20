// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

const putEvent = vi.fn();
const handleAuthEvent = vi.fn(async () => undefined);

vi.mock('../../../common/providers/registry.js', () => ({
  getEventProvider: async () => ({ putEvent: (...a: unknown[]) => putEvent(...a) }),
}));
vi.mock('../../../common/logging/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock('../services/identity-stitch.service.js', () => ({
  identityStitchService: { handleAuthEvent: (...a: unknown[]) => handleAuthEvent(...a) },
}));
// The stitch service (mocked above) transitively pulls in the Redis client;
// mock it so importing the controller never opens a live connection in tests.
vi.mock('../../../common/cache/redis.js', () => ({
  cacheGet: async () => null,
  cacheSet: async () => undefined,
}));

const { analyticsEventsController } = await import('./analytics-events.controller.js');

type MockRes = { statusCode: number; body: unknown; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> };
function mockRes(): MockRes {
  const res = { statusCode: 200, body: undefined } as MockRes;
  res.status = vi.fn((c: number) => { res.statusCode = c; return res; });
  res.json = vi.fn((b: unknown) => { res.body = b; return res; });
  return res;
}
// Flush the fire-and-forget background write.
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => { putEvent.mockReset(); handleAuthEvent.mockClear(); });

describe('AnalyticsEventsController.ingest', () => {
  it('accepts a valid event and writes it to analytics_events with a server-stamped userId', async () => {
    const req: any = { user: { id: 'user-1' }, body: { events: [{ eventType: 'listing_viewed', listingType: 'stay', deviceId: 'd1', props: { rank: 2 } }] } };
    const res = mockRes();
    await analyticsEventsController.ingest(req, res, vi.fn());
    await flush();

    expect(res.statusCode).toBe(202);
    expect(res.body).toMatchObject({ success: true, accepted: 1 });
    expect(putEvent).toHaveBeenCalledTimes(1);
    const [table, payload] = putEvent.mock.calls[0];
    expect(table).toBe('analytics_events');
    expect(payload).toMatchObject({ userId: 'user-1', eventType: 'listing_viewed', listingType: 'stay', deviceId: 'd1' });
    expect(payload.props).toEqual({ rank: 2 });
    expect(typeof payload.timestamp).toBe('string');
    expect(payload.date).toBe(payload.timestamp.slice(0, 10));
    expect(typeof payload.expiresAt).toBe('number');
  });

  it('records anonymous when unauthenticated', async () => {
    const req: any = { body: { events: [{ eventType: 'login' }] } };
    const res = mockRes();
    await analyticsEventsController.ingest(req, res, vi.fn());
    await flush();
    expect(putEvent.mock.calls[0][1].userId).toBe('anonymous');
  });

  it('writes each event of a batch', async () => {
    const req: any = { user: { id: 'u' }, body: { events: [{ eventType: 'a.b' }, { eventType: 'c_d' }] } };
    const res = mockRes();
    await analyticsEventsController.ingest(req, res, vi.fn());
    await flush();
    expect(res.body).toMatchObject({ accepted: 2 });
    expect(putEvent).toHaveBeenCalledTimes(2);
  });

  it('rejects a non-snake_case eventType with 400 and writes nothing', async () => {
    const req: any = { body: { events: [{ eventType: 'ListingViewed' }] } };
    const res = mockRes();
    await analyticsEventsController.ingest(req, res, vi.fn());
    await flush();
    expect(res.statusCode).toBe(400);
    expect(putEvent).not.toHaveBeenCalled();
  });

  it('rejects an empty batch with 400', async () => {
    const req: any = { body: { events: [] } };
    const res = mockRes();
    await analyticsEventsController.ingest(req, res, vi.fn());
    await flush();
    expect(res.statusCode).toBe(400);
    expect(putEvent).not.toHaveBeenCalled();
  });

  it('carries language and origin envelope fields through to the payload', async () => {
    const req: any = {
      user: { id: 'user-1' },
      body: { events: [{ eventType: 'listing_viewed', language: 'te', originCity: 'Bengaluru', originState: 'Karnataka' }] },
    };
    const res = mockRes();
    await analyticsEventsController.ingest(req, res, vi.fn());
    await flush();
    expect(putEvent.mock.calls[0][1]).toMatchObject({ language: 'te', originCity: 'Bengaluru', originState: 'Karnataka' });
  });

  it('stitches identity on signup/login with a real userId + deviceId', async () => {
    const req: any = {
      user: { id: 'user-1' },
      body: { events: [{ eventType: 'signup', deviceId: 'd1', channel: 'google' }, { eventType: 'listing_viewed', deviceId: 'd1' }] },
    };
    const res = mockRes();
    await analyticsEventsController.ingest(req, res, vi.fn());
    await flush();
    expect(handleAuthEvent).toHaveBeenCalledTimes(1);
    expect(handleAuthEvent).toHaveBeenCalledWith({ eventType: 'signup', userId: 'user-1', deviceId: 'd1', channel: 'google' });
  });

  it('never stitches anonymous or deviceless auth events', async () => {
    const anonReq: any = { body: { events: [{ eventType: 'login', deviceId: 'd1' }] } };
    await analyticsEventsController.ingest(anonReq, mockRes(), vi.fn());
    const devicelessReq: any = { user: { id: 'u1' }, body: { events: [{ eventType: 'login' }] } };
    await analyticsEventsController.ingest(devicelessReq, mockRes(), vi.fn());
    await flush();
    expect(handleAuthEvent).not.toHaveBeenCalled();
  });
});
