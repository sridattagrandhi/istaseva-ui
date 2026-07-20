// @vitest-environment node
//
// End-to-end parity for service variants (servicesCatalog): the price the
// assistant PREVIEWS for a chosen variant must equal the price the HOLD
// actually charges. Before the fix, get_booking_price_preview used the flat
// listing.price (cheapest variant) while createHold defaulted to catalog[0],
// so the quote (₹396) didn't match the charge (₹830 for Men's). Now both
// resolve the same variant via resolveServiceCatalogGroup.
//
// Requires Postgres at localhost:5432. Run: npm run test:integration
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../../../common/db/postgres.js';
import { assistantBookingService } from '../../services/assistant-booking.service.js';
import { getBookingPricePreviewTool } from './get-booking-price-preview.tool.js';

const PROVIDER = '00000000-0000-4000-c000-0000000000c1';
const LISTING = '00000000-0000-4000-c000-0000000000c2';
const HOST = 'svc-variant-host-user';
const GUEST = 'svc-variant-guest-user';
const DATE = '2032-10-12';
const CATALOG = [
  { id: 'svc-men', name: "Men's Haircut", basePrice: 700, addOns: [{ id: 'addon-beard', label: 'Beard Trim', price: 200 }] },
  { id: 'svc-women', name: "Women's Haircut", basePrice: 1200, addOns: [] },
  { id: 'svc-kid', name: "Kid's Haircut", basePrice: 396, addOns: [] },
];

beforeAll(async () => {
  await pool.query(
    `INSERT INTO provider_profiles (id, user_id, display_name, is_available) VALUES ($1,$2,'svc-variant-test',true) ON CONFLICT (id) DO NOTHING`,
    [PROVIDER, HOST],
  );
  await pool.query('DELETE FROM bookings WHERE provider_id = $1', [PROVIDER]);
  await pool.query('DELETE FROM listings WHERE id = $1', [LISTING]);
  await pool.query(
    `INSERT INTO listings (id, user_id, listing_type, name, location, city, category, price, is_active, metadata)
     VALUES ($1,$2,'service','Test Salon','Hyderabad','Hyderabad','salon',396,true,$3::jsonb)`,
    [LISTING, HOST, JSON.stringify({ pricingUnit: 'per_visit', serviceModes: ['visit-provider'], servicesCatalog: CATALOG })],
  );
});

afterAll(async () => {
  await pool.query('DELETE FROM bookings WHERE provider_id = $1', [PROVIDER]);
  await pool.query('DELETE FROM listings WHERE id = $1', [LISTING]);
  await pool.query('DELETE FROM provider_profiles WHERE id = $1', [PROVIDER]);
  await pool.end();
});

describe('service variant pricing — preview matches the actual charge', () => {
  it("Men's Haircut: hold charge equals the previewed total (not the ₹396 headline)", async () => {
    const preview: any = await (getBookingPricePreviewTool as any).execute(
      { listingId: LISTING, serviceMode: 'visit-provider', serviceCatalogId: 'svc-men' },
      { userId: GUEST },
    );
    expect(preview.available).toBe(true);
    expect(preview.total).toBe(829.54); // 700 + ₹3 + 18% GST, exact (no whole-rupee rounding)

    const hold = await assistantBookingService.prepare(
      {
        listingId: LISTING,
        scheduledDate: DATE,
        startTime: '10:00',
        endTime: '11:00',
        serviceMode: 'visit-provider',
        serviceCatalogId: 'svc-men',
      },
      GUEST,
    );
    // The charge resolves the Men's variant: 700 + ₹3 + 18% GST = 82954 paise.
    // (NOT the ₹396 Kid's headline — that was the bug.) Preview now shows the
    // EXACT amount, so quote == charge to the paise.
    expect(hold.amountPaise).toBe(82954);
    expect(preview.total).toBeCloseTo(hold.amount, 2);
    expect(hold.amount).toBeGreaterThan(800); // not the ₹396 headline
  });

  it("Women's Haircut prices higher than Men's (variant actually drives the charge)", async () => {
    await pool.query('DELETE FROM bookings WHERE provider_id = $1', [PROVIDER]);
    const hold = await assistantBookingService.prepare(
      {
        listingId: LISTING,
        scheduledDate: DATE,
        startTime: '12:00',
        endTime: '13:00',
        serviceMode: 'visit-provider',
        serviceCatalogId: 'svc-women',
      },
      GUEST,
    );
    // 1200 + ₹3 + 18% GST = 1419.54 → ₹1420, well above Men's 830.
    expect(hold.amount).toBeGreaterThan(830);
  });
});

describe('service variant — tolerant id + required choice (the ₹470.82 bug)', () => {
  it('resolves a slug/name the model invented ("mens-haircut") to the Men\'s variant', async () => {
    await pool.query('DELETE FROM bookings WHERE provider_id = $1', [PROVIDER]);
    const hold = await assistantBookingService.prepare(
      { listingId: LISTING, scheduledDate: DATE, startTime: '14:00', endTime: '15:00', serviceMode: 'visit-provider', serviceCatalogId: 'mens-haircut' },
      GUEST,
    );
    // "mens-haircut" ≈ "Men's Haircut" → ₹700 base (82954 paise), NOT the
    // ₹396 headline (47082 paise) it silently fell back to before.
    expect(hold.amountPaise).toBe(82954);
  });

  it('refuses to book a multi-variant service with NO variant chosen (no silent cheapest default)', async () => {
    await expect(
      assistantBookingService.prepare(
        { listingId: LISTING, scheduledDate: DATE, startTime: '15:00', endTime: '16:00', serviceMode: 'visit-provider' },
        GUEST,
      ),
    ).rejects.toThrow(/Which service would you like/i);
  });

  it('refuses an unresolvable (invented) variant id instead of charging the cheapest', async () => {
    await expect(
      assistantBookingService.prepare(
        { listingId: LISTING, scheduledDate: DATE, startTime: '15:00', endTime: '16:00', serviceMode: 'visit-provider', serviceCatalogId: 'totally-made-up-xyz' },
        GUEST,
      ),
    ).rejects.toThrow(/Which service would you like/i);
  });
});
