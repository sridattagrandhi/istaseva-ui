// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AppError } from '../../../common/errors/app-error.js';

const getById = vi.fn();

vi.mock('../services/bookings.service.js', () => ({ bookingsService: { getById } }));
vi.mock('../services/invoice.service.js', () => ({ invoiceService: {} }));
vi.mock('../services/booking-intent.service.js', () => ({ bookingIntentService: {} }));

function makeRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    json(payload: unknown) { this.body = payload; return this; },
    status(code: number) { this.statusCode = code; return this; },
  };
}

async function invoke(id: string) {
  const { bookingsController } = await import('./bookings.controller.js');
  const req = { params: { id }, user: { id: 'user-1' } } as any;
  const res = makeRes();
  const next = vi.fn();
  await bookingsController.getById(req, res as any, next);
  return { res, next };
}

describe('GET /api/bookings/:id — malformed id guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getById.mockResolvedValue({ data: { id: 'x' } });
  });

  // Regression: a non-UUID id used to hit Postgres and 500 with a raw
  // `invalid input syntax for type uuid` message.
  it('rejects a non-UUID id with 400 and never calls the service', async () => {
    const { next } = await invoke('not-a-uuid');
    expect(getById).not.toHaveBeenCalled();
    expect((next.mock.calls[0][0] as AppError).statusCode).toBe(400);
  });

  it('passes a well-formed UUID through to the service with the user id', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const { next } = await invoke(id);
    expect(next).not.toHaveBeenCalled();
    expect(getById).toHaveBeenCalledWith(id, 'user-1');
  });
});
