// @vitest-environment node
//
// DB-backed test for multi-room ("numberOfRooms") stays in the assistant path.
// Reproduces the field report: a hotel has 5 Single rooms, 3 are booked for a
// range → only 2 are free. The assistant must quote 2 (not the quantity 5) and
// must refuse a request for 3.
//
// Requires Postgres at localhost:5432. Run: npm run test:integration
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool, transaction } from '../../../../common/db/postgres.js';
import { bookingsRepository } from '../../../bookings/repositories/bookings.repository.js';
import { checkListingAvailability } from './check-availability.tool.js';
import { getStayPricingPreviewTool } from './get-stay-pricing-preview.tool.js';
import { assistantBookingService } from '../../services/assistant-booking.service.js';

const PROVIDER = '00000000-0000-4000-c000-0000000000e1';
const LISTING = '00000000-0000-4000-c000-0000000000e2';
const ROOM = '00000000-0000-4000-c000-0000000000e3';
const USER = 'multi-room-test-user'; // no user_profiles row ⇒ passes listPublic's verified gate
const D = (d: number) => `2032-04-${String(d).padStart(2, '0')}`;
const PRICE_PAISE = 50000; // ₹500/night

beforeAll(async () => {
  await pool.query(`INSERT INTO provider_profiles (id, user_id, display_name) VALUES ($1,$2,'multi-room-test') ON CONFLICT (id) DO NOTHING`, [PROVIDER, USER]);
  await pool.query('DELETE FROM bookings WHERE provider_id = $1', [PROVIDER]);
  await pool.query('DELETE FROM listings WHERE id = $1', [LISTING]);
  await pool.query(
    `INSERT INTO listings (id, user_id, listing_type, name, location, city, is_active)
     VALUES ($1,$2,'stay','Test Hotel','Hyderabad','Hyderabad',true)`,
    [LISTING, USER],
  );
  await pool.query(
    `INSERT INTO listing_room_types (id, listing_id, name, base_price_paise, quantity, max_guests)
     VALUES ($1,$2,'Single',$3,5,2)`,
    [ROOM, LISTING, PRICE_PAISE],
  );
  // One booking holding 3 Singles across D15→D18 (so D15,16,17 each have 3 taken).
  await pool.query(
    `INSERT INTO bookings (user_id, provider_id, listing_id, room_type_id, service_category, scheduled_date, end_date, start_time, end_time, room_count, status)
     VALUES ($1,$2,$3,$4,'stay',$5,$6,'14:00','11:00',3,'confirmed')`,
    [USER, PROVIDER, LISTING, ROOM, D(15), D(18)],
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM bookings WHERE provider_id = $1', [PROVIDER]);
  await pool.query('DELETE FROM listing_room_types WHERE listing_id = $1', [LISTING]);
  await pool.query('DELETE FROM listings WHERE id = $1', [LISTING]);
  await pool.query('DELETE FROM provider_profiles WHERE id = $1', [PROVIDER]);
  await pool.end();
});

describe('multi-room availability — remaining units', () => {
  it('getRoomTypeAvailability returns remaining 2 (5 − 3 booked) for the 17th', async () => {
    const res = await bookingsRepository.getRoomTypeAvailability(LISTING, ROOM, D(17), D(18));
    expect(res.rows[0]?.quantity).toBe(5);
    expect(res.rows[0]?.remaining).toBe(2);
  });

  it('check_availability exposes unitsRemaining: 2 (not quantity 5)', async () => {
    const r = await checkListingAvailability({ listingId: LISTING, date: D(17), checkOutDate: D(18), roomTypeId: ROOM });
    const single = r.roomTypes?.find((rt) => rt.name === 'Single');
    expect(single?.quantity).toBe(5);
    expect(single?.unitsRemaining).toBe(2);
    expect(single?.available).toBe(true); // still bookable — 2 left
  });

  it('a fully-consumed room reports unitsRemaining 0', async () => {
    // Book the remaining 2 on a separate night (D20) so it's fully taken there.
    await pool.query(
      `INSERT INTO bookings (user_id, provider_id, listing_id, room_type_id, service_category, scheduled_date, end_date, start_time, end_time, room_count, status)
       VALUES ($1,$2,$3,$4,'stay',$5,$6,'14:00','11:00',5,'confirmed')`,
      [USER, PROVIDER, LISTING, ROOM, D(20), D(21)],
    );
    const r = await checkListingAvailability({ listingId: LISTING, date: D(20), checkOutDate: D(21), roomTypeId: ROOM });
    const single = r.roomTypes?.find((rt) => rt.name === 'Single');
    expect(single?.unitsRemaining).toBe(0);
    expect(single?.available).toBe(false);
    await pool.query('DELETE FROM bookings WHERE provider_id=$1 AND scheduled_date=$2', [PROVIDER, D(20)]);
  });
});

describe('multi-room conflict check — book against remaining', () => {
  const conflicts = (rooms: number) =>
    transaction((c) =>
      bookingsRepository.findConflictingBookingsForUpdate(c, PROVIDER, D(17), '11:00', '14:00', ROOM, D(18), LISTING, rooms),
    ).then((r) => r.rows.length > 0);

  it('booking 2 rooms is allowed (3 + 2 = 5 ≤ quantity)', async () => {
    expect(await conflicts(2)).toBe(false);
  });
  it('booking 3 rooms is rejected (3 + 3 = 6 > quantity 5)', async () => {
    expect(await conflicts(3)).toBe(true);
  });
});

describe('multi-room assistant prepare — refuses over-capacity', () => {
  it('rejects a request for 3 rooms, quoting the 2 that remain', async () => {
    await expect(
      assistantBookingService.prepare(
        { listingId: LISTING, scheduledDate: D(17), checkOutDate: D(18), roomTypeId: ROOM, guestCount: 1, numberOfRooms: 3 },
        USER,
      ),
    ).rejects.toThrow(/Only 2 Single/i);
  });
});

describe('multi-room pricing preview — total scales per room', () => {
  it('numberOfRooms 2 ≈ 2× the single-room subtotal', async () => {
    const ctx: any = { userId: USER };
    const one: any = await (getStayPricingPreviewTool as any).execute({ listingId: LISTING, checkInDate: D(17), checkOutDate: D(18), roomTypeId: ROOM }, ctx);
    const two: any = await (getStayPricingPreviewTool as any).execute({ listingId: LISTING, checkInDate: D(17), checkOutDate: D(18), roomTypeId: ROOM, numberOfRooms: 2 }, ctx);
    expect(one.available).toBe(true);
    expect(two.available).toBe(true);
    // Subtotal (pre-fee) must exactly double; total roughly doubles (flat ₹3 fee).
    expect(two.subtotal).toBe(one.subtotal * 2);
  });
});
