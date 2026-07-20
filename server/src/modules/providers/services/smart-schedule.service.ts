import { cacheGet, cacheSet, cacheDelByPattern } from '../../../common/cache/redis.js';
import { logger } from '../../../common/logging/logger.js';
import { providersRepository } from '../repositories/providers.repository.js';
import { availabilityOverridesRepository } from '../../listings/repositories/availability-overrides.repository.js';
import { getTravelTimeProvider, haversineKm, type VehicleClass } from './travel-time.js';

/**
 * Parse availability text like "Mon-Fri, 9 AM - 7 PM" to structured slots.
 * Used as a fallback when provider_availability table has no entries.
 */
function parseAvailabilityText(text: string | null | undefined): { days: number[]; start: string; end: string } | null {
  if (!text) return null;
  const normalized = text.toLowerCase().trim();

  const dayMap: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const parseTime = (str: string): string | null => {
    str = str.trim();
    const match24 = str.match(/^(\d{1,2}):(\d{2})$/);
    if (match24) return `${match24[1].padStart(2, '0')}:${match24[2]}`;
    const match12 = str.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
    if (match12) {
      let h = parseInt(match12[1]);
      if (match12[3].toLowerCase() === 'pm' && h !== 12) h += 12;
      if (match12[3].toLowerCase() === 'am' && h === 12) h = 0;
      return `${String(h).padStart(2, '0')}:${match12[2] || '00'}`;
    }
    return null;
  };

  // "Mon-Fri, 9 AM - 7 PM"
  const dayRangeMatch = normalized.match(/^(mon|tue|wed|thu|fri|sat|sun)\s*-\s*(mon|tue|wed|thu|fri|sat|sun)\s*,?\s*(.+?)\s*-\s*(.+)$/i);
  if (dayRangeMatch) {
    const startDay = dayMap[dayRangeMatch[1].slice(0, 3)];
    const endDay = dayMap[dayRangeMatch[2].slice(0, 3)];
    const start = parseTime(dayRangeMatch[3]);
    const end = parseTime(dayRangeMatch[4]);
    if (start && end) {
      const days: number[] = [];
      for (let d = startDay; ; d = (d + 1) % 7) {
        days.push(d);
        if (d === endDay) break;
      }
      return { days, start, end };
    }
  }

  // Just times: "9 AM - 5 PM"
  const timeOnly = normalized.match(/^(.+?)\s*-\s*(.+)$/);
  if (timeOnly) {
    const start = parseTime(timeOnly[1]);
    const end = parseTime(timeOnly[2]);
    if (start && end) return { days: [0, 1, 2, 3, 4, 5, 6], start, end };
  }

  // Fallback: assume everyday 8am-8pm
  return { days: [0, 1, 2, 3, 4, 5, 6], start: '08:00', end: '20:00' };
}

/**
 * Day of week (0=Sun…6=Sat) for a YYYY-MM-DD calendar date, evaluated
 * timezone-independently. We pin to UTC midnight on purpose so two
 * processes — one running in UTC, one in IST — agree on the weekday for
 * "2026-05-27" (Wednesday). `new Date('2026-05-27T00:00:00').getDay()`
 * silently varies by host TZ; this helper does not.
 */
export function dayOfWeekForYmd(ymd: string): number {
  const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return new Date(ymd).getUTCDay();
  const [, y, mo, d] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d))).getUTCDay();
}

export class SmartScheduleService {
  async findSlots(params: {
    service_category: string;
    /** When supplied, the search is scoped to this listing's provider only.
     *  Bypasses the category text-match — which silently returned no rows
     *  whenever the agent's free-text serviceCategory didn't equal the
     *  listing's stored `category` / `service_categories[]` value, and made
     *  the chat assistant tell users "all booked" when nothing was actually
     *  booked. */
    listing_id?: string;
    lat?: number;
    lng?: number;
    preferred_date: string;
    duration_minutes: number;
  }) {
    // Use a TZ-independent weekday helper that splits YYYY-MM-DD and goes
    // through Date.UTC, so two API processes — one in UTC, one in IST —
    // agree on the weekday for the same calendar date. (The original
    // `new Date('2026-05-27T00:00:00').getDay()` happens to return the
    // right value on UTC hosts because the parse-as-local Date lands on
    // UTC midnight, but the helper is more defensive and makes the
    // intent explicit.) The actual "no cleaning slot" bug was a
    // case-sensitive SQL category compare — see providers.repository.ts.
    const dayOfWeek = dayOfWeekForYmd(params.preferred_date);
    const latKey = params.lat != null ? Math.round(params.lat * 100) : 'na';
    const lngKey = params.lng != null ? Math.round(params.lng * 100) : 'na';
    const listingKey = params.listing_id ?? 'na';
    const cacheKey = `schedule:${params.service_category}:${listingKey}:${params.preferred_date}:${params.duration_minutes}:${latKey}:${lngKey}`;
    const cached = await cacheGet<any>(cacheKey);
    if (cached) return cached;

    // P3: working_hours JSONB shape is { mon: ['09:00','19:00'], ..., sun: null }.
    // We resolve the day window once here and short-circuit providers whose
    // weekly off lands on the requested date.
    const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
    const dayKey = DAY_KEYS[dayOfWeek];
    const resolveWorkingWindow = (
      workingHours: any,
      fallbackStart: string,
      fallbackEnd: string,
    ): { start: string; end: string } | null => {
      if (!workingHours || typeof workingHours !== 'object') {
        return { start: fallbackStart, end: fallbackEnd };
      }
      const entry = workingHours[dayKey];
      if (entry === null) return null;                  // weekly off
      if (Array.isArray(entry) && entry.length === 2 && entry[0] && entry[1]) {
        return { start: entry[0], end: entry[1] };
      }
      return { start: fallbackStart, end: fallbackEnd };
    };

    // First try: providers with explicit availability records.
    //
    // When listing_id is supplied, skip this query entirely — we'll go
    // straight to the listing-scoped lookup below. The category-based path
    // is best for "find me ANY masseuse" intent; once the user has picked a
    // specific listing, that listing's working_hours are the right source
    // of truth, not its provider's per-day availability rows (which most
    // hosts haven't populated and which caused the empty-slots / "all
    // booked" lie).
    const providers = params.listing_id
      ? { rows: [] as any[] }
      : await providersRepository.listAvailableProvidersWithAvailability(params.service_category, dayOfWeek);

    logger.info('Smart schedule: providers with availability', {
      serviceCategory: params.service_category,
      dayOfWeek,
      date: params.preferred_date,
      providersFound: providers.rows.length,
    });

    // Fallback: if no providers found via availability table, find providers
    // by category and use their listing availability text
    let providerSlotData: Array<{
      id: string;
      display_name: string;
      // Listing name takes precedence over the provider's brand when the
      // slot is rendered — users are picking a *service* slot, not a brand.
      listing_name: string | null;
      lat: number | null;
      lng: number | null;
      service_radius_km: number;
      buffer_minutes: number;
      avail_start: string;
      avail_end: string;
      vehicle_class: string;
      max_jobs_per_day: number;
      listing_id?: string | null;
      // True for fixed-location services (visit-provider / online) where the
      // provider never travels between customers. Those get the plain
      // working-hours grid (like the booking modal), NOT the travel-optimised
      // "smart" slots meant for mobile providers (drivers / at-home).
      fixed_location?: boolean;
    }> = [];

    // First-source: providers with a structured per-day availability row that
    // matches today's day-of-week. We still use these times verbatim — the
    // provider explicitly opted into them via the availability table.
    for (const provider of providers.rows as any[]) {
      providerSlotData.push({
        id: provider.id,
        display_name: provider.display_name,
        listing_name: provider.listing_name ?? null,
        lat: provider.lat,
        lng: provider.lng,
        service_radius_km: provider.service_radius_km || 20,
        buffer_minutes: provider.buffer_minutes || 30,
        avail_start: provider.avail_start,
        avail_end: provider.avail_end,
        vehicle_class: provider.vehicle_class || 'scooter',
        max_jobs_per_day: provider.max_jobs_per_day || 6,
        listing_id: provider.listing_id ?? null,
        // First-source rows come from the per-day availability table (mostly
        // mobile providers who opted in). Default to mobile scheduling.
        fixed_location: false,
      });
    }

    if (providerSlotData.length === 0) {
      const fallbackProviders = params.listing_id
        ? await providersRepository.listProvidersForListing(params.listing_id)
        : await providersRepository.listProvidersByCategory(params.service_category);

      logger.info('Smart schedule: fallback to working_hours / listing availability', {
        serviceCategory: params.service_category,
        fallbackProvidersFound: fallbackProviders.rows.length,
      });

      for (const provider of fallbackProviders.rows as any[]) {
        // Source priority for the day's working window:
        //   1. listing.metadata.workingHours[dayKey]  (per-listing data —
        //      always preferred when present so each listing keeps its own
        //      schedule even if the host owns multiple listings)
        //   2. listing.metadata.bufferMinutes for the per-slot stride
        //   3. provider.working_hours[dayKey]         (host-wide default
        //      kept on provider_profiles; only read when the listing's own
        //      metadata is empty)
        //   4. parseAvailabilityText(legacy free-text)
        //   5. 08:00–20:00 fallback
        //
        // Why this order: listings.service.update used to mirror the most
        // recently edited listing's workingHours into provider_profiles —
        // a cab save would silently overwrite the salon's schedule. That
        // mirror is gone. Now smart-schedule explicitly reads from the
        // listing-scoped fallback path's row (which we extended to include
        // listing_metadata) so each listing's hours are authoritative.
        const listingMeta = (provider.listing_metadata && typeof provider.listing_metadata === 'object')
          ? provider.listing_metadata as Record<string, unknown>
          : null;
        const listingWorkingHours = listingMeta && typeof listingMeta.workingHours === 'object'
          ? listingMeta.workingHours as Record<string, unknown>
          : null;
        let window = listingWorkingHours
          ? resolveWorkingWindow(listingWorkingHours, '08:00', '20:00')
          : resolveWorkingWindow(provider.working_hours, '08:00', '20:00');
        if (!window) continue; // weekly off — skip this provider for this date

        // If we fell back to provider.working_hours AND it's the default
        // (untouched), prefer the listing's free-text if it parses to
        // *something*, since that's a stronger signal than "we never asked".
        if (!listingWorkingHours) {
          const looksLikeDefault =
            provider.working_hours &&
            provider.working_hours[dayKey] &&
            provider.working_hours[dayKey][0] === '09:00' &&
            provider.working_hours[dayKey][1] === '19:00';
          if (looksLikeDefault) {
            const parsed = parseAvailabilityText(provider.listing_availability || provider.availability);
            if (parsed && parsed.days.includes(dayOfWeek)) {
              window = { start: parsed.start, end: parsed.end };
            }
          }
        }

        // Buffer minutes: listing-scoped overrides provider-scoped so a
        // listing that wants tighter back-to-back slots isn't constrained
        // by the provider's default.
        const listingBuffer = listingMeta && typeof listingMeta.bufferMinutes === 'number'
          ? Number(listingMeta.bufferMinutes)
          : null;

        providerSlotData.push({
          id: provider.id,
          display_name: provider.display_name,
          listing_name: provider.listing_name ?? null,
          lat: provider.lat,
          lng: provider.lng,
          service_radius_km: provider.service_radius_km || 20,
          buffer_minutes: (listingBuffer != null && listingBuffer >= 0)
            ? listingBuffer
            : (provider.buffer_minutes || 30),
          avail_start: window.start,
          avail_end: window.end,
          vehicle_class: provider.vehicle_class || 'scooter',
          max_jobs_per_day: provider.max_jobs_per_day || 6,
          listing_id: provider.listing_id ?? null,
          // Fixed-location service = visit-provider / online only (no at-home,
          // no transport). Such a provider stays put, so the travel-time slot
          // machinery doesn't apply — use the plain working-hours grid.
          fixed_location: (() => {
            const modes = Array.isArray(listingMeta?.serviceModes)
              ? (listingMeta!.serviceModes as unknown[]).map((m) => String(m))
              : [];
            return modes.length > 0 && modes.every((m) => m === 'visit-provider' || m === 'online');
          })(),
        });
      }
    }

    const providerIds = providerSlotData.map((p) => p.id);
    const listingIds = providerSlotData.map((p: any) => p.listing_id).filter(Boolean) as string[];
    let occupied: any[] = [];
    let blackoutSet = new Set<string>();
    // Listings whose provider blocked THIS date via the Schedule UI (per-listing
    // override table, room_type_id NULL). This is the source of truth the
    // booking modal reads and createHold enforces, so the slot finder must drop
    // these too — otherwise it offers slots the hold would later reject.
    let blockedListingSet = new Set<string>();
    if (providerIds.length > 0) {
      const [occRes, blackoutRes, listingBlockRes] = await Promise.all([
        providersRepository.listOccupiedIntervalsForProvidersOnDate(
          providerIds,
          listingIds,
          params.preferred_date,
        ),
        providersRepository.listBlackoutDatesForProviders(providerIds, params.preferred_date),
        listingIds.length > 0
          ? availabilityOverridesRepository.listListingLevelBlocksForDate(listingIds, params.preferred_date)
              .catch(() => ({ rows: [] as Array<{ listing_id: string }> }))
          : Promise.resolve({ rows: [] as Array<{ listing_id: string }> }),
      ]);
      occupied = occRes.rows;
      // Set of "providerId|date" pairs the provider has blocked off. Cheap
      // lookup inside the per-provider loop.
      blackoutSet = new Set(blackoutRes.rows.map((r: any) => `${r.provider_id}|${r.blackout_date}`));
      blockedListingSet = new Set(listingBlockRes.rows.map((r) => r.listing_id));
    }

    // Drop providers who've blocked the requested date entirely — either at the
    // provider level (legacy blackout table) or at the listing level (Schedule
    // UI / availability overrides).
    providerSlotData = providerSlotData.filter(
      (p) => !blackoutSet.has(`${p.id}|${params.preferred_date}`)
        && !((p as any).listing_id && blockedListingSet.has((p as any).listing_id)),
    );

    const travelTime = getTravelTimeProvider();

    /** Parse "HH:MM" or "HH:MM:SS" to total minutes since midnight. */
    const toMins = (t: string): number => {
      const [h, m] = t.split(':').map(Number);
      return h * 60 + (m || 0);
    };

    /**
     * Mini-TSP: given N stops the provider already has plus a candidate stop,
     * compute the total minimum-route travel time. For N≤7 we brute-force
     * permute (5040 max — sub-millisecond). For larger N we use a greedy
     * nearest-neighbor heuristic. This is what makes the algorithm "smart" —
     * it picks the slot that minimizes the provider's overall daily driving,
     * not just whichever first fits.
     */
    const totalRouteMinutes = (
      stops: Array<{ lat: number | null; lng: number | null }>,
      hourOfDay: number,
      vehicle: VehicleClass,
    ): number => {
      const valid = stops.filter((s) => s.lat != null && s.lng != null) as Array<{ lat: number; lng: number }>;
      if (valid.length < 2) return 0;
      const dist = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) =>
        travelTime.travelMinutes(a.lat, a.lng, b.lat, b.lng, { hourOfDay, vehicle }) as number;

      // For tiny N, brute-force all orderings starting from valid[0]. For
      // larger N, fall back to nearest-neighbor — TSP is NP-hard so we don't
      // pretend to be optimal, just *better than naive*.
      if (valid.length <= 7) {
        const rest = valid.slice(1);
        const permute = (arr: typeof rest): typeof rest[] => {
          if (arr.length <= 1) return [arr];
          const out: typeof rest[] = [];
          for (let i = 0; i < arr.length; i++) {
            const remaining = [...arr.slice(0, i), ...arr.slice(i + 1)];
            for (const sub of permute(remaining)) out.push([arr[i], ...sub]);
          }
          return out;
        };
        let best = Infinity;
        for (const order of permute(rest)) {
          const route = [valid[0], ...order];
          let total = 0;
          for (let i = 0; i < route.length - 1; i++) total += dist(route[i], route[i + 1]);
          if (total < best) best = total;
        }
        return best === Infinity ? 0 : best;
      }
      // Greedy nearest-neighbor for N>7.
      const remaining = [...valid.slice(1)];
      let current = valid[0];
      let total = 0;
      while (remaining.length > 0) {
        let bestIdx = 0;
        let bestD = Infinity;
        for (let i = 0; i < remaining.length; i++) {
          const d = dist(current, remaining[i]);
          if (d < bestD) { bestD = d; bestIdx = i; }
        }
        total += bestD;
        current = remaining[bestIdx];
        remaining.splice(bestIdx, 1);
      }
      return total;
    };

    const slots: any[] = [];

    for (const provider of providerSlotData) {
      // Provider service-radius gate (skip impossible providers entirely).
      let distanceToUser = 0;
      const vehicle: VehicleClass = (provider.vehicle_class as VehicleClass) || 'scooter';
      if (provider.lat && provider.lng && params.lat && params.lng) {
        distanceToUser = haversineKm(params.lat, params.lng, provider.lat, provider.lng);
        if (distanceToUser > (provider.service_radius_km || 30)) continue;
      }

      // 1. Build a sorted list of OCCUPIED intervals for THIS LISTING. Scope
      //    strictly by listing_id — the same rule the booking modal uses
      //    (listServiceBookingsForProvider: `WHERE listing_id = $1`) and the
      //    per-listing invariant in CLAUDE.md. A host owns multiple independent
      //    listings under one provider_profile (a salon + a cab, two stylists);
      //    a booking on one must NOT block another's calendar. Matching by
      //    provider_id here was the bug: a sibling listing booked 09:00–17:00
      //    blanket-blocked this listing's whole day, so the assistant reported
      //    free slots as "all booked up" while the modal showed them open.
      //    Provider-wide slot_locks (listing_id NULL in the UNION) are dropped
      //    for the same reason — they can't be attributed to this listing.
      //    Fall back to provider scoping only when this row has no listing to
      //    scope to (category-wide provider search without a specific listing).
      const providerListingId = (provider as any).listing_id ?? null;
      const busyRaw = occupied
        .filter((b: any) =>
          providerListingId
            ? b.listing_id === providerListingId
            : b.provider_id === provider.id
        )
        .map((b: any) => ({
          start: toMins(b.start_time),
          end: toMins(b.end_time),
          lat: b.lat ?? null,
          lng: b.lng ?? null,
        }))
        .sort((a, b) => a.start - b.start);

      // Merge overlapping/adjacent busy intervals so the gap-finder doesn't
      // see redundant ranges.
      const busy: typeof busyRaw = [];
      for (const iv of busyRaw) {
        const last = busy[busy.length - 1];
        if (last && iv.start <= last.end) {
          last.end = Math.max(last.end, iv.end);
        } else {
          busy.push({ ...iv });
        }
      }

      // Daily-cap gate. If today already has max_jobs_per_day distinct
      // bookings, skip this provider entirely — no more capacity. We count
      // *raw* bookings (busyRaw, pre-merge) so back-to-back jobs that happen
      // to share a boundary still count separately.
      const cap = provider.max_jobs_per_day || 6;
      if (busyRaw.length >= cap) continue;

      const [availStartH, availStartM] = provider.avail_start.split(':').map(Number);
      const [availEndH, availEndM] = provider.avail_end.split(':').map(Number);
      const availStartMin = availStartH * 60 + (availStartM || 0);
      const availEndMin = availEndH * 60 + (availEndM || 0);

      // ── Fixed-location services: plain working-hours grid (modal parity) ──
      // A visit-provider/online service doesn't travel between customers, so
      // there is no route to optimise and no inter-job travel buffer. Emit the
      // SAME grid the booking modal renders client-side: stride = duration +
      // host buffer, anchored at the opening time, dropping any slot that
      // overlaps a real booking. This is the fix for the assistant "inventing"
      // 30-min-offset times (e.g. 12:30) that the listing page never offers.
      if (provider.fixed_location) {
        const hostBuffer = Math.max(0, provider.buffer_minutes ?? 0);
        const step = Math.max(1, params.duration_minutes + hostBuffer);
        for (let s = availStartMin; s + params.duration_minutes <= availEndMin; s += step) {
          const e = s + params.duration_minutes;
          if (busy.some((b) => s < b.end && e > b.start)) continue; // booked → skip
          const startStr = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
          const endStr = `${String(Math.floor(e / 60)).padStart(2, '0')}:${String(e % 60).padStart(2, '0')}`;
          const hour = s / 60;
          const timeScore = hour >= 8 && hour <= 12 ? 0.9
                          : hour > 12 && hour <= 16 ? 0.7
                          : hour > 16 && hour <= 19 ? 0.6 : 0.4;
          slots.push({
            provider_id: provider.id,
            provider_name: provider.listing_name || provider.display_name,
            start_time: startStr,
            end_time: endStr,
            estimated_travel_minutes: 0,
            distance_km: Math.round(distanceToUser * 10) / 10,
            is_zone_optimized: false,
            score: Math.round(timeScore * 100) / 100,
          });
        }
        continue; // handled — skip the mobile travel/gap machinery below
      }

      const buffer = provider.buffer_minutes || 15;

      // 2. Invert busy intervals into FREE gaps within the working window.
      const gaps: Array<{ start: number; end: number; prev: typeof busyRaw[0] | null; next: typeof busyRaw[0] | null }> = [];
      let cursor = availStartMin;
      for (const iv of busy) {
        if (iv.end <= availStartMin) continue;
        if (iv.start >= availEndMin) break;
        if (iv.start > cursor) {
          gaps.push({
            start: cursor,
            end: Math.min(iv.start, availEndMin),
            prev: busy.find((b) => b.end === cursor) ?? null,
            next: iv,
          });
        }
        cursor = Math.max(cursor, iv.end);
      }
      if (cursor < availEndMin) {
        gaps.push({
          start: cursor,
          end: availEndMin,
          prev: busy.find((b) => b.end === cursor) ?? null,
          next: null,
        });
      }

      // 3. For each gap, compute the earliest start (after travel from prev
      //    job) and latest end (before travel to next job). Emit candidates
      //    on a 30-min stride within the feasible window.
      let lastEmittedEnd = -Infinity;
      for (const gap of gaps) {
        const userLat = params.lat ?? null;
        const userLng = params.lng ?? null;

        const travelFromPrev = (gap.prev && gap.prev.lat != null && gap.prev.lng != null && userLat != null && userLng != null)
          ? travelTime.travelMinutes(gap.prev.lat, gap.prev.lng, userLat, userLng, {
              hourOfDay: Math.floor(gap.start / 60), vehicle,
            }) as number
          : (gap.prev ? buffer : 0);

        const travelToNext = (gap.next && gap.next.lat != null && gap.next.lng != null && userLat != null && userLng != null)
          ? travelTime.travelMinutes(userLat, userLng, gap.next.lat, gap.next.lng, {
              hourOfDay: Math.floor(gap.end / 60), vehicle,
            }) as number
          : (gap.next ? buffer : 0);

        const earliestStart = gap.start + travelFromPrev + (gap.prev ? buffer : 0);
        const latestEnd = gap.end - travelToNext - (gap.next ? buffer : 0);
        if (latestEnd - earliestStart < params.duration_minutes) continue;

        // Snap earliestStart up to the next 30-min boundary so emitted slots
        // are user-friendly (10:00, 10:30 etc., not 10:13).
        const firstStart = Math.ceil(earliestStart / 30) * 30;

        for (let slotStart = firstStart; slotStart + params.duration_minutes <= latestEnd; slotStart += 30) {
          const slotEnd = slotStart + params.duration_minutes;
          // Don't emit overlapping candidates for the same provider — picking
          // one would invalidate any overlapping siblings anyway.
          if (slotStart < lastEmittedEnd) continue;

          const startStr = `${String(Math.floor(slotStart / 60)).padStart(2, '0')}:${String(slotStart % 60).padStart(2, '0')}`;
          const endStr   = `${String(Math.floor(slotEnd / 60)).padStart(2, '0')}:${String(slotEnd % 60).padStart(2, '0')}`;

          // ---------- Scoring ----------
          const maxRadius = provider.service_radius_km || 30;
          const distanceScore = Math.max(0, 1 - distanceToUser / maxRadius);

          // Time-of-day preference (mornings preferred, evenings less so).
          const hour = slotStart / 60;
          const timeScore = hour >= 8 && hour <= 12 ? 0.9
                          : hour > 12 && hour <= 16 ? 0.7
                          : hour > 16 && hour <= 19 ? 0.6 : 0.4;

          // Mini-TSP: total daily route cost if THIS slot is added.
          const stops = [
            { lat: provider.lat, lng: provider.lng },           // home base start
            ...busy.map((b) => ({ lat: b.lat, lng: b.lng })),   // existing jobs
            { lat: userLat, lng: userLng },                     // candidate
            { lat: provider.lat, lng: provider.lng },           // return home
          ];
          const routeMinutes = totalRouteMinutes(stops, Math.floor(hour), vehicle);
          // Normalize: 60 mins of total daily travel ≈ neutral (score 1.0);
          // 240 mins ≈ very poor (score 0). This rewards slots that keep the
          // provider's whole day cheap, not just slots with low individual
          // travel. THIS is what gives the algorithm true cluster-awareness.
          const routeScore = Math.max(0, 1 - Math.max(0, routeMinutes - 60) / 180);

          // Zone bonus retained for backwards-compat with frontend pill.
          const zoneOptimized = busy.some((b) => {
            if (!b.lat || !b.lng || userLat == null || userLng == null) return false;
            return haversineKm(userLat, userLng, b.lat, b.lng) < 5;
          });

          const loadScore = Math.max(0, 1 - busy.length * 0.1);
          const score =
            distanceScore * 0.30 +
            timeScore     * 0.20 +
            routeScore    * 0.35 +    // route efficiency dominates
            (zoneOptimized ? 0.10 : 0) +
            loadScore     * 0.05;

          const travelToUser = (provider.lat && provider.lng && userLat != null && userLng != null)
            ? travelTime.travelMinutes(provider.lat, provider.lng, userLat, userLng, {
                hourOfDay: Math.floor(hour), vehicle,
              }) as number
            : 15;

          slots.push({
            provider_id: provider.id,
            // Listing name beats provider display name (user is picking a
            // service offering, not a brand).
            provider_name: provider.listing_name || provider.display_name,
            start_time: startStr,
            end_time: endStr,
            estimated_travel_minutes: travelToUser,
            distance_km: Math.round(distanceToUser * 10) / 10,
            is_zone_optimized: zoneOptimized,
            score: Math.round(score * 100) / 100,
          });
          lastEmittedEnd = slotEnd;
        }
      }
    }

    slots.sort((a, b) => b.score - a.score);
    const totalProviders = new Set(slots.map((s) => s.provider_id)).size;
    const response = {
      slots: slots.slice(0, 20),
      totalProviders,
    };
    // 60s TTL — short enough that a cancellation or new booking elsewhere
    // doesn't leave stale slots visible too long. We also invalidate
    // explicitly on booking events via invalidateForDate().
    await cacheSet(cacheKey, response, 60);

    logger.info('Smart schedule: generated slots', {
      totalSlots: slots.length,
      returnedSlots: response.slots.length,
      totalProviders,
    });

    return response;
  }

  /**
   * Drop every cached schedule for a given date — call this whenever a
   * booking on that date transitions in/out of an "occupied" status, so the
   * next user fetch recomputes against fresh occupancy data.
   */
  async invalidateForDate(date: string): Promise<void> {
    try {
      await cacheDelByPattern(`schedule:*:${date}:*`);
    } catch (err) {
      logger.warn('Smart schedule cache invalidation failed', { date, err });
    }
  }
}

export const smartScheduleService = new SmartScheduleService();
