/**
 * Booking Domain Service
 *
 * All booking business logic lives here, independent of UI and infrastructure.
 */

import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import type { Booking, ServiceResult, UUID } from "@/types/domain";
import type { PrepareBookingResult } from "@/domains/chat/user-assistant.service";

// Categorical guest-facing cancellation reasons. Mirrors the server enum in
// server/src/modules/bookings/schemas/cancellation-reasons.ts (no shared code
// between web and server — same convention as booking statuses). Change both
// in the same PR.
export const CANCELLATION_REASONS = [
  "plans_changed",
  "found_alternative",
  "price_too_high",
  "booked_by_mistake",
  "host_asked_offline",
  "property_issue",
  "other",
] as const;

export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

/**
 * Structured request for the unified prepare-booking endpoint
 * (POST /api/bookings/prepare). Superset of what stays/services/transport
 * collect. The server owns notes, hold, order, authoritative price, and the
 * returned PrepareBookingResult — the client only collects inputs and then
 * launches Razorpay with the result.
 */
export interface PrepareBookingInput {
  listingType: "stay" | "service" | "transport";
  listingId: string;
  serviceCategory: string;
  scheduledDate: string;
  startTime?: string;
  endTime?: string;
  checkOutDate?: string;
  endDate?: string;
  numberOfRooms?: number;
  couponCode?: string;
  address?: string;
  idempotencyKey?: string;
  // Display / result decoration
  listingTitle?: string;
  listingName?: string;
  listingImage?: string;
  listingLocation?: string;
  roomPricePerNight?: number;
  // Shared
  note?: string;
  contact?: { name?: string; phone?: string };
  guestName?: string;
  insuranceOptIn?: boolean;
  // Stay
  guestCount?: number;
  roomTypeId?: string;
  roomName?: string;
  roomCount?: number;
  // Service
  serviceMode?: "at-home" | "visit-provider" | "online";
  serviceAddress?: string;
  visitAddress?: string;
  meetingDetails?: string;
  serviceHours?: number;
  slot?: string;
  serviceAddOns?: Array<{ id?: string; label: string; price: number }>;
  serviceCatalogId?: string;
  serviceCatalogName?: string;
  serviceCatalogBasePrice?: number;
  // Transport
  transportMode?: "hourly" | "day" | "package";
  pickupLocation?: string;
  passengerCount?: number;
  scheduledTime?: string;
  vehicleType?: string;
  transportationType?: string;
  transportationLabel?: string;
  transportHours?: number;
  transportStartTime?: string;
  transportEndTime?: string;
  transportSelectedSlots?: string[];
  transportDays?: number;
  transportEndDate?: string;
  transportPackageId?: string;
  transportPackageLabel?: string;
  transportPackagePrice?: number;
  transportPackageHours?: number;
}

/** Result of a host-books-on-behalf create — the booking + its payment link. */
export interface OnBehalfBookingResult {
  bookingId: string;
  holdExpiresAt: string | null;
  paymentLink: { shortUrl: string; paymentLinkId: string };
  amount: number;
  amountPaise: number;
  currency: "INR";
  guest: { name: string | null; phone: string; email: string | null };
  listing: { id: string; name: string; image?: string; location?: string };
  schedule: {
    scheduledDate: string;
    startTime: string;
    endTime: string;
    checkOutDate?: string;
    nights?: number;
  };
  room?: { id: string; name: string; pricePerNight?: number };
}

export class BookingService {
  /**
   * Prepare a booking: server creates the hold + Razorpay order and returns
   * everything needed to launch checkout. One round trip, server-authoritative
   * price — the same path the chat assistant's Confirm & Pay card uses.
   */
  async prepare(input: PrepareBookingInput): Promise<ServiceResult<PrepareBookingResult>> {
    const res = await apiRequest<{ success: boolean; data: PrepareBookingResult }>(
      "/api/bookings/prepare",
      {
        method: "POST",
        headers: getJsonHeaders(),
        body: JSON.stringify(input),
      },
    );
    if (!res.success || !res.data?.data) {
      return { success: false, error: res.error || "Unable to prepare booking" };
    }
    return { success: true, data: res.data.data };
  }

  /**
   * Host-books-on-behalf: create a booking for a walk-up guest who has no
   * account. Same structured payload as prepare(), plus the guest to bill.
   * Returns a Razorpay Payment Link (QR / short URL) the guest pays — the
   * booking confirms via the payment_link.paid webhook once they do.
   */
  async prepareOnBehalf(
    input: PrepareBookingInput,
    guest: { name?: string; phone: string; email?: string },
    opts: { admin?: boolean } = {},
  ): Promise<ServiceResult<OnBehalfBookingResult>> {
    // Admin variant hits the ops-console endpoint: same flow, but the server
    // skips the "host owns this listing" check and records an admin action.
    const res = await apiRequest<{ data: OnBehalfBookingResult }>(
      opts.admin ? "/api/admin/bookings/on-behalf" : "/api/bookings/on-behalf",
      {
        method: "POST",
        headers: getJsonHeaders(),
        body: JSON.stringify({ ...input, guest }),
      },
    );
    if (!res.success || !res.data?.data) {
      return { success: false, error: res.error || "Unable to create booking for guest" };
    }
    return { success: true, data: res.data.data };
  }

  async createHold(params: {
    providerId?: UUID;
    listingId?: UUID;
    serviceCategory: string;
    scheduledDate: string;
    /** Checkout date (exclusive) for multi-night stays. Omit for services/transport. */
    endDate?: string;
    startTime: string;
    endTime: string;
    agreedPrice?: number;
    address?: string;
    lat?: number;
    lng?: number;
    notes?: string;
    idempotencyKey?: string;
    couponCode?: string;
    roomTypeId?: UUID;
    numberOfRooms?: number;
  }): Promise<ServiceResult<{ booking: Booking; hold: { lockId: UUID; expiresAt: string } }>> {
    const result = await apiRequest<{ data: { booking: any; hold: { lockId: UUID; expiresAt: string } } }>(
      "/api/bookings/holds",
      {
        method: "POST",
        headers: getJsonHeaders(),
        body: JSON.stringify({
          providerId: params.providerId,
          listingId: params.listingId,
          serviceCategory: params.serviceCategory,
          scheduledDate: params.scheduledDate,
          endDate: params.endDate,
          startTime: params.startTime,
          endTime: params.endTime,
          agreedPrice: params.agreedPrice,
          address: params.address,
          lat: params.lat,
          lng: params.lng,
          notes: params.notes,
          idempotencyKey: params.idempotencyKey,
          couponCode: params.couponCode || undefined,
          roomTypeId: params.roomTypeId,
          numberOfRooms: params.numberOfRooms,
        }),
      }
    );

    if (!result.success || !result.data) return { success: false, error: result.error };
    return {
      success: true,
      data: {
        booking: this.mapBooking(result.data.data.booking),
        hold: result.data.data.hold,
      },
    };
  }

  async releaseHold(bookingId: UUID): Promise<ServiceResult<Booking>> {
    const result = await apiRequest<{ data: any }>(`/api/bookings/holds/${bookingId}`, {
      method: "DELETE",
      headers: getJsonHeaders(false),
    });

    if (!result.success || !result.data) return { success: false, error: result.error };
    return { success: true, data: this.mapBooking(result.data.data) };
  }

  async getUserBookings(scope: "user" | "provider" = "user"): Promise<ServiceResult<Booking[]>> {
    // No pagination on the dashboards yet — they render the full list in
    // one scroll. Ask for the controller's hard cap so the Completed /
    // Cancelled tabs and the booking-modal conflict check both see every
    // row. If the user ever has >1000 bookings we'll add real pagination;
    // until then this matches what the UI actually consumes.
    const params = new URLSearchParams({ limit: "1000" });
    if (scope === "provider") params.set("scope", "provider");
    const result = await apiRequest<{ data: any[] }>(`/api/bookings?${params.toString()}`, {
      headers: getJsonHeaders(false),
    });
    if (!result.success || !result.data) return { success: false, error: result.error };
    return { success: true, data: (result.data.data || []).map(this.mapBooking) };
  }

  async getProviderBookings(_providerId: UUID): Promise<ServiceResult<Booking[]>> {
    return this.getUserBookings("provider");
  }

  /** Fetch a single booking (used by the post-payment success modal to
   *  read the server-side `totalPaidPaise` and reconcile the displayed
   *  Total against what was actually charged). */
  async getById(bookingId: UUID): Promise<ServiceResult<Booking>> {
    const result = await apiRequest<{ data: any }>(`/api/bookings/${bookingId}`, {
      headers: getJsonHeaders(false),
    });
    if (!result.success || !result.data) return { success: false, error: result.error };
    return { success: true, data: this.mapBooking(result.data.data) };
  }

  async updateBookingStatus(
    bookingId: UUID,
    status: string,
    actorRole?: "guest" | "host" | "provider",
    cancellationReason?: CancellationReason,
  ): Promise<ServiceResult<Booking>> {
    const result = await apiRequest<{ data: any }>(`/api/bookings/${bookingId}/status`, {
      method: "PATCH",
      headers: getJsonHeaders(),
      body: JSON.stringify({
        status,
        ...(actorRole ? { as: actorRole } : {}),
        ...(cancellationReason ? { cancellationReason } : {}),
      }),
    });

    if (!result.success || !result.data) return { success: false, error: result.error };
    return { success: true, data: this.mapBooking(result.data.data) };
  }

private mapBooking(row: any): Booking {
    return {
      id: row.id,
      userId: row.user_id,
      providerId: row.provider_id,
      providerUserId: row.provider_user_id,
      serviceCategory: row.service_category,
      listingId: row.listing_id,
      listingName: row.listing_name,
      scheduledDate: row.scheduled_date,
      startTime: row.start_time,
      endTime: row.end_time,
      status: row.status,
      address: row.address,
      // WS6: false when the host gave no street-level address — details
      // surfaces show the "message/call your host for directions" note.
      hasExactAddress: row.has_exact_address !== false,
      lat: row.lat,
      lng: row.lng,
      notes: row.notes,
      estimatedTravelMinutes: row.estimated_travel_minutes,
      // The person providing the booking — driver (transport), provider
      // (service), or host (stay). That's the listing owner's own name
      // (host_name = user_profiles.display_name on listings.user_id), NOT the
      // provider_profile business name (provider_name), which a host can
      // reuse across many listings. Fall back to the business name only when
      // the person's name is missing on older rows.
      providerName: row.host_name || row.provider_name,
      // On-behalf bookings: the row's user_id may be the HOST (walk-up guest
      // with no account), so the real guest's name/phone live in the
      // guest_contact jsonb the host entered. Prefer it; fall back to the
      // guest's own profile (guest_name/guest_phone joins).
      guestName: row.guest_contact?.name || row.guest_name,
      guestPhone: row.guest_contact?.phone ?? row.guest_phone ?? undefined,
      bookedOnBehalf: !!row.booked_on_behalf,
      agreedPricePaise: row.agreed_price_paise != null ? Number(row.agreed_price_paise) : undefined,
      // Total the customer was actually charged. Backend surfaces the
      // completed-payment breakdown columns via a LATERAL join on bookings
      // queries; we recompute the total as a sum-of-lines so a stale
      // `payment.amount_paise` (we've seen it lag insurance) doesn't drift
      // away from the receipt/invoice number. Falls back to undefined when
      // the breakdown isn't available (legacy / unpaid bookings) — callers
      // then fall back to agreed_price_paise.
      totalPaidPaise: (() => {
        const subtotal = Number(row.payment_subtotal_paise);
        if (!Number.isFinite(subtotal)) return undefined;
        const platformFee = Number(row.payment_platform_fee_paise) || 0;
        const taxes = Number(row.payment_taxes_paise) || 0;
        const insurance = Number(row.payment_insurance_premium_paise) || 0;
        const discount = Number(row.payment_discount_paise) || 0;
        return Math.max(0, subtotal - discount) + platformFee + taxes + insurance;
      })(),
      roomTypeId: row.room_type_id ?? undefined,
      roomTypeName: row.room_type_name_snapshot ?? row.room_type_name ?? undefined,
      roomCount: row.room_count != null && Number.isFinite(Number(row.room_count))
        ? Math.max(1, Math.round(Number(row.room_count)))
        : undefined,
      // Transport vehicle/driver snapshots — frozen at booking time so the
      // detail/summary keeps showing the booked car even if the host edits
      // the listing later. Driver name reuses providerName above.
      vehicleModel: row.vehicle_model_snapshot ?? undefined,
      vehiclePlate: row.vehicle_plate_snapshot ?? undefined,
      vehicleColor: row.vehicle_color_snapshot ?? undefined,
      driverPhone: row.driver_phone_snapshot ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

let _instance: BookingService | null = null;
export function getBookingService(): BookingService {
  if (!_instance) _instance = new BookingService();
  return _instance;
}
