/**
 * One-off: re-emit booking_confirmed notifications for the most recent
 * confirmed booking per category (stay / service / transport) belonging to
 * a target user. Used to verify email + PDF invoice rendering on staging
 * after a deploy without going through the full UI booking flow.
 *
 * Usage (one-off ECS task):
 *   node scripts/resend-booking-confirmed.js <userEmail>
 *
 * The script bypasses HTTP — it imports the compiled email service and
 * directly invokes sendNotificationEmailToUser. The invoice attachment is
 * built fresh from DB via invoiceService.render, so it reflects whatever
 * the deployed code renders today. We also build the email body's Fare
 * Summary block from the stored payments breakdown so the email body
 * matches the PDF (subtotal, platform fee, discount, GST, insurance, total).
 */
import pg from 'pg';

const targetEmail = process.argv[2];
if (!targetEmail) {
  console.error('Usage: node scripts/resend-booking-confirmed.js <userEmail>');
  process.exit(2);
}

if (!process.env.DATABASE_URL && process.env.DB_HOST) {
  const { DB_USER, DB_PASSWORD, DB_HOST, DB_PORT = '5432', DB_NAME = 'instaserve' } = process.env;
  process.env.DATABASE_URL = `postgres://${DB_USER}:${encodeURIComponent(DB_PASSWORD ?? '')}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL or DB_HOST env required');
  process.exit(2);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' || /rds\.amazonaws\.com/.test(process.env.DATABASE_URL || '')
    ? { rejectUnauthorized: false }
    : undefined,
});

function formatINR(paise) {
  const n = Number(paise);
  if (!Number.isFinite(n)) return '₹0';
  const negative = n < 0;
  const rupees = Math.abs(n) / 100;
  const hasPaise = Math.round(Math.abs(n)) % 100 !== 0;
  const formatted = rupees.toLocaleString('en-IN', {
    minimumFractionDigits: hasPaise ? 2 : 0,
    maximumFractionDigits: 2,
  });
  return `${negative ? '-' : ''}₹${formatted}`;
}

function classifyGstRate(bucket, pricePerNight) {
  if (bucket === 'stay') {
    const paise = pricePerNight != null ? Math.round(Number(pricePerNight) * 100) : null;
    return paise != null && paise > 750_000 ? 0.18 : 0.12;
  }
  if (bucket === 'transport') return 0.05;
  return 0.18;
}

async function findUserId(email) {
  const r = await pool.query(
    `SELECT user_id, id FROM user_profiles WHERE email = $1 LIMIT 1`,
    [email],
  );
  return r.rows[0]?.user_id || r.rows[0]?.id || null;
}

async function pickBookingsByCategory(userId) {
  const r = await pool.query(
    `WITH ranked AS (
       SELECT b.id, b.service_category, b.status, b.created_at, b.scheduled_date,
              l.listing_type, l.category AS listing_category, l.name AS listing_name, l.price_per_night,
              l.location AS listing_location, l.city AS listing_city, l.state AS listing_state,
              pp.display_name AS provider_name,
              CASE
                WHEN l.listing_type = 'stay' OR b.service_category ILIKE 'hotel%' OR b.service_category ILIKE 'homestay%' OR b.service_category ILIKE 'stay%' THEN 'stay'
                WHEN l.listing_type = 'transport' OR b.service_category ILIKE 'driver-%' THEN 'transport'
                ELSE 'service'
              END AS bucket,
              ROW_NUMBER() OVER (
                PARTITION BY (
                  CASE
                    WHEN l.listing_type = 'stay' OR b.service_category ILIKE 'hotel%' OR b.service_category ILIKE 'homestay%' OR b.service_category ILIKE 'stay%' THEN 'stay'
                    WHEN l.listing_type = 'transport' OR b.service_category ILIKE 'driver-%' THEN 'transport'
                    ELSE 'service'
                  END
                )
                ORDER BY b.created_at DESC
              ) AS rn
         FROM bookings b
         LEFT JOIN listings l ON l.id = b.listing_id
         LEFT JOIN provider_profiles pp ON pp.id = b.provider_id
        WHERE b.user_id::text = $1
          AND b.status IN ('confirmed','completed','in_progress','cancelled')
          AND EXISTS (SELECT 1 FROM payments p WHERE p.booking_id = b.id AND p.status = 'completed')
     )
     SELECT * FROM ranked WHERE rn = 1 ORDER BY bucket`,
    [String(userId)],
  );
  return r.rows;
}

async function loadPaymentBreakdown(bookingId) {
  const r = await pool.query(
    `SELECT amount_paise, subtotal_paise, platform_fee_paise, taxes_paise,
            insurance_premium_paise, discount_paise
       FROM payments
      WHERE booking_id = $1 AND status = 'completed'
      ORDER BY completed_at DESC NULLS LAST, created_at DESC
      LIMIT 1`,
    [bookingId],
  );
  const p = r.rows[0];
  if (!p) return null;
  return {
    amount_paise: Number(p.amount_paise),
    subtotal_paise: p.subtotal_paise != null ? Number(p.subtotal_paise) : null,
    platform_fee_paise: p.platform_fee_paise != null ? Number(p.platform_fee_paise) : 0,
    taxes_paise: p.taxes_paise != null ? Number(p.taxes_paise) : 0,
    insurance_premium_paise: p.insurance_premium_paise != null ? Number(p.insurance_premium_paise) : 0,
    discount_paise: p.discount_paise != null ? Number(p.discount_paise) : 0,
  };
}

function buildPricingLines(bk, breakdown) {
  if (!breakdown || breakdown.subtotal_paise == null) return undefined;
  const rate = classifyGstRate(bk.bucket, bk.price_per_night);
  return {
    description: bk.listing_name || bk.service_category || 'Service',
    subtotal: formatINR(breakdown.subtotal_paise),
    baseFare: formatINR(breakdown.subtotal_paise),
    platformFee: breakdown.platform_fee_paise > 0 ? formatINR(breakdown.platform_fee_paise) : undefined,
    discount: breakdown.discount_paise > 0 ? formatINR(breakdown.discount_paise) : undefined,
    insurance: breakdown.insurance_premium_paise > 0 ? formatINR(breakdown.insurance_premium_paise) : undefined,
    gstLabel: `CGST + SGST @ ${Math.round(rate * 100)}%`,
    gstAmount: formatINR(breakdown.taxes_paise),
    total: formatINR(breakdown.amount_paise),
  };
}

async function main() {
  const userId = await findUserId(targetEmail);
  if (!userId) {
    console.error(`No user found for ${targetEmail}`);
    process.exit(1);
  }
  console.log(`Target user_id=${userId} email=${targetEmail}`);

  const picks = await pickBookingsByCategory(userId);
  if (!picks.length) {
    console.error('No paid bookings found.');
    process.exit(1);
  }
  for (const p of picks) {
    console.log(`  ${p.bucket}: booking=${p.id} status=${p.status} category=${p.service_category}`);
  }

  const { sendNotificationEmailToUser } = await import('../dist/modules/notifications/services/email.service.js');

  for (const bk of picks) {
    const breakdown = await loadPaymentBreakdown(bk.id);
    const pricing = buildPricingLines(bk, breakdown);
    console.log(`Sending ${bk.bucket} email for booking ${bk.id}, pricing=${pricing ? 'present' : 'missing'}...`);

    const hotelAddress = bk.bucket === 'stay'
      ? [bk.listing_location, bk.listing_city, bk.listing_state].filter(Boolean).join(', ') || undefined
      : undefined;

    try {
      await sendNotificationEmailToUser({
        userId: String(userId),
        type: 'booking_confirmed',
        data: {
          bookingId: bk.id,
          title: `Booking confirmed — ${bk.listing_name || bk.service_category}`,
          message: `Re-send for verification (${bk.bucket}).`,
          listing: bk.listing_name || undefined,
          provider: bk.provider_name || undefined,
          guest: undefined,
          amount: pricing?.total,
          pricing,
          // category-specific shape so the template chooses the right details block
          hotelAddress,
          checkInDate: bk.bucket === 'stay' ? String(bk.scheduled_date || '').slice(0, 10) || undefined : undefined,
          date: bk.bucket !== 'stay' ? String(bk.scheduled_date || '').slice(0, 10) || undefined : undefined,
          serviceType: bk.bucket === 'transport' ? bk.service_category : undefined,
        },
      });
      console.log(`  ✓ ${bk.bucket} email dispatched`);
    } catch (err) {
      console.error(`  ✗ ${bk.bucket} failed:`, err?.message || err);
    }
  }

  await pool.end();
}

main().catch((err) => {
  console.error('resend failed:', err);
  process.exit(1);
});
