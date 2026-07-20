import { ForbiddenError, ListingNotReadyError, NotFoundError, ValidationError } from '../../../common/errors/app-error.js';
import { roomTypesRepository } from '../repositories/room-types.repository.js';
import { listingsRepository } from '../repositories/listings.repository.js';
import { listingsService } from './listings.service.js';

// Sathrams sit under the `homestay` category but expose multiple cell /
// dormitory tiers, so the readiness gate treats them the same as
// hotel/lodge/heritage. Note: only `category` is checked here; for sathrams
// the guard fires when `metadata.propertyType === 'sathram'`, handled below.
const MULTI_ROOM_STAY_CATEGORIES = new Set(['hotel', 'lodge', 'heritage']);

/**
 * Run the centralized readiness validator with a prospective room set so we
 * can reject a room-type mutation that would leave an already-active
 * hotel/lodge/heritage listing in a broken state (no rooms, zero-priced
 * room, missing photo, etc.). No-op when the listing is inactive — drafts
 * are intentionally allowed to save incomplete data.
 */
async function guardActiveHotel(
  listing: Record<string, unknown>,
  prospectiveRooms: Array<{
    name: string;
    base_price_paise: string | number | null;
    max_guests: number | null;
    quantity: number | null;
    photos: string[] | null;
  }>,
) {
  if (listing.is_active !== true) return;
  const category = typeof listing.category === 'string' ? listing.category : '';
  const metadata = (listing.metadata && typeof listing.metadata === 'object'
    ? (listing.metadata as Record<string, unknown>)
    : {});
  const propertyType = typeof metadata.propertyType === 'string' ? metadata.propertyType : '';
  const isMultiRoom = MULTI_ROOM_STAY_CATEGORIES.has(category) || propertyType === 'sathram';
  if (!isMultiRoom) return;

  // We evaluate BOTH the current live state and the prospective state, then
  // only reject when the prospective edit introduces a missing-code that
  // wasn't already failing. The previous "any failure blocks" rule trapped
  // hosts whose legacy hotel had multiple rooms without photos — they
  // couldn't fix room 1's amenities until room 2 ALSO had a photo, etc.,
  // even though their edit was strictly an improvement. Treating already-
  // broken listings as a starting baseline lets the host iterate one room
  // at a time. Activation (inactive → active) still runs the strict gate
  // via `listings.service.update`, so this leniency only applies to edits
  // on a listing that was ALREADY published.
  const userId = String(listing.user_id);
  const [currentReadiness, prospectiveReadiness] = await Promise.all([
    listingsService.evaluateReadiness(listing, userId),
    listingsService.evaluateReadiness(listing, userId, prospectiveRooms),
  ]);
  if (prospectiveReadiness.ready) return;
  const currentCodes = new Set(currentReadiness.missing.map((m) => m.code));
  const newRegressions = prospectiveReadiness.missing.filter((m) => !currentCodes.has(m.code));
  if (newRegressions.length > 0) {
    throw new ListingNotReadyError(newRegressions);
  }
}

function toProspectiveRoom(input: unknown) {
  const r = (input ?? {}) as Record<string, unknown>;
  return {
    name: typeof r.name === 'string' ? r.name : '',
    base_price_paise: (r.base_price_paise as string | number | null) ?? null,
    max_guests: typeof r.max_guests === 'number' ? r.max_guests : Number(r.max_guests) || null,
    quantity: typeof r.quantity === 'number' ? r.quantity : Number(r.quantity) || null,
    photos: Array.isArray(r.photos) ? (r.photos as string[]) : null,
  };
}

/**
 * Room types belong to a listing and represent bookable rooms (hotel-style
 * stays). Mutating a listing's rooms is restricted to the listing owner —
 * we look the listing up first and check `user_id`.
 */
async function assertListingOwner(listingId: string, userId: string) {
  const result = await listingsRepository.getById(listingId);
  const row = result.rows[0];
  if (!row) throw new NotFoundError('Listing', listingId);
  if (row.user_id !== userId) {
    throw new ForbiddenError('Not authorized to modify this listing');
  }
  return row;
}

function normalizePayload(payload: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  if (payload.name !== undefined) {
    if (typeof payload.name !== 'string' || !payload.name.trim()) {
      throw new ValidationError('name is required');
    }
    out.name = payload.name.trim();
  }
  if (payload.description !== undefined) out.description = payload.description ?? null;
  if (payload.base_price_paise !== undefined) {
    const n = Number(payload.base_price_paise);
    if (!Number.isFinite(n) || n < 0) throw new ValidationError('base_price_paise must be a non-negative number');
    out.base_price_paise = Math.round(n);
  }
  if (payload.max_guests !== undefined) {
    const n = Number(payload.max_guests);
    if (!Number.isFinite(n) || n < 1) throw new ValidationError('max_guests must be at least 1');
    out.max_guests = Math.floor(n);
  }
  if (payload.quantity !== undefined) {
    const n = Number(payload.quantity);
    if (!Number.isFinite(n) || n < 1) throw new ValidationError('quantity must be at least 1');
    out.quantity = Math.floor(n);
  }
  if (payload.bedrooms !== undefined) {
    const n = Number(payload.bedrooms);
    if (!Number.isFinite(n) || n < 0) throw new ValidationError('bedrooms must be a non-negative integer');
    out.bedrooms = Math.floor(n);
  }
  if (payload.bathrooms !== undefined) {
    const n = Number(payload.bathrooms);
    if (!Number.isFinite(n) || n < 0) throw new ValidationError('bathrooms must be a non-negative integer');
    out.bathrooms = Math.floor(n);
  }
  if (payload.unit_identifiers !== undefined) {
    if (!Array.isArray(payload.unit_identifiers)) {
      throw new ValidationError('unit_identifiers must be an array of strings');
    }
    // Trim and de-dup; drop empties. Doesn't enforce length === quantity —
    // hosts often add identifiers progressively, and a quantity > IDs.length
    // case is meaningful (e.g. "8 rooms total, only 3 have custom names").
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const v of payload.unit_identifiers) {
      if (typeof v !== 'string') continue;
      const trimmed = v.trim();
      if (!trimmed) continue;
      if (seen.has(trimmed.toLowerCase())) continue;
      seen.add(trimmed.toLowerCase());
      cleaned.push(trimmed);
    }
    out.unit_identifiers = cleaned;
  }
  if (payload.amenities !== undefined) {
    if (!Array.isArray(payload.amenities)) {
      throw new ValidationError('amenities must be an array of strings');
    }
    // Trim, drop empties, case-insensitive de-dup. Mirrors how
    // `listings.amenities` is treated elsewhere so the union the consumer
    // filter computes doesn't double-count "ac" + "AC".
    const seen = new Set<string>();
    const cleaned: string[] = [];
    for (const v of payload.amenities) {
      if (typeof v !== 'string') continue;
      const trimmed = v.trim();
      if (!trimmed) continue;
      const key = trimmed.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      cleaned.push(trimmed);
    }
    out.amenities = cleaned;
  }
  if (payload.photos !== undefined) {
    if (!Array.isArray(payload.photos)) throw new ValidationError('photos must be an array of URLs');
    out.photos = payload.photos.filter((p) => typeof p === 'string');
  }
  if (payload.sort_order !== undefined) out.sort_order = Number(payload.sort_order) || 0;
  return out;
}

export class RoomTypesService {
  async listForListing(listingId: string) {
    const result = await roomTypesRepository.listForListing(listingId);
    return { data: result.rows };
  }

  async create(listingId: string, userId: string, payload: Record<string, unknown>) {
    const listing = await assertListingOwner(listingId, userId);
    const normalized = normalizePayload(payload);
    if (!normalized.name) throw new ValidationError('name is required');
    if (normalized.base_price_paise === undefined) throw new ValidationError('base_price_paise is required');

    const liveRooms = (await roomTypesRepository.listForListing(listingId)).rows.map(toProspectiveRoom);
    await guardActiveHotel(listing, [...liveRooms, toProspectiveRoom(normalized)]);

    const result = await roomTypesRepository.create(listingId, normalized);
    return { data: result.rows[0] };
  }

  async update(listingId: string, roomId: string, userId: string, payload: Record<string, unknown>) {
    const listing = await assertListingOwner(listingId, userId);
    const existing = await roomTypesRepository.getById(roomId);
    if (!existing.rows[0] || existing.rows[0].listing_id !== listingId) {
      throw new NotFoundError('Room type', roomId);
    }
    const normalized = normalizePayload(payload);

    const liveRooms = (await roomTypesRepository.listForListing(listingId)).rows;
    const prospective = liveRooms.map((r) =>
      r.id === roomId ? toProspectiveRoom({ ...r, ...normalized }) : toProspectiveRoom(r),
    );
    await guardActiveHotel(listing, prospective);

    const result = await roomTypesRepository.update(roomId, normalized);
    // Defensive: if the repo update returned no rows (concurrent delete,
    // optimistic-locking miss, mis-mocked test), surface a typed error
    // instead of a TypeError from accessing `.rows[0]` on undefined.
    // assertListingOwner + the existence check above ruled the row out
    // existing at call time, so an empty result here is genuinely
    // exceptional.
    const updated = result?.rows?.[0];
    if (!updated) {
      throw new NotFoundError('Room type', roomId);
    }
    return { data: updated };
  }

  async delete(listingId: string, roomId: string, userId: string) {
    const listing = await assertListingOwner(listingId, userId);
    const existing = await roomTypesRepository.getById(roomId);
    if (!existing.rows[0] || existing.rows[0].listing_id !== listingId) {
      throw new NotFoundError('Room type', roomId);
    }

    const liveRooms = (await roomTypesRepository.listForListing(listingId)).rows;
    const prospective = liveRooms.filter((r) => r.id !== roomId).map(toProspectiveRoom);
    await guardActiveHotel(listing, prospective);

    await roomTypesRepository.delete(roomId);
    return { success: true };
  }
}

export const roomTypesService = new RoomTypesService();
