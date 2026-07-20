import { logger } from '../../../common/logging/logger.js';
import { getSearchProvider } from '../../../common/providers/registry.js';
import { approximateListingGeo } from '../../listings/services/listing-geo-privacy.js';

export class SearchService {
  async search(params: {
    searchQuery: string;
    category?: string;
    lat?: number;
    lng?: number;
    radiusKm: number;
    page: number;
    limit: number;
    sortBy: string;
  }) {
    const { searchQuery, category, lat, lng, radiusKm, page, limit, sortBy } = params;
    try {
      const provider = await getSearchProvider();
      const result = await provider.search({
        searchQuery,
        category,
        lat,
        lng,
        radiusKm,
        page,
        limit,
        sortBy,
      });
      // GEO PRIVACY (WS6): the provider returns raw `l.*` listing rows —
      // exact coords, street address, and the untrusted `location` text.
      // /api/search is unauthenticated, so every listing row leaving here
      // must be approximated, same as listings.listPublic. The provider
      // stays dumb; the module boundary is where the policy lives.
      const mask = (rows: unknown) =>
        Array.isArray(rows) ? rows.map((r) => approximateListingGeo(r as Record<string, unknown>)) : rows;
      return { ...result, data: mask(result.data), listings: mask(result.listings) };
    } catch (err) {
      // The OpenSearch client hides the actual response body inside `err.meta`;
      // logging only err.message gives you a useless "Response Error". Surface
      // status + body so the cause (missing index, mapping mismatch, auth) is
      // visible in CloudWatch.
      const e = err as Error & { meta?: { statusCode?: number; body?: unknown } };
      logger.error('Search provider failed', {
        error: e.message,
        statusCode: e.meta?.statusCode,
        body: e.meta?.body,
      });
      throw err;
    }
  }
}

export const searchService = new SearchService();
