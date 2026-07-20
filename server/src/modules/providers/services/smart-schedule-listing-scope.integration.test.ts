// @vitest-environment node
//
// Regression for the assistant "all booked up" bug: the smart-schedule slot
// generator (find_available_slots) used to scope busy intervals by provider_id,
// so a booking on ONE of a host's listings blanket-blocked the others. A host
// owning a salon + another listing, with the other listing booked 09:00–17:00,
// made the salon report zero open slots even though the booking modal (which is
// listing-scoped) showed the whole day free. The fix scopes occupancy by
// listing_id, matching the modal.
//
// Requires Postgres at localhost:5432. Run: npm run test:integration
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../../common/db/postgres.js';
import { cacheDelByPattern } from '../../../common/cache/redis.js';
import { smartScheduleService } from './smart-schedule.service.js';

const PROVIDER = '00000000-0000-4000-c000-0000000000b1';
const TARGET = '00000000-0000-4000-c000-0000000000b2';  // the salon we ask slots for
const SIBLING = '00000000-0000-4000-c000-0000000000b3'; // another listing, same host
const HOST = 'smart-schedule-host-user';
const GUEST = 'smart-schedule-guest-user';
const DATE_SIBLING = '2032-09-15'; // case 1: sibling booked
const DATE_TARGET = '2032-09-16';  // case 2: target booked (distinct date → distinct cache key)
const DATE_GRID = '2032-09-17';    // case 3: grid parity (distinct date → distinct cache key)
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WORKING_HOURS = Object.fromEntries(DAYS.map((d) => [d, ['09:00', '17:00']]));

beforeAll(async () => {
  await pool.query(
    `INSERT INTO provider_profiles (id, user_id, display_name, is_available)
     VALUES ($1,$2,'smart-schedule-test',true) ON CONFLICT (id) DO UPDATE SET is_available = true`,
    [PROVIDER, HOST],
  );
  await pool.query('DELETE FROM bookings WHERE provider_id = $1', [PROVIDER]);
  await pool.query('DELETE FROM listings WHERE id = ANY($1)', [[TARGET, SIBLING]]);
  await pool.query(
    `INSERT INTO listings (id, user_id, listing_type, name, location, city, category, is_active, metadata)
     VALUES ($1,$2,'service','Test Salon','Hyderabad','Hyderabad','salon',true,$3::jsonb),
            ($4,$2,'service','Test Sibling','Hyderabad','Hyderabad','salon',true,$3::jsonb)`,
    [TARGET, HOST, JSON.stringify({ workingHours: WORKING_HOURS, serviceModes: ['visit-provider'], bufferMinutes: 0 }), SIBLING],
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM bookings WHERE provider_id = $1', [PROVIDER]);
  await pool.query('DELETE FROM listings WHERE id = ANY($1)', [[TARGET, SIBLING]]);
  await pool.query('DELETE FROM provider_profiles WHERE id = $1', [PROVIDER]);
  await pool.end();
});

const findTargetSlots = async (date: string) => {
  // Production invalidates this cache on every booking write; our raw-SQL
  // inserts don't, so clear it here to avoid stale reads across runs.
  await cacheDelByPattern(`schedule:*:${date}:*`);
  return smartScheduleService.findSlots({
    service_category: 'salon',
    listing_id: TARGET,
    preferred_date: date,
    duration_minutes: 60,
  });
};

describe('smart-schedule occupancy is listing-scoped', () => {
  it("a sibling listing booked all day does NOT block the target's slots", async () => {
    // Sibling listing fully booked 09:00–17:00; target has no bookings.
    await pool.query(
      `INSERT INTO bookings (user_id, provider_id, listing_id, service_category, scheduled_date, end_date, start_time, end_time, status)
       VALUES ($1,$2,$3,'salon',$4,$4,'09:00','17:00','confirmed')`,
      [GUEST, PROVIDER, SIBLING, DATE_SIBLING],
    );
    const res: any = await findTargetSlots(DATE_SIBLING);
    // Pre-fix: 0 slots (sibling blanket-blocked the day). Post-fix: full day.
    expect(res.slots.length).toBeGreaterThan(0);
    expect(res.slots.some((s: any) => s.start_time === '09:00')).toBe(true);
  });

  it("a booking on the TARGET listing still blocks that window (no over-correction)", async () => {
    // Target booked 09:00–12:00; afternoon should remain open, morning blocked.
    await pool.query(
      `INSERT INTO bookings (user_id, provider_id, listing_id, service_category, scheduled_date, end_date, start_time, end_time, status)
       VALUES ($1,$2,$3,'salon',$4,$4,'09:00','12:00','confirmed')`,
      [GUEST, PROVIDER, TARGET, DATE_TARGET],
    );
    const res: any = await findTargetSlots(DATE_TARGET);
    const starts = res.slots.map((s: any) => s.start_time);
    // A 60-min slot starting before 12:00 would overlap the booking → excluded.
    expect(starts.every((t: string) => t >= '12:00')).toBe(true);
    expect(res.slots.length).toBeGreaterThan(0); // afternoon still bookable
  });

  it('fixed-location service emits the plain hourly grid (no invented :30 buffer slots)', async () => {
    // Mirrors the salon screenshot: only 11:00 booked. The assistant must
    // offer the same on-the-hour grid the booking modal shows (09–16 minus
    // 11:00), NEVER a travel-buffered 12:30 / 13:30.
    await pool.query('DELETE FROM bookings WHERE provider_id = $1 AND scheduled_date = $2', [PROVIDER, DATE_GRID]);
    await pool.query(
      `INSERT INTO bookings (user_id, provider_id, listing_id, service_category, scheduled_date, end_date, start_time, end_time, status)
       VALUES ($1,$2,$3,'salon',$4,$4,'11:00','12:00','confirmed')`,
      [GUEST, PROVIDER, TARGET, DATE_GRID],
    );
    const res: any = await findTargetSlots(DATE_GRID);
    const starts = res.slots.map((s: any) => s.start_time).sort();
    // Working hours 09:00–17:00, 60-min slots, 0 buffer → 09..16 on the hour.
    expect(starts).toEqual(['09:00', '10:00', '12:00', '13:00', '14:00', '15:00', '16:00']);
    // The booked 11:00 is gone, and nothing lands on a half-hour.
    expect(starts).not.toContain('11:00');
    expect(starts.some((t: string) => t.endsWith(':30'))).toBe(false);
  });
});
