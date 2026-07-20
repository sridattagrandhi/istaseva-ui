import { NotFoundError, ListingNotReadyError, ValidationError } from '../../../common/errors/app-error.js';
import { runListingGuardrails, formatGuardrailIssues } from '../../../common/guardrails/listing-guardrails.js';
import { listingsRepository } from '../repositories/listings.repository.js';
import { roomTypesRepository } from '../repositories/room-types.repository.js';
import { providersRepository } from '../../providers/repositories/providers.repository.js';
import { trackServerEvent } from '../../analytics/services/analytics-track.js';
import { verificationRepository } from '../../verification/repositories/verification.repository.js';
import { smartScheduleService, dayOfWeekForYmd } from '../../providers/services/smart-schedule.service.js';
import { bookingsRepository } from '../../bookings/repositories/bookings.repository.js';
import { geocodeAddress, buildAddressString } from '../../../common/services/geocode.service.js';
import { ensureCityState } from '../../../common/services/india-location.js';
import { logger } from '../../../common/logging/logger.js';
import { cacheGet, cacheSet } from '../../../common/cache/redis.js';
import { approximateListingGeo } from './listing-geo-privacy.js';
import { scanAddressInProse } from '../../../common/guardrails/address-in-prose.js';
import { storageService } from '../../infrastructure/services/storage.service.js';
import { validateListingReadiness } from './listing-readiness.js';

/**
 * Rewrites direct S3 image URLs on a listing row to media CDN URLs.
 * No-ops when S3_PUBLIC_BASE_URL is not configured (local dev).
 */
function rewriteListingImageUrls<T extends Record<string, unknown>>(row: T): T {
  if (!row) return row;
  return {
    ...row,
    image_url: storageService.rewriteS3UrlToCdn(row.image_url as string | null),
    images: storageService.rewriteS3UrlArrayToCdn(row.images as string[] | null),
    photos: storageService.rewriteS3UrlArrayToCdn(row.photos as string[] | null),
  };
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(n) && n !== 0 ? n : null;
}

const TRANSPORT_CATEGORIES = new Set(['auto', 'cab', 'van', 'bike', 'tempo', 'driver-auto', 'driver-cab']);
const STAY_CATEGORIES = new Set(['hotel', 'homestay', 'lodge', 'village-stay', 'farm-stay', 'heritage', 'sathram', 'stay']);

/**
 * Fields whose value can change whether a listing is "ready". A patch that
 * only touches non-readiness fields (e.g. discount_percent, image_url
 * thumbnail) on an active listing is allowed to save without re-running the
 * full validator. `metadata` is included because mode-specific gates (e.g.
 * serviceModes, packageOptions, pricePerHour) live inside it.
 */
const READINESS_FIELDS = new Set([
  'name', 'title', 'category', 'listing_type', 'description',
  'location', 'address', 'city', 'state',
  'price', 'price_per_night',
  'bedrooms', 'bathrooms', 'max_guests',
  'availability', 'photos', 'images',
  'property_type', 'vehicle_name', 'vehicle_year',
  'metadata', 'service_area',
]);

function payloadTouchesReadiness(payload: Record<string, unknown>): boolean {
  for (const key of Object.keys(payload)) {
    if (READINESS_FIELDS.has(key)) return true;
  }
  return false;
}

/**
 * Single source of truth for the listing kind. Mirrors the migration backfill
 * exactly so a row's `listing_type` matches whatever the UI/adapters infer.
 *
 *   1. metadata.listingType is explicit (set by onboarding) — use it.
 *   2. Vehicle fields or transport categories → 'transport'.
 *   3. Property fields or stay categories → 'stay'.
 *   4. Otherwise: 'service'.
 */
function derivelistingType(payload: Record<string, unknown>): 'stay' | 'service' | 'transport' {
  const meta = payload.metadata as Record<string, unknown> | undefined;
  const explicit = typeof meta?.listingType === 'string' ? meta.listingType : undefined;
  if (explicit === 'stay' || explicit === 'service' || explicit === 'transport') return explicit;

  const category = typeof payload.category === 'string' ? payload.category : '';
  // Phase 3: a non-empty `metadata.transportationTypes` array is a strong
  // signal this is a transport listing — covers the new catalog ids
  // (sedan_cab, tempo_traveller, airport_transfer, ...) without having to
  // enumerate them server-side.
  const transportationTypes = meta?.transportationTypes;
  if (Array.isArray(transportationTypes) && transportationTypes.length > 0) return 'transport';
  if (payload.vehicle_name || TRANSPORT_CATEGORIES.has(category)) return 'transport';
  if (payload.property_type || payload.price_per_night || STAY_CATEGORIES.has(category) || category.startsWith('stay:')) return 'stay';
  return 'service';
}

/**
 * If the payload lacks valid lat/lng, try to fill them in by geocoding the address.
 * Mutates `payload` in place. Never throws — geocoding failures are logged and ignored.
 */
async function ensureCoordinates(payload: Record<string, unknown>): Promise<void> {
  const lat = toNumber(payload.lat);
  const lng = toNumber(payload.lng);
  if (lat !== null && lng !== null) return;

  const address = buildAddressString(payload);
  if (!address) return;

  const result = await geocodeAddress(address);
  if (result) {
    payload.lat = result.lat;
    payload.lng = result.lng;
    logger.info('Auto-geocoded listing address', { address, lat: result.lat, lng: result.lng });
  }
}

/**
 * Derive the listing's neighbourhood ("Kukatpally") from the host's STATED
 * location — never from the coordinate. Mutates `payload` in place. Never
 * throws: geocoding must not block listing creation.
 *
 * The self-limiting property is the point. Forward-geocoding what the host
 * actually typed returns a sublocality only when the host was specific enough
 * to name one: "Hyderabad, Telangana" yields nothing, so `area` stays null and
 * the public label degrades to "Hyderabad, Telangana" — exactly what it was
 * before. Reverse-geocoding the stored lat/lng would instead ALWAYS name some
 * neighbourhood, inventing precision the host never gave (a city-only listing
 * carries a city-centroid coord, which would confidently label a Whitefield
 * stay "Majestic", with no way for the host to correct it).
 *
 * Call BEFORE ensureCityState: that helper mutates city/state, which changes
 * buildAddressString's output and would miss the geocode cache entry
 * ensureCoordinates just populated with the identical query.
 */
async function ensureArea(payload: Record<string, unknown>): Promise<void> {
  if (typeof payload.area === 'string' && payload.area.trim()) return;

  const address = buildAddressString(payload);
  if (!address) return;

  const result = await geocodeAddress(address);
  const area = result?.area?.trim();
  if (!area) return;
  payload.area = area;
  logger.info('Derived listing area', { address, area });
}

/**
 * WS6 guard: a listing must carry a derived city or state, because public
 * reads rebuild the display location from those columns (never the raw
 * free-text `location`, which can hold a full street address). Runs after
 * ensureCityState, so this only fires when derivation genuinely found
 * nothing — the fix is for the host to state the city, not for us to guess.
 *
 * Deliberately no equivalent for `area`: a null area is normal (most hosts
 * state only a city) and the label degrades cleanly, so requiring one would
 * reject perfectly good listings.
 */
function requireCityOrState(payload: Record<string, unknown>): void {
  const has = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
  if (has(payload.city) || has(payload.state)) return;
  throw new ValidationError(
    "We couldn't determine this listing's city — please include the city and state in the location (for example \"Tirupati, Andhra Pradesh\").",
  );
}

type AvailabilitySlot = {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
};

function parseAvailabilityToSlots(availability?: unknown): AvailabilitySlot[] {
  const value = typeof availability === 'string' ? availability.trim() : '';
  const weekdays = [1, 2, 3, 4, 5];
  const weekends = [0, 6];
  const everyday = [0, 1, 2, 3, 4, 5, 6];

  if (!value) {
    return everyday.map((dayOfWeek) => ({ dayOfWeek, startTime: '09:00', endTime: '18:00' }));
  }

  const normalized = value.toLowerCase().replace(/\s+/g, ' ').trim();

  // Preset values
  if (normalized === 'weekdays only' || normalized === 'weekdays') {
    return weekdays.map((dayOfWeek) => ({ dayOfWeek, startTime: '09:00', endTime: '18:00' }));
  }
  if (normalized === 'weekends only' || normalized === 'weekends') {
    return weekends.map((dayOfWeek) => ({ dayOfWeek, startTime: '09:00', endTime: '18:00' }));
  }
  if (normalized === '24/7 available' || normalized === '24/7') {
    return everyday.map((dayOfWeek) => ({ dayOfWeek, startTime: '00:00', endTime: '23:59' }));
  }
  if (normalized === 'available now' || normalized === 'flexible hours' || normalized === 'book in advance') {
    return everyday.map((dayOfWeek) => ({ dayOfWeek, startTime: '08:00', endTime: '20:00' }));
  }

  const dayMap: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const to24Hour = (hour: number, meridiem: string) => {
    if (meridiem.toLowerCase() === 'pm' && hour !== 12) return hour + 12;
    if (meridiem.toLowerCase() === 'am' && hour === 12) return 0;
    return hour;
  };

  // Parse time from various formats: "9 AM", "9:30 AM", "09:00", "9am"
  const parseTime = (str: string): string | null => {
    str = str.trim();
    // 24-hour format: "09:00", "14:30"
    const match24 = str.match(/^(\d{1,2}):(\d{2})$/);
    if (match24) return `${match24[1].padStart(2, '0')}:${match24[2]}`;
    // 12-hour: "9 AM", "9:30 PM", "9am", "12:30pm"
    const match12 = str.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
    if (match12) {
      const h = to24Hour(parseInt(match12[1]), match12[3]);
      const m = match12[2] || '00';
      return `${String(h).padStart(2, '0')}:${m}`;
    }
    return null;
  };

  // Day-range pattern: "Mon-Fri, 9 AM - 7 PM" or "Mon-Sun, 9:00 - 18:00" etc.
  const dayRangeMatch = normalized.match(/^(mon|tue|wed|thu|fri|sat|sun)\s*-\s*(mon|tue|wed|thu|fri|sat|sun)\s*,?\s*(.+?)\s*-\s*(.+)$/i);
  if (dayRangeMatch) {
    const startDay = dayMap[dayRangeMatch[1].slice(0, 3)];
    const endDay = dayMap[dayRangeMatch[2].slice(0, 3)];
    const startTime = parseTime(dayRangeMatch[3]);
    const endTime = parseTime(dayRangeMatch[4]);
    if (startTime && endTime) {
      const days: number[] = [];
      for (let day = startDay; ; day = (day + 1) % 7) {
        days.push(day);
        if (day === endDay) break;
      }
      return days.map((dayOfWeek) => ({ dayOfWeek, startTime, endTime }));
    }
  }

  // Just a time range without days: "9 AM - 5 PM" or "09:00 - 18:00"
  const timeOnly = normalized.match(/^(.+?)\s*-\s*(.+)$/);
  if (timeOnly) {
    const startTime = parseTime(timeOnly[1]);
    const endTime = parseTime(timeOnly[2]);
    if (startTime && endTime) {
      return everyday.map((dayOfWeek) => ({ dayOfWeek, startTime, endTime }));
    }
  }

  return everyday.map((dayOfWeek) => ({ dayOfWeek, startTime: '09:00', endTime: '18:00' }));
}

function slotsFromWorkingHours(workingHours?: unknown): AvailabilitySlot[] {
  if (!workingHours || typeof workingHours !== 'object') return [];
  const dayMap: Array<[string, number]> = [
    ['sun', 0], ['mon', 1], ['tue', 2], ['wed', 3], ['thu', 4], ['fri', 5], ['sat', 6],
  ];
  const rows: AvailabilitySlot[] = [];
  for (const [key, dayOfWeek] of dayMap) {
    const window = (workingHours as Record<string, unknown>)[String(key)];
    if (!Array.isArray(window) || window.length !== 2) continue;
    const [startTime, endTime] = window;
    if (typeof startTime !== 'string' || typeof endTime !== 'string') continue;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(endTime)) continue;
    if (startTime >= endTime) continue;
    rows.push({ dayOfWeek, startTime, endTime });
  }
  return rows;
}

function resolveAvailabilitySlots(listing: Record<string, unknown>): AvailabilitySlot[] {
  const structured = slotsFromWorkingHours((listing.metadata as Record<string, unknown> | undefined)?.workingHours);
  return structured.length > 0 ? structured : parseAvailabilityToSlots(listing.availability);
}

function decodeCursor(raw?: string): { updatedAt: string; id: string } | undefined {
  if (!raw) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (decoded && typeof decoded.u === 'string' && typeof decoded.i === 'string') {
      return { updatedAt: decoded.u, id: decoded.i };
    }
  } catch {
    // Bad cursor — fall through and return the first page.
  }
  return undefined;
}

function encodeCursor(row: { updated_at: unknown; id: unknown }): string {
  const u = row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at);
  return Buffer.from(JSON.stringify({ u, i: String(row.id) }), 'utf8').toString('base64url');
}

export class ListingsService {
  async listPublic(filters: { type?: string; limit?: number; cursor?: string; availableWithinHours?: number; from?: string; to?: string }) {
    const limit = filters.limit ?? 20;

    // Marketplace pages are identical for every visitor with the same params
    // (nothing user-scoped in the query), and the Explore landing hammers the
    // same unfiltered first page — a 1000-user load test measured 2,504
    // fetches of this endpoint saturating the DB. A short TTL keeps a fresh
    // listing/review visible within a minute, which is acceptable for a
    // discovery grid; booking correctness is unaffected (the authoritative
    // conflict check runs at hold time, listing-scoped per CLAUDE.md).
    const cacheKey = `listings:public:v1:${filters.type ?? 'all'}:${limit}:${filters.cursor ?? '-'}:${filters.from ?? '-'}:${filters.to ?? '-'}:${filters.availableWithinHours ?? '-'}`;
    try {
      const cached = await cacheGet<{ data: Record<string, unknown>[]; nextCursor: string | null }>(cacheKey);
      if (cached) return cached;
    } catch (err) {
      // Redis being down must degrade to DB reads, never 500 the marketplace.
      logger.warn('listings page cache read failed', { err: String(err) });
    }

    // Fetch one extra row so we can tell whether another page exists without
    // a separate COUNT query.
    const result = await listingsRepository.listPublic({
      type: filters.type,
      limit: limit + 1,
      cursor: decodeCursor(filters.cursor),
      from: filters.from,
      to: filters.to,
    });
    const hasMore = result.rows.length > limit;
    let pageRows = (hasMore ? result.rows.slice(0, limit) : result.rows).map(rewriteListingImageUrls);
    if (filters.availableWithinHours && filters.availableWithinHours > 0) {
      pageRows = await this.filterByNextAvailable(pageRows, filters.availableWithinHours);
    }
    // Slot-level date filter for services/transport: drop any listing with no
    // free bookable slot in the chosen window. The stay night-clause runs in
    // SQL (repository); this is the time-of-day equivalent for the other
    // verticals. `[from, to)` with `to` exclusive (checkout-style, same wire
    // shape as stays); a one-day pick arrives as from/from+1. Semantics are
    // ANY-day: a listing stays if at least one day in the window has a free
    // slot — the right meaning for appointments/rides ("some day this week").
    if ((filters.type === 'service' || filters.type === 'transport') && filters.from) {
      pageRows = await this.filterByDateRangeAvailability(pageRows, filters.from, filters.to);
    }
    const last = hasMore ? pageRows[pageRows.length - 1] : null;
    const nextCursor = last ? encodeCursor(last as { updated_at: unknown; id: unknown }) : null;
    // Geo privacy (B1): the discovery grid is cached and shared across all
    // visitors, so it always carries APPROXIMATE geo (no street address, ~1km
    // rounded coordinates). Exact geo is served per-viewer from GET /:id to
    // the owner/admin/confirmed guest. Applied after availability filtering
    // and cursor computation, which key on the real coordinates / updated_at.
    const page = { data: pageRows.map((r) => approximateListingGeo(r as Record<string, unknown>)), nextCursor };
    try {
      await cacheSet(cacheKey, page, 60);
    } catch (err) {
      logger.warn('listings page cache write failed', { err: String(err) });
    }
    return page;
  }

  /**
   * Keep only listings whose smart-schedule next-available slot starts within
   * `hours` of now. Slots are computed per (category, lat, lng) and matched to
   * each listing by provider_profile_id when present, otherwise any slot in
   * the same category counts.
   */
  private async filterByNextAvailable(rows: Record<string, unknown>[], hours: number): Promise<Record<string, unknown>[]> {
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const nowMins = now.getHours() * 60 + now.getMinutes();
    const thresholdMins = nowMins + hours * 60;

    const cache = new Map<string, Array<{ provider_id: string; start_time: string }>>();
    const out: Record<string, unknown>[] = [];
    for (const row of rows) {
      const category = typeof row.category === 'string' ? row.category : '';
      if (!category) continue;
      const lat = typeof row.lat === 'number' ? row.lat : null;
      const lng = typeof row.lng === 'number' ? row.lng : null;
      const key = `${category}|${lat ?? ''}|${lng ?? ''}`;
      let slots = cache.get(key);
      if (!slots) {
        try {
          const result = await smartScheduleService.findSlots({
            service_category: category,
            lat: lat ?? undefined,
            lng: lng ?? undefined,
            preferred_date: today,
            duration_minutes: 60,
          });
          slots = result.slots as Array<{ provider_id: string; start_time: string }>;
        } catch (err) {
          logger.warn('availableWithinHours: smart-schedule lookup failed', { category, err });
          slots = [];
        }
        cache.set(key, slots);
      }
      const providerId = typeof row.provider_profile_id === 'string' ? row.provider_profile_id : null;
      const matching = providerId ? slots.filter((s) => s.provider_id === providerId) : slots;
      const earliest = matching.reduce((min, s) => {
        const [h, m] = s.start_time.split(':').map(Number);
        const mins = h * 60 + (m || 0);
        return mins < min ? mins : min;
      }, Infinity);
      if (earliest <= thresholdMins) out.push(row);
    }
    return out;
  }

  /**
   * Drop service/transport listings that have no free bookable slot on `date`.
   * Slot-level (not asset-level): a provider with one 9am booking is still
   * shown if the rest of the working day is open. A listing is unavailable when
   * the host blocked the day (metadata.blockedDates), it's a weekly off
   * (metadata.workingHours[dayKey] === null), or existing bookings — expanded
   * by the buffer — leave no gap long enough for one booking. Working hours
   * fall back to a generous 08:00–20:00 window when unset, so the filter errs
   * toward showing a listing (the authoritative conflict check still runs at
   * hold time). Bookings are batched into one query for the whole page.
   */
  /**
   * Range wrapper over the single-day slot filter: keeps a listing when ANY
   * day in `[from, to)` has a free bookable slot (`to` exclusive; absent or
   * degenerate `to` collapses to the single day `from`). Evaluated day by
   * day against only the still-unmatched rows, so the common case (most
   * listings free on day one) costs a single pass. Window capped at 30 days
   * — beyond that the filter stops meaning "soon" and just burns queries.
   */
  private async filterByDateRangeAvailability(
    rows: Record<string, unknown>[],
    from: string,
    to?: string,
  ): Promise<Record<string, unknown>[]> {
    if (rows.length === 0) return rows;
    const MAX_RANGE_DAYS = 30;
    const nextYmd = (ymd: string): string => {
      const d = new Date(`${ymd}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    };
    const days: string[] = [from];
    if (to) {
      let cur = nextYmd(from);
      while (cur < to && days.length < MAX_RANGE_DAYS) {
        days.push(cur);
        cur = nextYmd(cur);
      }
    }
    let unmatched = rows;
    const keep = new Set<string>();
    for (const day of days) {
      if (unmatched.length === 0) break;
      const ok = await this.filterByDateAvailability(unmatched, day);
      for (const r of ok) keep.add(String(r.id));
      unmatched = unmatched.filter((r) => !keep.has(String(r.id)));
    }
    return rows.filter((r) => keep.has(String(r.id)));
  }

  private async filterByDateAvailability(
    rows: Record<string, unknown>[],
    date: string,
  ): Promise<Record<string, unknown>[]> {
    if (rows.length === 0) return rows;
    const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
    const dayKey = DAY_KEYS[dayOfWeekForYmd(date)];
    const toMin = (t: string | null | undefined): number | null => {
      if (!t || typeof t !== 'string') return null;
      const [h, m] = t.split(':').map(Number);
      if (!Number.isFinite(h)) return null;
      return h * 60 + (Number.isFinite(m) ? m : 0);
    };

    const ids = rows.map((r) => String(r.id));
    let intervalsByListing = new Map<string, Array<{ start: number; end: number }>>();
    try {
      const booked = await bookingsRepository.bookedIntervalsForListingsOnDate(ids, date);
      for (const b of booked.rows) {
        const arr = intervalsByListing.get(b.listing_id) ?? [];
        const start = b.scheduled_date === date ? toMin(b.start_time) : null;
        const end = b.scheduled_date === date ? toMin(b.end_time) : null;
        // Same-day interval, or a multi-day booking spanning the date → treat
        // as a whole-day block so a listing occupied all day drops out.
        arr.push(start != null && end != null && end > start ? { start, end } : { start: 0, end: 24 * 60 });
        intervalsByListing.set(b.listing_id, arr);
      }
    } catch (err) {
      // A booking-lookup failure must not 500 the marketplace; fall back to
      // "don't hide anything by date" rather than dropping the whole grid.
      logger.warn('date availability: booked-intervals lookup failed', { err: String(err) });
      intervalsByListing = new Map();
    }

    const resolveWindow = (workingHours: unknown): { start: number; end: number } | null => {
      const FALLBACK = { start: 8 * 60, end: 20 * 60 };
      if (!workingHours || typeof workingHours !== 'object') return FALLBACK;
      const entry = (workingHours as Record<string, unknown>)[dayKey];
      if (entry === null) return null; // weekly off
      if (Array.isArray(entry) && entry.length === 2) {
        const s = toMin(entry[0] as string);
        const e = toMin(entry[1] as string);
        if (s != null && e != null && e > s) return { start: s, end: e };
      }
      return FALLBACK;
    };

    return rows.filter((row) => {
      const meta = (row.metadata ?? {}) as Record<string, unknown>;
      const blocks = Array.isArray(meta.blockedDates) ? (meta.blockedDates as unknown[]) : [];
      if (blocks.includes(date)) return false;
      const win = resolveWindow(meta.workingHours);
      if (!win) return false;
      const buffer = Number(meta.bufferMinutes);
      const buf = Number.isFinite(buffer) && buffer > 0 ? buffer : 0;
      // Smallest bookable unit: the service's own duration when set, else 60
      // min (the finest transport/hourly granularity). A gap must fit this.
      const durRaw = Number(meta.serviceDurationMinutes);
      const minDur = Number.isFinite(durRaw) && durRaw > 0 ? durRaw : 60;
      const intervals = (intervalsByListing.get(String(row.id)) ?? [])
        .map((iv) => ({ start: iv.start - buf, end: iv.end + buf }))
        .sort((a, b) => a.start - b.start);
      let cursor = win.start;
      for (const iv of intervals) {
        if (iv.end <= cursor) continue;
        const gapEnd = Math.min(iv.start, win.end);
        if (gapEnd - cursor >= minDur) return true;
        cursor = Math.max(cursor, iv.end);
        if (cursor >= win.end) break;
      }
      return win.end - cursor >= minDur;
    });
  }

  async listForUser(userId: string) {
    const result = await listingsRepository.listForUser(userId);
    return { data: result.rows.map(rewriteListingImageUrls) };
  }

  /**
   * GEO PRIVACY (WS6): returns the RAW row — exact coords, raw `location`
   * free text (routinely a full street address), and unscrubbed metadata.
   * The HTTP controller gates this per-viewer (owner/admin/booked → exact,
   * everyone else → approximateListingGeo). Any OTHER surface that shows the
   * result to a user who might not be booked (chat tools especially — their
   * results ship verbatim to the client via toolCalls[]) must call
   * getByIdPublic instead, or mask explicitly. find_next_availability leaked
   * exactly this way after WS6 patched three sibling tools and missed it.
   */
  async getById(id: string) {
    const result = await listingsRepository.getById(id);
    if (!result.rows[0]) throw new NotFoundError('Listing', id);
    // Hotel-style listings have multiple bookable room types attached. Other
    // stays / services / transport return an empty array — the client treats
    // the absence of rooms as "single price on the listing itself".
    const rooms = await roomTypesRepository.listForListing(id);
    const listing: Record<string, unknown> = rewriteListingImageUrls(result.rows[0] as Record<string, unknown>);
    listing.room_types = rooms.rows.map((r) => ({
      ...r,
      base_price_paise: Number(r.base_price_paise),
      photos: storageService.rewriteS3UrlArrayToCdn(r.photos as string[] | null),
    }));
    return { data: listing };
  }

  /** getById with the public (unbooked-viewer) geo mask applied — the safe
   *  default for discovery surfaces that can't run the controller's
   *  per-viewer gate. Mirrors what listPublic already does to every row. */
  async getByIdPublic(id: string) {
    const { data } = await this.getById(id);
    return { data: approximateListingGeo(data) };
  }

  /**
   * Runs the centralized readiness validator for a listing belonging to
   * `userId`. Loads room types, provider, and verification docs from the
   * repositories so the validator is the single source of truth for
   * "can this listing go live?". Returns the same `{ ready, missing }`
   * shape the validator produces.
   */
  async getReadiness(listingId: string, userId: string) {
    const result = await listingsRepository.getById(listingId);
    const listing = result.rows[0];
    // Ownership check: a non-owner querying readiness sees the same 404 as
    // they would for any other host-only listing surface. Mirrors the
    // pattern used by listing update/delete.
    if (!listing || listing.user_id !== userId) {
      throw new NotFoundError('Listing', listingId);
    }
    return await this.evaluateReadiness(listing, userId);
  }

  /**
   * Runs the validator against a listing + provider snapshot. If `rooms` is
   * provided the caller is supplying a prospective set (e.g. room-types
   * mutations that want to see "what would readiness be AFTER this edit?");
   * otherwise we load the live set from the repository.
   */
  async evaluateReadiness(
    listing: Record<string, unknown>,
    userId: string,
    rooms?: Array<{
      name: string;
      base_price_paise: string | number | null;
      max_guests: number | null;
      quantity: number | null;
      photos: string[] | null;
    }>,
  ) {
    const [liveRooms, userStatusResult, docsResult] = await Promise.all([
      rooms ? Promise.resolve(null) : roomTypesRepository.listForListing(String(listing.id)),
      verificationRepository.getVerificationStatusForUser(userId),
      verificationRepository.listDocumentsForUser(userId),
    ]);
    const roomList = rooms ?? (liveRooms?.rows ?? []).map((r) => ({
      name: r.name,
      base_price_paise: r.base_price_paise,
      max_guests: r.max_guests,
      quantity: r.quantity,
      photos: r.photos as string[] | null,
    }));
    const verificationStatus = userStatusResult.rows[0]?.verification_status ?? 'pending';
    return validateListingReadiness({
      listing,
      roomTypes: roomList,
      user: { verification_status: verificationStatus },
      documents: (docsResult.rows as Array<Record<string, unknown>>).map((d) => ({
        document_type: String(d.document_type ?? ''),
        status: String(d.status ?? ''),
      })),
    });
  }

  async create(userId: string, payload: Record<string, unknown>) {
    await ensureCoordinates(payload);
    // Neighbourhood for the public label. Runs before ensureCityState so it
    // reuses the geocode cache entry ensureCoordinates just warmed — see
    // ensureArea. Null (host stated only a city) is the normal case.
    await ensureArea(payload);
    // city/state feed the admin console's filter facets — keep them populated
    // and sane (a real Indian state, city parsed from the address text) even
    // when the onboarding path only sent a free-text `location`.
    ensureCityState(payload);
    // GEO PRIVACY (WS6): public reads rebuild the display location from
    // city/state (the raw `location` text can carry a full street address),
    // so a listing without them would show a BLANK location to browsers.
    // Enforce at the single chokepoint every onboarding path (AI, web,
    // mobile) flows through — fail loudly here, not silently later.
    requireCityOrState(payload);
    // Legal / safe / viable + India-only guardrail — the single server
    // chokepoint every onboarding path (AI, manual web, mobile) flows
    // through. Deterministic checks (prohibited content, non-India
    // location) are hard; the semantic viability check fails open (and is
    // a no-op under the dev mock LLM), so a transient model/geocode hiccup
    // never blocks a legitimate host. Runs before the row is written so
    // rejected content never lands in the DB, even as a draft.
    const guardrailIssues = await runListingGuardrails(payload, { semantic: true });
    // Blocking issues reject the payload; 'warn' issues (e.g. a street
    // address typed into the description) save fine and ride back on the
    // response so the onboarding surface can nudge the host.
    const blockingIssues = guardrailIssues.filter((i) => i.severity !== 'warn');
    if (blockingIssues.length > 0) {
      throw new ValidationError(formatGuardrailIssues(blockingIssues));
    }
    const guardrailWarnings = guardrailIssues.filter((i) => i.severity === 'warn').map((i) => i.message);
    // Stamp listing_type as a real column so the DB-level CHECK constraint
    // catches mistyped onboarding payloads instead of letting them silently
    // land as the wrong listing kind. Priority mirrors the migration:
    // explicit metadata wins, then category-based inference, finally service.
    payload.listing_type = derivelistingType(payload);
    // New listings always start inactive. Activation is gated by the
    // readiness validator on update(), so even an explicit is_active=true
    // in the create payload must not bypass KYC/photos/etc.
    payload.is_active = false;
    const result = await listingsRepository.create(userId, payload);
    const listing = result.rows[0];
    // Analytics: new listing created (provider-supply signal).
    trackServerEvent('listing_created', {
      userId,
      listingId: listing.id ? String(listing.id) : null,
      listingType: (typeof listing.listing_type === 'string' ? listing.listing_type : undefined) as 'stay' | 'service' | 'transport' | undefined,
      source: 'server',
      props: { city: typeof listing.city === 'string' ? listing.city : undefined },
    });
    const category = typeof listing.category === 'string' ? listing.category : '';
    const existingProvider = await providersRepository.getByUserId(userId);
    const providerRow = existingProvider.rows[0]
      ? (
        await providersRepository.updateServiceCategories(userId, Array.from(new Set([...(existingProvider.rows[0].service_categories || []), category].filter(Boolean))))
      ).rows[0]
      : (
        await providersRepository.create(userId, {
          display_name: listing.name || listing.title || 'Provider',
          service_categories: category ? [category] : [],
          lat: listing.lat,
          lng: listing.lng,
          service_radius_km: Number(listing.metadata?.serviceRadius || 15),
          buffer_minutes: 30,
          is_available: true,
          bio: listing.description,
        })
      ).rows[0];

    if (providerRow?.id) {
      await providersRepository.deleteAvailabilityForProvider(providerRow.id);
      const slots = resolveAvailabilitySlots(listing);
      await Promise.all(slots.map((slot) =>
        providersRepository.createAvailability(providerRow.id, slot.dayOfWeek, slot.startTime, slot.endTime)
      ));
    }

    return {
      data: { ...listing, provider_profile_id: providerRow?.id || null },
      ...(guardrailWarnings.length > 0 ? { warnings: guardrailWarnings } : {}),
    };
  }

  async update(id: string, userId: string, payload: Record<string, unknown>) {
    // WARN-ONLY prose check on edited text (same nudge as create; never
    // blocks an edit — the address belongs in the location field).
    const proseWarnings = [
      ...scanAddressInProse('name', payload.name ?? payload.title),
      ...scanAddressInProse('description', payload.description),
    ].map((i) => i.message);
    // Centralized readiness gate. We must catch three cases here:
    //   1. Inactive → active flip (activation).
    //   2. Already-active row being edited in a way that touches readiness
    //      fields (e.g. clearing photos, removing serviceModes). The edit
    //      must not leave a live listing in a broken state.
    //   3. Active row being explicitly deactivated — always allowed, the
    //      listing is hidden so invariants don't need to hold.
    // Inactive drafts are intentionally allowed to save incomplete data so
    // the host can build the listing progressively.
    const existing = (await listingsRepository.getById(id)).rows[0];
    if (!existing) throw new NotFoundError('Listing', id);
    if (existing.user_id !== userId) throw new NotFoundError('Listing', id);

    const wantsActivation = payload.is_active === true || payload.isActive === true;
    const wantsDeactivation = payload.is_active === false || payload.isActive === false;
    const wasActive = existing.is_active === true;

    const touchesReadiness = payloadTouchesReadiness(payload);
    const shouldValidate = wantsActivation
      || (wasActive && !wantsDeactivation && touchesReadiness);

    if (shouldValidate) {
      const merged = { ...existing, ...payload, is_active: true };
      const readiness = await this.evaluateReadiness(merged, userId);
      if (!readiness.ready) {
        throw new ListingNotReadyError(readiness.missing);
      }
    }

    // If the address was changed and lat/lng are missing, try to geocode
    if (
      (payload.address || payload.location || payload.city || payload.state) &&
      toNumber(payload.lat) === null &&
      toNumber(payload.lng) === null
    ) {
      // Reuse the existing row we already loaded for the gate above so the
      // geocoder sees the full merged address rather than just the patch.
      const merged = { ...existing, ...payload };
      await ensureCoordinates(merged);
      if (merged.lat !== undefined) payload.lat = merged.lat;
      if (merged.lng !== undefined) payload.lng = merged.lng;
    }

    // Any location-ish change: re-derive the neighbourhood from the NEW text.
    // `area: undefined` on the merged row forces a fresh derivation rather
    // than letting ensureArea short-circuit on the existing value — an edit
    // from "Kukatpally, Hyderabad" down to "Hyderabad" has to CLEAR the stale
    // area (null), not keep advertising a neighbourhood the host no longer
    // claims. Runs before ensureCityState for the same cache reason as create().
    if (payload.address || payload.location || payload.city || payload.state) {
      const explicitArea = typeof payload.area === 'string' && payload.area.trim().length > 0;
      if (!explicitArea) {
        const merged: Record<string, unknown> = { ...existing, ...payload, area: undefined };
        await ensureArea(merged);
        const nextArea = typeof merged.area === 'string' && merged.area.trim() ? merged.area.trim() : null;
        if (nextArea !== (existing.area ?? null)) payload.area = nextArea;
      }
    }

    // Any location-ish change: re-derive city/state over the merged row so
    // the admin facets stay clean (same rules as create()), and enforce
    // that the edit can't strip both — the public display location is built
    // from these columns (WS6), so losing them would blank the listing's
    // location for every browser.
    if (payload.address || payload.location || payload.city || payload.state) {
      const merged = { ...existing, ...payload };
      ensureCityState(merged);
      requireCityOrState(merged);
      if (merged.city !== existing.city) payload.city = merged.city;
      if (merged.state !== existing.state) payload.state = merged.state;
    }

    const result = await listingsRepository.update(id, userId, payload);
    if (!result.rows[0]) throw new NotFoundError('Listing', id);
    const listing = result.rows[0];

    // Re-sync provider profile fields when relevant ones change.
    //
    // Scheduling fields (workingHours, bufferMinutes, serviceRadius) and the
    // provider_availability rows are DELIBERATELY NOT synced from listing
    // metadata here. Hosts often run more than one listing under a single
    // provider profile — e.g. a salon and a cab — and the old sync wiped
    // the provider row + provider_availability with whatever listing was
    // saved last. That meant editing the cab's hours retroactively changed
    // the salon's schedule in smart-schedule's slot search. Each listing
    // now owns its own metadata.workingHours / bufferMinutes; smart-schedule
    // reads them from the listing when it has a listing_id (see
    // smart-schedule.service.ts's listing-scoped fallback path). The
    // provider_profile's working_hours stays whatever was set during the
    // provider's own onboarding and serves only as a host-wide default.
    //
    // What we still mirror: name / bio / lat / lng. Those are host-identity
    // fields most operators expect to stay in lockstep with their listing.
    const existingProvider = await providersRepository.getByUserId(userId);
    const providerRow = existingProvider.rows[0];
    if (providerRow?.id) {
      const updates: Record<string, unknown> = {};
      if (payload.name) updates.display_name = payload.name;
      if (payload.description) updates.bio = payload.description;
      if (payload.lat) updates.lat = payload.lat;
      if (payload.lng) updates.lng = payload.lng;
      if (Object.keys(updates).length > 0) {
        await providersRepository.update(providerRow.id, updates);
      }
    }

    return { data: listing, ...(proseWarnings.length > 0 ? { warnings: proseWarnings } : {}) };
  }

}

export const listingsService = new ListingsService();
