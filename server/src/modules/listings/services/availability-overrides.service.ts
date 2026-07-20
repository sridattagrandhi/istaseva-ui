import { ForbiddenError, NotFoundError, ValidationError } from '../../../common/errors/app-error.js';
import { availabilityOverridesRepository } from '../repositories/availability-overrides.repository.js';
import { listingsRepository } from '../repositories/listings.repository.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

async function assertListingOwner(listingId: string, userId: string) {
  const result = await listingsRepository.getById(listingId);
  const row = result.rows[0];
  if (!row) throw new NotFoundError('Listing', listingId);
  if (row.user_id !== userId) {
    throw new ForbiddenError('Not authorized to modify this listing');
  }
  return row;
}

interface OverrideInput {
  date: string;
  blocked?: boolean;
  pricePaise?: number | null;
  roomTypeId?: string | null;
}

export class AvailabilityOverridesService {
  /** Public read — anyone can see what's blocked / specially priced. */
  async listForListing(listingId: string, from: string, to: string) {
    if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
      throw new ValidationError('from/to must be YYYY-MM-DD');
    }
    const result = await availabilityOverridesRepository.listForListing(listingId, from, to);
    return {
      data: result.rows.map((r) => ({
        listing_id: r.listing_id,
        room_type_id: r.room_type_id,
        // Defensive normalization: even if pg's typecast changes some day,
        // the wire format MUST stay "YYYY-MM-DD" so the frontend's per-date
        // lookups work. `Date` objects round-trip via ISO; strings get
        // sliced; anything else falls back to String().
        date: (r.date as unknown) instanceof Date
          ? (r.date as unknown as Date).toISOString().slice(0, 10)
          : typeof r.date === 'string'
            ? r.date.slice(0, 10)
            : String(r.date).slice(0, 10),
        blocked: r.blocked,
        price_paise: r.price_paise == null ? null : Number(r.price_paise),
      })),
    };
  }

  /**
   * Bulk upsert from the host calendar. Each entry that has `blocked=false`
   * AND `pricePaise == null` is treated as "clear" — the row is deleted so
   * the date returns to listing defaults. Anything else is upserted.
   */
  async bulkSet(listingId: string, userId: string, entries: OverrideInput[]) {
    await assertListingOwner(listingId, userId);
    if (!Array.isArray(entries)) throw new ValidationError('entries must be an array');

    const results = [];
    for (const entry of entries) {
      if (!ISO_DATE.test(entry.date)) {
        throw new ValidationError(`Invalid date: ${entry.date}`);
      }
      const blocked = Boolean(entry.blocked);
      const pricePaise = entry.pricePaise == null ? null : Math.round(Number(entry.pricePaise));
      if (pricePaise !== null && (!Number.isFinite(pricePaise) || pricePaise < 0)) {
        throw new ValidationError(`Invalid pricePaise for ${entry.date}`);
      }
      const roomTypeId = entry.roomTypeId ?? null;

      if (!blocked && pricePaise === null) {
        // Default state — drop the row.
        await availabilityOverridesRepository.delete(listingId, roomTypeId, entry.date);
        results.push({ date: entry.date, room_type_id: roomTypeId, cleared: true });
        continue;
      }
      const upserted = await availabilityOverridesRepository.upsert({
        listingId,
        roomTypeId,
        date: entry.date,
        blocked,
        pricePaise,
      });
      results.push(upserted.rows[0]);
    }
    return { data: results };
  }
}

export const availabilityOverridesService = new AvailabilityOverridesService();
