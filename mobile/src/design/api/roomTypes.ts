// design/api/roomTypes.ts — room types are a SEPARATE backend resource
// (listing_room_types) with dedicated CRUD endpoints. Mirrors the web
// ListingService room-type methods 1:1: camelCase in, snake_case body, and
// ₹→paise conversion done by the caller (basePricePaise).
//
// IMPORTANT: never send rooms inside the listing create/update body — the
// listing repository strips any key not in LISTING_MUTABLE_FIELDS, so a
// `room_types` array on PATCH /api/listings/:id is silently dropped. Rooms
// only persist through these endpoints.
import { api } from "@/lib/api";

/** A room row exactly as the backend returns it (snake_case). */
export type RoomTypeRow = {
  id: string;
  name: string;
  description: string | null;
  base_price_paise: number;
  max_guests: number;
  quantity: number;
  bedrooms: number;
  bathrooms: number;
  unit_identifiers: string[];
  amenities: string[];
  photos: string[];
  sort_order: number;
};

export type RoomTypeInput = {
  name: string;
  description?: string;
  basePricePaise: number;
  maxGuests: number;
  quantity?: number;
  bedrooms?: number;
  bathrooms?: number;
  unitIdentifiers?: string[];
  amenities?: string[];
  photos: string[];
  sortOrder?: number;
};

const toBody = (p: Partial<RoomTypeInput>): Record<string, unknown> => {
  const b: Record<string, unknown> = {};
  if (p.name !== undefined) b.name = p.name;
  if (p.description !== undefined) b.description = p.description ?? null;
  if (p.basePricePaise !== undefined) b.base_price_paise = p.basePricePaise;
  if (p.maxGuests !== undefined) b.max_guests = p.maxGuests;
  if (p.quantity !== undefined) b.quantity = p.quantity;
  if (p.bedrooms !== undefined) b.bedrooms = p.bedrooms;
  if (p.bathrooms !== undefined) b.bathrooms = p.bathrooms;
  if (p.unitIdentifiers !== undefined) b.unit_identifiers = p.unitIdentifiers;
  if (p.amenities !== undefined) b.amenities = p.amenities;
  if (p.photos !== undefined) b.photos = p.photos;
  if (p.sortOrder !== undefined) b.sort_order = p.sortOrder;
  return b;
};

export async function listRoomTypes(listingId: string): Promise<RoomTypeRow[]> {
  const res = await api.get(`/api/listings/${listingId}/room-types`);
  const rows = res.data?.data ?? res.data ?? [];
  return Array.isArray(rows) ? rows : [];
}

export async function createRoomType(listingId: string, payload: RoomTypeInput) {
  const res = await api.post(
    `/api/listings/${listingId}/room-types`,
    toBody({ quantity: 1, bedrooms: 1, bathrooms: 1, unitIdentifiers: [], amenities: [], sortOrder: 0, ...payload }),
  );
  return res.data?.data ?? res.data;
}

export async function updateRoomType(listingId: string, roomId: string, payload: Partial<RoomTypeInput>) {
  const res = await api.patch(`/api/listings/${listingId}/room-types/${roomId}`, toBody(payload));
  return res.data?.data ?? res.data;
}

export async function deleteRoomType(listingId: string, roomId: string) {
  const res = await api.delete(`/api/listings/${listingId}/room-types/${roomId}`);
  return res.data?.data ?? res.data;
}

/**
 * Maps the onboarding form's in-memory room shape (price in ₹ as a string,
 * etc.) to a create payload. Shared by the post-create bulk loop so the
 * conversion stays in one place.
 */
export function formRoomToInput(r: any, sortOrder: number): RoomTypeInput {
  return {
    name: r.name,
    description: r.description || "",
    basePricePaise: Math.round((Number(r.price) || 0) * 100),
    maxGuests: Number(r.maxGuests) || 2,
    quantity: Number(r.quantity) || 1,
    bedrooms: Number(r.bedrooms) || 1,
    bathrooms: Number(r.bathrooms) || 1,
    unitIdentifiers: Array.isArray(r.unitIdentifiers) ? r.unitIdentifiers : [],
    amenities: Array.isArray(r.amenities) ? r.amenities : [],
    photos: Array.isArray(r.photos) ? r.photos : [],
    sortOrder,
  };
}

/**
 * Bulk-create rooms right after a listing is created during onboarding —
 * mirrors the web useConversationEngine post-create loop. Non-blocking per
 * room: a failure is collected and returned (the listing is already created),
 * never aborting the rest.
 */
export async function createRoomTypesAfterListing(listingId: string, rooms: any[]): Promise<{ failed: string[] }> {
  const failed: string[] = [];
  for (let i = 0; i < rooms.length; i++) {
    try {
      await createRoomType(listingId, formRoomToInput(rooms[i], i));
    } catch {
      failed.push(rooms[i]?.name || `Room ${i + 1}`);
    }
  }
  return { failed };
}
