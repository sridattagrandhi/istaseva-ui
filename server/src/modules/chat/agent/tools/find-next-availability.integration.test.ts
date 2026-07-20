// @vitest-environment node
//
// DB-backed test for find_next_availability — the "soonest bookable date,
// across mode-matching listings, ranked" tool. Verifies the three bugs from
// the field report are fixed: (1) it never returns today/a booked date as
// "available", (2) a day-rate-only driver is never offered for an hourly ask,
// (3) when 15th-19th are booked it returns the 20th.
//
// Requires Postgres at localhost:5432 (docker compose up -d postgres &&
// cd server && npm run db:migrate). Run:
//   npm run test:integration
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../../../common/db/postgres.js';
import { findNextAvailability } from './find-next-availability.tool.js';

const PROVIDER = '00000000-0000-4000-b000-0000000000d1';
const USER = 'next-avail-test-user'; // no user_profiles row ⇒ passes listPublic's verified gate
const RAJI = '00000000-0000-4000-b000-0000000000d2'; // hourly, booked 15-19
const RAVI = '00000000-0000-4000-b000-0000000000d3'; // day-rate only
const ZARA = '00000000-0000-4000-b000-0000000000d4'; // hourly, rated 5, pricier
const QURI = '00000000-0000-4000-b000-0000000000d5'; // hourly, unrated, cheaper
const SVC = '00000000-0000-4000-b000-0000000000d6'; // service
const STAY = '00000000-0000-4000-b000-0000000000d7'; // stay, no room types
const DAYONLY_C = '00000000-0000-4000-b000-0000000000d8'; // day-only, isolated loc

const WH = { sun: ['09:00', '18:00'], mon: ['09:00', '18:00'], tue: ['09:00', '18:00'], wed: ['09:00', '18:00'], thu: ['09:00', '18:00'], fri: ['09:00', '18:00'], sat: ['09:00', '18:00'] };
const D = (day: number) => `2031-03-${String(day).padStart(2, '0')}`;

async function listing(id: string, type: string, name: string, location: string, metadata: Record<string, unknown>, pricePerNight?: number) {
  await pool.query(
    `INSERT INTO listings (id, user_id, listing_type, name, location, city, is_active, metadata, price_per_night)
     VALUES ($1,$2,$3,$4,$5,$5,true,$6::jsonb,$7)
     ON CONFLICT (id) DO UPDATE SET metadata = EXCLUDED.metadata, is_active = true`,
    [id, USER, type, name, location, JSON.stringify(metadata), pricePerNight ?? null],
  );
}
async function booking(listingId: string, category: string, date: string, start: string, end: string, endDate?: string) {
  await pool.query(
    `INSERT INTO bookings (user_id, provider_id, listing_id, service_category, scheduled_date, end_date, start_time, end_time, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'confirmed')`,
    [USER, PROVIDER, listingId, category, date, endDate ?? date, start, end],
  );
}
async function review(listingId: string, rating: number) {
  await pool.query(`INSERT INTO reviews (user_id, stay_id, rating) VALUES ($1,$2,$3)`, [USER, listingId, rating]);
}

beforeAll(async () => {
  await pool.query(`INSERT INTO provider_profiles (id, user_id, display_name) VALUES ($1,$2,'next-avail-test') ON CONFLICT (id) DO NOTHING`, [PROVIDER, USER]);
  await pool.query('DELETE FROM bookings WHERE provider_id = $1', [PROVIDER]);
  await pool.query('DELETE FROM reviews WHERE user_id = $1', [USER]);
  await pool.query('DELETE FROM listings WHERE user_id = $1', [USER]);

  // Scenario A (loc "navara"): one hourly driver booked 15-19, one day-only driver.
  await listing(RAJI, 'transport', 'Raji Van', 'navara', { pricePerHour: 100, workingHours: WH });
  await listing(RAVI, 'transport', 'Ravi Trips', 'navara', { pricePerDay: 2000, workingHours: WH });
  for (let d = 15; d <= 19; d += 1) await booking(RAJI, 'driver-hourly', D(d), '14:00', '17:00');
  // Ravi (day) is busy 15th only — for the day-mode whole-day test.
  await booking(RAVI, 'driver-day', D(15), '09:00', '18:00');

  // Scenario B (loc "rankton"): two hourly drivers both free → ranking.
  await listing(ZARA, 'transport', 'Zara Cabs', 'rankton', { pricePerHour: 200, workingHours: WH }); // rated 5
  await listing(QURI, 'transport', 'Quri Rides', 'rankton', { pricePerHour: 100, workingHours: WH }); // unrated, cheaper
  await review(ZARA, 5);

  // Scenario C (loc "dayton"): ONLY a day-only driver → hourly scan finds nothing.
  await listing(DAYONLY_C, 'transport', 'Dayton Day Cabs', 'dayton', { pricePerDay: 3000, workingHours: WH });

  // Scenario S (loc "svcville"): a service booked 10-11 on the 15th.
  await listing(SVC, 'service', 'Clean Co', 'svcville', { workingHours: WH, serviceModes: ['at-home'] });
  await booking(SVC, 'cleaning', D(15), '10:00', '11:00');

  // Scenario T (loc "stayton"): a no-room stay booked the night of the 15th.
  await listing(STAY, 'stay', 'Stayton Lodge', 'stayton', {}, 1500);
  await booking(STAY, 'stay', D(15), '14:00', '11:00', D(16)); // 1 night, occupies the 15th
});

afterAll(async () => {
  await pool.query('DELETE FROM bookings WHERE provider_id = $1', [PROVIDER]);
  await pool.query('DELETE FROM reviews WHERE user_id = $1', [USER]);
  await pool.query('DELETE FROM listings WHERE user_id = $1', [USER]);
  await pool.query('DELETE FROM provider_profiles WHERE id = $1', [PROVIDER]);
  await pool.end();
});

describe('find_next_availability — transport hourly', () => {
  it('skips booked 15th-19th and returns the 20th for the same window', async () => {
    const res = await findNextAvailability({
      category: 'transport', transportMode: 'hourly', location: 'navara',
      startTime: '14:00', endTime: '17:00', fromDate: D(15), daysAhead: 30,
    } as any);
    expect(res.found).toBe(true);
    expect(res.earliestDate).toBe(D(20));
    // Only the hourly driver — the day-rate-only Ravi must be filtered out.
    expect(res.options.map((o) => o.listingId)).toEqual([RAJI]);
    expect(res.options.map((o) => o.title)).not.toContain('Ravi Trips');
  });

  it('does not return "today" when today is fully booked', async () => {
    // Scan starting on the 15th (booked) — earliest must move forward.
    const res = await findNextAvailability({
      category: 'transport', transportMode: 'hourly', location: 'navara',
      startTime: '14:00', endTime: '17:00', fromDate: D(15), daysAhead: 30,
    } as any);
    expect(res.earliestDate).not.toBe(D(15));
  });

  it('reports scannedListings:0 when only a day-rate driver exists for an hourly ask', async () => {
    const res = await findNextAvailability({
      category: 'transport', transportMode: 'hourly', location: 'dayton',
      startTime: '14:00', endTime: '17:00', fromDate: D(15), daysAhead: 10,
    } as any);
    expect(res.scannedListings).toBe(0);
    expect(res.found).toBe(false);
  });

  it('ranks the earliest-date options by rating, then price', async () => {
    const res = await findNextAvailability({
      category: 'transport', transportMode: 'hourly', location: 'rankton',
      startTime: '14:00', endTime: '17:00', fromDate: D(15), daysAhead: 5,
    } as any);
    expect(res.found).toBe(true);
    expect(res.earliestDate).toBe(D(15)); // both free, soonest is the start day
    // Zara (rating 5) ranks above Quri (unrated) even though Quri is cheaper.
    expect(res.options.map((o) => o.listingId)).toEqual([ZARA, QURI]);
  });
});

describe('find_next_availability — transport day mode', () => {
  it('treats any booking that day as whole-day-blocking', async () => {
    // Ravi is day-booked on the 15th → earliest day-rental is the 16th.
    const res = await findNextAvailability({
      category: 'transport', transportMode: 'day', location: 'navara',
      fromDate: D(15), daysAhead: 10,
    } as any);
    expect(res.found).toBe(true);
    expect(res.earliestDate).toBe(D(16));
    expect(res.options.map((o) => o.listingId)).toContain(RAVI);
  });
});

describe('find_next_availability — services & stays', () => {
  it('service: earliest open window skips the booked 10-11 slot on the 15th', async () => {
    const res = await findNextAvailability({
      category: 'service', location: 'svcville',
      startTime: '10:00', endTime: '11:00', fromDate: D(15), daysAhead: 10,
    } as any);
    expect(res.found).toBe(true);
    expect(res.earliestDate).toBe(D(16));
  });

  it('stay: earliest free night skips the 15th', async () => {
    const res = await findNextAvailability({
      category: 'stay', location: 'stayton', nights: 1, fromDate: D(15), daysAhead: 10,
    } as any);
    expect(res.found).toBe(true);
    expect(res.earliestDate).toBe(D(16));
  });
});
