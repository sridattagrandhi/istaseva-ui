import { dbQuery } from '../../../common/repositories/database.js';

const MUTABLE_FIELDS = new Set([
  'name',
  'description',
  'base_price_paise',
  'max_guests',
  'photos',
  'sort_order',
  'quantity',
  'bedrooms',
  'bathrooms',
  'unit_identifiers',
  // Per-room-type amenities. UNION-ed with `listings.amenities` by the
  // consumer-side stay filter so chip queries match if ANY room (or the
  // listing-level fallback) advertises the amenity.
  'amenities',
]);

export interface RoomTypeRow {
  id: string;
  listing_id: string;
  name: string;
  description: string | null;
  base_price_paise: string | number;
  max_guests: number;
  quantity: number;
  /** Bedrooms inside ONE room of this type (e.g. 1 for "Deluxe King", 2 for a suite). */
  bedrooms: number;
  /** Bathrooms inside ONE room of this type. */
  bathrooms: number;
  /** Optional room numbers/labels — ["101","102",…] or ["8a","8b","8c"]. Empty when host doesn't number rooms. */
  unit_identifiers: string[];
  /** Free-text amenity strings ("AC", "Balcony"…). Empty array when the
   *  host hasn't authored room-specific amenities — the consumer-side
   *  filter falls back to listing-level `listings.amenities` in that case. */
  amenities: string[];
  photos: string[];
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export class RoomTypesRepository {
  /** Rooms attached to a listing, in sort order. Empty array if none. */
  listForListing(listingId: string) {
    return dbQuery<RoomTypeRow>(
      `SELECT * FROM listing_room_types
       WHERE listing_id = $1
       ORDER BY sort_order ASC, created_at ASC`,
      [listingId],
    );
  }

  getById(id: string) {
    return dbQuery<RoomTypeRow>(
      `SELECT * FROM listing_room_types WHERE id = $1 LIMIT 1`,
      [id],
    );
  }

  create(listingId: string, payload: Record<string, unknown>) {
    const record = Object.fromEntries(
      Object.entries(payload).filter(([k]) => MUTABLE_FIELDS.has(k)),
    );
    const entries = Object.entries({ ...record, listing_id: listingId });
    const columns = entries.map(([k]) => `"${k}"`);
    const placeholders = entries.map((_, i) => `$${i + 1}`);
    const values = entries.map(([, v]) => v);

    return dbQuery<RoomTypeRow>(
      `INSERT INTO listing_room_types (${columns.join(', ')})
       VALUES (${placeholders.join(', ')})
       RETURNING *`,
      values,
    );
  }

  update(id: string, payload: Record<string, unknown>) {
    const entries = Object.entries(payload).filter(([k]) => MUTABLE_FIELDS.has(k));
    if (entries.length === 0) return this.getById(id);

    const assignments = entries.map(([k], i) => `"${k}" = $${i + 1}`);
    const values = entries.map(([, v]) => v);
    values.push(id);

    return dbQuery<RoomTypeRow>(
      `UPDATE listing_room_types
       SET ${assignments.join(', ')}, updated_at = NOW()
       WHERE id = $${values.length}
       RETURNING *`,
      values,
    );
  }

  delete(id: string) {
    return dbQuery(
      `DELETE FROM listing_room_types WHERE id = $1 RETURNING id`,
      [id],
    );
  }
}

export const roomTypesRepository = new RoomTypesRepository();
