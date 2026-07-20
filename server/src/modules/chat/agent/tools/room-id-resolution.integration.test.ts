// @vitest-environment node
//
// Regression for the "Oops, looks like there was an issue finding that room
// type" loop (mobile assistant screenshots). On a MULTI-room stay:
//   - a fabricated (but syntactically valid) UUID must NOT hard-fail with a
//     misleading "doesn't exist anymore"; it must come back as room_required
//     with a "which one?" message + structured roomOptions[] so the next turn
//     recovers, AND it must never imply the room is unavailable.
//   - the room NAME ("Single") and the real room UUID both resolve cleanly.
//
// Requires Postgres at localhost:5432. Run: npm run test:integration
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../../../common/db/postgres.js';
import { assistantBookingService } from '../../services/assistant-booking.service.js';
import { prepareBookingTool } from './prepare-booking.tool.js';
import { getStayPricingPreviewTool } from './get-stay-pricing-preview.tool.js';

const PROVIDER = '00000000-0000-4000-c000-0000000000f1';
const LISTING = '00000000-0000-4000-c000-0000000000f2';
const ROOM_SINGLE = '00000000-0000-4000-c000-0000000000f3';
const ROOM_DOUBLE = '00000000-0000-4000-c000-0000000000f4';
const FAKE_UUID = '11111111-2222-4333-8444-555555555555'; // valid shape, not a real room
const USER = 'room-id-resolution-test-user';
const D = (d: number) => `2032-05-${String(d).padStart(2, '0')}`;

beforeAll(async () => {
  await pool.query(
    `INSERT INTO provider_profiles (id, user_id, display_name) VALUES ($1,$2,'room-id-res-test') ON CONFLICT (id) DO NOTHING`,
    [PROVIDER, USER],
  );
  await pool.query('DELETE FROM bookings WHERE provider_id = $1', [PROVIDER]);
  await pool.query('DELETE FROM listing_room_types WHERE listing_id = $1', [LISTING]);
  await pool.query('DELETE FROM listings WHERE id = $1', [LISTING]);
  await pool.query(
    `INSERT INTO listings (id, user_id, listing_type, name, location, city, is_active)
     VALUES ($1,$2,'stay','Sriari Sannidhi (test)','Tirupati','Tirupati',true)`,
    [LISTING, USER],
  );
  await pool.query(
    `INSERT INTO listing_room_types (id, listing_id, name, base_price_paise, quantity, max_guests)
     VALUES ($1,$2,'Single',20000,5,2), ($3,$2,'Double',30000,5,4)`,
    [ROOM_SINGLE, LISTING, ROOM_DOUBLE],
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM bookings WHERE provider_id = $1', [PROVIDER]);
  await pool.query('DELETE FROM listing_room_types WHERE listing_id = $1', [LISTING]);
  await pool.query('DELETE FROM listings WHERE id = $1', [LISTING]);
  await pool.query('DELETE FROM provider_profiles WHERE id = $1', [PROVIDER]);
  await pool.end();
});

const prepare = (roomTypeId: string) =>
  assistantBookingService.prepare(
    { listingId: LISTING, scheduledDate: D(17), checkOutDate: D(18), roomTypeId, guestCount: 1 },
    USER,
  );

describe('room id resolution on multi-room stays (loop regression)', () => {
  it('fabricated UUID → room_required with options, NOT a false "unavailable"', async () => {
    // Service layer: accurate disambiguation message, never "doesn't exist anymore".
    let msg = '';
    try {
      await prepare(FAKE_UUID);
      throw new Error('expected a ValidationError');
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/which one\?/i);
    expect(msg).toMatch(/Single/);
    expect(msg).toMatch(/Double/);
    expect(msg).not.toMatch(/anymore|isn'?t available|sold out|doesn'?t exist on this listing/i);

    // Tool layer: classified as room_required + structured roomOptions[] so the
    // agent recovers without re-inventing an id.
    const res: any = await prepareBookingTool.execute(
      { listingId: LISTING, scheduledDate: D(17), checkOutDate: D(18), roomTypeId: FAKE_UUID, guestCount: 1 } as any,
      { userId: USER } as any,
    );
    expect(res.success).toBe(false);
    expect(res.reason).toBe('room_required');
    expect(Array.isArray(res.roomOptions)).toBe(true);
    expect(res.roomOptions.map((r: any) => r.name).sort()).toEqual(['Double', 'Single']);
    expect(res.userMessage).not.toMatch(/anymore|sold out|isn'?t available/i);
  });

  it('room NAME "Single" resolves (no room-not-found failure)', async () => {
    let threw: Error | null = null;
    try { await prepare('Single'); } catch (e) { threw = e as Error; }
    if (threw) expect(threw.message).not.toMatch(/which one\?|doesn'?t match|doesn'?t exist/i);
  });

  it('real room UUID resolves (control)', async () => {
    let threw: Error | null = null;
    try { await prepare(ROOM_SINGLE); } catch (e) { threw = e as Error; }
    if (threw) expect(threw.message).not.toMatch(/which one\?|doesn'?t match|doesn'?t exist/i);
  });
});

describe('get_stay_pricing_preview — room + single-night handling', () => {
  const preview = (extra: Record<string, unknown>) =>
    (getStayPricingPreviewTool as any).execute(
      { listingId: LISTING, checkInDate: D(17), ...extra },
      { userId: USER },
    );

  it('fabricated UUID → room_required with options, not a false "doesn\'t exist"', async () => {
    const res: any = await preview({ checkOutDate: D(18), roomTypeId: FAKE_UUID });
    expect(res.available).toBe(false);
    expect(res.reason).toBe('room_required');
    expect(res.userMessage).toMatch(/which one\?/i);
    expect(res.userMessage).toMatch(/Single/);
    expect(res.userMessage).not.toMatch(/anymore|sold out|isn'?t available|doesn'?t exist/i);
  });

  it('single-night stay (checkOutDate omitted) prices without asking for nights', async () => {
    const res: any = await preview({ roomTypeId: ROOM_SINGLE }); // no checkOutDate
    expect(res.available).toBe(true);
    expect(res.nightly).toHaveLength(1);
    // ₹200 + ₹3 platform + 12% GST → ₹227 (insurance not opted in)
    expect(res.total).toBe(227);
  });
});
