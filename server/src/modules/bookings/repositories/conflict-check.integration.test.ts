// @vitest-environment node
//
// DB-backed regression test for findConflictingBookingsForUpdate — the
// listing-scoped double-booking guard that createHold relies on.
//
// Why integration (real Postgres) and not a unit test: the bug this guards
// against lived entirely in SQL. The same-day branch filtered out any row
// whose end_date equalled scheduled_date — which is EVERY single-day booking,
// because createHold stores end_date = scheduled_date (end_date is NOT NULL).
// A unit test that mocks the repository (as bookings.service.test.ts does)
// cannot see this; only running the real query against real rows can.
//
// Requires a Postgres at localhost:5432 (docker compose up -d postgres &&
// cd server && npm run db:migrate). Run with:
//   npx vitest run server/src/modules/bookings/repositories/conflict-check.integration.test.ts
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { pool, transaction } from '../../../common/db/postgres.js';
import { bookingsRepository } from './bookings.repository.js';

// Fixed UUIDs scoped to this test so cleanup never touches app data.
const PROVIDER = '00000000-0000-4000-a000-0000000000c1';
const LISTING = '00000000-0000-4000-a000-0000000000c2';
const OTHER_LISTING = '00000000-0000-4000-a000-0000000000c3';
const USER = 'conflict-check-test-user';

const D = (day: number) => `2030-09-${String(day).padStart(2, '0')}`; // far-future, collision-free

type Seed = {
  category: string;
  date: string;
  start: string;
  end: string;
  endDate?: string; // defaults to `date` (the real same-day storage)
  listing?: string;
  status?: string;
};

async function seed(b: Seed) {
  await pool.query(
    `INSERT INTO bookings
       (user_id, provider_id, listing_id, service_category, scheduled_date, end_date, start_time, end_time, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      USER,
      PROVIDER,
      b.listing ?? LISTING,
      b.category,
      b.date,
      b.endDate ?? b.date, // single-day rows store end_date = scheduled_date
      b.start,
      b.end,
      b.status ?? 'confirmed',
    ],
  );
}

// Mirrors createHold's call: same-day bookings pass endDate=null (isMultiNight
// false → same-day branch); multi-day rentals/stays pass an exclusive endDate.
async function conflicts(opts: {
  date: string;
  start: string;
  end: string;
  endDate?: string | null;
  listing?: string;
}) {
  const res = await transaction((client) =>
    bookingsRepository.findConflictingBookingsForUpdate(
      client,
      PROVIDER,
      opts.date,
      opts.end,
      opts.start,
      null, // roomTypeId — exercise the non-room (transport/service/flat-stay) branch
      opts.endDate ?? null,
      opts.listing ?? LISTING,
      1,
    ),
  );
  return res.rows.length > 0;
}

beforeAll(async () => {
  // Synthetic provider so the FK on bookings.provider_id is satisfied and
  // cleanup (by this provider id) can never touch real app data.
  await pool.query(
    `INSERT INTO provider_profiles (id, user_id, display_name)
     VALUES ($1, $2, 'conflict-check-test')
     ON CONFLICT (id) DO NOTHING`,
    [PROVIDER, USER],
  );
});

beforeEach(async () => {
  await pool.query('DELETE FROM bookings WHERE provider_id = $1', [PROVIDER]);
});

afterAll(async () => {
  await pool.query('DELETE FROM bookings WHERE provider_id = $1', [PROVIDER]);
  await pool.query('DELETE FROM provider_profiles WHERE id = $1', [PROVIDER]);
  await pool.end();
});

describe('findConflictingBookingsForUpdate — same-day transport combinations', () => {
  it('hourly vs overlapping hourly → conflict', async () => {
    await seed({ category: 'driver-hourly', date: D(10), start: '14:00', end: '17:00' });
    expect(await conflicts({ date: D(10), start: '16:00', end: '18:00' })).toBe(true);
  });

  it('hourly vs non-overlapping hourly (same day) → NO conflict', async () => {
    await seed({ category: 'driver-hourly', date: D(10), start: '14:00', end: '17:00' });
    expect(await conflicts({ date: D(10), start: '09:00', end: '11:00' })).toBe(false);
  });

  it('existing DAY rental blocks a new hourly inside its window → conflict (the reported bug)', async () => {
    await seed({ category: 'driver-day', date: D(10), start: '09:00', end: '17:00' });
    expect(await conflicts({ date: D(10), start: '14:00', end: '17:00' })).toBe(true);
  });

  it('existing hourly blocks a new DAY rental → conflict', async () => {
    await seed({ category: 'driver-hourly', date: D(10), start: '14:00', end: '17:00' });
    expect(await conflicts({ date: D(10), start: '09:00', end: '17:00' })).toBe(true);
  });

  it('existing PACKAGE (full-day window) blocks a new hourly → conflict', async () => {
    await seed({ category: 'driver-package', date: D(10), start: '00:00', end: '23:59' });
    expect(await conflicts({ date: D(10), start: '10:00', end: '11:00' })).toBe(true);
  });

  it('day vs day (same date) → conflict', async () => {
    await seed({ category: 'driver-day', date: D(10), start: '09:00', end: '17:00' });
    expect(await conflicts({ date: D(10), start: '09:00', end: '17:00' })).toBe(true);
  });

  it('day vs package (same date) → conflict', async () => {
    await seed({ category: 'driver-day', date: D(10), start: '09:00', end: '17:00' });
    expect(await conflicts({ date: D(10), start: '09:00', end: '17:00' })).toBe(true);
  });

  it('package vs package (same date) → conflict', async () => {
    await seed({ category: 'driver-package', date: D(10), start: '09:00', end: '17:00' });
    expect(await conflicts({ date: D(10), start: '09:00', end: '17:00' })).toBe(true);
  });
});

describe('findConflictingBookingsForUpdate — multi-day transport / stays', () => {
  it('existing multi-day rental blocks a new hourly on an intermediate day → conflict', async () => {
    // Rental D10→D13 (exclusive) occupies D10,D11,D12.
    await seed({ category: 'driver-day', date: D(10), start: '09:00', end: '17:00', endDate: D(13) });
    expect(await conflicts({ date: D(11), start: '14:00', end: '17:00' })).toBe(true);
  });

  it('existing same-day hourly blocks a new multi-day rental spanning that day → conflict', async () => {
    // This is the multi-night-branch counterpart of the bug: a single-day row
    // on the rental's start day must be visible to a new multi-day rental.
    await seed({ category: 'driver-hourly', date: D(10), start: '14:00', end: '17:00' });
    expect(await conflicts({ date: D(10), start: '09:00', end: '17:00', endDate: D(13) })).toBe(true);
  });

  it('multi-day rental does NOT conflict with an hourly outside its range → NO conflict', async () => {
    await seed({ category: 'driver-hourly', date: D(20), start: '14:00', end: '17:00' });
    expect(await conflicts({ date: D(10), start: '09:00', end: '17:00', endDate: D(13) })).toBe(false);
  });

  it('stay vs overlapping stay → conflict', async () => {
    await seed({ category: 'stay', date: D(10), start: '14:00', end: '11:00', endDate: D(12) });
    expect(await conflicts({ date: D(11), start: '14:00', end: '11:00', endDate: D(13) })).toBe(true);
  });

  it('back-to-back stays (checkout day == next check-in) → NO conflict', async () => {
    await seed({ category: 'stay', date: D(10), start: '14:00', end: '11:00', endDate: D(12) });
    expect(await conflicts({ date: D(12), start: '14:00', end: '11:00', endDate: D(14) })).toBe(false);
  });
});

describe('findConflictingBookingsForUpdate — services and scope', () => {
  it('service vs overlapping service → conflict', async () => {
    await seed({ category: 'salon', date: D(10), start: '10:00', end: '11:00' });
    expect(await conflicts({ date: D(10), start: '10:30', end: '11:30' })).toBe(true);
  });

  it('service vs non-overlapping service → NO conflict', async () => {
    await seed({ category: 'salon', date: D(10), start: '10:00', end: '11:00' });
    expect(await conflicts({ date: D(10), start: '14:00', end: '15:00' })).toBe(false);
  });

  it('a booking on a DIFFERENT listing does not block (per-listing scope)', async () => {
    await seed({ category: 'driver-day', date: D(10), start: '09:00', end: '17:00', listing: OTHER_LISTING });
    expect(await conflicts({ date: D(10), start: '14:00', end: '17:00', listing: LISTING })).toBe(false);
  });

  it('expired pending holds are ignored', async () => {
    // hold_expires_at in the past → must not block. Seed a pending row then age it.
    await seed({ category: 'driver-day', date: D(10), start: '09:00', end: '17:00', status: 'pending' });
    await pool.query(
      `UPDATE bookings SET hold_expires_at = NOW() - INTERVAL '1 hour' WHERE provider_id = $1`,
      [PROVIDER],
    );
    expect(await conflicts({ date: D(10), start: '14:00', end: '17:00' })).toBe(false);
  });
});
