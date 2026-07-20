export interface SearchQuery {
  searchQuery: string;
  category?: string;
  lat?: number;
  lng?: number;
  radiusKm: number;
  page: number;
  limit: number;
  sortBy: string;
}

/**
 * Future implementations:
 * - OpenSearch
 * - PostgreSQL full-text fallback
 * - Algolia / custom search backend
 */
export interface ISearchProvider {
  search(params: SearchQuery): Promise<Record<string, unknown>>;
}
