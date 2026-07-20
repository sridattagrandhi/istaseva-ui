/**
 * Booking address shaping (WS6).
 *
 * A street-level address is ENCOURAGED at onboarding, not required. When the
 * host never gave one, the confirmation email / web dashboard / mobile
 * bookings screen swap the address line for "message or call your host for
 * directions" — so `hasExactAddress` decides whether a booked guest is told
 * how to actually find the place. Getting it wrong is silent: the guest just
 * sees a place name where directions should have been.
 *
 * "Exact" = the text says MORE than the listing's own place columns. It is
 * checked per comma SEGMENT rather than by comparing the whole string against
 * a set of assembled permutations ("City", "City, State", "Area, City, State",
 * …): the permutation set has to enumerate every ordering and subset a host
 * might type, and silently mislabels the ones it forgot. Segment checking asks
 * the question directly — is there anything here that ISN'T the area, city, or
 * state? A real address always has a road or door number that isn't.
 */

const clean = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

export interface ListingPlaceRow {
  listing_address?: unknown;
  listing_location?: unknown;
  listing_area?: unknown;
  listing_city?: unknown;
  listing_state?: unknown;
}

export interface ListingAddressShape {
  /** The address line shown to a CONFIRMED guest — raw text preferred, since
   *  for the rows where `address` is NULL it's their only navigable address. */
  hotelAddress: string | null;
  /** False when the host gave nothing beyond area/city/state. */
  hasExactAddress: boolean;
}

export interface BookingAddressRow extends ListingPlaceRow {
  /** bookings.address — the customer's own address (at-home) or the
   *  server-snapshotted provider address (visit-provider). */
  booking_address?: unknown;
  /** bookings.notes JSON — carries serviceMode / visitAddress for services. */
  notes?: unknown;
  /** bookings.service_category ('driver-*' marks transport). Either alias. */
  service_category?: unknown;
  booking_service_category?: unknown;
}

/**
 * SINGLE source of truth for the booking-level "does the guest have a real
 * address to navigate to?" flag — every surface (dashboard, success screen,
 * mobile bookings, confirmation email) must use this. It replaced a SQL copy
 * in bookings.repository.ts that drifted from shapeListingAddress: the SQL
 * counted ANY booking address as exact (so a visit-provider booking that
 * snapshotted the masked area label read as a street address) and predated
 * the `area` column (so "Kukatpally, Hyderabad, Telangana" read as one too).
 *
 * Mode rules:
 *  - at-home / online / transport → true. The guest doesn't travel to the
 *    host's place (the address on the booking is their OWN, or there isn't
 *    one), so "message your host for directions" would be noise.
 *  - visit-provider → the snapshotted visit address must say more than the
 *    listing's own area/city/state — the masked label must NOT count.
 *  - stays / legacy rows → judge the listing's columns (shapeListingAddress).
 */
export function bookingHasExactAddress(row: BookingAddressRow): boolean {
  let notes: Record<string, unknown> | null = null;
  try {
    const parsed = typeof row.notes === 'string' && row.notes ? JSON.parse(row.notes) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) notes = parsed;
  } catch { /* legacy free-text notes */ }

  const mode = typeof notes?.serviceMode === 'string' && notes.serviceMode.trim()
    ? notes.serviceMode.trim()
    : null;
  // Any service mode where the customer does NOT travel to the provider —
  // at-home, online, and legacy spellings like "remote" — needs no
  // directions warning. Only visit-provider is warn-eligible, so unknown
  // future modes fail safe (no spurious warning) rather than falling
  // through to the stay branch.
  if (mode && mode !== 'visit-provider') return true;

  const category = String(row.service_category ?? row.booking_service_category ?? '');
  const isTransport = category.startsWith('driver-')
    || typeof notes?.transportMode === 'string'
    || typeof notes?.pickup === 'string';
  if (isTransport) return true;

  if (mode === 'visit-provider') {
    const visit = clean(row.booking_address) ?? clean(notes?.visitAddress);
    if (!visit) return false;
    // Reuse the segment rule: the visit address counts only when it says
    // more than the listing's own place names.
    return shapeListingAddress({
      listing_location: visit,
      listing_area: row.listing_area,
      listing_city: row.listing_city,
      listing_state: row.listing_state,
    }).hasExactAddress;
  }

  return shapeListingAddress(row).hasExactAddress;
}

export function shapeListingAddress(row: ListingPlaceRow): ListingAddressShape {
  // The email address line for a CONFIRMED guest: prefer the structured
  // street address, else the raw location text, then append city/state only
  // when not already contained (seed `location` is usually "City, State" —
  // blind joining rendered "Pune, Maharashtra, Pune, Maharashtra").
  const base = clean(row.listing_address) ?? clean(row.listing_location);
  const addressParts: string[] = base ? [base] : [];
  for (const part of [clean(row.listing_city), clean(row.listing_state)]) {
    if (part && !addressParts.some((p) => p.toLowerCase().includes(part.toLowerCase()))) {
      addressParts.push(part);
    }
  }

  // The listing's own place columns. `area` is the derived neighbourhood
  // ("Kukatpally") — usually null, and included here because a host typing
  // exactly "Kukatpally, Hyderabad, Telangana" has named their neighbourhood,
  // NOT given a street address, and still needs the directions hint.
  const placeNames = new Set(
    [clean(row.listing_area), clean(row.listing_city), clean(row.listing_state)]
      .filter((v): v is string => v !== null)
      .map((v) => v.toLowerCase()),
  );
  const saysNothingBeyondPlace = (value: string): boolean => {
    const segments = value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    return segments.length > 0 && segments.every((segment) => placeNames.has(segment));
  };

  const loc = clean(row.listing_location);
  const addr = clean(row.listing_address);
  // Either field saying more than the place columns counts — seed rows
  // sometimes hold a bare city name in `address` too.
  const hasExactAddress = (!!addr && !saysNothingBeyondPlace(addr))
    || (!!loc && !saysNothingBeyondPlace(loc));

  return {
    hotelAddress: addressParts.length > 0 ? addressParts.join(', ') : null,
    hasExactAddress,
  };
}
