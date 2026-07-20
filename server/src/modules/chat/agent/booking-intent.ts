/**
 * Conversation-scoped booking-intent slots — structured memory of what the
 * user has ALREADY told us (mode, date, party size, pickup…), carried across
 * turns so the model never re-asks an answered question.
 *
 * Why this exists: the loop only carries text history between turns, and the
 * model must re-derive intent from raw chat every time. In practice it drops
 * facts across stage transitions — "tour packages for the 11th" in turn 1
 * became "hourly, day, or package?" five turns later. This is the customer
 * funnel's version of the onboarding agent's profile state.
 *
 * Slots are filled from two DETERMINISTIC sources (no extra LLM calls):
 *   1. Conservative keyword extraction from the user's own messages
 *      ("tour package" → transportMode=package, "7 passengers" → count).
 *   2. Args of tool calls the model executed — models echo user-given facts
 *      (date, pickup, passengers) into search/preview/prepare args.
 * The merged state is injected into the system context as "Booking intent
 * already established — treat as answered". The model is told the user's
 * NEWEST message always wins, so a change of mind overrides a stale slot.
 *
 * Deliberately EXCLUDED: listing-scoped ids (roomTypeId, transportPackageId).
 * Carried across a listing switch they could silently book the wrong room or
 * tour — trip-level facts only.
 *
 * Storage matches recent-hits: per-user Redis key, short TTL, best-effort.
 */
import { redis } from '../../../common/cache/redis.js';
import { logger } from '../../../common/logging/logger.js';

const TTL_SECONDS = 30 * 60; // parity with recent-hits — a chat-session scratchpad

export interface BookingIntent {
  category?: 'stay' | 'service' | 'transport';
  transportMode?: 'hourly' | 'day' | 'package';
  transportHours?: number;
  transportDays?: number;
  /** YYYY-MM-DD — already resolved by the model (never raw "the 11th"). */
  date?: string;
  checkOutDate?: string;
  startTime?: string;
  endTime?: string;
  passengerCount?: number;
  guestCount?: number;
  pickupLocation?: string;
  serviceMode?: 'at-home' | 'visit-provider' | 'online';
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

function key(userId: string): string {
  return `assistant:booking-intent:${userId}`;
}

/** Coerce untrusted values (LLM args / stored JSON) into valid slots; drop garbage. */
export function sanitizeIntent(raw: unknown): BookingIntent {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: BookingIntent = {};
  if (r.category === 'stay' || r.category === 'service' || r.category === 'transport') out.category = r.category;
  if (r.transportMode === 'hourly' || r.transportMode === 'day' || r.transportMode === 'package') out.transportMode = r.transportMode;
  const hours = Number(r.transportHours);
  if (Number.isFinite(hours) && hours > 0 && hours <= 24) out.transportHours = hours;
  const days = Number(r.transportDays);
  if (Number.isInteger(days) && days >= 1 && days <= 30) out.transportDays = days;
  if (typeof r.date === 'string' && DATE_RE.test(r.date)) out.date = r.date;
  if (typeof r.checkOutDate === 'string' && DATE_RE.test(r.checkOutDate)) out.checkOutDate = r.checkOutDate;
  if (typeof r.startTime === 'string' && TIME_RE.test(r.startTime)) out.startTime = r.startTime;
  if (typeof r.endTime === 'string' && TIME_RE.test(r.endTime)) out.endTime = r.endTime;
  const pax = Number(r.passengerCount);
  if (Number.isInteger(pax) && pax >= 1 && pax <= 40) out.passengerCount = pax;
  const guests = Number(r.guestCount);
  if (Number.isInteger(guests) && guests >= 1 && guests <= 40) out.guestCount = guests;
  if (typeof r.pickupLocation === 'string') {
    const pickup = r.pickupLocation.trim();
    if (pickup.length >= 3 && pickup.length <= 300) out.pickupLocation = pickup;
  }
  if (r.serviceMode === 'at-home' || r.serviceMode === 'visit-provider' || r.serviceMode === 'online') out.serviceMode = r.serviceMode;
  return out;
}

/** Newest facts win; undefined in `patch` never erases an existing slot. */
export function mergeIntent(base: BookingIntent, patch: BookingIntent): BookingIntent {
  const merged: BookingIntent = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
  }
  return merged;
}

/**
 * Conservative keyword extraction from ONE user message. Only phrasings that
 * unambiguously pin a slot in a marketplace-chat register — a false positive
 * here becomes a "fact" the model stops asking about, so precision beats
 * recall. Dates/locations are NOT text-parsed (they need IST resolution and
 * geocoding); those slots fill from tool args once the model resolves them.
 */
export function intentFromUserText(text: string): BookingIntent {
  const t = String(text ?? '').toLowerCase();
  if (!t) return {};
  const out: BookingIntent = {};
  if (/\b(?:tour|sightseeing)\s+packages?\b|\bpackage\s+tours?\b/.test(t)) {
    out.transportMode = 'package';
  } else if (/\bhourly\b|\bby the hour\b/.test(t)) {
    out.transportMode = 'hourly';
  } else if (/\bday rental\b|\bfull day\b|\bfor the (?:whole |full )?day\b/.test(t)) {
    out.transportMode = 'day';
  }
  const pax = /\b(\d{1,2})\s*(?:passengers?|pax|people|persons?)\b/.exec(t);
  if (pax) {
    const n = Number(pax[1]);
    if (n >= 1 && n <= 40) out.passengerCount = n;
  }
  const guests = /\b(\d{1,2})\s*guests?\b/.exec(t);
  if (guests) {
    const n = Number(guests[1]);
    if (n >= 1 && n <= 40) out.guestCount = n;
  }
  return out;
}

/** Booking-relevant slots the model just threaded into a tool call. */
export function intentFromToolArgs(name: string, args: Record<string, unknown> | undefined): BookingIntent {
  if (!args) return {};
  switch (name) {
    case 'search_listings':
      return sanitizeIntent({
        category: args.category,
        date: args.date,
        checkOutDate: args.checkOutDate,
        startTime: args.startTime,
        endTime: args.endTime,
        transportMode: args.transportPricingMode,
      });
    case 'check_availability':
      return sanitizeIntent({ date: args.date });
    case 'find_available_slots':
      return sanitizeIntent({ date: args.preferredDate });
    case 'get_booking_price_preview':
      return sanitizeIntent({
        transportMode: args.transportMode,
        transportHours: args.transportHours,
        transportDays: args.transportDays,
        serviceMode: args.serviceMode,
      });
    case 'prepare_booking':
      return sanitizeIntent({
        date: args.scheduledDate,
        checkOutDate: args.checkOutDate,
        startTime: args.startTime,
        endTime: args.endTime,
        transportMode: args.transportMode,
        transportHours: args.transportHours,
        transportDays: args.transportDays,
        passengerCount: args.passengerCount,
        guestCount: args.guestCount,
        pickupLocation: args.pickupLocation,
        serviceMode: args.serviceMode,
      });
    default:
      return {};
  }
}

/** Merge the harvest of a whole turn's tool calls (declaration order — later wins). */
export function intentFromToolCalls(calls: Array<{ name: string; args: Record<string, unknown> | undefined }>): BookingIntent {
  let patch: BookingIntent = {};
  for (const call of calls) {
    patch = mergeIntent(patch, intentFromToolArgs(call.name, call.args));
  }
  return patch;
}

export async function readBookingIntent(userId: string): Promise<BookingIntent> {
  if (!userId) return {};
  try {
    const raw = await redis.get(key(userId));
    return raw ? sanitizeIntent(JSON.parse(raw)) : {};
  } catch (err) {
    logger.warn('booking-intent: read failed', { error: (err as Error).message });
    return {};
  }
}

/** Read-merge-write; returns the merged state. Best-effort — never throws. */
export async function updateBookingIntent(userId: string, patch: BookingIntent): Promise<BookingIntent> {
  const existing = await readBookingIntent(userId);
  if (Object.keys(patch).length === 0) return existing;
  const merged = mergeIntent(existing, patch);
  if (!userId) return merged;
  try {
    await redis.set(key(userId), JSON.stringify(merged), 'EX', TTL_SECONDS);
  } catch (err) {
    logger.warn('booking-intent: write failed', { error: (err as Error).message });
  }
  return merged;
}

/** Replace the stored state outright (delete when empty). Used on the FIRST
 *  user turn of a conversation so a fresh chat never inherits the previous
 *  conversation's slots from inside the TTL window. Best-effort. */
export async function overwriteBookingIntent(userId: string, intent: BookingIntent): Promise<BookingIntent> {
  if (!userId) return intent;
  try {
    if (Object.keys(intent).length === 0) {
      await redis.del(key(userId));
    } else {
      await redis.set(key(userId), JSON.stringify(intent), 'EX', TTL_SECONDS);
    }
  } catch (err) {
    logger.warn('booking-intent: overwrite failed', { error: (err as Error).message });
  }
  return intent;
}

/** System-context block, or null when nothing is established yet. */
export function formatBookingIntentSection(intent: BookingIntent): string | null {
  if (Object.keys(intent).length === 0) return null;
  return [
    'Booking intent already established in THIS conversation (from the user\'s own messages and the tool calls that acted on them) — treat every slot below as ANSWERED: do NOT re-ask it, and thread it into your tool calls (`transportPricingMode`/`date` on search_listings; mode/hours/date/passengers/pickup on previews and prepare_booking). If the user\'s newest message changes one, the newest message wins:',
    JSON.stringify(intent),
  ].join('\n');
}
