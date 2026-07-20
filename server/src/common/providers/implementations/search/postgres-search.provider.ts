import { query } from '../../../db/postgres.js';
import type { ISearchProvider, SearchQuery } from '../../interfaces/search-provider.interface.js';

/**
 * Postgres-backed search. The agent's `search_listings` tool maps user phrases
 * like "hotels in Hyderabad" into (searchQuery="hotels hyderabad", category="stay").
 *
 * Key correctness points the previous implementation got wrong:
 *  - The `category` arg is the platform-level listing kind (stay / service /
 *    transport) which lives in `listings.listing_type`. The narrower
 *    `listings.category` column holds sub-types (hotel, homestay, auto, etc.)
 *    and the value 'stay' never appears there — so filtering category='stay'
 *    excluded every row.
 *  - tsvector only indexed name+description+category. City + state + address
 *    weren't searchable, so "Hyderabad" produced zero hits even when a stay
 *    in Hyderabad existed. We now fold those columns into the vector.
 *  - Provider verification gating mirrors `listingsRepository.listPublic`
 *    so what the agent sees matches what the Explore page shows.
 */
export class PostgresSearchProvider implements ISearchProvider {
  async search(params: SearchQuery): Promise<Record<string, unknown>> {
    const { searchQuery, category, lat, lng, radiusKm, page, limit } = params;
    const offset = (page - 1) * limit;

    // Subcategory text: union of the legacy scalar (metadata->>'subcategory')
    // and the new array (metadata->'subcategories'). When a salon publishes
    // ["beard trim", "haircut", "nails"], we want a user query for "beard
    // trim" to match this listing via tsquery — without this expression the
    // text wouldn't appear in the indexed string and we'd fall back to the
    // LLM rerank (which still works, but a precise lexical hit is cheaper).
    // CASE guards against non-array metadata so a malformed row doesn't blow
    // up array_to_string.
    const TEXT_EXPR = `
      COALESCE(l.name, '') || ' ' ||
      COALESCE(l.title, '') || ' ' ||
      COALESCE(l.description, '') || ' ' ||
      COALESCE(l.category, '') || ' ' ||
      COALESCE(l.metadata->>'subcategory', '') || ' ' ||
      COALESCE(
        CASE WHEN jsonb_typeof(l.metadata->'subcategories') = 'array'
             THEN (SELECT string_agg(elem, ' ') FROM jsonb_array_elements_text(l.metadata->'subcategories') elem)
             ELSE ''
        END, ''
      ) || ' ' ||
      COALESCE(l.area, '') || ' ' ||
      COALESCE(l.city, '') || ' ' ||
      COALESCE(l.state, '') || ' ' ||
      COALESCE(l.location, '') || ' ' ||
      COALESCE(l.address, '')
    `;

    let sql = `
      SELECT l.*,
             ts_rank(to_tsvector('english', ${TEXT_EXPR}), plainto_tsquery('english', $1)) as relevance
      FROM listings l
      LEFT JOIN user_profiles up ON up.user_id = l.user_id
      WHERE l.is_active = true
        AND (up.verification_status = 'verified' OR up.user_id IS NULL)
        -- Admin enforcement: mirrors listings.repository.listPublic — change both together.
        AND l.banned_at IS NULL
        AND l.archived_at IS NULL
        AND COALESCE(up.is_suspended, false) = false
        AND (
          to_tsvector('english', ${TEXT_EXPR}) @@ plainto_tsquery('english', $1)
          OR l.name ILIKE '%' || $1 || '%'
          OR l.title ILIKE '%' || $1 || '%'
          OR l.area ILIKE '%' || $1 || '%'
          OR l.city ILIKE '%' || $1 || '%'
          OR l.state ILIKE '%' || $1 || '%'
          OR l.location ILIKE '%' || $1 || '%'
          OR l.address ILIKE '%' || $1 || '%'
          OR l.category ILIKE '%' || $1 || '%'
        )
    `;
    const queryParams: any[] = [searchQuery];

    if (category === 'stay' || category === 'service' || category === 'transport') {
      sql += ` AND l.listing_type = $${queryParams.length + 1}`;
      queryParams.push(category);
    }

    if (lat !== undefined && lng !== undefined) {
      sql += `
        AND (l.lat IS NULL OR l.lng IS NULL OR
             (6371 * acos(cos(radians($${queryParams.length + 1})) * cos(radians(l.lat)) *
              cos(radians(l.lng) - radians($${queryParams.length + 2})) +
              sin(radians($${queryParams.length + 1})) * sin(radians(l.lat)))) <= $${queryParams.length + 3})
      `;
      queryParams.push(lat, lng, radiusKm);
    }

    sql += ` ORDER BY relevance DESC, l.updated_at DESC LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`;
    queryParams.push(limit, offset);

    const [listingsResult, providerResult] = await Promise.all([
      query(sql, queryParams),
      query(
        `SELECT pp.id, pp.display_name, pp.service_categories, pp.lat, pp.lng,
                pp.service_radius_km, up.verification_status, pp.is_available
         FROM provider_profiles pp
         LEFT JOIN user_profiles up ON up.user_id = pp.user_id
         WHERE pp.is_available = true
           AND (pp.display_name ILIKE '%' || $1 || '%'
                OR $1 = ANY(pp.service_categories))
         LIMIT $2`,
        [searchQuery, limit]
      ),
    ]);

    // Keep both `listings`/`providers` (for legacy callers) AND `data`
    // (which the search_listings tool reads). One return shape, no surprises.
    return {
      data: listingsResult.rows,
      listings: listingsResult.rows,
      providers: providerResult.rows,
      total: listingsResult.rows.length + providerResult.rows.length,
      page,
      limit,
    };
  }
}

export const postgresSearchProvider = new PostgresSearchProvider();
