import { dbQuery } from '../../../common/repositories/database.js';

const LISTING_MUTABLE_FIELDS = new Set([
  'title',
  'name',
  'description',
  'location',
  'area',
  'city',
  'state',
  'country',
  'price',
  'price_per_night',
  'max_guests',
  'bedrooms',
  'bathrooms',
  'amenities',
  'image_url',
  'images',
  'photos',
  'property_type',
  'category',
  'service_area',
  'vehicle_name',
  'vehicle_year',
  'availability',
  'is_active',
  'is_published',
  'status',
  'booking_mode',
  'booking_rules',
  'discount_percent',
  'metadata',
  'lat',
  'lng',
  'address',
  'listing_type',
]);

export class ListingsRepository {
  listPublic(filters: { type?: string; limit?: number; cursor?: { updatedAt: string; id: string }; from?: string; to?: string }) {
    const params: any[] = [];
    const clauses = [
      'is_active = true',
      // Only show listings from verified users (or those without a user profile for backward compat)
      `(u.verification_status = 'verified' OR u.user_id IS NULL)`,
      // Admin enforcement: banned/archived listings and suspended hosts never
      // surface publicly. Mirrors postgres-search.provider — change both together.
      'l.banned_at IS NULL',
      'l.archived_at IS NULL',
      'COALESCE(u.is_suspended, false) = false',
    ];

    // listing_type is the source of truth — the migration backfilled it from
    // metadata/category and a CHECK constraint guarantees one of the three
    // known kinds. Old fan-out OR clauses are gone.
    if (filters.type === 'stay' || filters.type === 'service' || filters.type === 'transport') {
      params.push(filters.type);
      clauses.push(`l.listing_type = $${params.length}`);
    }

    // Date-range availability filter (stays). When both from/to are present and
    // describe at least one night, drop any listing that is FULLY unavailable
    // on ANY requested night [from, to-1]. The occupancy rule mirrors
    // bookings.repository.listBookedDatesForListing exactly (per-room-type
    // quantity for multi-room stays, any active booking for single-unit) plus
    // listing-level host blocks, so this discovery filter agrees with the
    // booking calendar. The authoritative per-room conflict check still runs at
    // hold/booking time — this only narrows what the grid shows.
    // Stays only: the occupancy model below is room-night based. Services and
    // transport are slot-based (time-of-day), so their date availability is
    // computed in the service layer (filterByDateAvailability) — applying this
    // night clause to them would over-hide any listing with a single same-day
    // booking regardless of remaining slots.
    const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
    if (filters.type === 'stay' && filters.from && filters.to && ISO_DATE.test(filters.from) && ISO_DATE.test(filters.to) && filters.to > filters.from) {
      params.push(filters.from);
      const fromParam = `$${params.length}`;
      params.push(filters.to);
      const toParam = `$${params.length}`;
      clauses.push(`NOT EXISTS (
        SELECT 1
        FROM generate_series(${fromParam}::date, (${toParam}::date - INTERVAL '1 day')::date, INTERVAL '1 day') AS req(night)
        WHERE
          -- Whole property taken offline by the host on this night.
          EXISTS (
            SELECT 1 FROM listing_availability_overrides ao
            WHERE ao.listing_id = l.id AND ao.room_type_id IS NULL
              AND ao.blocked = true AND ao.date = req.night
          )
          OR (
            CASE WHEN (SELECT COUNT(*) FROM listing_room_types lrt WHERE lrt.listing_id = l.id) = 0
              -- Single-unit stay: any active booking covering this night fills it.
              THEN EXISTS (
                SELECT 1 FROM bookings b
                WHERE b.listing_id = l.id
                  AND b.status IN ('pending','confirmed','in_progress')
                  AND b.scheduled_date <= req.night
                  AND GREATEST(b.scheduled_date, b.end_date - INTERVAL '1 day')::date >= req.night
              )
              -- Multi-room stay: night is full only when EVERY room type is at
              -- capacity (no room type has remaining inventory that night).
              ELSE NOT EXISTS (
                SELECT 1 FROM listing_room_types rt2
                WHERE rt2.listing_id = l.id
                  AND COALESCE((
                    SELECT SUM(COALESCE(b.room_count, 1)) FROM bookings b
                    WHERE b.listing_id = l.id AND b.room_type_id = rt2.id
                      AND b.status IN ('pending','confirmed','in_progress')
                      AND b.scheduled_date <= req.night
                      AND GREATEST(b.scheduled_date, b.end_date - INTERVAL '1 day')::date >= req.night
                  ), 0) < rt2.quantity
              )
            END
          )
      )`);
    }

    // Keyset pagination: order is (updated_at DESC, id DESC) so the cursor is a
    // tuple comparison against the last row of the previous page. Composite
    // (col1, col2) < (a, b) does the lexicographic compare in one shot.
    if (filters.cursor) {
      params.push(filters.cursor.updatedAt);
      const updatedAtParam = `$${params.length}`;
      params.push(filters.cursor.id);
      const idParam = `$${params.length}`;
      clauses.push(`(l.updated_at, l.id) < (${updatedAtParam}::timestamptz, ${idParam}::uuid)`);
    }

    // LATERAL join pulls the listing's room types in a single round trip so
    // hotel cards on the Explore page can render "From ₹X" without a second
    // request per listing (mobile's mapStay also derives listingKind and the
    // card price from list-row room_types — don't drop it from this query).
    // Empty array for non-hotels — adapter treats empty/undefined the same.
    //
    // avg_rating / review_count come from the denormalized columns on
    // listings (trigger-maintained from reviews; see migration
    // 20260709100000_listing_rating_denormalization). The old AVG/COUNT
    // aggregation forced a GROUP BY that blocked LIMIT pushdown, so every
    // page fetch aggregated ALL matching listings — measured at 9 saturated
    // DB cores / p95 7.9s under a 75 req/s load test. Without the GROUP BY
    // the planner walks idx_listings_updated_at_id and stops at LIMIT, and
    // the lateral runs only for the returned page.
    let sql = `
      SELECT l.*, pp.id AS provider_profile_id,
             u.created_at AS user_created_at,
             COALESCE(rt.room_types, '[]'::jsonb) AS room_types
      FROM listings l
      LEFT JOIN provider_profiles pp ON pp.user_id = l.user_id
      LEFT JOIN user_profiles u ON u.user_id = l.user_id
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(
          jsonb_build_object(
            'id', rt.id,
            'listing_id', rt.listing_id,
            'name', rt.name,
            'description', rt.description,
            'base_price_paise', rt.base_price_paise,
            'max_guests', rt.max_guests,
            'quantity', rt.quantity,
            'bedrooms', rt.bedrooms,
            'bathrooms', rt.bathrooms,
            'unit_identifiers', rt.unit_identifiers,
            'photos', rt.photos,
            'sort_order', rt.sort_order
          ) ORDER BY rt.sort_order
        ) AS room_types
        FROM listing_room_types rt
        WHERE rt.listing_id = l.id
      ) rt ON true
      WHERE ${clauses.map((clause) => clause.replace(/\bis_active\b/g, 'l.is_active').replace(/\bproperty_type\b/g, 'l.property_type').replace(/\bprice_per_night\b/g, 'l.price_per_night').replace(/\bcategory\b/g, 'l.category').replace(/\bmetadata\b/g, 'l.metadata').replace(/\bvehicle_name\b/g, 'l.vehicle_name')).join(' AND ')}
      ORDER BY l.updated_at DESC, l.id DESC
    `;

    if (filters.limit) {
      params.push(filters.limit);
      sql += ` LIMIT $${params.length}`;
    }

    return dbQuery(sql, params);
  }

  listForUser(userId: string) {
    return dbQuery(
      // from_price_paise = cheapest room type, so the dashboard can show
      // "from ₹X" for multi-room stays (whose listing-level price is 0 —
      // per-room pricing lives in listing_room_types). NULL for single-unit
      // stays / services / transport (no room types).
      `SELECT l.*, pp.id AS provider_profile_id,
              ROUND(AVG(r.rating)::numeric, 1) AS avg_rating,
              COUNT(r.id) AS review_count,
              (SELECT MIN(rt.base_price_paise) FROM listing_room_types rt WHERE rt.listing_id = l.id) AS from_price_paise
       FROM listings l
       LEFT JOIN provider_profiles pp ON pp.user_id = l.user_id
       LEFT JOIN reviews r ON r.stay_id = l.id::text
       WHERE l.user_id = $1
       GROUP BY l.id, pp.id
       ORDER BY l.created_at DESC`,
      [userId]
    );
  }

  getById(id: string) {
    return dbQuery(
      `SELECT l.*, pp.id AS provider_profile_id,
              u.created_at AS user_created_at,
              ROUND(AVG(r.rating)::numeric, 1) AS avg_rating,
              COUNT(r.id) AS review_count,
              COALESCE(rt.room_types, '[]'::jsonb) AS room_types
       FROM listings l
       LEFT JOIN provider_profiles pp ON pp.user_id = l.user_id
       LEFT JOIN user_profiles u ON u.user_id = l.user_id
       LEFT JOIN reviews r ON r.stay_id = l.id::text
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(
           jsonb_build_object(
             'id', rt.id,
             'listing_id', rt.listing_id,
             'name', rt.name,
             'description', rt.description,
             'base_price_paise', rt.base_price_paise,
             'max_guests', rt.max_guests,
             'quantity', rt.quantity,
             'bedrooms', rt.bedrooms,
             'bathrooms', rt.bathrooms,
             'unit_identifiers', rt.unit_identifiers,
             'photos', rt.photos,
             'sort_order', rt.sort_order
           ) ORDER BY rt.sort_order
         ) AS room_types
         FROM listing_room_types rt
         WHERE rt.listing_id = l.id
       ) rt ON true
       WHERE l.id = $1
       GROUP BY l.id, pp.id, u.created_at, rt.room_types
       LIMIT 1`,
      [id]
    );
  }

  create(userId: string, payload: Record<string, unknown>) {
    const record = Object.fromEntries(
      Object.entries(payload).filter(([key]) => LISTING_MUTABLE_FIELDS.has(key))
    );

    const entries = Object.entries({ ...record, user_id: userId });
    const columns = entries.map(([key]) => `"${key}"`);
    const placeholders = entries.map((_, index) => `$${index + 1}`);
    const values = entries.map(([, value]) => value);

    return dbQuery(
      `INSERT INTO listings (${columns.join(', ')})
       VALUES (${placeholders.join(', ')})
       RETURNING *`,
      values
    );
  }

  update(id: string, userId: string, payload: Record<string, unknown>) {
    const entries = Object.entries(payload).filter(([key]) => LISTING_MUTABLE_FIELDS.has(key));

    if (entries.length === 0) {
      return this.getById(id);
    }

    const assignments = entries.map(([key], index) => `"${key}" = $${index + 1}`);
    const values = entries.map(([, value]) => value);
    values.push(id, userId);

    return dbQuery(
      `UPDATE listings
       SET ${assignments.join(', ')}, updated_at = NOW()
       WHERE id = $${values.length - 1} AND user_id = $${values.length}
       RETURNING *`,
      values
    );
  }


  /** Distinct categories + metadata.subcategor(y|ies) values for a given
   *  listing_type, restricted to active rows. Used by the marketplace
   *  filter dialog so the chips reflect what's actually published instead
   *  of a hard-coded preset.
   *
   *  Subcategory shape evolved: legacy listings store a single string at
   *  `metadata.subcategory`; new listings store an array at
   *  `metadata.subcategories` so a salon can publish multiple sub-skills
   *  ("Beard trim", "Haircut", "Nails"). We union BOTH so a host's old
   *  single-value listing stays filterable alongside new multi-value ones.
   *  `jsonb_array_elements_text` lazily expands the array; the LEFT JOIN
   *  fallback to the legacy scalar handles rows where the array is missing
   *  or empty. */
  async distinctTaxonomy(listingType: 'stay' | 'service' | 'transport') {
    const result = await dbQuery<{ category: string | null; sub: string | null }>(
      `SELECT category, sub FROM (
         SELECT category, NULLIF(TRIM(BOTH FROM (metadata->>'subcategory')), '') AS sub
           FROM listings
          WHERE listing_type = $1 AND is_active = TRUE
         UNION
         SELECT l.category, NULLIF(TRIM(BOTH FROM elem), '') AS sub
           FROM listings l,
                LATERAL jsonb_array_elements_text(
                  CASE WHEN jsonb_typeof(l.metadata->'subcategories') = 'array'
                       THEN l.metadata->'subcategories'
                       ELSE '[]'::jsonb
                  END
                ) AS elem
          WHERE l.listing_type = $1 AND l.is_active = TRUE
       ) t`,
      [listingType]
    );

    const categories = new Set<string>();
    const subcategories = new Set<string>();
    for (const row of result.rows) {
      if (row.category) categories.add(row.category);
      if (row.sub) subcategories.add(row.sub);
    }
    return {
      categories: Array.from(categories).sort((a, b) => a.localeCompare(b)),
      subcategories: Array.from(subcategories).sort((a, b) => a.localeCompare(b)),
    };
  }
}

export const listingsRepository = new ListingsRepository();
