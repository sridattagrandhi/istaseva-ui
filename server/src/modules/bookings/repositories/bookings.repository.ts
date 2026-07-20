import type pg from 'pg';
import { dbQuery, runDbQuery } from '../../../common/repositories/database.js';
import type { BookingStatus } from '../schemas/booking-status.js';

// A "real relationship" = paid/underway/finished booking. Counterparty phone
// numbers AND exact listing geo are shared only at these statuses — a pending
// unpaid hold must not expose them, or a throwaway hold harvests a host's
// number/home address for free. Mirrors the "Call" gate in
// findActiveRelationship.
const ACTIVE_RELATIONSHIP_STATUSES = `('confirmed', 'in_progress', 'completed')`;

export class BookingsRepository {
  listForUser(userId: string, status: unknown, limit: number, offset: number) {
    // LATERAL join to grab the latest COMPLETED payment row's breakdown so
    // the dashboard can render the true total paid (base + platform + GST +
    // insurance − discount) instead of just agreed_price_paise, which
    // excludes insurance and was showing ₹6.90 on a ₹8.90 booking.
    let sql = `
      SELECT b.*, pp.display_name as provider_name, pp.user_id as provider_user_id,
             l.name as listing_name,
             hp.display_name as host_name,
             CASE WHEN b.status IN ${ACTIVE_RELATIONSHIP_STATUSES} THEN hp.phone END as host_phone,
             l.user_id as host_user_id,
             COALESCE(b.address, l.location) as address,
             -- Ingredients for the WS6 "does the guest have a REAL street
             -- address?" flag. The flag itself is computed in the service
             -- layer by bookingHasExactAddress (listing-address.ts) — the
             -- single source of truth shared with the confirmation email.
             -- A SQL copy used to live here and drifted (it counted any
             -- b.address as exact and predated the l.area column).
             b.address  AS booking_address,
             l.address  AS listing_address,
             l.location AS listing_location,
             l.area     AS listing_area,
             l.city     AS listing_city,
             l.state    AS listing_state,
             p.subtotal_paise          AS payment_subtotal_paise,
             p.platform_fee_paise      AS payment_platform_fee_paise,
             p.taxes_paise             AS payment_taxes_paise,
             p.insurance_premium_paise AS payment_insurance_premium_paise,
             p.discount_paise          AS payment_discount_paise,
             p.amount_paise            AS payment_amount_paise
      FROM bookings b
      LEFT JOIN provider_profiles pp ON pp.id = b.provider_id
      LEFT JOIN listings l ON l.id = b.listing_id
      LEFT JOIN user_profiles hp ON hp.user_id = l.user_id
      LEFT JOIN LATERAL (
        SELECT subtotal_paise, platform_fee_paise, taxes_paise,
               insurance_premium_paise, discount_paise, amount_paise
          FROM payments
         WHERE booking_id = b.id AND status = 'completed'
         ORDER BY completed_at DESC NULLS LAST, created_at DESC
         LIMIT 1
      ) p ON true
      WHERE b.user_id = $1
    `;
    const params: unknown[] = [userId];

    if (status) {
      sql += ` AND b.status = $${params.length + 1}`;
      params.push(status);
    }

    // Order by when the booking was placed (created_at) so the dashboard's
    // "most recent activity first" matches what the guest expects. The old
    // ORDER BY scheduled_date DESC pushed long-past completed bookings to
    // the bottom of the list — combined with the 20-row default LIMIT, the
    // Completed tab on dashboards rendered empty even when matching rows
    // existed. Fallbacks keep ordering deterministic for rows with no
    // created_at (legacy) and as a tiebreaker.
    sql += ` ORDER BY b.created_at DESC NULLS LAST, b.scheduled_date DESC, b.start_time DESC`;
    sql += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    return dbQuery(sql, params);
  }

  listForProvider(userId: string, status: unknown, limit: number, offset: number) {
    // Same payment breakdown surfacing as listForUser — keeps the host
    // dashboard's "Amount" column in lock-step with the guest dashboard,
    // the receipt email, and the invoice PDF (all four totals derive from
    // the same payment_* columns).
    let sql = `
      SELECT b.*, pp.display_name as provider_name, pp.user_id as provider_user_id,
             up.display_name as guest_name,
             CASE WHEN b.status IN ${ACTIVE_RELATIONSHIP_STATUSES} THEN up.phone END as guest_phone,
             l.name as listing_name,
             COALESCE(b.address, l.location) as address,
             p.subtotal_paise          AS payment_subtotal_paise,
             p.platform_fee_paise      AS payment_platform_fee_paise,
             p.taxes_paise             AS payment_taxes_paise,
             p.insurance_premium_paise AS payment_insurance_premium_paise,
             p.discount_paise          AS payment_discount_paise,
             p.amount_paise            AS payment_amount_paise
      FROM bookings b
      INNER JOIN provider_profiles owned_pp ON owned_pp.id = b.provider_id
      LEFT JOIN provider_profiles pp ON pp.id = b.provider_id
      LEFT JOIN user_profiles up ON up.user_id = b.user_id
      LEFT JOIN listings l ON l.id = b.listing_id
      LEFT JOIN LATERAL (
        SELECT subtotal_paise, platform_fee_paise, taxes_paise,
               insurance_premium_paise, discount_paise, amount_paise
          FROM payments
         WHERE booking_id = b.id AND status = 'completed'
         ORDER BY completed_at DESC NULLS LAST, created_at DESC
         LIMIT 1
      ) p ON true
      WHERE owned_pp.user_id = $1
        -- Partner dashboards only ever show real bookings: paid (confirmed /
        -- in_progress / completed) or cancelled. Unpaid holds ('pending') and
        -- lapsed holds ('expired') never surface to hosts/providers.
        AND b.status NOT IN ('pending', 'expired')
    `;
    const params: unknown[] = [userId];

    if (status) {
      sql += ` AND b.status = $${params.length + 1}`;
      params.push(status);
    }

    // Mirror listForUser — sort by booking-placed time so the host/provider
    // dashboards surface the most recent activity first instead of bumping
    // older completed bookings out of the limited window.
    sql += ` ORDER BY b.created_at DESC NULLS LAST, b.scheduled_date DESC, b.start_time DESC`;
    sql += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);

    return dbQuery(sql, params);
  }

  countForUser(userId: string) {
    return dbQuery('SELECT COUNT(*) FROM bookings WHERE user_id = $1', [userId]);
  }

  /**
   * Find any booking by `userId` that qualifies them to leave a review for the
   * given stay (listing) or provider. A booking qualifies when it is either:
   *   - status = 'completed', or
   *   - status in ('confirmed', 'in_progress') AND scheduled_date is in the
   *     past (so a guest who has actually stayed can review even if the host
   *     hasn't flipped the status yet).
   *
   * Bookings that already carry a review are skipped — each booking supports
   * exactly one review, so a repeat guest's second stay picks the next
   * unreviewed booking, and a fully-reviewed history yields no rows (the
   * service rejects the duplicate).
   *
   * `preferredBookingId` (when the client says WHICH booking it's reviewing —
   * e.g. the review prompt) sorts that booking first, but only if it passes
   * the same ownership/eligibility checks; an ineligible or foreign id just
   * falls back to any other qualifying booking.
   *
   * At least one of `stayId` / `providerId` must be provided. When both are
   * provided, either match qualifies (e.g. a stay booking matched on
   * listing_id, or a service booking matched on provider_id).
   */
  findEligibleBookingForReview(
    userId: string,
    stayId: string | null,
    providerId: string | null,
    preferredBookingId: string | null = null,
  ) {
    return dbQuery<{ id: string }>(
      `SELECT id FROM bookings
       WHERE user_id = $1
         AND (
           ($2::text IS NOT NULL AND listing_id::text = $2)
           OR
           ($3::uuid IS NOT NULL AND provider_id = $3)
         )
         AND (
           status = 'completed'
           OR (status IN ('confirmed', 'in_progress') AND scheduled_date < CURRENT_DATE)
         )
         AND NOT EXISTS (SELECT 1 FROM reviews r WHERE r.booking_id = bookings.id)
       ORDER BY CASE WHEN $4::uuid IS NOT NULL AND id = $4::uuid THEN 0 ELSE 1 END,
                scheduled_date DESC
       LIMIT 1`,
      [userId, stayId, providerId, preferredBookingId],
    );
  }

  /**
   * True when the user has a real (paid/underway/finished) booking for the
   * listing. Powers the listing-geo privacy gate: exact address/coordinates
   * are shared only with confirmed guests (or the owner/admin).
   */
  userHasActiveBookingForListing(userId: string, listingId: string) {
    return dbQuery<{ ok: number }>(
      `SELECT 1 AS ok FROM bookings
       WHERE user_id = $1 AND listing_id = $2
         AND status IN ${ACTIVE_RELATIONSHIP_STATUSES}
       LIMIT 1`,
      [userId, listingId],
    );
  }

  countForProvider(userId: string) {
    // Mirrors listForProvider's status exclusion so pagination totals match.
    return dbQuery(
      `SELECT COUNT(*)
       FROM bookings b
       INNER JOIN provider_profiles pp ON pp.id = b.provider_id
       WHERE pp.user_id = $1
         AND b.status NOT IN ('pending', 'expired')`,
      [userId]
    );
  }

  countPendingForUser(userId: string) {
    // Exclude on-behalf holds: a host who books for many walk-up guests would
    // otherwise blow past the 3-pending cap, and their own personal bookings
    // would be blocked by holds that aren't really theirs to pay for.
    return dbQuery(
      `SELECT COUNT(*) FROM bookings WHERE user_id = $1 AND status = 'pending' AND booked_on_behalf = false`,
      [userId],
    );
  }

  getAccessibleBookingById(bookingId: string, userId: string) {
    // Same payment breakdown surfacing as listForUser/listForProvider so
    // the single-booking detail modal renders the same total as the list.
    return dbQuery(
      `SELECT b.*, pp.display_name as provider_name, pp.user_id as provider_user_id,
              up.display_name as guest_name,
              CASE WHEN b.status IN ${ACTIVE_RELATIONSHIP_STATUSES} THEN up.phone END as guest_phone,
              l.name as listing_name,
              hp.display_name as host_name,
              CASE WHEN b.status IN ${ACTIVE_RELATIONSHIP_STATUSES} THEN hp.phone END as host_phone,
              l.user_id as host_user_id,
              COALESCE(b.address, l.location) as address,
              -- Same WS6 ingredients as the guest list query above — the flag
              -- is computed by bookingHasExactAddress in the service layer.
              b.address  AS booking_address,
              l.address  AS listing_address,
              l.location AS listing_location,
              l.area     AS listing_area,
              l.city     AS listing_city,
              l.state    AS listing_state,
              p.subtotal_paise          AS payment_subtotal_paise,
              p.platform_fee_paise      AS payment_platform_fee_paise,
              p.taxes_paise             AS payment_taxes_paise,
              p.insurance_premium_paise AS payment_insurance_premium_paise,
              p.discount_paise          AS payment_discount_paise,
              p.amount_paise            AS payment_amount_paise
       FROM bookings b
       LEFT JOIN provider_profiles pp ON pp.id = b.provider_id
       LEFT JOIN user_profiles up ON up.user_id = b.user_id
       LEFT JOIN listings l ON l.id = b.listing_id
       LEFT JOIN user_profiles hp ON hp.user_id = l.user_id
       LEFT JOIN LATERAL (
         SELECT subtotal_paise, platform_fee_paise, taxes_paise,
                insurance_premium_paise, discount_paise, amount_paise
           FROM payments
          WHERE booking_id = b.id AND status = 'completed'
          ORDER BY completed_at DESC NULLS LAST, created_at DESC
          LIMIT 1
       ) p ON true
       WHERE b.id = $1 AND (b.user_id = $2 OR b.provider_id IN (
         SELECT id FROM provider_profiles WHERE user_id = $2
       ))`,
      [bookingId, userId]
    );
  }

  getById(bookingId: string, client?: pg.PoolClient) {
    return runDbQuery(client ?? null, 'SELECT * FROM bookings WHERE id = $1', [bookingId]);
  }

  /**
   * Ops-console fetch: getAccessibleBookingById's exact SELECT without the
   * ownership predicate. Callers MUST be behind requireRole('admin') — this
   * powers updateStatus's admin actor path and the admin booking detail view.
   */
  getBookingByIdForAdmin(bookingId: string) {
    return dbQuery(
      `SELECT b.*, pp.display_name as provider_name, pp.user_id as provider_user_id,
              up.display_name as guest_name, up.phone as guest_phone, l.name as listing_name,
              hp.display_name as host_name, hp.phone as host_phone, l.user_id as host_user_id,
              p.subtotal_paise          AS payment_subtotal_paise,
              p.platform_fee_paise      AS payment_platform_fee_paise,
              p.taxes_paise             AS payment_taxes_paise,
              p.insurance_premium_paise AS payment_insurance_premium_paise,
              p.discount_paise          AS payment_discount_paise,
              p.amount_paise            AS payment_amount_paise
       FROM bookings b
       LEFT JOIN provider_profiles pp ON pp.id = b.provider_id
       LEFT JOIN user_profiles up ON up.user_id = b.user_id
       LEFT JOIN listings l ON l.id = b.listing_id
       LEFT JOIN user_profiles hp ON hp.user_id = l.user_id
       LEFT JOIN LATERAL (
         SELECT subtotal_paise, platform_fee_paise, taxes_paise,
                insurance_premium_paise, discount_paise, amount_paise
           FROM payments
          WHERE booking_id = b.id AND status = 'completed'
          ORDER BY completed_at DESC NULLS LAST, created_at DESC
          LIMIT 1
       ) p ON true
       WHERE b.id = $1`,
      [bookingId]
    );
  }

  getByIdForUpdate(client: pg.PoolClient, bookingId: string) {
    return client.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [bookingId]);
  }

  /** Driver contact for a transport booking snapshot: the provider's
   *  display name + the host user's phone (user_profiles.phone). Keyed by
   *  provider_profiles.id so it works whether or not the caller already
   *  resolved the host user id. */
  getDriverContact(providerId: string, client?: pg.PoolClient) {
    // Driver NAME is the host's personal name (user_profiles.display_name —
    // "Raji B"), NOT the provider-profile business name ("Ravi's Trips"): the
    // rider wants the person who'll drive, plus their phone to reach them.
    return runDbQuery(
      client ?? null,
      `SELECT up.display_name AS driver_name, up.phone AS driver_phone
         FROM provider_profiles pp
         LEFT JOIN user_profiles up ON up.user_id = pp.user_id
        WHERE pp.id = $1
        LIMIT 1`,
      [providerId],
    );
  }

  /**
   * Active booking relationship between two users, for the in-chat "Call"
   * gate. Returns one row per active booking linking `userId` and `peerUserId`
   * in EITHER direction (I'm the guest of peer's listing, or peer is the guest
   * on a listing I own), carrying the peer's phone + the peer's ROLE relative
   * to me. A booking's counterparty (provider/host) is COALESCE(provider
   * profile owner, listing owner). Only confirmed/in_progress/completed
   * bookings qualify — the call channel opens once a real booking exists,
   * never for pre-booking discovery chats.
   */
  findActiveRelationship(userId: string, peerUserId: string) {
    return dbQuery<{ peer_role: string; peer_phone: string | null }>(
      `SELECT
         CASE
           WHEN b.user_id = $2 THEN 'guest'
           WHEN l.listing_type = 'stay' THEN 'host'
           WHEN l.listing_type = 'transport' THEN 'driver'
           ELSE 'provider'
         END              AS peer_role,
         peer.phone       AS peer_phone
       FROM bookings b
       LEFT JOIN provider_profiles pp ON pp.id = b.provider_id
       LEFT JOIN listings l ON l.id = b.listing_id
       LEFT JOIN user_profiles peer ON peer.user_id = $2
      WHERE b.status IN ('confirmed', 'in_progress', 'completed')
        AND (
          (b.user_id = $1 AND COALESCE(pp.user_id, l.user_id) = $2)
          OR
          (b.user_id = $2 AND COALESCE(pp.user_id, l.user_id) = $1)
        )`,
      [userId, peerUserId],
    );
  }

  /**
   * Resolve the two chat parties for a booking so the confirmation can seed a
   * provider→guest system message: the guest (b.user_id), the counterparty
   * (provider-profile owner, else listing owner), and the listing label/type
   * for the message body.
   */
  getBookingChatParties(bookingId: string) {
    return dbQuery<{
      guest_user_id: string | null;
      counterparty_user_id: string | null;
      listing_name: string | null;
      listing_type: string | null;
      scheduled_date: string | Date | null;
      end_date: string | Date | null;
      start_time: string | null;
      end_time: string | null;
      guest_count: number | null;
      room_count: number | null;
      room_type: string | null;
      service_category: string | null;
      notes: string | null;
    }>(
      `SELECT b.user_id                       AS guest_user_id,
              COALESCE(pp.user_id, l.user_id) AS counterparty_user_id,
              l.name                          AS listing_name,
              l.listing_type                  AS listing_type,
              b.scheduled_date                AS scheduled_date,
              b.end_date                      AS end_date,
              b.start_time                    AS start_time,
              b.end_time                      AS end_time,
              b.guest_count                   AS guest_count,
              b.room_count                    AS room_count,
              b.room_type_name_snapshot       AS room_type,
              b.service_category              AS service_category,
              b.notes                         AS notes
         FROM bookings b
         LEFT JOIN provider_profiles pp ON pp.id = b.provider_id
         LEFT JOIN listings l ON l.id = b.listing_id
        WHERE b.id = $1
        LIMIT 1`,
      [bookingId],
    );
  }

  findByIdempotencyKey(userId: string, idempotencyKey: string) {
    return dbQuery(
      `SELECT * FROM bookings
       WHERE user_id = $1 AND idempotency_key = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId, idempotencyKey]
    );
  }

  /**
   * Dates that are fully booked for the listing — i.e. the booked-dates the
   * picker should disable. The shape of "fully booked" depends on the
   * listing's room model:
   *
   *   - Listings without room types (homestays, single-listing stays):
   *       any active booking on a date marks that date booked.
   *
   *   - Listings with room types AND a roomTypeId is given:
   *       count active bookings for THAT room on each date; mark booked only
   *       when count >= room_type.quantity. Other rooms might still be free.
   *
   *   - Listings with room types AND no roomTypeId is given (rare — caller
   *     hasn't picked a room yet): return only dates where every room type
   *     is fully booked. This is conservative — picking a specific room
   *     usually opens the date back up.
   */
  /**
   * Read-only mirror of the same-day branch of
   * `findConflictingBookingsForUpdate` — "does any active booking on this
   * listing overlap [startTime, endTime) on this date?" — WITHOUT FOR UPDATE
   * or a transaction. Used by the assistant's search availability gate to
   * drop time-conflicting transport/service listings BEFORE they're shown,
   * so the agent can't suggest a slot the hold check would later reject.
   * Same overlap predicate as the hold so the two never disagree.
   */
  listActiveBookingsOverlappingWindow(listingId: string, date: string, startTime: string, endTime: string) {
    return dbQuery<{ id: string }>(
      `SELECT id
       FROM bookings
       WHERE listing_id = $1::uuid
         AND scheduled_date <= $2::date
         -- EXCLUSIVE end floored at next day so single-day rows (which store
         -- end_date = scheduled_date, not NULL) still register as occupying $2.
         -- Must stay identical to findConflictingBookingsForUpdate's guard.
         AND GREATEST(COALESCE(end_date, scheduled_date), (scheduled_date + INTERVAL '1 day')::date) > $2::date
         AND status IN ('pending', 'confirmed', 'in_progress')
         AND (status != 'pending' OR hold_expires_at IS NULL OR hold_expires_at > NOW())
         AND (
           (end_date IS NOT NULL AND end_date > scheduled_date)
           OR (start_time < $3 AND end_time > $4)
         )`,
      [listingId, date, endTime, startTime],
    );
  }

  /**
   * Active bookings that touch `date` for the given listings, as raw time
   * intervals. Powers the Explore date filter's slot-level availability check
   * for services/transport (listing-scoped per CLAUDE.md — never per-provider).
   * A same-day booking returns its [start_time, end_time); a multi-day booking
   * that merely spans the date returns NULL times and the caller treats it as a
   * whole-day block. Only future-relevant statuses count, matching the
   * authoritative conflict check.
   */
  bookedIntervalsForListingsOnDate(listingIds: string[], date: string) {
    return dbQuery<{ listing_id: string; scheduled_date: string; start_time: string | null; end_time: string | null }>(
      `SELECT listing_id,
              TO_CHAR(scheduled_date, 'YYYY-MM-DD') AS scheduled_date,
              start_time, end_time
         FROM bookings
        WHERE listing_id = ANY($1::uuid[])
          AND status IN ('pending', 'confirmed', 'in_progress')
          AND scheduled_date <= $2::date
          AND COALESCE(end_date, scheduled_date) >= $2::date`,
      [listingIds, date],
    );
  }

  listBookedDatesForListing(listingId: string, roomTypeId?: string) {
    // For multi-night stays we expand each booking into its occupied nights
    // (scheduled_date .. end_date - 1 day, inclusive) so the calendar
    // disables every night a guest will be in the property — not just the
    // check-in night. The checkout day itself is free (the next guest may
    // check in on it). Same-day service bookings have end_date =
    // scheduled_date so they expand to a single date.
    if (roomTypeId) {
      return dbQuery<{ date: string }>(
        `WITH nights AS (
           SELECT TO_CHAR(d::date, 'YYYY-MM-DD') AS date, rt.quantity,
                  COALESCE(b.room_count, 1) AS rooms
           FROM bookings b
           JOIN listing_room_types rt ON rt.id = b.room_type_id
           CROSS JOIN LATERAL generate_series(
             b.scheduled_date,
             GREATEST(b.scheduled_date, b.end_date - INTERVAL '1 day')::date,
             INTERVAL '1 day'
           ) AS d
           WHERE b.listing_id = $1
             AND b.room_type_id = $2
             AND b.status IN ('pending', 'confirmed', 'in_progress')
             AND b.end_date >= CURRENT_DATE
         )
         SELECT date FROM nights
         WHERE date >= TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD')
         GROUP BY date, quantity
         HAVING SUM(rooms) >= quantity`,
        [listingId, roomTypeId],
      );
    }
    return dbQuery<{ date: string }>(
      `WITH room_count AS (
         SELECT COUNT(*) AS n FROM listing_room_types WHERE listing_id = $1
       ),
       nights AS (
         SELECT b.id, b.room_type_id, TO_CHAR(d::date, 'YYYY-MM-DD') AS date,
                COALESCE(b.room_count, 1) AS rooms
         FROM bookings b
         CROSS JOIN LATERAL generate_series(
           b.scheduled_date,
           GREATEST(b.scheduled_date, b.end_date - INTERVAL '1 day')::date,
           INTERVAL '1 day'
         ) AS d
         WHERE b.listing_id = $1
           AND b.status IN ('pending', 'confirmed', 'in_progress')
           AND b.end_date >= CURRENT_DATE
       )
       SELECT date FROM nights
       WHERE date >= TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD')
       GROUP BY date
       HAVING (
         -- No room types defined → any active booking blocks the date.
         (SELECT n FROM room_count) = 0
         OR
         -- All room-types are fully booked for this night.
         NOT EXISTS (
           SELECT 1 FROM listing_room_types rt2
           WHERE rt2.listing_id = $1
             AND COALESCE((
               SELECT SUM(n2.rooms) FROM nights n2
               WHERE n2.room_type_id = rt2.id
                 AND n2.date = nights.date
             ), 0) < rt2.quantity
         )
       )`,
      [listingId],
    );
  }

  /**
   * Remaining rooms of `roomTypeId` available across the requested date range
   * [from, to). Used by the customer booking modal to cap the "How many
   * rooms?" stepper so the user can't pick more than what's actually free
   * before they submit — turning the backend's createHold conflict error
   * into an upfront cap.
   *
   * `remaining` is the MIN across every night in the range: a date with 4 of
   * 5 rooms taken caps the whole range at 1, even if other nights are fully
   * free. Same-day requests (to <= from) collapse to a single date.
   *
   * Pending holds whose `hold_expires_at` has passed are ignored (matches
   * the conflict-check rules).
   */
  getRoomTypeAvailability(listingId: string, roomTypeId: string, from: string, to: string) {
    return dbQuery<{ quantity: number; remaining: number }>(
      `WITH rt AS (
         SELECT quantity FROM listing_room_types
          WHERE id = $2 AND listing_id = $1
          LIMIT 1
       ),
       date_range AS (
         SELECT d::date AS date
         FROM generate_series(
           $3::date,
           GREATEST($3::date, ($4::date - INTERVAL '1 day')::date),
           INTERVAL '1 day'
         ) AS d
       ),
       taken_per_date AS (
         SELECT d.date, COALESCE(SUM(b.room_count), 0)::int AS taken
         FROM date_range d
         LEFT JOIN bookings b
           ON b.listing_id = $1
          AND b.room_type_id = $2
          AND b.status IN ('pending', 'confirmed', 'in_progress')
          AND (b.status != 'pending' OR b.hold_expires_at IS NULL OR b.hold_expires_at > NOW())
          AND b.scheduled_date <= d.date
          -- EXCLUSIVE end floored at next day: a same-day room booking stores
          -- end_date = scheduled_date, so a plain COALESCE would drop it from
          -- the per-date occupancy count and over-report availability.
          AND GREATEST(COALESCE(b.end_date, b.scheduled_date), (b.scheduled_date + INTERVAL '1 day')::date) > d.date
         GROUP BY d.date
       )
       SELECT rt.quantity::int AS quantity,
              GREATEST(0, rt.quantity - COALESCE(MAX(t.taken), 0))::int AS remaining
       FROM rt
       LEFT JOIN taken_per_date t ON true
       GROUP BY rt.quantity`,
      [listingId, roomTypeId, from, to],
    );
  }

  /**
   * Read-only fetch of active transport bookings (driver-*) for a listing's
   * provider, scoped to a date window. Powers the booking-modal "this day is
   * already booked from X to Y" UI on the customer side and the driver
   * dashboard schedule view.
   *
   * Bookings are joined to the listing via `provider_id` (not `listing_id`):
   * a driver may have several listings (cab + auto), but the underlying
   * vehicle/driver can only be at one place at a time, so availability is a
   * provider-level concept. Same scoping as `findConflictingBookingsForUpdate`.
   *
   * Holds with `hold_expires_at` in the past are filtered out so a
   * dead-but-not-swept hold doesn't falsely block the calendar.
   */
  /** Mirror of `listTransportBookingsForProvider` for service listings.
   *  Same provider/listing OR-match, same active-status filter, same DATE
   *  bounds. Service categories are anything NOT starting with "driver-",
   *  but we look at booking rows whose listing/provider matches — that's
   *  enough to guarantee we're scoped to this service. */
  listServiceBookingsForProvider(providerId: string | null, listingId: string | null, from: string, to: string) {
    return dbQuery<{
      id: string;
      scheduled_date: string;
      start_time: string;
      end_time: string;
      service_category: string;
      status: string;
    }>(
      // Scope to listing_id ONLY (not provider). A single provider can own
      // multiple independent service listings (e.g. two stylists at the same
      // spa, or distinct cabin rooms) — booking one of them should NOT block
      // the others on the calendar. We previously OR'd in provider_id to
      // bridge to legacy rows missing listing_id, but that caused false
      // cross-blocks across the provider's services. The `providerId`
      // parameter is kept in the signature for call-site stability; it's
      // intentionally unused below. Conflict-check at hold time mirrors
      // this listing-scoped rule — see findConflictingBookingsForUpdate.
      // Params re-ordered: listingId is now $1 (was $2). providerId is
      // dropped from the array entirely because pg refuses to bind a $N
      // parameter that the SQL never references ("could not determine data
      // type of parameter $N"). The function signature still accepts it
      // for call-site stability — it's intentionally ignored.
      //
      // generate_series expansion: multi-day rentals (end_date > scheduled_date)
      // are stored as ONE row, but the customer's date picker needs to grey
      // out EVERY day the vehicle is held — not just the start. Expand each
      // row into one (id, day) tuple per day in [scheduled_date, end_date).
      // Same-day rows (end_date null or = scheduled_date) collapse to a
      // single output row, matching the previous behavior exactly. The
      // [from, to] clip applies after expansion so we only emit days in
      // the requested window. Service bookings have end_date=null today,
      // so the expansion is a no-op there; this stays correct if/when
      // multi-day services land.
      `WITH expanded AS (
         SELECT
           id,
           gs::date AS scheduled_date,
           start_time,
           end_time,
           service_category,
           status
         FROM bookings
         CROSS JOIN LATERAL generate_series(
           scheduled_date,
           -- GREATEST guards against the same-day case: hourly/package/single-
           -- day rentals set end_date = scheduled_date, so end_date - 1 day
           -- lands BEFORE scheduled_date and generate_series(start, stop)
           -- with stop < start returns ZERO rows — silently dropping every
           -- same-day hourly + package booking from the customer modal AND
           -- the host schedule view. Clamping the upper bound back to
           -- scheduled_date collapses same-day rows to one day, while
           -- multi-day rentals (end_date > scheduled_date, exclusive end)
           -- still expand correctly to end_date - 1 day.
           GREATEST(scheduled_date, COALESCE(end_date - INTERVAL '1 day', scheduled_date)::date),
           INTERVAL '1 day'
         ) AS gs
         WHERE listing_id = $1::uuid
           AND status IN ('pending', 'confirmed', 'in_progress')
           AND (status != 'pending' OR hold_expires_at IS NULL OR hold_expires_at > NOW())
       )
       SELECT id, scheduled_date, start_time, end_time, service_category, status
       FROM expanded
       WHERE scheduled_date >= $2::date
         AND scheduled_date <= $3::date
       ORDER BY scheduled_date, start_time`,
      [listingId, from, to],
    );
  }

  listTransportBookingsForProvider(providerId: string | null, listingId: string | null, from: string, to: string) {
    // Match by either provider_id OR listing_id — same belt-and-suspenders
    // approach the smart-schedule occupancy query uses. The driver's
    // schedule dialog was missing bookings whose row had a listing_id but
    // no resolved provider_id (e.g. ones the customer modal created
    // straight against the listing). Either branch is sufficient to
    // identify a real conflict for this vehicle.
    return dbQuery<{
      id: string;
      scheduled_date: string;
      start_time: string;
      end_time: string;
      service_category: string;
      status: string;
    }>(
      // Scope to listing_id ONLY (not provider). Each vehicle is an
      // independent asset — a provider can own a Range Rover AND an Alto
      // K10, and booking one of them should NOT grey out the other on the
      // calendar. We previously OR'd in provider_id to bridge legacy rows
      // missing listing_id, but that caused false cross-blocks across the
      // provider's other cars (and even their service listings). The
      // `providerId` parameter is kept in the signature for call-site
      // stability; it's intentionally unused below. Conflict-check at hold
      // time mirrors this listing-scoped rule — see
      // findConflictingBookingsForUpdate.
      // Params re-ordered: listingId is now $1 (was $2). providerId is
      // dropped from the array entirely because pg refuses to bind a $N
      // parameter that the SQL never references ("could not determine data
      // type of parameter $N"). The function signature still accepts it
      // for call-site stability — it's intentionally ignored.
      //
      // generate_series expansion: multi-day rentals (end_date > scheduled_date)
      // are stored as ONE row, but the customer's date picker needs to grey
      // out EVERY day the vehicle is held — not just the start. Expand each
      // row into one (id, day) tuple per day in [scheduled_date, end_date).
      // Same-day rows (end_date null or = scheduled_date) collapse to a
      // single output row, matching the previous behavior exactly. The
      // [from, to] clip applies after expansion so we only emit days in
      // the requested window. Service bookings have end_date=null today,
      // so the expansion is a no-op there; this stays correct if/when
      // multi-day services land.
      `WITH expanded AS (
         SELECT
           id,
           gs::date AS scheduled_date,
           start_time,
           end_time,
           service_category,
           status
         FROM bookings
         CROSS JOIN LATERAL generate_series(
           scheduled_date,
           -- GREATEST guards against the same-day case: hourly/package/single-
           -- day rentals set end_date = scheduled_date, so end_date - 1 day
           -- lands BEFORE scheduled_date and generate_series(start, stop)
           -- with stop < start returns ZERO rows — silently dropping every
           -- same-day hourly + package booking from the customer modal AND
           -- the host schedule view. Clamping the upper bound back to
           -- scheduled_date collapses same-day rows to one day, while
           -- multi-day rentals (end_date > scheduled_date, exclusive end)
           -- still expand correctly to end_date - 1 day.
           GREATEST(scheduled_date, COALESCE(end_date - INTERVAL '1 day', scheduled_date)::date),
           INTERVAL '1 day'
         ) AS gs
         WHERE listing_id = $1::uuid
           AND status IN ('pending', 'confirmed', 'in_progress')
           AND (status != 'pending' OR hold_expires_at IS NULL OR hold_expires_at > NOW())
       )
       SELECT id, scheduled_date, start_time, end_time, service_category, status
       FROM expanded
       WHERE scheduled_date >= $2::date
         AND scheduled_date <= $3::date
       ORDER BY scheduled_date, start_time`,
      [listingId, from, to],
    );
  }

  /**
   * Serializes hold-create transactions for a (provider, date) pair using a
   * Postgres transaction-scoped advisory lock. The lock auto-releases on
   * commit/rollback.
   *
   * Why this is needed: `findConflictingBookingsForUpdate` uses `FOR UPDATE`,
   * which locks rows it READS but doesn't prevent CONCURRENT INSERTS of new
   * overlapping rows (the classic phantom-read problem). Two simultaneous
   * holds for non-equal but overlapping windows on the same provider+date —
   * say 09:00–11:00 and 10:00–12:00 — would each see "no conflict" because
   * neither row exists yet, then both insert.
   *
   * The Redis lock at `bookings.service.ts` is keyed on
   * `provider:date:start_time` so it doesn't catch this either — different
   * start times → different keys → both pass.
   *
   * `pg_advisory_xact_lock` over `hashtextextended(provider || date)` is the
   * right primitive: any concurrent hold-create txn for the same calendar day
   * blocks here until the first commits, at which point its inserted booking
   * is visible to the subsequent `findConflictingBookingsForUpdate` and the
   * overlap is correctly rejected.
   */
  acquireProviderDateAdvisoryLock(client: pg.PoolClient, providerId: string, scheduledDate: string) {
    return client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2::text, 0))`,
      [providerId, scheduledDate],
    );
  }

  findConflictingBookings(providerId: string, scheduledDate: string, endTime: string, startTime: string, client?: pg.PoolClient) {
    return runDbQuery(
      client ?? null,
      `SELECT id FROM bookings
       WHERE provider_id = $1
         AND scheduled_date = $2
         AND start_time < $3 AND end_time > $4
         AND status IN ('pending', 'confirmed', 'in_progress')`,
      [providerId, scheduledDate, endTime, startTime]
    );
  }

  /**
   * Conflict check at hold time. The "what counts as a conflict" rule depends
   * on whether a specific room is being booked:
   *
   *   - roomTypeId given (hotel-style): only count bookings on the SAME room
   *     and only flag when that room is at full quantity. Other rooms on the
   *     same provider+date stay free.
   *
   *   - roomTypeId omitted: legacy single-listing behaviour — any active
   *     booking on the same (provider, date, overlapping time) is a conflict.
   */
  findConflictingBookingsForUpdate(
    client: pg.PoolClient,
    providerId: string,
    scheduledDate: string,
    endTime: string,
    startTime: string,
    roomTypeId?: string | null,
    endDate?: string | null,
    listingId?: string | null,
    requestedRoomCount?: number | null,
  ) {
    // Two regimes:
    //   - Multi-night stay (endDate > scheduledDate): the booking spans
    //     nights [scheduledDate, endDate). A conflict is any active booking
    //     whose range overlaps — i.e. its scheduled_date < our endDate AND
    //     its end_date > our scheduledDate. start_time / end_time are not
    //     consulted here: two stays on the same room overlap on calendar
    //     dates regardless of advertised check-in/out times.
    //   - Same-day (endDate omitted or equal to scheduledDate): the legacy
    //     time-slot overlap rule. Used by service + transport bookings.
    const isMultiNight = !!endDate && endDate > scheduledDate;
    // Multi-room bookings (e.g. 3 "Non-AC" rooms in one shot) reserve their
    // full share of inventory. The conflict check sums already-reserved
    // rooms over the overlap window and rejects when the new booking would
    // push the total above the room type's `quantity`. Legacy single-room
    // bookings pass through unchanged (default 1).
    const newRooms = Math.max(1, Math.round(Number(requestedRoomCount) || 1));

    if (roomTypeId) {
      if (isMultiNight) {
        return client.query(
          `WITH active AS (
             SELECT b.id, rt.quantity, COALESCE(b.room_count, 1) AS rooms
             FROM bookings b
             JOIN listing_room_types rt ON rt.id = b.room_type_id
             WHERE b.provider_id = $1
               AND b.scheduled_date < $2::date
               AND b.end_date       > $3::date
               AND b.status IN ('pending', 'confirmed', 'in_progress')
               AND (b.status != 'pending' OR b.hold_expires_at IS NULL OR b.hold_expires_at > NOW())
               AND b.room_type_id = $4
             FOR UPDATE
           )
           SELECT id FROM active
           WHERE (SELECT COALESCE(SUM(rooms), 0) FROM active) + $5::int
                 > (SELECT MAX(quantity) FROM active)`,
          [providerId, endDate, scheduledDate, roomTypeId, newRooms],
        );
      }
      return client.query(
        `WITH active AS (
           SELECT b.id, rt.quantity, COALESCE(b.room_count, 1) AS rooms
           FROM bookings b
           JOIN listing_room_types rt ON rt.id = b.room_type_id
           WHERE b.provider_id = $1
             AND b.scheduled_date = $2
             AND b.start_time < $3
             AND b.end_time > $4
             AND b.status IN ('pending', 'confirmed', 'in_progress')
             AND (b.status != 'pending' OR b.hold_expires_at IS NULL OR b.hold_expires_at > NOW())
             AND b.room_type_id = $5
           FOR UPDATE
         )
         SELECT id FROM active
         WHERE (SELECT COALESCE(SUM(rooms), 0) FROM active) + $6::int
               > (SELECT MAX(quantity) FROM active)`,
        [providerId, scheduledDate, endTime, startTime, roomTypeId, newRooms],
      );
    }

    // Non-roomType branches scope by LISTING, not provider. A provider can
    // own multiple independent assets (two cars, two stylists) — booking
    // one must NOT 409 a hold for another. listingId is preferred; if a
    // legacy caller still passes null we fall back to the old provider
    // scope so behavior degrades safely rather than silently allowing
    // genuine double-bookings on the same asset.
    const scopeCol = listingId ? 'listing_id' : 'provider_id';
    const scopeVal = listingId ?? providerId;

    if (isMultiNight) {
      return client.query(
        // We compare against each row's EXCLUSIVE end date — the first
        // calendar day it no longer occupies. Single-day bookings (hourly
        // transport, services, same-day day rentals) DO NOT store end_date
        // IS NULL: createHold writes end_date = scheduled_date for them (see
        // the INSERT below). So a plain COALESCE(end_date, scheduled_date + 1)
        // is wrong — it returns scheduled_date for those rows, making them
        // invisible (scheduled_date is never > scheduled_date) and silently
        // double-bookable. GREATEST(..., scheduled_date + 1 day) floors the
        // exclusive end at "next day" so a single-day row on May 28 occupies
        // [May 28, May 29) and correctly overlaps a May 27–29 rental, while a
        // genuine multi-day rental (end_date > scheduled_date) keeps its real
        // exclusive end.
        `SELECT id
         FROM bookings
         WHERE ${scopeCol} = $1
           AND scheduled_date < $2::date
           AND GREATEST(COALESCE(end_date, scheduled_date), (scheduled_date + INTERVAL '1 day')::date) > $3::date
           AND status IN ('pending', 'confirmed', 'in_progress')
           AND (status != 'pending' OR hold_expires_at IS NULL OR hold_expires_at > NOW())
         FOR UPDATE`,
        [scopeVal, endDate, scheduledDate],
      );
    }
    return client.query(
      // Same-day conflict check for single-day bookings (hourly transport,
      // services, package). The date-window guard uses the same EXCLUSIVE-end
      // expression as the multi-night branch so EVERY row that occupies
      // calendar day $2 is visible — including single-day rows, which store
      // end_date = scheduled_date (NOT NULL). The old COALESCE(end_date,
      // scheduled_date + 1) returned scheduled_date for those rows, so
      // `> $2` was `scheduled_date > scheduled_date` = false and they were
      // filtered out BEFORE the time-overlap OR clause ran — making this
      // entire branch a no-op for same-day overlaps (a confirmed day rental
      // 09:00–17:00 didn't block a 14:00–17:00 hourly on the same listing).
      //
      // OR clause:
      //   - If the OTHER row is multi-day (end_date > scheduled_date),
      //     it occupies the whole calendar day on $2, so any time-of-day
      //     conflicts.
      //   - If the OTHER row is single-day (end_date null or = scheduled_date),
      //     only the actual start/end overlap matters — same as before.
      `SELECT id
       FROM bookings
       WHERE ${scopeCol} = $1
         AND scheduled_date <= $2::date
         AND GREATEST(COALESCE(end_date, scheduled_date), (scheduled_date + INTERVAL '1 day')::date) > $2::date
         AND status IN ('pending', 'confirmed', 'in_progress')
         AND (status != 'pending' OR hold_expires_at IS NULL OR hold_expires_at > NOW())
         AND (
           (end_date IS NOT NULL AND end_date > scheduled_date)
           OR (start_time < $3 AND end_time > $4)
         )
       FOR UPDATE`,
      [scopeVal, scheduledDate, endTime, startTime]
    );
  }

  findActiveSlotLocks(providerId: string, scheduledDate: string, endTime: string, startTime: string, userId: string, client?: pg.PoolClient) {
    return runDbQuery(
      client ?? null,
      `SELECT id FROM slot_locks
       WHERE provider_id = $1
         AND scheduled_date = $2
         AND start_time < $3 AND end_time > $4
         AND locked_by != $5
         AND status = 'active'
         AND expires_at > NOW()`,
      [providerId, scheduledDate, endTime, startTime, userId]
    );
  }

  findActiveSlotLocksForUpdate(client: pg.PoolClient, providerId: string, scheduledDate: string, endTime: string, startTime: string, userId: string) {
    return client.query(
      `SELECT id
       FROM slot_locks
       WHERE provider_id = $1
         AND scheduled_date = $2
         AND start_time < $3
         AND end_time > $4
         AND locked_by != $5
         AND status = 'active'
         AND expires_at > NOW()
       FOR UPDATE`,
      [providerId, scheduledDate, endTime, startTime, userId]
    );
  }

  expireStaleLocksForUser(userId: string, providerId: string, client?: pg.PoolClient) {
    return runDbQuery(
      client ?? null,
      `UPDATE slot_locks
       SET status = 'expired', released_at = NOW()
       WHERE locked_by = $1 AND provider_id = $2 AND status = 'active' AND expires_at <= NOW()
       RETURNING id`,
      [userId, providerId]
    );
  }

  expireStaleBookingsForUser(userId: string, providerId: string, client?: pg.PoolClient) {
    return runDbQuery(
      client ?? null,
      `UPDATE bookings
       SET status = 'expired', expired_at = NOW(), updated_at = NOW()
       WHERE user_id = $1 AND provider_id = $2 AND status = 'pending' AND hold_expires_at <= NOW()
       RETURNING id`,
      [userId, providerId]
    );
  }

  findActiveLockForUserProvider(userId: string, providerId: string, client?: pg.PoolClient) {
    return runDbQuery(
      client ?? null,
      `SELECT id, booking_id FROM slot_locks
       WHERE locked_by = $1 AND provider_id = $2 AND status = 'active' AND expires_at > NOW()
       LIMIT 1`,
      [userId, providerId]
    );
  }

  async createPendingBookingHold(
    client: pg.PoolClient,
    params: {
      providerId: string;
      scheduledDate: string;
      endDate?: string | null;
      startTime: string;
      endTime: string;
      userId: string;
      serviceCategory: string;
      address?: string;
      lat?: number;
      lng?: number;
      notes?: string;
      idempotencyKey?: string;
      holdMinutes?: number;
      agreedPricePaise?: number;
      listingId?: string;
      couponId?: string | null;
      roomTypeId?: string | null;
      roomCount?: number | null;
      guestNameSnapshot?: string | null;
      guestCount?: number | null;
      roomTypeNameSnapshot?: string | null;
      /** Transport receipt snapshots — the booked vehicle's model / plate /
       *  colour and the driver's phone, frozen at hold time so My Bookings,
       *  the confirmation screen, and the invoice stay correct even if the
       *  host later edits or deletes the listing. Null for non-transport. */
      vehicleModelSnapshot?: string | null;
      vehiclePlateSnapshot?: string | null;
      vehicleColorSnapshot?: string | null;
      driverPhoneSnapshot?: string | null;
      /** Forward fee/GST/discount breakdown computed at hold time. Copied
       *  byte-for-byte to the payment row at createOrder, so the invoice
       *  + email always show exactly what was charged — no inverse math. */
      subtotalPaise?: number | null;
      platformFeePaise?: number | null;
      taxesPaise?: number | null;
      discountPaise?: number | null;
      /** fee_rules.id that produced platformFeePaise; null = legacy flat fee. */
      feeRuleId?: string | null;
      /** Business-audience fee_rules.id + commission (paise) on the
       *  discounted subtotal — the payout-side snapshot. Both null when
       *  resolution fell back (earnings treat null commission as 0). */
      commissionRuleId?: string | null;
      commissionPaise?: number | null;
      /** Host-books-on-behalf: flags the hold + records the creating host and
       *  the paying guest's contact. Absent for ordinary self-service holds. */
      bookedOnBehalf?: boolean;
      createdByUserId?: string | null;
      guestContact?: { name?: string | null; phone: string; email?: string | null } | null;
    }
  ) {
    const holdMinutes = params.holdMinutes ?? 5;
    const bookingResult = await client.query(
      `INSERT INTO bookings (
         user_id, provider_id, service_category, scheduled_date, end_date, start_time, end_time,
         address, lat, lng, notes, status, hold_expires_at, idempotency_key,
         agreed_price_paise, listing_id, coupon_id, room_type_id,
         guest_name_snapshot, guest_count, room_type_name_snapshot,
         subtotal_paise, platform_fee_paise, taxes_paise, discount_paise,
         room_count,
         vehicle_model_snapshot, vehicle_plate_snapshot, vehicle_color_snapshot, driver_phone_snapshot,
         booked_on_behalf, created_by_user_id, guest_contact, fee_rule_id,
         commission_rule_id, commission_paise
       )
       VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', NOW() + ($12 || ' minutes')::interval, $13, $14, $15, $16, $17,
         $18, $19, $20, $21, $22, $23, $24, $25,
         $26, $27, $28, $29,
         $30, $31, $32, $33,
         $34, $35
       )
       RETURNING *`,
      [
        params.userId,
        params.providerId,
        params.serviceCategory,
        params.scheduledDate,
        // Same-day bookings (service/transport) default to scheduled_date.
        params.endDate && params.endDate > params.scheduledDate ? params.endDate : params.scheduledDate,
        params.startTime,
        params.endTime,
        params.address,
        params.lat,
        params.lng,
        params.notes,
        String(holdMinutes),
        params.idempotencyKey ?? null,
        params.agreedPricePaise ?? null,
        params.listingId ?? null,
        params.couponId ?? null,
        params.roomTypeId ?? null,
        params.guestNameSnapshot ?? null,
        params.guestCount ?? null,
        params.roomTypeNameSnapshot ?? null,
        params.subtotalPaise ?? null,
        params.platformFeePaise ?? null,
        params.taxesPaise ?? null,
        params.discountPaise ?? null,
        Math.max(1, Math.round(Number(params.roomCount) || 1)),
        params.vehicleModelSnapshot ?? null,
        params.vehiclePlateSnapshot ?? null,
        params.vehicleColorSnapshot ?? null,
        params.driverPhoneSnapshot ?? null,
        params.bookedOnBehalf ?? false,
        params.createdByUserId ?? null,
        params.guestContact ? JSON.stringify(params.guestContact) : null,
        params.feeRuleId ?? null,
        params.commissionRuleId ?? null,
        params.commissionPaise ?? null,
      ]
    );

    const booking = bookingResult.rows[0];

    // On-behalf holds skip the slot_locks row entirely. The DB enforces ONE
    // active lock per (locked_by, provider) — idx_slot_locks_active_user_
    // provider_unique — which is the same per-guest guard the on-behalf path
    // deliberately bypasses (a host/linked guest may hold several unpaid
    // payment-link bookings against one provider at once; a provider's
    // listings all share one profile, so even a stay + a salon collide).
    // The 24h PENDING booking row inserted above is the real conflict
    // authority (findConflictingBookingsForUpdate reads bookings, not locks),
    // so skipping the lock loses nothing. Downstream shape is preserved with
    // a synthetic lock keyed by the booking itself.
    if (params.bookedOnBehalf) {
      return {
        booking,
        lock: { id: booking.id, expires_at: booking.hold_expires_at },
      };
    }

    const lockResult = await client.query(
      `INSERT INTO slot_locks (
         provider_id, scheduled_date, start_time, end_time, locked_by, expires_at, status, booking_id
       )
       VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' minutes')::interval, 'active', $7)
       RETURNING *`,
      [params.providerId, params.scheduledDate, params.startTime, params.endTime, params.userId, String(holdMinutes), booking.id]
    );

    return {
      booking,
      lock: lockResult.rows[0],
    };
  }

  setPaymentLink(bookingId: string, linkId: string, linkUrl: string, client?: pg.PoolClient) {
    return runDbQuery(
      client ?? null,
      `UPDATE bookings
         SET payment_link_id = $2, payment_link_url = $3, updated_at = NOW()
       WHERE id = $1
       RETURNING id`,
      [bookingId, linkId, linkUrl],
    );
  }

  updateStatus(bookingId: string, status: BookingStatus, client?: pg.PoolClient, cancellationReason?: string) {
    // cancellation_reason is only ever written on the cancel transition; other
    // transitions leave whatever is already there (a re-cancel can't happen —
    // the service's transition matrix blocks cancelled → cancelled).
    return runDbQuery(
      client ?? null,
      `UPDATE bookings
       SET status = $1::text::public.booking_status,
           updated_at = NOW(),
           cancelled_at = CASE WHEN $1 = 'cancelled' THEN NOW() ELSE cancelled_at END,
           cancellation_reason = CASE WHEN $1 = 'cancelled' THEN COALESCE($3, cancellation_reason) ELSE cancellation_reason END,
           expired_at = CASE WHEN $1 = 'expired' THEN NOW() ELSE expired_at END
       WHERE id = $2
       RETURNING *`,
      [status, bookingId, cancellationReason ?? null]
    );
  }

  confirmBooking(client: pg.PoolClient, bookingId: string) {
    return client.query(
      `UPDATE bookings
       SET status = 'confirmed', hold_expires_at = NULL, updated_at = NOW()
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [bookingId]
    );
  }

  expireBooking(client: pg.PoolClient, bookingId: string) {
    return client.query(
      `UPDATE bookings
       SET status = 'expired', expired_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
      [bookingId]
    );
  }

  releaseHoldByBookingId(bookingId: string, userId: string, client?: pg.PoolClient) {
    return runDbQuery(
      client ?? null,
      `UPDATE slot_locks
       SET status = 'released', released_at = NOW()
       WHERE booking_id = $1 AND locked_by = $2 AND status = 'active'
       RETURNING *`,
      [bookingId, userId]
    );
  }

  deleteSlotLock(providerId: string, scheduledDate: string, startTime: string, client?: pg.PoolClient) {
    return runDbQuery(
      client ?? null,
      `UPDATE slot_locks
       SET status = 'released', released_at = NOW()
       WHERE provider_id = $1 AND scheduled_date = $2 AND start_time = $3 AND status = 'active'`,
      [providerId, scheduledDate, startTime]
    );
  }

  getCompletedPaymentSummary(bookingId: string, client?: pg.PoolClient) {
    return runDbQuery(
      client ?? null,
      // Include the fee breakdown columns so the cancel path can compute
      // partial refunds without a second round-trip.
      `SELECT id, status, provider_ref, provider_payment_id, amount_paise, currency,
              subtotal_paise, platform_fee_paise, taxes_paise, insurance_premium_paise, discount_paise
       FROM payments
       WHERE booking_id = $1 AND status = 'completed'
       ORDER BY updated_at DESC
       LIMIT 1`,
      [bookingId]
    );
  }

  /** Cancellation policy + scheduled-start data for a booking — used by the
   *  cancel-preview and the actual cancel flow. Falls back to 'flexible' when
   *  the booking has no listing (service bookings). */
  getCancellationContext(bookingId: string, client?: pg.PoolClient) {
    return runDbQuery<{
      id: string;
      user_id: string;
      status: string;
      scheduled_date: string | null;
      start_time: string | null;
      cancellation_policy: 'flexible' | 'moderate' | 'strict';
    }>(
      client ?? null,
      `SELECT b.id, b.user_id, b.status, b.scheduled_date, b.start_time,
              COALESCE(l.cancellation_policy, 'flexible') AS cancellation_policy
       FROM bookings b
       LEFT JOIN listings l ON l.id = b.listing_id
       WHERE b.id = $1
       LIMIT 1`,
      [bookingId],
    );
  }

  cleanupExpiredHolds(client: pg.PoolClient) {
    return client.query(`SELECT public.cleanup_expired_booking_holds() AS cleaned`);
  }
}

export const bookingsRepository = new BookingsRepository();
