import { dbQuery } from '../../../common/repositories/database.js';

export interface AvailabilityOverrideRow {
  listing_id: string;
  room_type_id: string | null;
  date: string;
  blocked: boolean;
  price_paise: string | number | null;
  created_at: string;
  updated_at: string;
}

export class AvailabilityOverridesRepository {
  /** All overrides for a listing within an inclusive date range.
   *  The `date` column is cast to text so it always serializes as a
   *  10-char "YYYY-MM-DD" — node-postgres otherwise returns it as a JS
   *  `Date` object which JSON-serializes to a full ISO timestamp. That
   *  broke per-date lookups on the frontend (priceByDate.get("2026-05-28")
   *  missed rows keyed "2026-05-28T00:00:00.000Z") and was the silent
   *  cause of guest-side custom prices and blocks not rendering. */
  listForListing(listingId: string, from: string, to: string) {
    return dbQuery<AvailabilityOverrideRow>(
      `SELECT listing_id, room_type_id, date::text AS date, blocked, price_paise, created_at, updated_at
       FROM listing_availability_overrides
       WHERE listing_id = $1 AND date >= $2 AND date <= $3
       ORDER BY date ASC`,
      [listingId, from, to],
    );
  }

  /**
   * Listing-level whole-day blocks (room_type_id IS NULL, blocked = true) for a
   * set of listings on ONE date. Used by smart-schedule to drop a listing whose
   * provider blocked that day via the Schedule UI — the per-listing override
   * table is the source of truth the booking modal reads and createHold
   * enforces, so the slot finder must honour it too. Returns one row per
   * blocked listing_id.
   */
  listListingLevelBlocksForDate(listingIds: string[], date: string) {
    return dbQuery<{ listing_id: string }>(
      `SELECT DISTINCT listing_id
       FROM listing_availability_overrides
       WHERE listing_id = ANY($1) AND date = $2
         AND room_type_id IS NULL AND blocked = true`,
      [listingIds, date],
    );
  }

  /**
   * Upsert one override row. NULL room_type_id is the listing-level row;
   * that's why we have two partial unique indexes — one ON CONFLICT clause
   * per index, since a single ON CONFLICT can't mention both.
   */
  async upsert(row: {
    listingId: string;
    roomTypeId: string | null;
    date: string;
    blocked: boolean;
    pricePaise: number | null;
  }) {
    if (row.roomTypeId) {
      return dbQuery<AvailabilityOverrideRow>(
        `INSERT INTO listing_availability_overrides
           (listing_id, room_type_id, date, blocked, price_paise)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (listing_id, room_type_id, date) WHERE room_type_id IS NOT NULL
         DO UPDATE SET blocked = EXCLUDED.blocked,
                       price_paise = EXCLUDED.price_paise,
                       updated_at = NOW()
         RETURNING *`,
        [row.listingId, row.roomTypeId, row.date, row.blocked, row.pricePaise],
      );
    }
    return dbQuery<AvailabilityOverrideRow>(
      `INSERT INTO listing_availability_overrides
         (listing_id, room_type_id, date, blocked, price_paise)
       VALUES ($1, NULL, $2, $3, $4)
       ON CONFLICT (listing_id, date) WHERE room_type_id IS NULL
       DO UPDATE SET blocked = EXCLUDED.blocked,
                     price_paise = EXCLUDED.price_paise,
                     updated_at = NOW()
       RETURNING *`,
      [row.listingId, row.date, row.blocked, row.pricePaise],
    );
  }

  /** Delete a specific override (host clearing back to default). */
  delete(listingId: string, roomTypeId: string | null, date: string) {
    if (roomTypeId) {
      return dbQuery(
        `DELETE FROM listing_availability_overrides
         WHERE listing_id = $1 AND room_type_id = $2 AND date = $3`,
        [listingId, roomTypeId, date],
      );
    }
    return dbQuery(
      `DELETE FROM listing_availability_overrides
       WHERE listing_id = $1 AND room_type_id IS NULL AND date = $2`,
      [listingId, date],
    );
  }
}

export const availabilityOverridesRepository = new AvailabilityOverridesRepository();
