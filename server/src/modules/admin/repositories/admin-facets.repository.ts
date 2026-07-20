import { query } from '../../../common/db/postgres.js';

export interface AdminFacets {
  states: string[];
  cities: Array<{ city: string; state: string | null }>;
  /** Listing types actually present in the DB (stay / service / transport …). */
  types: string[];
  /** Categories tagged with their listing type so pickers can narrow. */
  categories: Array<{ value: string; type: string }>;
}

/**
 * Filter-option sources for the ops screens. city/state are free-text
 * columns, so options are whatever's actually in the DB — deduped
 * case-insensitively via initcap(btrim(...)) so "BENGALURU"/"bengaluru"
 * collapse into one entry.
 */
export const adminFacetsRepository = {
  async listingFacets(): Promise<AdminFacets> {
    const [states, cities, types, categories] = await Promise.all([
      query<{ value: string }>(
        `SELECT DISTINCT initcap(btrim(state)) AS value
           FROM listings
          WHERE state IS NOT NULL AND btrim(state) <> ''
          ORDER BY 1
          LIMIT 100`
      ),
      query<{ city: string; state: string | null }>(
        `SELECT DISTINCT initcap(btrim(city)) AS city,
                NULLIF(initcap(btrim(state)), '') AS state
           FROM listings
          WHERE city IS NOT NULL AND btrim(city) <> ''
          ORDER BY 1, 2
          LIMIT 500`
      ),
      query<{ value: string }>(
        `SELECT DISTINCT listing_type AS value
           FROM listings
          WHERE listing_type IS NOT NULL AND btrim(listing_type) <> ''
          ORDER BY 1
          LIMIT 20`
      ),
      query<{ value: string; type: string }>(
        `SELECT DISTINCT btrim(category) AS value, listing_type AS type
           FROM listings
          WHERE category IS NOT NULL AND btrim(category) <> ''
          ORDER BY 1, 2
          LIMIT 200`
      ),
    ]);
    return {
      states: states.rows.map((r) => r.value),
      cities: cities.rows.map((r) => ({ city: r.city, state: r.state })),
      types: types.rows.map((r) => r.value),
      categories: categories.rows.map((r) => ({ value: r.value, type: r.type })),
    };
  },
};
