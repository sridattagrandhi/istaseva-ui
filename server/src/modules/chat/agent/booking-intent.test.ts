// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory redis stub — enough for the read-merge-write round trip.
const store = new Map<string, string>();
vi.mock('../../../common/cache/redis.js', () => ({
  redis: {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; }),
    del: vi.fn(async (k: string) => { store.delete(k); return 1; }),
  },
}));
vi.mock('../../../common/logging/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  sanitizeIntent,
  mergeIntent,
  intentFromUserText,
  intentFromToolArgs,
  intentFromToolCalls,
  readBookingIntent,
  updateBookingIntent,
  overwriteBookingIntent,
  formatBookingIntentSection,
} from './booking-intent.js';

beforeEach(() => store.clear());

describe('intentFromUserText — conservative keyword slots', () => {
  it('pins package mode from "tour packages" (the screenshot regression)', () => {
    expect(intentFromUserText('Are there any tour packages in hyderabad for the 11th?'))
      .toEqual({ transportMode: 'package' });
  });

  it('pins package mode from "sightseeing package" and "package tour"', () => {
    expect(intentFromUserText('any sightseeing packages?').transportMode).toBe('package');
    expect(intentFromUserText('looking for a package tour').transportMode).toBe('package');
  });

  it('captures passenger count ("7 passengers, pick me up from Trident")', () => {
    expect(intentFromUserText('7 passengers, and can you pick me up from Trident Hotels'))
      .toEqual({ passengerCount: 7 });
  });

  it('captures guest count and hourly/day modes', () => {
    expect(intentFromUserText('we are 3 guests')).toEqual({ guestCount: 3 });
    expect(intentFromUserText('need a driver hourly')).toEqual({ transportMode: 'hourly' });
    expect(intentFromUserText('a cab for the full day')).toEqual({ transportMode: 'day' });
  });

  it('stays empty on chatter — precision over recall', () => {
    expect(intentFromUserText('which is best rated?')).toEqual({});
    expect(intentFromUserText('')).toEqual({});
    // "package" alone (e.g. a parcel) must NOT pin transport mode
    expect(intentFromUserText('can I leave a package at the desk?')).toEqual({});
  });
});

describe('intentFromToolArgs / intentFromToolCalls — harvest what the model threaded through', () => {
  it('search_listings: category, date, transportPricingMode → transportMode', () => {
    expect(intentFromToolArgs('search_listings', {
      category: 'transport', location: 'Hyderabad', date: '2026-07-11', transportPricingMode: 'package',
    })).toEqual({ category: 'transport', date: '2026-07-11', transportMode: 'package' });
  });

  it('prepare_booking: full trip-level slot set (scheduledDate → date)', () => {
    expect(intentFromToolArgs('prepare_booking', {
      listingId: 'x', scheduledDate: '2026-07-11', transportMode: 'package',
      passengerCount: 7, pickupLocation: 'Trident Hotels, Hyderabad',
    })).toEqual({
      date: '2026-07-11', transportMode: 'package', passengerCount: 7,
      pickupLocation: 'Trident Hotels, Hyderabad',
    });
  });

  it('never harvests listing-scoped ids (stale across a listing switch → wrong booking)', () => {
    const fromPrepare = intentFromToolArgs('prepare_booking', {
      scheduledDate: '2026-07-11', transportPackageId: 'pkg-0', roomTypeId: 'r1',
    });
    expect(fromPrepare).toEqual({ date: '2026-07-11' });
  });

  it('unknown tools contribute nothing; later calls win in a multi-call turn', () => {
    expect(intentFromToolArgs('get_listing_details', { listingId: 'x' })).toEqual({});
    expect(intentFromToolCalls([
      { name: 'search_listings', args: { date: '2026-07-11' } },
      { name: 'prepare_booking', args: { scheduledDate: '2026-07-12' } },
    ])).toEqual({ date: '2026-07-12' });
  });
});

describe('sanitizeIntent / mergeIntent', () => {
  it('drops garbage values instead of persisting them as facts', () => {
    expect(sanitizeIntent({
      transportMode: 'rocket', date: 'the 11th', passengerCount: 900,
      pickupLocation: 'ab', startTime: '9am', guestCount: 2,
    })).toEqual({ guestCount: 2 });
  });

  it('merge: patch wins, undefined never erases', () => {
    expect(mergeIntent(
      { transportMode: 'package', date: '2026-07-11' },
      { date: '2026-07-12', passengerCount: 7 },
    )).toEqual({ transportMode: 'package', date: '2026-07-12', passengerCount: 7 });
  });
});

describe('update/read round trip + context block', () => {
  it('accumulates slots across turns and formats the context block', async () => {
    // turn 1: user text pins the mode
    await updateBookingIntent('u1', intentFromUserText('tour packages in hyderabad for the 11th?'));
    // turn 1 tool harvest: model resolved the date onto the search call
    await updateBookingIntent('u1', intentFromToolCalls([
      { name: 'search_listings', args: { category: 'transport', date: '2026-07-11' } },
    ]));
    const intent = await readBookingIntent('u1');
    expect(intent).toEqual({ transportMode: 'package', category: 'transport', date: '2026-07-11' });
    const block = formatBookingIntentSection(intent);
    expect(block).toContain('do NOT re-ask');
    expect(block).toContain('"transportMode":"package"');
    expect(block).toContain('"date":"2026-07-11"');
  });

  it('empty patch does not create a key; empty intent renders no block', async () => {
    const intent = await updateBookingIntent('u2', {});
    expect(intent).toEqual({});
    expect(store.size).toBe(0);
    expect(formatBookingIntentSection({})).toBeNull();
  });

  it('overwrite: a fresh chat replaces (or clears) the previous conversation\'s slots', async () => {
    await updateBookingIntent('u3', { transportMode: 'package', date: '2026-07-11' });
    // New chat, first message mentions nothing → previous slots must NOT leak in
    expect(await overwriteBookingIntent('u3', {})).toEqual({});
    expect(await readBookingIntent('u3')).toEqual({});
    // New chat whose first message pins a slot → only that slot survives
    await updateBookingIntent('u3', { transportMode: 'package', passengerCount: 7 });
    expect(await overwriteBookingIntent('u3', { guestCount: 2 })).toEqual({ guestCount: 2 });
    expect(await readBookingIntent('u3')).toEqual({ guestCount: 2 });
  });
});
