/**
 * Listing Domain Service
 */

import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import type { Listing, ServiceResult, UUID } from "@/types/domain";

export interface AvailabilityOverride {
  listingId: string;
  roomTypeId: string | null;
  date: string;
  blocked: boolean;
  pricePaise: number | null;
}

/**
 * camelCase listing → POST /api/listings body (snake_case). Shared by
 * create() below and the admin ops console's create-for-user path so the
 * two stay field-for-field identical. `user_id` is intentionally NOT set
 * here — the self-serve path adds it, the admin path sends targetUserId.
 */
export function toCreateListingApiBody(listing: Partial<Listing> & { category: string; name: string }) {
  return {
    category: listing.category,
    name: listing.name,
    description: listing.description,
    location: listing.location,
    lat: listing.lat,
    lng: listing.lng,
    service_area: listing.serviceArea,
    price: listing.price,
    availability: listing.availability,
    photos: listing.photos || [],
    amenities: listing.amenities || [],
    vehicle_name: listing.vehicleName,
    vehicle_year: listing.vehicleYear,
    property_type: listing.propertyType,
    bedrooms: listing.bedrooms,
    bathrooms: listing.bathrooms,
    max_guests: listing.maxGuests,
    is_active: listing.isActive,
    booking_mode: listing.bookingMode,
    booking_rules: listing.bookingRules,
    metadata: listing.metadata,
  };
}

export class ListingService {
  async listPublic(params?: { type?: "stay" | "service" | "transport"; limit?: number; availableWithinHours?: number }): Promise<ServiceResult<any[]>> {
    const page = await this.listPublicPage(params);
    if (!page.success || !page.data) return { success: false, error: page.error };
    return { success: true, data: page.data.data };
  }

  async listPublicPage(params?: { type?: "stay" | "service" | "transport"; limit?: number; cursor?: string | null; availableWithinHours?: number; from?: string; to?: string }): Promise<ServiceResult<{ data: any[]; nextCursor: string | null }>> {
    const search = new URLSearchParams();
    if (params?.type) search.set("type", params.type);
    if (params?.limit) search.set("limit", String(params.limit));
    if (params?.cursor) search.set("cursor", params.cursor);
    if (params?.availableWithinHours && params.availableWithinHours > 0) {
      search.set("availableWithinHours", String(params.availableWithinHours));
    }
    // Stay date-range availability filter. Backend ignores a malformed or
    // zero-length range, so only send when both ends are present.
    if (params?.from && params?.to) {
      search.set("from", params.from);
      search.set("to", params.to);
    }

    const suffix = search.toString() ? `?${search.toString()}` : "";
    const result = await apiRequest<{ data: any[]; nextCursor: string | null }>(`/api/listings${suffix}`, {
      headers: getJsonHeaders(false),
    });

    if (!result.success || !result.data) return { success: false, error: result.error };
    return {
      success: true,
      data: { data: result.data.data || [], nextCursor: result.data.nextCursor ?? null },
    };
  }

  async getRawById(id: UUID): Promise<ServiceResult<any>> {
    const result = await apiRequest<{ data: any }>(`/api/listings/${id}`, {
      headers: getJsonHeaders(false),
    });
    if (!result.success || !result.data) return { success: false, error: result.error };
    return { success: true, data: result.data.data };
  }

  async getByUserId(_userId: UUID): Promise<ServiceResult<Listing[]>> {
    const result = await apiRequest<{ data: any[] }>("/api/listings/mine", {
      headers: getJsonHeaders(false),
    });
    if (!result.success || !result.data) return { success: false, error: result.error };
    return { success: true, data: (result.data.data || []).map(this.mapListing) };
  }

  async getById(id: UUID): Promise<ServiceResult<Listing>> {
    const result = await apiRequest<{ data: any }>(`/api/listings/${id}`);
    if (!result.success || !result.data) return { success: false, error: result.error };
    return { success: true, data: this.mapListing(result.data.data) };
  }

  async create(listing: Partial<Listing> & { userId: string; category: string; name: string }): Promise<ServiceResult<Listing> & { warnings?: string[] }> {
    const result = await apiRequest<{ data: any; warnings?: string[] }>("/api/listings", {
      method: "POST",
      headers: getJsonHeaders(),
      body: JSON.stringify({
        user_id: listing.userId,
        ...toCreateListingApiBody(listing),
      }),
    });
    if (!result.success || !result.data) return { success: false, error: result.error };
    // warnings = warn-only guardrail nudges (e.g. a street address typed into
    // the description) — the listing saved; the UI should surface these.
    return { success: true, data: this.mapListing(result.data.data), warnings: result.data.warnings };
  }

  async update(id: UUID, updates: Partial<Listing>): Promise<ServiceResult<Listing> & { warnings?: string[] }> {
    const dbUpdates: any = {};
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.description !== undefined) dbUpdates.description = updates.description;
    if (updates.location !== undefined) dbUpdates.location = updates.location;
    if (updates.serviceArea !== undefined) dbUpdates.service_area = updates.serviceArea;
    if (updates.price !== undefined) dbUpdates.price = updates.price;
    if (updates.availability !== undefined) dbUpdates.availability = updates.availability;
    if (updates.photos !== undefined) dbUpdates.photos = updates.photos;
    if (updates.amenities !== undefined) dbUpdates.amenities = updates.amenities;
    if (updates.vehicleName !== undefined) dbUpdates.vehicle_name = updates.vehicleName;
    if (updates.vehicleYear !== undefined) dbUpdates.vehicle_year = updates.vehicleYear;
    if (updates.propertyType !== undefined) dbUpdates.property_type = updates.propertyType;
    if (updates.bedrooms !== undefined) dbUpdates.bedrooms = updates.bedrooms;
    if (updates.bathrooms !== undefined) dbUpdates.bathrooms = updates.bathrooms;
    if (updates.maxGuests !== undefined) dbUpdates.max_guests = updates.maxGuests;
    if (updates.isActive !== undefined) dbUpdates.is_active = updates.isActive;
    if (updates.bookingMode !== undefined) dbUpdates.booking_mode = updates.bookingMode;
    if (updates.bookingRules !== undefined) dbUpdates.booking_rules = updates.bookingRules;
    if (updates.discountPercent !== undefined) dbUpdates.discount_percent = updates.discountPercent;
    if (updates.metadata !== undefined) dbUpdates.metadata = updates.metadata;
    if ((updates as any).category !== undefined) dbUpdates.category = (updates as any).category;
    if ((updates as any).imageUrl !== undefined) dbUpdates.image_url = (updates as any).imageUrl;

    const result = await apiRequest<{ data: any; warnings?: string[] }>(`/api/listings/${id}`, {
      method: "PATCH",
      headers: getJsonHeaders(),
      body: JSON.stringify(dbUpdates),
    });
    if (!result.success || !result.data) {
      return {
        success: false,
        error: result.error,
        code: result.code,
        errorDetails: result.errorDetails,
      };
    }
    // Keep the re-fetch (fresh joined row) but don't drop the PATCH's
    // warn-only guardrail nudges on the floor.
    const fresh = await this.getById(id);
    return { ...fresh, warnings: result.data.warnings } as ServiceResult<Listing> & { warnings?: string[] };
  }

  // NOTE: no client-side listing delete — removal is admin-only (soft archive
  // via /api/admin/listings/:id/archive); owners deactivate instead.

  async listRoomTypes(listingId: UUID): Promise<ServiceResult<any[]>> {
    const result = await apiRequest<{ data: any[] }>(`/api/listings/${listingId}/room-types`, {
      headers: getJsonHeaders(false),
    });
    if (!result.success || !result.data) return { success: false, error: result.error };
    return { success: true, data: result.data.data || [] };
  }

  /**
   * Returns fully-booked nights for a listing (or for a specific room type when
   * roomTypeId is provided). The backend expands each booking into its occupied
   * nights and filters to dates where every available room is taken, so the
   * dates returned here are safe to disable as either check-in or in-range
   * nights in the calendar. Same-day services collapse to a single date.
   */
  async getBookedDates(listingId: UUID, roomTypeId?: UUID): Promise<ServiceResult<string[]>> {
    const suffix = roomTypeId ? `?roomTypeId=${encodeURIComponent(roomTypeId)}` : "";
    const result = await apiRequest<{ dates: string[] }>(
      `/api/listings/${listingId}/booked-dates${suffix}`,
      { headers: getJsonHeaders(false) },
    );
    if (!result.success || !result.data) return { success: false, error: result.error };
    return { success: true, data: Array.isArray(result.data.dates) ? result.data.dates : [] };
  }

  /**
   * Host-configured room `quantity` for the given room type + the minimum
   * number of rooms still bookable across the requested night range. Powers
   * the multi-room booking modal's "How many rooms?" stepper cap so the
   * user can't pick more than what's actually free for those nights.
   *
   * `to` is exclusive (matches `bookings.end_date` convention). Returns
   * `{ quantity: 0, remaining: 0 }` when the room type is missing — the
   * modal treats that as "can't book" rather than crashing.
   */
  async getRoomAvailability(
    listingId: UUID,
    roomTypeId: UUID,
    from: string,
    to: string,
  ): Promise<ServiceResult<{ quantity: number; remaining: number }>> {
    const qs = new URLSearchParams({ roomTypeId, from, to }).toString();
    const result = await apiRequest<{ quantity: number; remaining: number }>(
      `/api/listings/${listingId}/room-availability?${qs}`,
      { headers: getJsonHeaders(false) },
    );
    if (!result.success || !result.data) return { success: false, error: result.error };
    return {
      success: true,
      data: {
        quantity: Number(result.data.quantity) || 0,
        remaining: Number(result.data.remaining) || 0,
      },
    };
  }

  /**
   * Active driver-* bookings (pending hold, confirmed, in-progress) for this
   * transport listing's provider in the given date window. Used by the
   * booking modal to grey out unavailable time ranges before the user
   * submits, and by the driver dashboard's schedule view. Window defaults
   * to today → +90d to match `getAvailability`.
   */
  async getTransportBookings(
    listingId: UUID,
    opts?: { from?: string; to?: string },
  ): Promise<ServiceResult<Array<{
    id: string;
    scheduledDate: string;
    startTime: string;
    endTime: string;
    serviceCategory: string;
    status: string;
  }>>> {
    const qs: string[] = [];
    if (opts?.from) qs.push(`from=${encodeURIComponent(opts.from)}`);
    if (opts?.to) qs.push(`to=${encodeURIComponent(opts.to)}`);
    const suffix = qs.length ? `?${qs.join("&")}` : "";
    const result = await apiRequest<{ data: Array<Record<string, unknown>> }>(
      `/api/listings/${listingId}/transport-bookings${suffix}`,
      { headers: getJsonHeaders(false) },
    );
    if (!result.success || !result.data) return { success: false, error: result.error };
    const rows = Array.isArray(result.data.data) ? result.data.data : [];
    return {
      success: true,
      data: rows.map((r) => ({
        id: String(r.id ?? ""),
        // Normalize DATE column variations (ISO timestamp vs YYYY-MM-DD).
        scheduledDate: String(r.scheduledDate ?? r.scheduled_date ?? "").slice(0, 10),
        // Normalize TIME column variations ("09:00:00" or "09:00").
        startTime: String(r.startTime ?? r.start_time ?? "").slice(0, 5),
        endTime: String(r.endTime ?? r.end_time ?? "").slice(0, 5),
        serviceCategory: String(r.serviceCategory ?? r.service_category ?? ""),
        status: String(r.status ?? ""),
      })),
    };
  }

  /** Twin of `getTransportBookings` for service listings. Used by the
   *  service booking modal to filter already-taken time slots out of the
   *  picker so customers can't pick a window the provider is committed to. */
  async getServiceBookings(
    listingId: UUID,
    opts?: { from?: string; to?: string },
  ): Promise<ServiceResult<Array<{
    id: string;
    scheduledDate: string;
    startTime: string;
    endTime: string;
    serviceCategory: string;
    status: string;
  }>>> {
    const qs: string[] = [];
    if (opts?.from) qs.push(`from=${encodeURIComponent(opts.from)}`);
    if (opts?.to) qs.push(`to=${encodeURIComponent(opts.to)}`);
    const suffix = qs.length ? `?${qs.join("&")}` : "";
    const result = await apiRequest<{ data: Array<Record<string, unknown>> }>(
      `/api/listings/${listingId}/service-bookings${suffix}`,
      { headers: getJsonHeaders(false) },
    );
    if (!result.success || !result.data) return { success: false, error: result.error };
    const rows = Array.isArray(result.data.data) ? result.data.data : [];
    return {
      success: true,
      data: rows.map((r) => ({
        id: String(r.id ?? ""),
        scheduledDate: String(r.scheduledDate ?? r.scheduled_date ?? "").slice(0, 10),
        startTime: String(r.startTime ?? r.start_time ?? "").slice(0, 5),
        endTime: String(r.endTime ?? r.end_time ?? "").slice(0, 5),
        serviceCategory: String(r.serviceCategory ?? r.service_category ?? ""),
        status: String(r.status ?? ""),
      })),
    };
  }

  /**
   * Returns host-set availability overrides (blocked dates and per-night custom
   * prices) for a listing — listing-level rows have `room_type_id: null`, room-
   * specific rows shadow them. Callers should fold the two together so room
   * overrides win on dates where both exist. Range defaults to today → +90d.
   */
  async getAvailability(
    listingId: UUID,
    opts?: { from?: string; to?: string },
  ): Promise<ServiceResult<Array<{ listingId: string; roomTypeId: string | null; date: string; blocked: boolean; pricePaise: number | null }>>> {
    const qs: string[] = [];
    if (opts?.from) qs.push(`from=${encodeURIComponent(opts.from)}`);
    if (opts?.to) qs.push(`to=${encodeURIComponent(opts.to)}`);
    const suffix = qs.length ? `?${qs.join("&")}` : "";
    const result = await apiRequest<{ data: any[] }>(
      `/api/listings/${listingId}/availability${suffix}`,
      { headers: getJsonHeaders(false) },
    );
    if (!result.success || !result.data) return { success: false, error: result.error };
    const rows = Array.isArray(result.data.data) ? result.data.data : [];
    return {
      success: true,
      data: rows.map((r: any) => ({
        listingId: String(r.listing_id ?? r.listingId ?? listingId),
        roomTypeId: r.room_type_id ?? r.roomTypeId ?? null,
        // PG `DATE` columns occasionally arrive as full ISO timestamps
        // ("2026-05-28T00:00:00.000Z") instead of "2026-05-28". Slice to
        // the date portion so `priceByDate.get(YMD)` lookups in the
        // booking calendar match.
        date: String(r.date).slice(0, 10),
        blocked: Boolean(r.blocked),
        pricePaise: r.price_paise == null && r.pricePaise == null ? null : Number(r.price_paise ?? r.pricePaise),
      })),
    };
  }

  async createRoomType(
    listingId: UUID,
    payload: {
      name: string;
      description?: string;
      basePricePaise: number;
      maxGuests: number;
      quantity?: number;
      photos: string[];
      sortOrder?: number;
      /** Bedrooms inside ONE room of this type. */
      bedrooms?: number;
      /** Bathrooms inside ONE room of this type. */
      bathrooms?: number;
      /** Optional room numbers/labels — ["101","102",…]. Empty if host doesn't number rooms. */
      unitIdentifiers?: string[];
      /** Per-room amenities ("AC", "Balcony", …). Free-text strings. */
      amenities?: string[];
    },
  ): Promise<ServiceResult<any>> {
    const result = await apiRequest<{ data: any }>(`/api/listings/${listingId}/room-types`, {
      method: "POST",
      headers: getJsonHeaders(),
      body: JSON.stringify({
        name: payload.name,
        description: payload.description ?? null,
        base_price_paise: payload.basePricePaise,
        max_guests: payload.maxGuests,
        quantity: payload.quantity ?? 1,
        bedrooms: payload.bedrooms ?? 1,
        bathrooms: payload.bathrooms ?? 1,
        unit_identifiers: payload.unitIdentifiers ?? [],
        amenities: payload.amenities ?? [],
        photos: payload.photos,
        sort_order: payload.sortOrder ?? 0,
      }),
    });
    if (!result.success || !result.data) return { success: false, error: result.error };
    return { success: true, data: result.data.data };
  }

  async updateRoomType(
    listingId: UUID,
    roomId: UUID,
    payload: Partial<{ name: string; description: string; basePricePaise: number; maxGuests: number; quantity: number; bedrooms: number; bathrooms: number; unitIdentifiers: string[]; amenities: string[]; photos: string[]; sortOrder: number }>,
  ): Promise<ServiceResult<any>> {
    const body: Record<string, unknown> = {};
    if (payload.name !== undefined) body.name = payload.name;
    if (payload.description !== undefined) body.description = payload.description;
    if (payload.basePricePaise !== undefined) body.base_price_paise = payload.basePricePaise;
    if (payload.maxGuests !== undefined) body.max_guests = payload.maxGuests;
    if (payload.quantity !== undefined) body.quantity = payload.quantity;
    if (payload.bedrooms !== undefined) body.bedrooms = payload.bedrooms;
    if (payload.bathrooms !== undefined) body.bathrooms = payload.bathrooms;
    if (payload.unitIdentifiers !== undefined) body.unit_identifiers = payload.unitIdentifiers;
    if (payload.amenities !== undefined) body.amenities = payload.amenities;
    if (payload.photos !== undefined) body.photos = payload.photos;
    if (payload.sortOrder !== undefined) body.sort_order = payload.sortOrder;
    const result = await apiRequest<{ data: any }>(`/api/listings/${listingId}/room-types/${roomId}`, {
      method: "PATCH",
      headers: getJsonHeaders(),
      body: JSON.stringify(body),
    });
    if (!result.success || !result.data) return { success: false, error: result.error };
    return { success: true, data: result.data.data };
  }

  async deleteRoomType(listingId: UUID, roomId: UUID): Promise<ServiceResult<void>> {
    const result = await apiRequest<{ success: true }>(`/api/listings/${listingId}/room-types/${roomId}`, {
      method: "DELETE",
      headers: getJsonHeaders(),
    });
    if (!result.success) return { success: false, error: result.error };
    return { success: true };
  }

  async listAvailability(listingId: UUID, from?: string, to?: string): Promise<ServiceResult<AvailabilityOverride[]>> {
    const search = new URLSearchParams();
    if (from) search.set("from", from);
    if (to) search.set("to", to);
    const suffix = search.toString() ? `?${search.toString()}` : "";
    const result = await apiRequest<{ data: any[] }>(`/api/listings/${listingId}/availability${suffix}`, {
      headers: getJsonHeaders(false),
    });
    if (!result.success || !result.data) return { success: false, error: result.error };
    return {
      success: true,
      data: (result.data.data || []).map((r) => ({
        listingId: String(r.listing_id),
        roomTypeId: r.room_type_id ?? null,
        date: String(r.date).slice(0, 10),
        blocked: Boolean(r.blocked),
        pricePaise: r.price_paise == null ? null : Number(r.price_paise),
      })),
    };
  }

  async setAvailability(
    listingId: UUID,
    entries: Array<{ date: string; blocked?: boolean; pricePaise?: number | null; roomTypeId?: string | null }>,
  ): Promise<ServiceResult<void>> {
    const result = await apiRequest<{ data: any[] }>(`/api/listings/${listingId}/availability`, {
      method: "PUT",
      headers: getJsonHeaders(),
      body: JSON.stringify({ entries }),
    });
    if (!result.success) return { success: false, error: result.error };
    return { success: true };
  }

  private mapListing(row: any): Listing {
    return {
      id: row.id,
      userId: row.user_id,
      providerProfileId: row.provider_profile_id || undefined,
      category: row.category,
      name: row.name,
      description: row.description,
      location: row.location,
      lat: row.lat,
      lng: row.lng,
      serviceArea: row.service_area,
      price: row.price,
      availability: row.availability,
      photos: row.photos || [],
      amenities: row.amenities || [],
      vehicleName: row.vehicle_name,
      vehicleYear: row.vehicle_year,
      propertyType: row.property_type,
      maxGuests: row.max_guests,
      bedrooms: row.bedrooms,
      bathrooms: row.bathrooms,
      isActive: row.is_active,
      bookingMode: row.booking_mode || "manual_approval",
      bookingRules: row.booking_rules || {},
      discountPercent: typeof row.discount_percent === "number" ? row.discount_percent : Number(row.discount_percent) || 0,
      metadata: row.metadata || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

let _instance: ListingService | null = null;
export function getListingService(): ListingService {
  if (!_instance) _instance = new ListingService();
  return _instance;
}
