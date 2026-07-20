// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest';

const search = vi.fn();

vi.mock('../services/search.service.js', () => ({ searchService: { search } }));
vi.mock('../../../common/providers/registry.js', () => ({ getEventProvider: vi.fn() }));
vi.mock('../../../common/logging/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

const NUL = String.fromCharCode(0);

function makeRes() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    json(payload: unknown) { this.body = payload; return this; },
    status(code: number) { this.statusCode = code; return this; },
  };
}

async function invoke(query: Record<string, unknown>) {
  const { searchController } = await import('./search.controller.js');
  const req = { query, user: undefined } as any;
  const res = makeRes();
  const next = vi.fn();
  await searchController.search(req, res as any, next);
  return { res, next };
}

describe('GET /api/search — NUL-byte sanitization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    search.mockResolvedValue({ data: [] });
  });

  // Regression: `?q=%00` reached Postgres and 500'd with
  // `invalid byte sequence for encoding "UTF8": 0x00`.
  it('collapses a pure-NUL query to a clean 400, never hitting the service', async () => {
    const { res, next } = await invoke({ q: NUL });
    expect(search).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
  });

  it('strips embedded NUL bytes and searches the cleaned text', async () => {
    const { res, next } = await invoke({ q: NUL + 'hotel' + NUL });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][0].searchQuery).toBe('hotel');
  });

  it('strips NUL bytes from the category filter too', async () => {
    await invoke({ q: 'hotel', category: 'sta' + NUL + 'ys' });
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][0].category).toBe('stays');
  });

  it('leaves an ordinary query untouched', async () => {
    await invoke({ q: 'salon' });
    expect(search.mock.calls[0][0].searchQuery).toBe('salon');
  });
});
