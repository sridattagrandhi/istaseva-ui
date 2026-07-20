// @vitest-environment node
//
// Regression for the sathram "This time slot was just taken" bug.
//
// idx_bookings_active_slot_unique used to be scoped by provider_id, so a host
// who owned two listings (e.g. a sathram + another stay) couldn't have both
// booked on the same date with the same default 14:00 check-in window — the
// second insert hit the unique index even though the second listing had ZERO
// bookings. The fix scopes the index per-listing and excludes multi-room stays
// (room_type_id NOT NULL), which manage concurrency via room_count.
//
// Requires Postgres at localhost:5432. Run: npm run test:integration
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../../common/db/postgres.js';
import { assistantBookingService } from '../../chat/services/assistant-booking.service.js';

const PROVIDER = '00000000-0000-4000-c000-0000000000a1';
const SATHRAM = '00000000-0000-4000-c000-0000000000a2'; // multi-room stay (room_type_id set)
const OTHER = '00000000-0000-4000-c000-0000000000a3';   // another stay under the same host
const ROOM = '00000000-0000-4000-c000-0000000000a4';
const HOST = 'active-slot-host-user';
const GUEST = 'active-slot-guest-user';
const DATE = '2032-07-17';

beforeAll(async () => {
  await pool.query(
    `INSERT INTO provider_profiles (id, user_id, display_name) VALUES ($1,$2,'active-slot-test') ON CONFLICT (id) DO NOTHING`,
    [PROVIDER, HOST],
  );
  await pool.query('DELETE FROM bookings WHERE provider_id = $1', [PROVIDER]);
  await pool.query('DELETE FROM listing_room_types WHERE listing_id = $1', [SATHRAM]);
  await pool.query('DELETE FROM listings WHERE id = ANY($1)', [[SATHRAM, OTHER]]);
  await pool.query(
    `INSERT INTO listings (id, user_id, listing_type, name, location, city, is_active)
     VALUES ($1,$2,'stay','Test Sathram','Tirupati','Tirupati',true),
            ($3,$2,'stay','Test Other Stay','Tirupati','Tirupati',true)`,
    [SATHRAM, HOST, OTHER],
  );
  await pool.query(
    `INSERT INTO listing_room_types (id, listing_id, name, base_price_paise, quantity, max_guests)
     VALUES ($1,$2,'Single',20000,5,2)`,
    [ROOM, SATHRAM],
  );
  // The OTHER listing already has a confirmed booking on DATE at the same
  // default stay window (14:00). room_type_id NULL → it IS in the unique index.
  await pool.query(
    `INSERT INTO bookings (user_id, provider_id, listing_id, service_category, scheduled_date, end_date, start_time, end_time, status)
     VALUES ($1,$2,$3,'stay',$4,$4,'14:00','23:59','confirmed')`,
    [GUEST, PROVIDER, OTHER, DATE],
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM bookings WHERE provider_id = $1', [PROVIDER]);
  await pool.query('DELETE FROM listing_room_types WHERE listing_id = $1', [SATHRAM]);
  await pool.query('DELETE FROM listings WHERE id = ANY($1)', [[SATHRAM, OTHER]]);
  await pool.query('DELETE FROM provider_profiles WHERE id = $1', [PROVIDER]);
  await pool.end();
});

describe('active-slot uniqueness is per-listing, not per-provider', () => {
  it('books the sathram on a date the host has another listing booked', async () => {
    // Pre-fix: this threw ConflictError "This time slot was just taken".
    const res = await assistantBookingService.prepare(
      { listingId: SATHRAM, scheduledDate: DATE, roomTypeId: ROOM, guestCount: 1 },
      GUEST,
    );
    expect(res.bookingId).toBeTruthy();
    expect(res.amount).toBeGreaterThan(0);

    // And the hold actually landed against the sathram, not the other listing.
    const row = await pool.query('SELECT listing_id, room_type_id FROM bookings WHERE id = $1', [res.bookingId]);
    expect(row.rows[0].listing_id).toBe(SATHRAM);
    expect(row.rows[0].room_type_id).toBe(ROOM);
  });
});
