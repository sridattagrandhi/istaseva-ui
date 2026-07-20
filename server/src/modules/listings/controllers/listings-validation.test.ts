// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppError } from '../../../common/errors/app-error.js';

const create = vi.fn();
const getById = vi.fn();

vi.mock('../services/listings.service.js', () => ({
  listingsService: { create, getById },
}));
// The controller module also pulls in these at load time — stub them so the
// import doesn't reach the DB. They're not exercised by these tests.
vi.mock('../services/room-types.service.js', () => ({ roomTypesService: {} }));
vi.mock('../services/availability-overrides.service.js', () => ({ availabilityOverridesService: {} }));
vi.mock('../repositories/listings.repository.js', () => ({ listingsRepository: {} }));
vi.mock('../../bookings/repositories/bookings.repository.js', () => ({
  // getById applies the geo-privacy gate, which asks whether the viewer has a
  // booking. Default: no booking → approximate geo (doesn't affect these tests).
  bookingsRepository: { userHasActiveBookingForListing: vi.fn().mockResolvedValue({ rows: [] }) },
}));

function makeRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    json(payload: unknown) { this.body = payload; return this; },
    status(code: number) { this.statusCode = code; return this; },
  };
}

async function invoke(method: 'create' | 'getById', { body, params }: { body?: unknown; params?: Record<string, string> }) {
  const { listingsController } = await import('./listings.controller.js');
  const req = { body, params: params ?? {}, user: { id: 'user-1' } } as any;
  const res = makeRes();
  const next = vi.fn();
  await (listingsController as any)[method](req, res as any, next);
  return { res, next };
}

describe('POST /api/listings — create validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    create.mockResolvedValue({ data: { id: 'new-listing' } });
  });

  // Regression: an empty body used to return 201 and persist a listing with a
  // null name/category. It must now be rejected before the service runs.
  it('rejects an empty body with a 400 and never calls the service', async () => {
    const { next } = await invoke('create', { body: {} });
    expect(create).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0] as AppError;
    expect(err).toBeInstanceOf(AppError);
    expect(err.statusCode).toBe(400);
  });

  it('rejects a category-only body (no name or title)', async () => {
    const { next } = await invoke('create', { body: { category: 'salon' } });
    expect(create).not.toHaveBeenCalled();
    expect((next.mock.calls[0][0] as AppError).statusCode).toBe(400);
  });

  it('rejects whitespace-only name', async () => {
    const { next } = await invoke('create', { body: { category: 'salon', name: '   ' } });
    expect(create).not.toHaveBeenCalled();
    expect((next.mock.calls[0][0] as AppError).statusCode).toBe(400);
  });

  it('accepts a valid { category, name } body and returns 201', async () => {
    const { res, next } = await invoke('create', { body: { category: 'salon', name: 'Truefitt & Hill' } });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith('user-1', expect.objectContaining({ category: 'salon', name: 'Truefitt & Hill' }));
  });

  it('accepts a stay that carries title instead of name', async () => {
    const { res, next } = await invoke('create', { body: { category: 'homestay', title: 'Riverside Villa' } });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/listings/:id — malformed id guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getById.mockResolvedValue({ data: { id: 'x' } });
  });

  // Regression: a non-UUID id used to hit Postgres and 500 with a raw
  // `invalid input syntax for type uuid` message.
  it('rejects a non-UUID id with 400 and never calls the service', async () => {
    const { next } = await invoke('getById', { params: { id: 'not-a-uuid' } });
    expect(getById).not.toHaveBeenCalled();
    expect((next.mock.calls[0][0] as AppError).statusCode).toBe(400);
  });

  it('passes a well-formed UUID through to the service', async () => {
    const id = '26cc09ac-ef03-4594-8976-bc10f3a6bf28';
    const { next } = await invoke('getById', { params: { id } });
    expect(next).not.toHaveBeenCalled();
    expect(getById).toHaveBeenCalledWith(id);
  });
});
