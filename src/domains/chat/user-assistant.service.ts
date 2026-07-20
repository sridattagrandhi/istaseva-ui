import { apiRequest, getJsonHeaders } from "@/lib/api-client";
import type { ServiceResult } from "@/types/domain";

export type UserAssistantActionType =
  | "navigate"
  | "search"
  | "open_listing"
  // Phase: on-page agency — scroll to + flash a listing card on the grid the
  // user is browsing; falls back to opening the detail page when off-screen.
  | "highlight_listing"
  | "start_booking"
  // Legacy: agent emits this and frontend calls /api/assistant/prepare-booking
  // to actually create the hold. Still supported for the non-tool-loop path.
  | "prepare_booking"
  // Phase 2: agent loop has ALREADY called the prepare_booking tool which
  // created the hold + order; params is the full PrepareBookingResult, ready
  // to render in BookingConfirmCard with no second backend call.
  | "prepare_booking_done"
  // Phase 2: agent surfaces a cancel preview, UI shows a Confirm-cancel card.
  | "confirm_cancel_booking"
  // Phase 2: agent surfaces a host-message draft, UI shows a Confirm-send card.
  | "confirm_message_host"
  // Phase 2: agent already toggled the wishlist server-side via the
  // toggle_wishlist tool; the UI syncs SavedContext so hearts + the Saved
  // tab reflect it immediately (no second backend write).
  | "wishlist_updated"
  // Phase 2: agent read the user's bookings (get_user_bookings) and we render
  // them as an inline list in chat instead of bouncing to the dashboard.
  | "show_bookings"
  // Compact dashboard-insights strip (spend / counts / next trip), rendered
  // inline from a get_booking_insights tool result.
  | "show_insights"
  | "view_bookings"
  | "become_host"
  // Sathi found options; render inline cards in the chat. The user
  // chooses Open/Book per card — no auto-navigation.
  | "show_listing_cards"
  // Deep-link to a filtered Explore / Services / Transport page, with
  // filters carried in the URL so back-navigation restores them.
  | "apply_filters"
  // A write tool refused because the user isn't signed in; route them
  // to /login and remember the return URL.
  | "auth_required"
  | "none";

export interface UserAssistantAction {
  type: UserAssistantActionType;
  params?: Record<string, any>;
}

export interface UserAssistantResult {
  message: string;
  action?: UserAssistantAction;
  suggestions?: string[];
  /** Phase 5: telemetry array for tool calls. Used as a fallback when
   *  the realtime chip channel didn't deliver events (e.g. dev without
   *  websockets). Each entry includes a chip-friendly summary. */
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; durationMs: number; ok: boolean; summary?: string }>;
  /** Phase 5: server echoes the requestId we minted so the UI can
   *  correlate received chip events with the right message bubble. */
  requestId?: string;
}

export interface PrepareBookingResult {
  bookingId: string;
  holdExpiresAt: string;
  orderId: string;
  paymentId: string;
  keyId: string;
  amount: number;
  amountPaise: number;
  currency: "INR" | "USD";
  listing: { id: string; name: string; image?: string; location?: string };
  schedule: {
    scheduledDate: string;
    startTime: string;
    endTime: string;
    /** Stays only — when the guest checks out. */
    checkOutDate?: string;
    /** Stays only — number of nights in this hold. */
    nights?: number;
  };
  /** Hotel-style stays — the room the user picked. */
  room?: { id: string; name: string; pricePerNight?: number };
  /** Transport bookings — mode-specific details for display. */
  transport?: {
    mode: "hourly" | "day" | "package";
    pickupLocation?: string;
    passengerCount?: number;
    days?: number;
    hours?: number;
    packageId?: string;
  };
  /** Whether trip protection was added on this hold + the premium (rupees). */
  insurance?: { included: boolean; amount: number };
}

export class UserAssistantService {
  async respond(params: {
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    displayLang: string;
    context?: {
      path?: string;
      surface?: "discovery" | "onboarding" | "booking-details" | "dashboard" | "other";
      listingType?: "stay" | "service" | "transport" | null;
      /** Real device location — only sent when the user granted geolocation
       *  (never the app's default placeholder). Powers "near me" requests. */
      location?: { lat: number; lng: number; city?: string; state?: string };
    };
    /** Phase 5: client-minted UUID. Allows the UI to subscribe to the
     *  chip channel before this request fires so server-side tool events
     *  reach an active subscriber. */
    requestId?: string;
  }): Promise<ServiceResult<UserAssistantResult>> {
    return apiRequest<UserAssistantResult>("/api/assistant", {
      method: "POST",
      headers: getJsonHeaders(),
      // platform lets the agent know the on-page tools (filter_marketplace,
      // locate_listing) have a real grid to operate on here.
      body: JSON.stringify({ ...params, context: { ...(params.context ?? {}), platform: "web" } }),
    });
  }

  /**
   * Creates a real pending booking hold + Razorpay order in one call,
   * then returns everything the UI needs to launch checkout inline.
   * The backend looks up the listing's authoritative price — the agent's
   * role is just to decide *which* listing and *when*.
   */
  async prepareBooking(params: {
    listingId: string;
    scheduledDate: string;
    // Stays only — check-out date for multi-night ranges. Services/transport ignore this.
    checkOutDate?: string;
    startTime?: string;
    endTime?: string;
    notes?: string;
    insuranceOptIn?: boolean;
    roomTypeId?: string;
    guestCount?: number;
    serviceMode?: "at-home" | "visit-provider" | "online";
    serviceAddress?: string;
    serviceHours?: number;
    serviceAddOnIds?: string[];
    transportMode?: "hourly" | "day" | "package";
    transportHours?: number;
    transportDays?: number;
    transportPackageId?: string;
    pickupLocation?: string;
    passengerCount?: number;
  }): Promise<ServiceResult<PrepareBookingResult>> {
    // Backend returns { success, data: PrepareBookingResult } — apiRequest
    // wraps that response body as its own `data`, so we need one unwrap.
    const res = await apiRequest<{ success: boolean; data: PrepareBookingResult }>(
      "/api/assistant/prepare-booking",
      {
        method: "POST",
        headers: getJsonHeaders(),
        body: JSON.stringify(params),
      },
    );
    if (!res.success || !res.data?.data) {
      return { success: false, error: res.error || "Unable to prepare booking" };
    }
    return { success: true, data: res.data.data };
  }
}

let _instance: UserAssistantService | null = null;
export function getUserAssistantService() {
  if (!_instance) _instance = new UserAssistantService();
  return _instance;
}
