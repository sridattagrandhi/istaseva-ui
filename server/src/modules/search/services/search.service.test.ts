// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const providerSearch = vi.fn();
const getSearchProvider = vi.fn(async () => ({ search: providerSearch }));

vi.mock('../../../common/providers/registry.js', () => ({
  getSearchProvider,
}));

vi.mock('../../../common/logging/logger.js', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

const baseParams = {
  searchQuery: 'auto',
  radiusKm: 5,
  page: 1,
  limit: 10,
  sortBy: 'relevance',
};

describe('SearchService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards search params to the active provider', async () => {
    const { searchService } = await import('./search.service.js');
    providerSearch.mockResolvedValue({ items: [], total: 0 });
    await searchService.search(baseParams);
    expect(providerSearch).toHaveBeenCalledWith(expect.objectContaining({
      searchQuery: 'auto', radiusKm: 5, page: 1, limit: 10, sortBy: 'relevance',
    }));
  });

  it('re-throws and logs when the provider errors out', async () => {
    const { searchService } = await import('./search.service.js');
    const err: any = new Error('opensearch down');
    err.meta = { statusCode: 503, body: { error: 'service_unavailable' } };
    providerSearch.mockRejectedValue(err);
    await expect(searchService.search(baseParams)).rejects.toThrow('opensearch down');
  });
});
