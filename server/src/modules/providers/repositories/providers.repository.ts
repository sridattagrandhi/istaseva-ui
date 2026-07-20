import { dbQuery } from '../../../common/repositories/database.js';

const PROVIDER_PROFILE_MUTABLE_FIELDS = new Set([
  'display_name',
  'service_categories',
  'lat',
  'lng',
  'service_radius_km',
  'buffer_minutes',
  'is_available',
  'bio',
  // P3 scheduling fields. Smart-schedule reads these directly to pick travel
  // multipliers, enforce daily caps, and respect per-day working windows.
  'vehicle_class',
  'max_jobs_per_day',
  'working_hours',
]);

/** Columns we select for the smart-schedule context. Centralised so the two
 *  scheduling queries (with-availability and category-fallback) stay in sync. */
const PROVIDER_SCHEDULING_COLUMNS = `
  pp.id, pp.display_name, pp.lat, pp.lng,
  pp.service_radius_km, pp.buffer_minutes,
  pp.vehicle_class, pp.max_jobs_per_day, pp.working_hours
`;

export class ProvidersRepository {
  getByUserId(userId: string) {
    return dbQuery(
      'SELECT * FROM provider_profiles WHERE user_id = $1 LIMIT 1',
      [userId]
    );
  }

  create(userId: string, payload: Record<string, unknown>) {
    const record = Object.fromEntries(
      Object.entries(payload).filter(([key]) => PROVIDER_PROFILE_MUTABLE_FIELDS.has(key))
    );

    const entries = Object.entries({ ...record, user_id: userId });
    const columns = entries.map(([key]) => `"${key}"`);
    const placeholders = entries.map((_, index) => `$${index + 1}`);
    const values = entries.map(([, value]) => value);

    return dbQuery(
      `INSERT INTO provider_profiles (${columns.join(', ')})
       VALUES (${placeholders.join(', ')})
       RETURNING *`,
      values
    );
  }

  update(providerId: string, payload: Record<string, unknown>) {
    const record = Object.fromEntries(
      Object.entries(payload).filter(([key]) => PROVIDER_PROFILE_MUTABLE_FIELDS.has(key))
    );
    const entries = Object.entries(record);
    if (entries.length === 0) return dbQuery('SELECT * FROM provider_profiles WHERE id = $1', [providerId]);
    const setClauses = entries.map(([key], i) => `"${key}" = $${i + 2}`);
    const values = entries.map(([, v]) => v);
    return dbQuery(
      `UPDATE provider_profiles SET ${setClauses.join(', ')}, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [providerId, ...values]
    );
  }

  updateServiceCategories(userId: string, categories: string[]) {
    return dbQuery(
      `UPDATE provider_profiles
       SET service_categories = $2, updated_at = NOW()
       WHERE user_id = $1
       RETURNING *`,
      [userId, categories]
    );
  }

  deleteAvailabilityForProvider(providerId: string) {
    return dbQuery('DELETE FROM provider_availability WHERE provider_id = $1', [providerId]);
  }

  createAvailability(providerId: string, dayOfWeek: number, startTime: string, endTime: string) {
    return dbQuery(
      `INSERT INTO provider_availability (provider_id, day_of_week, start_time, end_time, is_active)
       VALUES ($1, $2, $3, $4, true)
       RETURNING *`,
      [providerId, dayOfWeek, startTime, endTime]
    );
  }

  listAvailableProvidersWithAvailability(serviceCategory: string, dayOfWeek: number) {
    // Also pull the listing name so the smart-schedule slot can surface the
    // *service offering* (e.g. "Super Cleanings") rather than the provider's
    // brand (e.g. "Trident Hotels"). DISTINCT ON keeps one row per provider —
    // we pick the listing whose category matches and is most recently
    // updated, which is the correct one when a provider has multiple offers.
    // Category matching is intentionally case-insensitive. The chat agent
    // hands us strings like "cleaning" while the host-onboarded data has
    // mixed-case values like "Home Cleaning" or "Cleaner". A strict `=`
    // returned zero rows and the assistant replied "no slot available"
    // even when matching providers existed. We compare lowercased on both
    // sides (listings.category column AND each element of the
    // service_categories text[]).
    return dbQuery(
      `SELECT DISTINCT ON (pp.id)
              ${PROVIDER_SCHEDULING_COLUMNS},
              pa.start_time as avail_start, pa.end_time as avail_end,
              l.name AS listing_name, l.id AS listing_id
       FROM provider_profiles pp
       JOIN provider_availability pa ON pa.provider_id = pp.id
       LEFT JOIN listings l ON l.user_id = pp.user_id
         AND COALESCE(l.is_active, true) = true
         AND LOWER(l.category) = LOWER($1)
       WHERE EXISTS (
         SELECT 1 FROM unnest(pp.service_categories) AS sc
          WHERE LOWER(sc) = LOWER($1)
       )
         AND pp.is_available = true
         AND pa.day_of_week = $2
         AND pa.is_active = true
       ORDER BY pp.id, l.updated_at DESC NULLS LAST`,
      [serviceCategory, dayOfWeek]
    );
  }

  /**
   * Returns every block of provider time that is NOT free on a given date —
   * any non-dead booking AND any active slot_lock (a different user is mid-
   * checkout). The status filter is inclusive ("anything except outright
   * dead") because pending/paid bookings still occupy the slot.
   *
   * Matches via provider_id OR listing_id so we still catch a booking that
   * was created against a listing without a resolved provider link.
   */
  listOccupiedIntervalsForProvidersOnDate(
    providerIds: string[],
    listingIds: string[],
    preferredDate: string,
  ) {
    return dbQuery(
      `SELECT provider_id, listing_id, start_time, end_time, address, lat, lng
       FROM bookings
       WHERE (provider_id = ANY($1) OR listing_id = ANY($2))
         AND scheduled_date = $3
         -- Positive list keyed off the booking_status enum members.
         -- Anything not here ('cancelled', 'expired') is treated as a freed slot.
         AND status IN ('pending', 'confirmed', 'in_progress', 'completed')
       UNION ALL
       SELECT provider_id, NULL::uuid as listing_id, start_time, end_time, NULL::text as address, NULL::double precision as lat, NULL::double precision as lng
       FROM slot_locks
       WHERE provider_id = ANY($1)
         AND scheduled_date = $3
         AND status = 'active'
         AND expires_at > NOW()`,
      [providerIds, listingIds, preferredDate]
    );
  }

  listBookingsForProvidersOnDate(providerIds: string[], preferredDate: string) {
    return this.listOccupiedIntervalsForProvidersOnDate(providerIds, [], preferredDate);
  }

  /**
   * Fallback: find providers by category without requiring provider_availability records.
   * Joins to listings to get availability text as a fallback for slot generation.
   */
  /**
   * Look up the single provider that owns a specific listing — used by the
   * chat assistant's find_available_slots when the user has already picked
   * a listing. Bypasses the category-text match (which silently returned 0
   * rows when listing.category didn't exactly match the agent's free-text
   * service category) and goes directly via listing_id → user_id.
   */
  listProvidersForListing(listingId: string) {
    return dbQuery(
      `SELECT DISTINCT ON (pp.id)
         ${PROVIDER_SCHEDULING_COLUMNS},
         pp.is_available,
         l.id AS listing_id,
         l.name AS listing_name,
         l.availability AS listing_availability,
         l.metadata AS listing_metadata
       FROM listings l
       JOIN provider_profiles pp ON pp.user_id = l.user_id
       WHERE l.id = $1
         AND COALESCE(l.is_active, true) = true
         AND pp.is_available = true
       ORDER BY pp.id, l.updated_at DESC NULLS LAST`,
      [listingId]
    );
  }

  listProvidersByCategory(serviceCategory: string) {
    // Same case-insensitive contract as listAvailableProvidersWithAvailability.
    return dbQuery(
      `SELECT DISTINCT ON (pp.id)
         ${PROVIDER_SCHEDULING_COLUMNS},
         pp.is_available,
         l.id AS listing_id,
         l.name AS listing_name,
         l.availability AS listing_availability
       FROM provider_profiles pp
       LEFT JOIN listings l ON l.user_id = pp.user_id
         AND COALESCE(l.is_active, true) = true
         AND LOWER(l.category) = LOWER($1)
       WHERE EXISTS (
         SELECT 1 FROM unnest(pp.service_categories) AS sc
          WHERE LOWER(sc) = LOWER($1)
       )
         AND pp.is_available = true
       ORDER BY pp.id, l.updated_at DESC NULLS LAST`,
      [serviceCategory]
    );
  }

  /** Dates the provider has explicitly blocked off (vacation, sick, etc.).
   *  Returns ISO date strings (YYYY-MM-DD) for the calling provider IDs. */
  listBlackoutDatesForProviders(providerIds: string[], fromDate: string) {
    if (providerIds.length === 0) return Promise.resolve({ rows: [] as Array<{ provider_id: string; blackout_date: string }> });
    return dbQuery<{ provider_id: string; blackout_date: string }>(
      `SELECT provider_id, blackout_date::text
       FROM provider_blackout_dates
       WHERE provider_id = ANY($1) AND blackout_date >= $2`,
      [providerIds, fromDate]
    );
  }
}

export const providersRepository = new ProvidersRepository();
