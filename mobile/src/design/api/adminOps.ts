// design/api/adminOps.ts — admin OPERATIONS client (mobile).
// Mirrors the web src/domains/admin/admin-ops.service.ts against the same
// /api/admin/* endpoints (all gated server-side by requireRole('admin')).
// The axios client injects the Firebase token, so an admin is authorized
// automatically. Mobile and web do not share types — keep these in sync with
// the backend contracts by hand.
import { api } from "@/lib/api";

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") search.set(k, String(v));
  }
  return search.toString();
}

// ── Shared ──
export interface DateFilter { from?: string; to?: string }

/** Multi-select array → comma-separated query param (the API's list format). */
const listParam = (values?: string[]) => (values && values.length ? values.join(",") : undefined);

/** Distinct filter options for the ops tabs' multi-selects — all SELECT
 *  DISTINCTs over the listings table, nothing hardcoded. */
export interface AdminFacets {
  states: string[];
  cities: Array<{ city: string; state: string | null }>;
  types: string[];
  categories: Array<{ value: string; type: string }>;
}

// ── Bookings ──
export interface AdminBookingRow {
  id: string;
  status: string;
  user_id: string;
  listing_id: string | null;
  scheduled_date: string;
  end_date: string | null;
  start_time: string | null;
  end_time: string | null;
  service_category: string | null;
  agreed_price_paise: number | null;
  created_at: string;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  booked_on_behalf: boolean;
  created_by_user_id: string | null;
  guest_contact: { name?: string; phone?: string; email?: string } | null;
  payment_link_url: string | null;
  listing_name: string | null;
  listing_type: string | null;
  guest_name: string | null;
  guest_email: string | null;
  guest_phone: string | null;
  provider_name: string | null;
  payment_amount_paise: number | null;
  payment_status: string | null;
  payment_refund_paise: number | null;
}
export interface AdminPaymentRow {
  id: string; status: string; amount_paise: number; currency: string;
  provider_ref: string | null; provider_payment_id: string | null;
  subtotal_paise: number | null; platform_fee_paise: number | null; taxes_paise: number | null;
  insurance_premium_paise: number | null; discount_paise: number | null; refund_paise: number | null;
  completed_at: string | null; created_at: string;
}
export interface AdminCancelPreview {
  bookingId: string; cancellable: boolean; currentStatus: string; policy: string;
  refundPaise: number; platformKeepsPaise: number; hostKeepsPaise: number;
  insuranceVoided: boolean; reason: string; chargedPaise?: number;
}
export interface AdminBookingDetail {
  booking: AdminBookingRow & Record<string, unknown>;
  payments: AdminPaymentRow[];
  cancelPreview: AdminCancelPreview | null;
}
export interface AdminBookingFilters extends DateFilter {
  bookingId?: string; user?: string; status?: string; bookedOnBehalf?: "true" | "false";
  /** Multi-selects: geo/type match the booked LISTING; category is the
   *  booking's service_category falling back to the listing category. */
  states?: string[]; cities?: string[]; types?: string[]; categories?: string[]; providerIds?: string[];
  limit?: number; offset?: number;
}

// ── Listings ──
export interface AdminListingRow {
  id: string; user_id: string; name: string | null; title: string | null;
  listing_type: string; category: string | null; city: string | null; state: string | null;
  is_active: boolean; is_published: boolean;
  banned_at: string | null; banned_reason: string | null; banned_by: string | null;
  archived_at: string | null; archived_reason: string | null; archived_by: string | null;
  created_at: string; updated_at: string;
  host_name: string | null; host_email: string | null; host_suspended: boolean | null;
}
export interface AdminListingFilters extends DateFilter {
  q?: string; type?: string; state?: "live" | "inactive" | "banned" | "archived"; userId?: string;
  /** Multi-selects over the listing's location/type/category (case-insensitive). */
  states?: string[]; cities?: string[]; types?: string[]; categories?: string[];
  limit?: number; offset?: number;
}

// ── Users ──
export interface AdminUserRow {
  user_id: string; display_name: string; email: string | null; phone: string | null;
  verification_status: string | null; is_suspended: boolean;
  suspended_at: string | null; suspension_reason: string | null; created_at: string;
}

// ── Fraud ──
export interface FraudSignalRow {
  id: string; user_id: string; event_type: string;
  risk_level: "low" | "medium" | "high" | "critical";
  device_id: string | null; session_id: string | null; ip_address: string | null;
  metadata: Record<string, unknown>; created_at: string;
  user_name: string | null; user_email: string | null; user_suspended: boolean | null;
}
export interface FraudSignalFilters extends DateFilter {
  userId?: string; riskLevel?: string; eventType?: string; limit?: number; offset?: number;
}
export interface SafetyAlertRow {
  id: string; user_id: string; booking_id: string | null; alert_type: string;
  description: string | null; status: string; emergency_contacts_notified: boolean; created_at: string;
}
export interface FraudUserDossier {
  profile: AdminUserRow | null; signals: FraudSignalRow[]; signalsTotal: number;
  safetyAlerts: SafetyAlertRow[]; bookingStats: Record<string, number>;
  recentBookings: AdminBookingRow[]; listings: AdminListingRow[];
}

// ── Coupons ──
export interface AdminCouponRow {
  id: string; host_user_id: string | null; is_platform: boolean; created_by: string | null;
  listing_id: string | null; category: string | null; code: string;
  discount_type: "percent" | "fixed"; discount_value: string;
  max_uses: number | null; uses_count: number; valid_from: string | null; valid_until: string | null;
  is_active: boolean; created_at: string;
  redemption_count: number; redeemed_paise: number; target_user_count: number;
  listing_name: string | null; creator_name: string | null;
}
export interface AdminCouponDetail {
  coupon: AdminCouponRow;
  targetUsers: Array<{ user_id: string; display_name: string | null; email: string | null }>;
  redemptions: Array<{
    id: string; booking_id: string | null; user_id: string; discount_paise: number;
    created_at: string; user_name: string | null; user_email: string | null; booking_status: string | null;
  }>;
}
export interface CreatePlatformCouponInput {
  code: string; discountType: "percent" | "fixed"; discountValue: number;
  maxUses?: number | null; validFrom?: string | null; validUntil?: string | null;
  listingId?: string | null; category?: "stay" | "service" | "transport" | null; userIds?: string[];
}

// ── Audit ──
export interface AdminActionRow {
  id: string; actor_user_id: string; action: string; target_type: string;
  target_id: string; reason: string | null; metadata: Record<string, unknown>; created_at: string;
}
export interface AdminActionFilters extends DateFilter {
  actor?: string; action?: string; targetType?: string; targetId?: string;
  /** Listing vertical/category facets — only listing-target rows can match. */
  types?: string[]; categories?: string[];
  limit?: number; offset?: number;
}

// ── Fees panel (platform-fee rules) ──
export interface AdminFeeRuleRow {
  id: string;
  audience: "customer" | "business";
  category: "stays" | "services" | "transport" | null;
  /** Specific service type within the vertical ('salon', 'hotel', …); null = whole vertical. */
  subcategory: string | null;
  scope_type: "global" | "state" | "city_tier" | "city" | "listing";
  scope_state: string | null;
  scope_city: string | null;
  scope_tier: string | null;
  scope_listing_id: string | null;
  listing_name?: string | null;
  percent_bps: number;
  fixed_paise: number;
  min_fee_paise: number | null;
  max_fee_paise: number | null;
  effective_from: string;
  effective_to: string | null;
  active: boolean;
  reason: string | null;
  created_at: string;
}
export interface AdminFeeTierRow { id: string; city: string; state: string; tier: "tier1" | "tier2" | "tier3" }
export interface CreateFeeRuleInput {
  audience: "customer" | "business";
  category?: "stays" | "services" | "transport" | null;
  subcategory?: string | null;
  scopeType: AdminFeeRuleRow["scope_type"];
  scopeState?: string | null;
  scopeCity?: string | null;
  scopeTier?: string | null;
  scopeListingId?: string | null;
  percentBps: number;
  fixedPaise: number;
  minFeePaise?: number | null;
  maxFeePaise?: number | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  reason?: string | null;
}
export interface FeeSimulationResult {
  matched: {
    rule: AdminFeeRuleRow | null;
    usedLegacyFallback: boolean;
    vertical: "stays" | "services" | "transport";
  };
  breakdown: {
    subtotalPaise: number;
    platformFeePaise: number;
    gstRate: number;
    taxesPaise: number;
    totalPaise: number;
  };
}

// ── Payouts ledger ──
export interface AdminOwedRow {
  providerUserId: string;
  name: string;
  email: string | null;
  pendingPaise: number;
  bookings: number;
  accountMethod: "bank" | "upi" | null;
}
/** One listing ("business") of a partner in the payouts drill-down. */
export interface AdminPartnerBusinessRow {
  listingId: string;
  name: string;
  listingType: string;
  category: string | null;
  city: string | null;
  state: string | null;
  status: "live" | "inactive" | "suspended" | "removed";
  pendingPaise: number;
  bookings: number;
}
export interface AdminPayoutRow {
  id: string;
  providerUserId: string;
  name: string;
  amountPaise: number;
  bookings: number;
  method: string;
  accountSnapshot: { accountNumberMasked?: string | null; ifsc?: string | null; upiIdMasked?: string | null; method?: string } | null;
  note: string | null;
  status: "paid" | "reversed";
  createdAt: string;
}

async function get<T>(path: string): Promise<T> {
  const res = await api.get(path);
  return res.data as T;
}

export const adminOps = {
  facets: () => get<AdminFacets>(`/api/admin/facets`),
  bookings: {
    search: ({ states, cities, types, categories, providerIds, ...f }: AdminBookingFilters) =>
      get<{ bookings: AdminBookingRow[]; total: number }>(`/api/admin/bookings?${qs({
        ...f,
        states: listParam(states),
        cities: listParam(cities),
        types: listParam(types),
        categories: listParam(categories),
        providerIds: listParam(providerIds),
      })}`),
    detail: (id: string) => get<AdminBookingDetail>(`/api/admin/bookings/${id}`),
    cancel: (id: string, opts: { refundMode: "policy" | "full"; reason: string }) =>
      api.post(`/api/admin/bookings/${id}/cancel`, opts).then((r) => r.data),
  },
  listings: {
    search: ({ states, cities, types, categories, ...f }: AdminListingFilters) =>
      get<{ listings: AdminListingRow[]; total: number }>(`/api/admin/listings?${qs({
        ...f,
        states: listParam(states),
        cities: listParam(cities),
        types: listParam(types),
        categories: listParam(categories),
      })}`),
    detail: (id: string) =>
      get<{ listing: Record<string, unknown>; host: AdminUserRow | null }>(`/api/admin/listings/${id}`),
    ban: (id: string, reason: string) => api.post(`/api/admin/listings/${id}/ban`, { reason }).then((r) => r.data),
    unban: (id: string, reason?: string) => api.post(`/api/admin/listings/${id}/unban`, { reason }).then((r) => r.data),
    /** Takedown ("delete") = soft archive — the only listing-removal path. */
    archive: (id: string, reason: string) => api.post(`/api/admin/listings/${id}/archive`, { reason }).then((r) => r.data),
    unarchive: (id: string, reason?: string) => api.post(`/api/admin/listings/${id}/unarchive`, { reason }).then((r) => r.data),
  },
  users: {
    search: (q: string, limit = 20) => get<{ users: AdminUserRow[] }>(`/api/admin/users?${qs({ q, limit })}`),
    get: (userId: string) => get<AdminUserRow>(`/api/admin/users/${encodeURIComponent(userId)}`),
    suspend: (userId: string, reason: string) =>
      api.post(`/api/admin/users/${encodeURIComponent(userId)}/suspend`, { reason }).then((r) => r.data),
    unsuspend: (userId: string, reason?: string) =>
      api.post(`/api/admin/users/${encodeURIComponent(userId)}/unsuspend`, { reason }).then((r) => r.data),
  },
  fraud: {
    signals: (f: FraudSignalFilters) =>
      get<{ signals: FraudSignalRow[]; total: number }>(`/api/admin/fraud/signals?${qs({ ...f })}`),
    eventTypes: () => get<{ eventTypes: string[] }>(`/api/admin/fraud/event-types`),
    userDossier: (userId: string) => get<FraudUserDossier>(`/api/admin/fraud/users/${encodeURIComponent(userId)}`),
  },
  coupons: {
    list: (f: { q?: string; scope?: "platform" | "host"; active?: "true" | "false"; limit?: number; offset?: number }) =>
      get<{ coupons: AdminCouponRow[]; total: number }>(`/api/admin/coupons?${qs({ ...f })}`),
    detail: (id: string) => get<AdminCouponDetail>(`/api/admin/coupons/${id}`),
    create: (input: CreatePlatformCouponInput) => api.post(`/api/admin/coupons`, input).then((r) => r.data),
    setActive: (id: string, isActive: boolean, reason?: string) =>
      api.patch(`/api/admin/coupons/${id}`, { isActive, reason }).then((r) => r.data),
  },
  audit: {
    actions: ({ types, categories, ...f }: AdminActionFilters) =>
      get<{ actions: AdminActionRow[]; total: number }>(`/api/admin/audit/actions?${qs({
        ...f, types: listParam(types), categories: listParam(categories),
      })}`),
    events: (query: { userId?: string; resource?: string; resourceId?: string; from?: string; to?: string }) =>
      get<{ events: Record<string, unknown>[]; truncated: boolean }>(`/api/admin/audit/events?${qs({ ...query })}`),
  },
  fees: {
    rules: {
      list: (f: { audience?: string; category?: string; subcategory?: string; scopeType?: string; includeInactive?: boolean } = {}) =>
        get<{ rules: AdminFeeRuleRow[] }>(`/api/admin/fees/rules?${qs({
          audience: f.audience, category: f.category, subcategory: f.subcategory, scopeType: f.scopeType,
          includeInactive: f.includeInactive ? "true" : undefined,
        })}`),
      create: (input: CreateFeeRuleInput) => api.post(`/api/admin/fees/rules`, input).then((r) => r.data),
      /** Edit-as-replace: retires ruleId and creates the edited version atomically. */
      replace: (ruleId: string, input: CreateFeeRuleInput) =>
        api.post(`/api/admin/fees/rules/${ruleId}/replace`, input).then((r) => r.data),
      deactivate: (ruleId: string, reason?: string) =>
        api.post(`/api/admin/fees/rules/${ruleId}/deactivate`, { reason }).then((r) => r.data),
    },
    tiers: {
      list: () => get<{ tiers: AdminFeeTierRow[] }>(`/api/admin/fees/tiers`),
      upsert: (input: { city: string; state: string; tier: string }) =>
        api.post(`/api/admin/fees/tiers`, input).then((r) => r.data),
      remove: (id: string) => api.delete(`/api/admin/fees/tiers/${id}`).then((r) => r.data),
    },
    simulate: (input: { audience?: "customer" | "business"; category?: string | null; city?: string | null; state?: string | null; subtotalPaise: number }) =>
      api.post(`/api/admin/fees/simulate`, input).then((r) => r.data as FeeSimulationResult),
  },
  payouts: {
    summary: () => get<{ owed: AdminOwedRow[] }>(`/api/admin/payouts/summary`),
    /** Drill-down: one partner's businesses (their listings) with per-listing owed money. */
    partnerBusinesses: (providerUserId: string) =>
      get<{ businesses: AdminPartnerBusinessRow[] }>(`/api/admin/payouts/partner/${encodeURIComponent(providerUserId)}/businesses`),
    ledger: (f: { providerUserId?: string; limit?: number } = {}) =>
      get<{ payouts: AdminPayoutRow[] }>(`/api/admin/payouts?${qs({ ...f })}`),
    record: (providerUserId: string, note?: string) =>
      api.post(`/api/admin/payouts`, { providerUserId, note }).then((r) => r.data),
  },
};
