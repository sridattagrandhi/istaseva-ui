import { apiRequest, getJsonHeaders } from "@/lib/api-client";

// Client for the admin OPS endpoints (mutations + investigation surfaces),
// as opposed to the analytics rollups in analytics/admin-metrics.service.ts.
// All routes require the `admin` role; the API enforces it independently.

export interface AdminActionRow {
  id: string;
  actor_user_id: string;
  action: string;
  target_type: string;
  target_id: string;
  reason: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface AdminActionsResponse {
  actions: AdminActionRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminActionFilters {
  actor?: string;
  action?: string;
  targetType?: string;
  targetId?: string;
  /** Listing vertical/category facets — only listing-target rows can match. */
  types?: string[];
  categories?: string[];
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

/** DynamoDB audit_events item (entity timeline). */
export interface AuditEventRecord {
  userId: string;
  action: string;
  resource: string;
  resourceId: string;
  bookingId?: string | null;
  paymentId?: string | null;
  fromStatus?: string | null;
  toStatus?: string | null;
  metadata?: Record<string, unknown>;
  timestamp: string;
}

export interface AuditEventsResponse {
  events: AuditEventRecord[];
  truncated: boolean;
}

export type AuditEventsQuery =
  | { userId: string; from?: string; to?: string }
  | { resource: string; resourceId: string; from?: string; to?: string };

export interface AdminUserRow {
  user_id: string;
  display_name: string;
  email: string | null;
  phone: string | null;
  verification_status: string | null;
  is_suspended: boolean;
  suspended_at: string | null;
  suspension_reason: string | null;
  created_at: string;
}

export interface AdminListingRow {
  id: string;
  user_id: string;
  name: string | null;
  title: string | null;
  listing_type: string;
  category: string | null;
  city: string | null;
  state: string | null;
  is_active: boolean;
  is_published: boolean;
  banned_at: string | null;
  banned_reason: string | null;
  banned_by: string | null;
  archived_at: string | null;
  archived_reason: string | null;
  archived_by: string | null;
  created_at: string;
  updated_at: string;
  host_name: string | null;
  host_email: string | null;
  host_suspended: boolean | null;
}

export interface AdminListingsResponse {
  listings: AdminListingRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminListingFilters {
  q?: string;
  type?: string;
  state?: "live" | "inactive" | "banned" | "archived";
  userId?: string;
  /** created_at range, YYYY-MM-DD, both inclusive. */
  from?: string;
  to?: string;
  /** Multi-selects over the listing's location/type/category (case-insensitive). */
  states?: string[];
  cities?: string[];
  types?: string[];
  categories?: string[];
  limit?: number;
  offset?: number;
}

export interface AdminBookingRow {
  id: string;
  status: string;
  user_id: string;
  listing_id: string | null;
  provider_id: string | null;
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

export interface AdminBookingsResponse {
  bookings: AdminBookingRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminBookingFilters {
  bookingId?: string;
  user?: string;
  listingId?: string;
  status?: string;
  bookedOnBehalf?: "true" | "false";
  from?: string;
  to?: string;
  /** Multi-selects: geo/type match the booked LISTING; category is the
   *  booking's service_category falling back to the listing category.
   *  providerIds has no UI picker (provider display names mirror listing
   *  names, so a picker read as a listing list) but the API supports it. */
  states?: string[];
  cities?: string[];
  types?: string[];
  categories?: string[];
  providerIds?: string[];
  limit?: number;
  offset?: number;
}

/** Distinct filter options for the ops screens' multi-selects — all
 *  SELECT DISTINCTs over the listings table, nothing hardcoded. */
export interface AdminFacets {
  states: string[];
  cities: Array<{ city: string; state: string | null }>;
  types: string[];
  categories: Array<{ value: string; type: string }>;
}


export interface AdminPaymentRow {
  id: string;
  status: string;
  amount_paise: number;
  currency: string;
  provider_ref: string | null;
  provider_payment_id: string | null;
  subtotal_paise: number | null;
  platform_fee_paise: number | null;
  taxes_paise: number | null;
  insurance_premium_paise: number | null;
  discount_paise: number | null;
  refund_paise: number | null;
  completed_at: string | null;
  created_at: string;
}

export interface AdminCancelPreview {
  bookingId: string;
  cancellable: boolean;
  currentStatus: string;
  policy: string;
  refundPaise: number;
  platformKeepsPaise: number;
  hostKeepsPaise: number;
  insuranceVoided: boolean;
  reason: string;
  chargedPaise?: number;
}

export interface AdminBookingDetail {
  booking: AdminBookingRow & Record<string, unknown>;
  payments: AdminPaymentRow[];
  cancelPreview: AdminCancelPreview | null;
}

export interface FraudSignalRow {
  id: string;
  user_id: string;
  event_type: string;
  risk_level: "low" | "medium" | "high" | "critical";
  device_id: string | null;
  session_id: string | null;
  ip_address: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  user_name: string | null;
  user_email: string | null;
  user_suspended: boolean | null;
}

export interface FraudSignalsResponse {
  signals: FraudSignalRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface FraudSignalFilters {
  userId?: string;
  riskLevel?: string;
  eventType?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export interface SafetyAlertRow {
  id: string;
  user_id: string;
  booking_id: string | null;
  alert_type: string;
  description: string | null;
  status: string;
  emergency_contacts_notified: boolean;
  created_at: string;
}

export interface FraudUserDossier {
  profile: AdminUserRow | null;
  signals: FraudSignalRow[];
  signalsTotal: number;
  safetyAlerts: SafetyAlertRow[];
  bookingStats: Record<string, number>;
  recentBookings: AdminBookingRow[];
  listings: AdminListingRow[];
}

export interface AdminCouponRow {
  id: string;
  host_user_id: string | null;
  is_platform: boolean;
  created_by: string | null;
  listing_id: string | null;
  category: string | null;
  code: string;
  discount_type: "percent" | "fixed";
  discount_value: string;
  max_uses: number | null;
  uses_count: number;
  valid_from: string | null;
  valid_until: string | null;
  is_active: boolean;
  created_at: string;
  redemption_count: number;
  redeemed_paise: number;
  target_user_count: number;
  listing_name: string | null;
  creator_name: string | null;
}

export interface AdminCouponsResponse {
  coupons: AdminCouponRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminCouponDetail {
  coupon: AdminCouponRow;
  targetUsers: Array<{ user_id: string; display_name: string | null; email: string | null }>;
  redemptions: Array<{
    id: string;
    booking_id: string | null;
    user_id: string;
    discount_paise: number;
    created_at: string;
    user_name: string | null;
    user_email: string | null;
    booking_status: string | null;
  }>;
}

export interface CreatePlatformCouponInput {
  code: string;
  discountType: "percent" | "fixed";
  discountValue: number;
  maxUses?: number | null;
  validFrom?: string | null;
  validUntil?: string | null;
  listingId?: string | null;
  category?: "stay" | "service" | "transport" | null;
  userIds?: string[];
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
  /** Joined listing name for listing-scope rules (list endpoint only). */
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
  deactivated_at: string | null;
}

export interface AdminFeeTierRow {
  id: string;
  city: string;
  state: string;
  tier: "tier1" | "tier2" | "tier3";
}

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
    spec: { percentBps: number; fixedPaise: number; minFeePaise: number | null; maxFeePaise: number | null; ruleId: string | null };
  };
  context: { category: string | null; city: string | null; state: string | null; listingId: string | null; listingName: string | null };
  breakdown: {
    subtotalPaise: number;
    platformFeePaise: number;
    gstRate: number;
    taxesPaise: number;
    insurancePaise: number;
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
  /** null = partner hasn't added a payout account yet. */
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
  accountSnapshot: {
    method?: string;
    accountHolder?: string | null;
    accountNumberMasked?: string | null;
    ifsc?: string | null;
    upiIdMasked?: string | null;
  } | null;
  note: string | null;
  status: "paid" | "reversed";
  createdBy: string | null;
  createdAt: string;
}

async function get<T>(path: string): Promise<T> {
  const result = await apiRequest<T>(path, { headers: getJsonHeaders(false) });
  if (!result.success || !result.data) {
    throw new Error(result.error || "Request failed");
  }
  return result.data;
}

function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  return search.toString();
}

/** Multi-select array → comma-separated query param (the API's list format). */
const listParam = (values?: string[]) => (values && values.length ? values.join(",") : undefined);

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const result = await apiRequest<T>(path, {
    method: "POST",
    headers: getJsonHeaders(),
    body: JSON.stringify(body),
  });
  if (!result.success || !result.data) {
    throw new Error(result.error || "Request failed");
  }
  return result.data;
}

async function del<T>(path: string): Promise<T> {
  const result = await apiRequest<T>(path, { method: "DELETE", headers: getJsonHeaders(false) });
  if (!result.success || !result.data) {
    throw new Error(result.error || "Request failed");
  }
  return result.data;
}

async function patch<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const result = await apiRequest<T>(path, {
    method: "PATCH",
    headers: getJsonHeaders(),
    body: JSON.stringify(body),
  });
  if (!result.success || !result.data) {
    throw new Error(result.error || "Request failed");
  }
  return result.data;
}

export const adminOps = {
  audit: {
    actions: ({ types, categories, ...filters }: AdminActionFilters) =>
      get<AdminActionsResponse>(`/api/admin/audit/actions?${qs({
        ...filters,
        types: listParam(types),
        categories: listParam(categories),
      })}`),
    events: (query: AuditEventsQuery) =>
      get<AuditEventsResponse>(`/api/admin/audit/events?${qs({ ...query })}`),
  },
  coupons: {
    list: (filters: { q?: string; scope?: "platform" | "host"; active?: "true" | "false"; limit?: number; offset?: number }) =>
      get<AdminCouponsResponse>(`/api/admin/coupons?${qs({ ...filters })}`),
    detail: (couponId: string) => get<AdminCouponDetail>(`/api/admin/coupons/${couponId}`),
    create: (input: CreatePlatformCouponInput) =>
      post<AdminCouponRow>(`/api/admin/coupons`, input as unknown as Record<string, unknown>),
    setActive: (couponId: string, isActive: boolean, reason?: string) =>
      patch<AdminCouponRow>(`/api/admin/coupons/${couponId}`, { isActive, reason }),
  },
  fees: {
    rules: {
      list: (filters: { audience?: string; category?: string; subcategory?: string; scopeType?: string; includeInactive?: boolean }) =>
        get<{ rules: AdminFeeRuleRow[] }>(`/api/admin/fees/rules?${qs({
          audience: filters.audience,
          category: filters.category,
          subcategory: filters.subcategory,
          scopeType: filters.scopeType,
          includeInactive: filters.includeInactive ? "true" : undefined,
        })}`),
      create: (input: CreateFeeRuleInput) =>
        post<{ rule: AdminFeeRuleRow }>(`/api/admin/fees/rules`, input as unknown as Record<string, unknown>),
      /** Edit-as-replace: retires ruleId and creates the edited version atomically. */
      replace: (ruleId: string, input: CreateFeeRuleInput) =>
        post<{ rule: AdminFeeRuleRow }>(`/api/admin/fees/rules/${ruleId}/replace`, input as unknown as Record<string, unknown>),
      deactivate: (ruleId: string, reason?: string) =>
        post<{ rule: AdminFeeRuleRow }>(`/api/admin/fees/rules/${ruleId}/deactivate`, { reason }),
    },
    tiers: {
      list: () => get<{ tiers: AdminFeeTierRow[] }>(`/api/admin/fees/tiers`),
      upsert: (input: { city: string; state: string; tier: string }) =>
        post<{ tier: AdminFeeTierRow }>(`/api/admin/fees/tiers`, input),
      remove: (id: string) => del<{ tier: AdminFeeTierRow }>(`/api/admin/fees/tiers/${id}`),
    },
    simulate: (input: {
      audience?: "customer" | "business";
      listingId?: string | null;
      category?: string | null;
      city?: string | null;
      state?: string | null;
      subtotalPaise: number;
      includeInsurance?: boolean;
    }) => post<FeeSimulationResult>(`/api/admin/fees/simulate`, input),
  },
  payouts: {
    summary: () => get<{ owed: AdminOwedRow[] }>(`/api/admin/payouts/summary`),
    /** Drill-down: one partner's businesses (their listings) with per-listing owed money. */
    partnerBusinesses: (providerUserId: string) =>
      get<{ businesses: AdminPartnerBusinessRow[] }>(`/api/admin/payouts/partner/${encodeURIComponent(providerUserId)}/businesses`),
    ledger: (filters: { providerUserId?: string; limit?: number } = {}) =>
      get<{ payouts: AdminPayoutRow[] }>(`/api/admin/payouts?${qs({ ...filters })}`),
    record: (providerUserId: string, note?: string) =>
      post<{ payout: { id: string; amountPaise: number; bookings: number; method: string; createdAt: string } }>(
        `/api/admin/payouts`,
        { providerUserId, note },
      ),
  },
  fraud: {
    signals: (filters: FraudSignalFilters) =>
      get<FraudSignalsResponse>(`/api/admin/fraud/signals?${qs({ ...filters })}`),
    eventTypes: () => get<{ eventTypes: string[] }>(`/api/admin/fraud/event-types`),
    userDossier: (userId: string) =>
      get<FraudUserDossier>(`/api/admin/fraud/users/${encodeURIComponent(userId)}`),
  },
  users: {
    search: (q: string, limit = 20) => get<{ users: AdminUserRow[] }>(`/api/admin/users?${qs({ q, limit })}`),
    get: (userId: string) => get<AdminUserRow>(`/api/admin/users/${encodeURIComponent(userId)}`),
    suspend: (userId: string, reason: string) =>
      post<AdminUserRow>(`/api/admin/users/${encodeURIComponent(userId)}/suspend`, { reason }),
    unsuspend: (userId: string, reason?: string) =>
      post<AdminUserRow>(`/api/admin/users/${encodeURIComponent(userId)}/unsuspend`, { reason }),
  },
  facets: () => get<AdminFacets>(`/api/admin/facets`),
  bookings: {
    search: ({ states, cities, types, categories, providerIds, ...filters }: AdminBookingFilters) =>
      get<AdminBookingsResponse>(`/api/admin/bookings?${qs({
        ...filters,
        states: listParam(states),
        cities: listParam(cities),
        types: listParam(types),
        categories: listParam(categories),
        providerIds: listParam(providerIds),
      })}`),
    detail: (bookingId: string) => get<AdminBookingDetail>(`/api/admin/bookings/${bookingId}`),
    cancel: (bookingId: string, opts: { refundMode: "policy" | "full"; reason: string }) =>
      post<{ data: Record<string, unknown> }>(`/api/admin/bookings/${bookingId}/cancel`, opts),
  },
  listings: {
    search: ({ states, cities, types, categories, ...filters }: AdminListingFilters) =>
      get<AdminListingsResponse>(`/api/admin/listings?${qs({
        ...filters,
        states: listParam(states),
        cities: listParam(cities),
        types: listParam(types),
        categories: listParam(categories),
      })}`),
    detail: (listingId: string) =>
      get<{ listing: Record<string, unknown>; host: AdminUserRow | null }>(`/api/admin/listings/${listingId}`),
    /** Assisted onboarding: create a draft listing on a KYC-verified user's
     *  account. `listing` is the same body POST /api/listings takes; `rooms`
     *  are room-type bodies for multi-room stays (created server-side as the
     *  owner, since the room-types route is ownership-checked). */
    createForUser: (targetUserId: string, listing: Record<string, unknown>, rooms: Array<Record<string, unknown>> = []) =>
      post<{ data: Record<string, unknown> }>(`/api/admin/listings/for-user`, { targetUserId, listing, rooms }),
    ban: (listingId: string, reason: string) =>
      post<AdminListingRow>(`/api/admin/listings/${listingId}/ban`, { reason }),
    unban: (listingId: string, reason?: string) =>
      post<AdminListingRow>(`/api/admin/listings/${listingId}/unban`, { reason }),
    /** Takedown ("delete") = soft archive — the only listing-removal path. */
    archive: (listingId: string, reason: string) =>
      post<AdminListingRow>(`/api/admin/listings/${listingId}/archive`, { reason }),
    unarchive: (listingId: string, reason?: string) =>
      post<AdminListingRow>(`/api/admin/listings/${listingId}/unarchive`, { reason }),
  },
};
