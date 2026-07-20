/**
 * Pricing breakdown derived from a booking + (optional) listing/provider rows.
 *
 * Used by:
 *   - InvoiceService (PDF render)
 *   - Booking-confirmed email metadata (so the receipt the customer sees in
 *     their inbox reconciles to the PDF invoice we generate on demand)
 *
 * All amounts are in paise. Caller is responsible for INR-formatting.
 */

const STAY_CATEGORIES = new Set(['hotel', 'homestay', 'lodge', 'village-stay', 'farm-stay', 'heritage', 'sathram', 'stay']);
// All transport / passenger-transport categories — they all attract the
// same 5% GST rate, so this list just decides what counts as "transport"
// for the breakdown's classification step. Must be a SUPERSET of every
// driver-* slug the FE form can produce, otherwise a `driver-scooter`
// booking falls through to the default GST classification (= wrong tax
// rate on the invoice).
//
// Lists to keep in sync when adding a driver category:
//   - src/lib/onboarding/field-registry.shared.ts  (FE listing-type inference)
//   - src/lib/onboarding-validation.ts             (FE isTransportCat)
//   - server registry's TRANSPORT_CATEGORY_PREFIX  (catches all via prefix — no change)
//   - this file
const TRANSPORT_CATEGORIES = new Set([
  // Legacy bare-vehicle slugs (pre-driver-prefix era; older bookings still
  // carry these). Keep for back-compat — `van`/`bike` are not produced by
  // current onboarding but exist on historical rows.
  'auto', 'cab', 'van', 'bike', 'tempo',
  // Current driver-* set — must match every transport category the FE
  // onboarding form can emit. driver-van / driver-bike are kept for
  // back-compat with existing bookings; bus / scooter / motorcycle are
  // current-era additions the FE recognizes.
  'driver-auto', 'driver-cab', 'driver-van', 'driver-bike', 'driver-tempo',
  'driver-bus', 'driver-scooter', 'driver-motorcycle',
  // Quote-accepted bookings stamp this category — same 5% passenger-transport
  // GST applies, so it needs to be on this list for the breakdown to classify
  // them correctly.
  'driver-quote',
]);

export interface GstClassification {
  rate: number;
  hsn: string;
  label: string;
}

export interface PricingBreakdown {
  /** Tax-inclusive amount the customer paid */
  grossPaise: number;
  /** Pre-tax value (gross / (1 + rate)) */
  taxablePaise: number;
  /** Total tax = gross - taxable */
  taxPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  interState: boolean;
  customerStateCode: string | null;
  providerStateCode: string | null;
  gst: GstClassification;
}

export function classifyGst(
  booking: Record<string, any>,
  listing: Record<string, any> | undefined,
): GstClassification {
  const explicitType = typeof listing?.listing_type === 'string' ? listing.listing_type : null;
  const category = String(booking.service_category || listing?.category || '').toLowerCase();

  const isStay = explicitType === 'stay'
    || STAY_CATEGORIES.has(category)
    || category.startsWith('stay:')
    || listing?.price_per_night != null
    || listing?.property_type != null;

  if (isStay) {
    const nightlyPaise = listing?.price_per_night != null
      ? Math.round(Number(listing.price_per_night) * 100)
      : null;
    const rate = nightlyPaise != null && nightlyPaise > 750_000 ? 0.18 : 0.12;
    return { rate, hsn: '9963', label: 'Accommodation services' };
  }

  const isTransport = explicitType === 'transport' || TRANSPORT_CATEGORIES.has(category);
  if (isTransport) {
    return { rate: 0.05, hsn: '9964', label: 'Passenger transport services' };
  }

  return { rate: 0.18, hsn: '9985', label: 'Support services' };
}

export function stateCodeFromGstin(gstin: string | null | undefined): string | null {
  if (!gstin) return null;
  const code = String(gstin).slice(0, 2);
  return /^\d{2}$/.test(code) ? code : null;
}

/**
 * GST state codes (the first two digits of a GSTIN) keyed by lowercase
 * state/UT name. Mirrored on web (`src/lib/gst-states.ts`) and mobile
 * (`mobile/src/design/gstStates.ts`) so the client tax-label preview agrees
 * with the invoice — change all three together.
 */
export const GST_STATE_CODES: Record<string, string> = {
  'jammu and kashmir': '01', 'himachal pradesh': '02', 'punjab': '03',
  'chandigarh': '04', 'uttarakhand': '05', 'haryana': '06', 'delhi': '07',
  'rajasthan': '08', 'uttar pradesh': '09', 'bihar': '10', 'sikkim': '11',
  'arunachal pradesh': '12', 'nagaland': '13', 'manipur': '14', 'mizoram': '15',
  'tripura': '16', 'meghalaya': '17', 'assam': '18', 'west bengal': '19',
  'jharkhand': '20', 'odisha': '21', 'orissa': '21', 'chhattisgarh': '22',
  'madhya pradesh': '23', 'gujarat': '24',
  'dadra and nagar haveli and daman and diu': '26', 'daman and diu': '26',
  'maharashtra': '27', 'karnataka': '29', 'goa': '30', 'lakshadweep': '31',
  'kerala': '32', 'tamil nadu': '33', 'puducherry': '34', 'pondicherry': '34',
  'andaman and nicobar islands': '35', 'telangana': '36', 'andhra pradesh': '37',
  'ladakh': '38',
};

/**
 * Best-effort GST state code from free text (a booking address or a
 * listing's `state` column). Scans for state names, longest match wins so
 * e.g. "Daman and Diu" never loses to a shorter contained name. Returns
 * null when no state name appears — callers treat that as "unknown" and
 * fall back to intra-state (CGST+SGST).
 */
export function gstStateCodeFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const hay = ` ${String(text).toLowerCase().replace(/[^a-z]+/g, ' ').trim()} `;
  let best: string | null = null;
  let bestLen = 0;
  for (const [name, code] of Object.entries(GST_STATE_CODES)) {
    if (name.length > bestLen && hay.includes(` ${name} `)) {
      best = code;
      bestLen = name.length;
    }
  }
  return best;
}

export function isInterState(
  providerStateCode: string | null,
  customerStateCode: string | null,
): boolean {
  if (!providerStateCode || !customerStateCode) return false;
  return providerStateCode !== customerStateCode;
}

export function computePricingBreakdown(
  booking: Record<string, any>,
  listing: Record<string, any> | undefined,
  providerGstin: string | null,
): PricingBreakdown {
  const gst = classifyGst(booking, listing);

  // Provider state: GSTIN prefix when registered, else the listing's `state`
  // column (host-stated, backfilled repo-wide). Customer state: GSTIN /
  // explicit metadata when present, else scanned from the booking address —
  // the address is customer-typed for at-home services and transport pickups
  // (genuine inter-state detection), and a listing-address snapshot for stays
  // (resolves to the provider's own state → intra-state, the intended
  // fallback). Unknown on either side keeps the pre-split behaviour:
  // intra-state CGST+SGST.
  const providerStateCode = stateCodeFromGstin(providerGstin)
    || gstStateCodeFromText(listing?.state != null ? String(listing.state) : null);
  const customerStateCode = stateCodeFromGstin(
    typeof booking.metadata?.customer_gstin === 'string' ? booking.metadata.customer_gstin : null,
  ) || (typeof booking.metadata?.state_code === 'string' ? booking.metadata.state_code : null)
    || gstStateCodeFromText(typeof booking.address === 'string' ? booking.address : null);
  const interState = isInterState(providerStateCode, customerStateCode);

  const grossPaise = Number(booking.agreed_price_paise || 0);
  const taxablePaise = Math.round(grossPaise / (1 + gst.rate));
  const taxPaise = grossPaise - taxablePaise;
  const cgstPaise = interState ? 0 : Math.round(taxPaise / 2);
  const sgstPaise = interState ? 0 : taxPaise - cgstPaise;
  const igstPaise = interState ? taxPaise : 0;

  return {
    grossPaise,
    taxablePaise,
    taxPaise,
    cgstPaise,
    sgstPaise,
    igstPaise,
    interState,
    customerStateCode,
    providerStateCode,
    gst,
  };
}

export function formatRupees(paise: number): string {
  return `INR ${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Customer-facing INR formatter: ₹-prefixed, Indian-style digit grouping
 * (1,00,000), no trailing zeros when the amount is a whole rupee.
 *
 *   12000   → "₹120"
 *   125200  → "₹1,252"
 *   1252050 → "₹12,520.50"
 *
 * Used by booking emails + invoices. Keeps the GST audit format
 * (formatRupees, "INR 1,252.00") separate — the latter must stay
 * predictable for reconciliation.
 *
 * Negative paise (refunds, discounts) render with a leading minus
 * preserving the ₹ prefix: "-₹500".
 */
export function formatINR(paise: number | null | undefined): string {
  const n = Number(paise);
  if (!Number.isFinite(n)) return '₹0';
  const negative = n < 0;
  const rupees = Math.abs(n) / 100;
  const hasPaise = Math.round(Math.abs(n)) % 100 !== 0;
  const formatted = rupees.toLocaleString('en-IN', {
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: 2,
  });
  return `${negative ? '-' : ''}₹${formatted}`;
}
