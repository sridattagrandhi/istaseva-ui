/**
 * Dev-only bulk seed script.
 *
 * Fills the LOCAL dev database with a realistic, skewed marketplace dataset so
 * dashboards, search, facets, and pagination can be exercised at volume:
 *   - customers + host users (user_profiles, hosts verified so listings are publicly visible)
 *   - provider_profiles + listings (stay/service/transport, real metadata shapes)
 *   - listing_room_types for stays
 *   - bookings (power-law user/listing selection, date spread, status mix)
 *   - payments (completed / refunded / failed) and reviews
 *   - analytics daily rollup tables + analytics_customer_profiles
 *
 * Distributions are deliberately skewed (few listings get most bookings, big
 * cities dominate, most users book 0-1 times) — uniform random data makes RFM
 * and funnel dashboards look homogeneous and useless.
 *
 * Everything seeded is tagged: user ids start with 'SEED' and emails end in
 * '@seed.istaseva.local'. Re-running wipes previous seed data first, so the
 * script is idempotent.
 *
 * Analytics notes:
 *   - Daily rollup rows are written ONLY for days <= (today - 2). The live
 *     15-min rollup job owns yesterday+today (DELETE+INSERT from DynamoDB
 *     events), so we stay out of its way — no conflicts, seeded history survives.
 *   - --wipe clears ALL rows from the analytics daily tables (they cannot be
 *     split into seeded vs real portions). In a dev DB the real portion is
 *     negligible; the live job regenerates yesterday+today on its next tick.
 *   - analytics_customer_profiles is recomputed from bookings by the server's
 *     rollup job anyway; we write a close approximation so dashboards work
 *     even when the server isn't running.
 *
 * Usage (from server/):
 *   node scripts/seed-dev.js                    # defaults: 1000 users, 700 listings, 3000 bookings
 *   node scripts/seed-dev.js --users 2000 --listings 1500 --bookings 8000
 *   node scripts/seed-dev.js --days 365         # spread activity over the past year
 *   node scripts/seed-dev.js --seed 42          # different deterministic dataset
 *   node scripts/seed-dev.js --wipe             # remove all seeded data and exit
 *
 * Refuses to run when NODE_ENV=production or when DATABASE_URL points at a
 * non-localhost host (override the latter with --force-remote if you really
 * mean it, e.g. a disposable staging DB).
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// ---------------------------------------------------------------------------
// CLI + safety rails
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function argNum(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number(argv[i + 1]);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`--${name} needs a positive number`);
  return Math.floor(v);
}
const WIPE_ONLY = argv.includes('--wipe');
const FORCE_REMOTE = argv.includes('--force-remote');
const N_USERS = argNum('users', 1000);
const N_LISTINGS = argNum('listings', 700);
const N_BOOKINGS = argNum('bookings', 3000);
const N_DAYS = argNum('days', 270);
const RNG_SEED = argNum('seed', 1);

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed: NODE_ENV=production');
  process.exit(1);
}

if (!process.env.DATABASE_URL && process.env.DB_HOST) {
  const { DB_USER, DB_PASSWORD, DB_HOST, DB_PORT = '5432', DB_NAME = 'instaserve' } = process.env;
  process.env.DATABASE_URL = `postgres://${DB_USER}:${encodeURIComponent(DB_PASSWORD ?? '')}@${DB_HOST}:${DB_PORT}/${DB_NAME}`;
}
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://instaserve:instaserve_dev@localhost:5432/instaserve';
}

const isLocalUrl = /@(localhost|127\.0\.0\.1)[:/]/i.test(process.env.DATABASE_URL);
if (!isLocalUrl && !FORCE_REMOTE) {
  console.error('Refusing to seed a non-localhost database. Pass --force-remote to override.');
  console.error(`DATABASE_URL host: ${process.env.DATABASE_URL.replace(/\/\/.*@/, '//<redacted>@')}`);
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isLocalUrl ? false : { rejectUnauthorized: false },
});

// ---------------------------------------------------------------------------
// Deterministic RNG + helpers
// ---------------------------------------------------------------------------

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(RNG_SEED);
const chance = (p) => rnd() < p;
const randint = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
function weighted(pairs) {
  const total = pairs.reduce((s, [, w]) => s + w, 0);
  let r = rnd() * total;
  for (const [v, w] of pairs) { r -= w; if (r <= 0) return v; }
  return pairs[pairs.length - 1][0];
}
/** Power-law index in [0, n): alpha > 1 skews toward low indexes. */
const powerIndex = (n, alpha) => Math.min(n - 1, Math.floor(n * Math.pow(rnd(), alpha)));
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const HEX = '0123456789abcdef';
function uuid() {
  let s = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) s += '-';
    else if (i === 14) s += '4';
    else if (i === 19) s += HEX[8 + Math.floor(rnd() * 4)];
    else s += HEX[Math.floor(rnd() * 16)];
  }
  return s;
}
const B36 = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
function seedUid() {
  let s = 'SEED';
  for (let i = 0; i < 24; i++) s += B36[Math.floor(rnd() * B36.length)];
  return s;
}

const NOW = new Date();
const DAY_MS = 24 * 3600 * 1000;
const dateStr = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => new Date(NOW.getTime() - n * DAY_MS);
function jitterCoord(v) { return v + (rnd() - 0.5) * 0.09; }

// ---------------------------------------------------------------------------
// Data pools
// ---------------------------------------------------------------------------

const CITIES = [
  { city: 'Bengaluru', state: 'Karnataka', lat: 12.9716, lng: 77.5946, w: 12 },
  { city: 'Mumbai', state: 'Maharashtra', lat: 19.076, lng: 72.8777, w: 11 },
  { city: 'Hyderabad', state: 'Telangana', lat: 17.385, lng: 78.4867, w: 10 },
  { city: 'Delhi', state: 'Delhi', lat: 28.6139, lng: 77.209, w: 9 },
  { city: 'Chennai', state: 'Tamil Nadu', lat: 13.0827, lng: 80.2707, w: 8 },
  { city: 'Pune', state: 'Maharashtra', lat: 18.5204, lng: 73.8567, w: 6 },
  { city: 'Kolkata', state: 'West Bengal', lat: 22.5726, lng: 88.3639, w: 5 },
  { city: 'Jaipur', state: 'Rajasthan', lat: 26.9124, lng: 75.7873, w: 4 },
  { city: 'Panaji', state: 'Goa', lat: 15.4909, lng: 73.8278, w: 4 },
  { city: 'Kochi', state: 'Kerala', lat: 9.9312, lng: 76.2673, w: 3 },
  { city: 'Tirupati', state: 'Andhra Pradesh', lat: 13.6288, lng: 79.4192, w: 3 },
  { city: 'Varanasi', state: 'Uttar Pradesh', lat: 25.3176, lng: 82.9739, w: 2 },
  { city: 'Mysuru', state: 'Karnataka', lat: 12.2958, lng: 76.6394, w: 2 },
  { city: 'Udaipur', state: 'Rajasthan', lat: 24.5854, lng: 73.7125, w: 2 },
  { city: 'Coimbatore', state: 'Tamil Nadu', lat: 11.0168, lng: 76.9558, w: 1 },
];
const cityWeighted = CITIES.map((c) => [c, c.w]);

const FIRST_NAMES = ['Aarav', 'Ananya', 'Rohan', 'Priya', 'Vikram', 'Sneha', 'Karthik', 'Divya', 'Arjun', 'Meera', 'Rahul', 'Pooja', 'Sanjay', 'Kavya', 'Aditya', 'Lakshmi', 'Nikhil', 'Shreya', 'Ravi', 'Anjali', 'Suresh', 'Deepa', 'Manoj', 'Nisha', 'Ganesh', 'Swati', 'Harish', 'Ritu', 'Prakash', 'Sunita', 'Vijay', 'Rekha', 'Amit', 'Geeta', 'Kiran', 'Padma', 'Raj', 'Usha', 'Mohan', 'Radha'];
const LAST_NAMES = ['Sharma', 'Reddy', 'Patel', 'Iyer', 'Nair', 'Gupta', 'Rao', 'Menon', 'Kulkarni', 'Das', 'Chowdhury', 'Naidu', 'Joshi', 'Verma', 'Pillai', 'Mehta', 'Kapoor', 'Bhat', 'Shetty', 'Mishra', 'Agarwal', 'Deshpande', 'Hegde', 'Chauhan', 'Banerjee', 'Krishnan', 'Singh', 'Yadav', 'Kamath', 'Trivedi'];

const LANGS = [['en', 35], ['hi', 25], ['te', 12], ['ta', 10], ['kn', 8], ['ml', 5], ['bn', 5]];
const CHANNELS = [['organic', 34], ['google_ads', 22], ['instagram', 16], ['referral', 12], ['facebook', 9], ['youtube', 7]];
const PLATFORMS = [['web', 55], ['android', 32], ['ios', 13]];

const STAY_KINDS = [['hotel', 5], ['homestay', 3], ['sathram', 2]];
const HOTEL_PREFIX = ['Grand', 'Royal', 'The Heritage', 'Lake View', 'Silver Oak', 'Palm Grove', 'Sunrise', 'Emerald', 'Lotus', 'Golden Gate', 'City Central', 'Garden Court'];
const HOTEL_SUFFIX = ['Hotel', 'Residency', 'Inn', 'Suites', 'Palace', 'Retreat', 'Regency'];
const HOMESTAY_NAMES = ['Coorg Coffee Estate Stay', 'Backwater Breeze Homestay', 'Hilltop Haven', 'Mango Grove Villa', 'Riverside Cottage', 'Banyan Tree Homestay', 'Paddy Field View', 'Old Town Heritage Home', 'Spice Garden Stay', 'Lakeside Bungalow'];
const SATHRAM_NAMES = ['Sri Venkateswara Sathram', 'Annapurna Choultry', 'Sri Rama Sathram', 'Padmavathi Nilayam', 'Govinda Sathram', 'Bhakta Nivas'];
const STAY_AMENITIES = ['WiFi', 'AC', 'Parking', 'Breakfast', 'Hot Water', 'Power Backup', 'Laundry', 'Restaurant', 'Pool', 'Gym', 'Garden', 'Spa'];
const ROOM_NAMES = ['Standard Room', 'Deluxe Room', 'Executive Suite', 'Family Room', 'Twin Room', 'Premium Room'];

const SERVICE_KINDS = [
  { cat: 'salon', names: ['Style Studio', 'Glamour Salon', 'Scissors & Co', 'Urban Cuts'], services: [['Men\'s Haircut', 250, 700], ['Women\'s Haircut', 500, 1500], ['Hair Spa', 800, 2000], ['Facial', 600, 1800]], addOns: [['Beard Trim', 150], ['Hair Wash', 100], ['Head Massage', 200]] },
  { cat: 'cleaning', names: ['Sparkle Home Cleaning', 'FreshNest Cleaners', 'ShineBright Services', 'CleanSweep Co'], services: [['Standard home cleaning', 400, 900], ['Deep cleaning', 1500, 3500], ['Sofa shampooing', 600, 1200], ['Kitchen deep clean', 800, 1600]], addOns: [['Balcony cleaning', 200], ['Fridge cleaning', 250]] },
  { cat: 'plumbing', names: ['AquaFix Plumbing', 'PipeMasters', 'FlowRight Services', 'DripStop Plumbers'], services: [['Tap repair', 150, 400], ['Bathroom fitting', 800, 2500], ['Leak fixing', 300, 900], ['Water tank cleaning', 700, 1400]], addOns: [['Extra fixture', 150]] },
  { cat: 'electrician', names: ['VoltSafe Electricals', 'BrightSpark Services', 'PowerFix Solutions', 'Watt Works'], services: [['Fan installation', 200, 500], ['Wiring check', 300, 800], ['Switchboard repair', 250, 700], ['Inverter setup', 900, 2200]], addOns: [['Extra point', 120]] },
  { cat: 'photography', names: ['Lens & Light Studio', 'Candid Frames', 'PixelCraft Photography', 'Moments Studio'], services: [['Event photography (4h)', 4000, 12000], ['Portrait session', 1500, 4000], ['Product shoot', 2500, 7000]], addOns: [['Same-day edits', 1000], ['Extra hour', 800]] },
  { cat: 'mehendi', names: ['Henna Art by Riya', 'Mehendi Magic', 'Bridal Henna Studio', 'Arabian Patterns'], services: [['Bridal mehendi', 3000, 9000], ['Party mehendi (per hand)', 300, 800], ['Arabic design', 500, 1500]], addOns: [['Glitter work', 200]] },
  { cat: 'yoga', names: ['Prana Yoga Studio', 'Asana Living', 'Shanti Yoga Classes', 'FlexFlow Yoga'], services: [['Personal session', 500, 1200], ['Group class (month)', 1500, 3500], ['Prenatal yoga', 700, 1500]], addOns: [['Diet consult', 400]] },
  { cat: 'pest-control', names: ['BugOff Pest Control', 'SafeHome Pest Care', 'PestAway Services', 'GuardPro Pest'], services: [['General pest control', 800, 1800], ['Termite treatment', 2500, 6000], ['Bed bug treatment', 1500, 3500]], addOns: [['Balcony treatment', 300]] },
];
const SERVICE_MODES = [['at-home', 5], ['visit-provider', 4], ['remote', 1]];

const CAB_VEHICLES = [['Toyota Innova', 7], ['Maruti Swift', 4], ['Hyundai Aura', 4], ['Toyota Etios', 4], ['Maruti Ertiga', 6], ['Mahindra Marazzo', 7], ['Honda Amaze', 4]];
const TEMPO_VEHICLES = [['Force Traveller', 12], ['Maruti Eeco', 7], ['Tata Winger', 9]];
const TRANSPORT_NAMES = ['Tours & Travels', 'Cab Service', 'Travels', 'Cabs', 'Taxi Service'];
const VEHICLE_COLORS = ['White', 'Silver', 'Black', 'Grey', 'Red'];
const PICKUP_SPOTS = ['Airport', 'Railway Station', 'City Centre', 'Bus Stand', 'Tech Park', 'Old Town'];

const CANCEL_REASONS = [['change_of_plans', 30], ['booked_by_mistake', 12], ['found_better_price', 15], ['provider_unavailable', 14], ['personal_emergency', 17], ['weather', 6], ['other', 6]];
const FAIL_REASONS = [['upi_timeout', 30], ['card_declined', 25], ['insufficient_funds', 20], ['network_error', 15], ['bank_failure', 10]];

const REVIEW_TITLES = { 5: ['Excellent experience', 'Absolutely loved it', 'Perfect!', 'Highly recommend'], 4: ['Very good', 'Great value', 'Would book again', 'Nice experience'], 3: ['Decent', 'Okay overall', 'Average experience'], 2: ['Below expectations', 'Disappointing', 'Needs improvement'], 1: ['Very poor', 'Do not recommend', 'Terrible experience'] };
const REVIEW_BODIES = {
  stay: { good: ['Clean rooms and very helpful staff. The location was convenient for us.', 'Comfortable beds, great breakfast, and quick check-in. Family loved it.', 'Peaceful place, well maintained, and good value for the price.'], bad: ['Room was not cleaned properly and the AC barely worked.', 'Photos are misleading — the property is much older than shown.', 'Check-in took forever and staff were unresponsive.'] },
  service: { good: ['Professional and punctual. Work quality was excellent.', 'Arrived on time, finished quickly, and cleaned up afterwards.', 'Very skilled and courteous. Pricing was transparent.'], bad: ['Showed up late and the work was sloppy.', 'Charged for add-ons that were not agreed upfront.', 'Had to call them back twice to fix the same issue.'] },
  transport: { good: ['Safe driver, clean vehicle, and reached on time.', 'Very polite driver who knew all the good stops on the route.', 'Comfortable ride, fair pricing, AC worked great.'], bad: ['Vehicle was not clean and driver kept taking calls.', 'Arrived 40 minutes late for the pickup.', 'Rash driving, would not book again.'] },
};
const REVIEW_TAGS = { stay: ['clean', 'great location', 'family friendly', 'good food', 'value for money'], service: ['professional', 'on time', 'good value', 'skilled'], transport: ['safe driver', 'clean vehicle', 'punctual', 'polite'] };

const SEARCH_TERMS = {
  stays: ['hotel near me', 'homestay', 'budget hotel', 'sathram tirupati', 'hill station stay', 'beach resort', 'family room', 'couple friendly hotel', 'heritage stay', 'pet friendly'],
  services: ['salon at home', 'deep cleaning', 'plumber', 'electrician near me', 'bridal mehendi', 'yoga classes', 'pest control', 'photographer for wedding'],
  transport: ['airport cab', 'outstation taxi', 'tempo traveller', 'cab for full day', 'local sightseeing cab', 'innova rental'],
};

const DEFAULT_WORKING_HOURS = { mon: ['09:00', '19:00'], tue: ['09:00', '19:00'], wed: ['09:00', '19:00'], thu: ['09:00', '19:00'], fri: ['09:00', '19:00'], sat: ['09:00', '19:00'], sun: null };
const LANG_LABELS = { en: 'English', hi: 'Hindi', te: 'Telugu', ta: 'Tamil', kn: 'Kannada', ml: 'Malayalam', bn: 'Bengali' };

// ---------------------------------------------------------------------------
// Pricing (mirrors server/src/modules/payments/pricing/fees.ts + booking-price.ts)
// ---------------------------------------------------------------------------

const PLATFORM_FEE_PAISE = 300;
const INSURANCE_FLAT_PAISE = 200;
function gstRateFor(category, nightlyPaise) {
  const cat = String(category || '').toLowerCase();
  if (/^(auto|cab|van|bike|tempo|driver-)/.test(cat)) return 0.05;
  if (/(hotel|homestay|lodge|stay|farm|heritage)/.test(cat)) {
    return nightlyPaise != null && nightlyPaise > 750_000 ? 0.18 : 0.12;
  }
  return 0.18;
}
function applyFees(subtotalPaise, category, nightlyPaise) {
  const discounted = Math.max(1, Math.round(subtotalPaise));
  const gstRate = gstRateFor(category, nightlyPaise ?? null);
  const taxes = Math.round((discounted + PLATFORM_FEE_PAISE) * gstRate);
  return { subtotalPaise: discounted, platformFeePaise: PLATFORM_FEE_PAISE, taxesPaise: taxes, totalPaise: discounted + PLATFORM_FEE_PAISE + taxes };
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

function makePerson() {
  const first = pick(FIRST_NAMES);
  const last = pick(LAST_NAMES);
  return { first, last, name: `${first} ${last}` };
}

function makeUsers() {
  const customers = [];
  for (let i = 0; i < N_USERS; i++) {
    const p = makePerson();
    const cityInfo = weighted(cityWeighted);
    const createdAgo = Math.floor((N_DAYS + 60) * Math.pow(rnd(), 0.7)); // spread, slightly old-heavy
    customers.push({
      userId: seedUid(),
      displayName: p.name,
      firstName: p.first,
      email: `seed.user${i}@seed.istaseva.local`,
      phone: `+91${randint(6, 9)}${String(randint(100000000, 999999999))}`,
      city: cityInfo,
      language: weighted(LANGS),
      channel: weighted(CHANNELS),
      createdAt: daysAgo(createdAgo),
      verified: chance(0.85),
    });
  }
  return customers;
}

function makeHostsAndListings() {
  const hosts = [];
  const listings = [];
  const listingTypeFor = () => weighted([['stay', 5], ['service', 3], ['transport', 2]]);

  while (listings.length < N_LISTINGS) {
    const p = makePerson();
    const cityInfo = weighted(cityWeighted);
    const host = {
      userId: seedUid(),
      displayName: p.name,
      firstName: p.first,
      email: `seed.host${hosts.length}@seed.istaseva.local`,
      phone: `+91${randint(6, 9)}${String(randint(100000000, 999999999))}`,
      city: cityInfo,
      language: weighted(LANGS),
      channel: weighted(CHANNELS),
      createdAt: daysAgo(Math.floor((N_DAYS + 90) * Math.pow(rnd(), 0.6))),
      providerId: uuid(),
      categories: new Set(),
      listingCount: weighted([[1, 55], [2, 25], [3, 13], [4, 7]]),
    };
    hosts.push(host);
    for (let k = 0; k < host.listingCount && listings.length < N_LISTINGS; k++) {
      const city = chance(0.85) ? host.city : weighted(cityWeighted);
      listings.push(buildListing(listings.length, host, city, listingTypeFor()));
    }
  }
  return { hosts, listings };
}

function photoUrls(idx, n) {
  return Array.from({ length: n }, (_, i) => `https://picsum.photos/seed/istaseva-${RNG_SEED}-${idx}-${i}/800/600`);
}

function langLabels(primary) {
  const set = new Set(['English', LANG_LABELS[primary] || 'Hindi']);
  if (chance(0.5)) set.add(pick(Object.values(LANG_LABELS)));
  return [...set];
}

function buildListing(idx, host, cityInfo, type) {
  const base = {
    id: uuid(),
    idx,
    userId: host.userId,
    providerId: host.providerId,
    hostName: host.displayName,
    type,
    city: cityInfo.city,
    state: cityInfo.state,
    lat: jitterCoord(cityInfo.lat),
    lng: jitterCoord(cityInfo.lng),
    createdAt: daysAgo(randint(30, N_DAYS + 60)),
    isActive: !chance(0.05),
    banned: false,
    photos: photoUrls(idx, randint(3, 6)),
    languages: langLabels(host.language),
    rooms: [],
  };
  base.location = `${cityInfo.city}, ${cityInfo.state}`;

  if (type === 'stay') {
    const kind = weighted(STAY_KINDS);
    base.category = kind;
    base.propertyType = kind;
    base.name = kind === 'hotel'
      ? `${pick(HOTEL_PREFIX)} ${pick(HOTEL_SUFFIX)} ${cityInfo.city}`
      : kind === 'homestay' ? `${pick(HOMESTAY_NAMES)}` : `${pick(SATHRAM_NAMES)}`;
    base.amenities = shuffle([...STAY_AMENITIES]).slice(0, randint(3, 7));
    base.price = '';
    const luxury = kind === 'hotel' && chance(0.08);
    const nRooms = randint(1, 3);
    const usedRoomNames = shuffle([...ROOM_NAMES]).slice(0, nRooms);
    for (let r = 0; r < nRooms; r++) {
      const nightlyRupees = luxury ? randint(8000, 15000) : kind === 'sathram' ? randint(300, 1200) : randint(900, 6500);
      base.rooms.push({
        id: uuid(), name: usedRoomNames[r],
        basePricePaise: nightlyRupees * 100,
        maxGuests: randint(1, 4), quantity: randint(2, 8),
        bedrooms: randint(1, 2), bathrooms: 1,
      });
    }
    base.metadata = {
      listingType: 'stay',
      description: `A ${kind === 'sathram' ? 'traditional pilgrim stay' : 'comfortable ' + kind} in ${cityInfo.city} with easy access to local attractions.`,
      checkInTime: pick(['12:00', '14:00', '15:00']),
      checkOutTime: pick(['10:00', '11:00', '12:00']),
      languages: base.languages,
    };
    if (chance(0.1)) {
      base.metadata.blockedDates = Array.from({ length: randint(3, 8) }, () => dateStr(new Date(NOW.getTime() + randint(3, 60) * DAY_MS)));
    }
  } else if (type === 'service') {
    const kind = pick(SERVICE_KINDS);
    base.category = kind.cat;
    base.name = `${pick(kind.names)} ${chance(0.5) ? cityInfo.city : host.firstName}`;
    base.amenities = [];
    const catalog = shuffle([...kind.services]).slice(0, randint(1, 3)).map(([name, lo, hi], i) => ({
      id: `svc-seed${idx}-${i}`, name, basePrice: randint(lo, hi),
      addOns: shuffle([...kind.addOns]).slice(0, randint(0, 2)).map(([label, price], j) => ({ id: `addon-seed${idx}-${i}-${j}`, label, price })),
    }));
    base.catalog = catalog;
    base.price = String(Math.min(...catalog.map((s) => s.basePrice)));
    base.metadata = {
      listingType: 'service',
      pricingUnit: 'per_visit',
      providerName: host.displayName,
      experience: `${randint(2, 15)} years`,
      duration: `${randint(1, 3)} hours`,
      languages: base.languages,
      serviceModes: [weighted(SERVICE_MODES)],
      subcategory: catalog[0].name,
      subcategories: catalog.map((s) => s.name),
      servicesCatalog: catalog,
      workingHours: DEFAULT_WORKING_HOURS,
      bufferMinutes: pick([0, 15, 30]),
      serviceRadius: pick([5, 10, 15, 25]),
      addOns: catalog[0].addOns,
    };
  } else {
    const isTempo = chance(0.3);
    base.category = isTempo ? 'driver-tempo' : 'driver-cab';
    const [vehicleName, seats] = isTempo ? pick(TEMPO_VEHICLES) : pick(CAB_VEHICLES);
    base.name = `${host.firstName} ${pick(TRANSPORT_NAMES)}`;
    base.vehicleName = vehicleName;
    base.amenities = [];
    const pricePerHour = randint(150, 450);
    const pricePerDay = pricePerHour * randint(7, 10);
    const modes = ['hourly', 'day'];
    const packages = [];
    if (chance(0.5)) {
      modes.push('package');
      packages.push({
        id: `pkg-seed${idx}-1`, hours: randint(4, 10),
        label: `${base.city} Sightseeing Package`,
        price: randint(1500, 5000),
        stops: shuffle(['City Palace', 'Old Fort', 'Lake Front', 'Main Temple', 'Museum', 'Local Market']).slice(0, randint(3, 5)).map((place) => ({ place })),
        description: `Full ${base.city} sightseeing with driver-guide.`,
        distanceKmMin: randint(40, 70), distanceKmMax: randint(80, 120),
      });
    }
    base.price = String(pricePerHour);
    base.transport = { pricePerHour, pricePerDay, packages, vehicleName, seats };
    base.metadata = {
      listingType: 'transport',
      transportType: isTempo ? 'tempo' : 'cab',
      vehicleType: isTempo ? 'Tempo' : 'Sedan',
      vehicleName,
      seatingCapacity: seats,
      pricePerHour, pricePerDay,
      transportMode: modes[0],
      transportModes: modes,
      packageOptions: packages,
      experience: `${randint(2, 20)} years`,
      languages: base.languages,
      workingHours: DEFAULT_WORKING_HOURS,
      bufferMinutes: pick([0, 15, 30]),
      serviceRadius: pick([15, 25, 50]),
      licensePlate: `${pick(['TS', 'KA', 'MH', 'TN', 'DL', 'AP'])}${String(randint(1, 39)).padStart(2, '0')}${pick(['AB', 'CD', 'EF', 'GH'])}${randint(1000, 9999)}`,
      transportationTypes: [{
        type: isTempo ? 'tempo_traveller' : 'sedan_cab',
        displayName: vehicleName,
        details: { basePrice: pricePerHour, perHourPrice: pricePerHour, perDayPrice: pricePerDay, vehicleName, seatingCapacity: seats },
      }],
    };
  }
  host.categories.add(base.category);
  return base;
}

function makeBookings(customers, listings) {
  const bookings = [];
  const activeSlots = new Set(); // guards idx_bookings_active_slot_unique for room_type_id IS NULL rows
  const bookers = customers.slice(0, Math.floor(customers.length * 0.55)); // ~45% of users never book
  const activeListings = listings.filter((l) => l.isActive && !l.banned);
  let skipped = 0;

  for (let i = 0; i < N_BOOKINGS; i++) {
    const user = bookers[powerIndex(bookers.length, 2.2)];
    const listing = activeListings[powerIndex(activeListings.length, 1.8)];

    // created_at: recent-heavy, never before the user/listing existed
    let createdAt = daysAgo(Math.floor(N_DAYS * Math.pow(rnd(), 1.7)));
    const floorDate = new Date(Math.max(user.createdAt.getTime(), listing.createdAt.getTime()) + DAY_MS);
    if (createdAt < floorDate) createdAt = floorDate;
    if (createdAt > NOW) createdAt = new Date(NOW.getTime() - 3600 * 1000);
    createdAt = new Date(createdAt.getTime() + randint(8, 22) * 3600 * 1000 + randint(0, 3599) * 1000);
    if (createdAt > NOW) createdAt = new Date(NOW.getTime() - randint(1, 6) * 3600 * 1000);

    const leadDays = listing.type === 'stay' ? randint(2, 40) : listing.type === 'service' ? randint(0, 7) : randint(0, 14);
    let schedDate = new Date(createdAt.getTime() + leadDays * DAY_MS);
    // weekend boost for stays
    if (listing.type === 'stay' && chance(0.35)) {
      const dow = schedDate.getUTCDay();
      schedDate = new Date(schedDate.getTime() + ((5 - dow + 7) % 7) * DAY_MS);
    }

    const b = {
      id: uuid(),
      userId: user.userId,
      user,
      listing,
      providerId: listing.providerId,
      createdAt,
      roomTypeId: null,
      roomTypeName: null,
      roomCount: 1,
      guestCount: null,
      vehicle: null,
      couponId: null,
    };

    if (listing.type === 'stay') {
      const room = pick(listing.rooms);
      const nights = weighted([[1, 35], [2, 30], [3, 18], [4, 9], [5, 5], [7, 3]]);
      b.serviceCategory = `stay:${listing.category}`;
      b.scheduledDate = dateStr(schedDate);
      b.endDate = dateStr(new Date(schedDate.getTime() + nights * DAY_MS));
      b.startTime = (listing.metadata.checkInTime || '14:00') + ':00';
      b.endTime = (listing.metadata.checkOutTime || '11:00') + ':00';
      b.roomTypeId = room.id;
      b.roomTypeName = room.name;
      b.roomCount = chance(0.15) ? 2 : 1;
      b.guestCount = randint(1, room.maxGuests * b.roomCount);
      const subtotal = room.basePricePaise * nights * b.roomCount;
      b.fees = applyFees(subtotal, b.serviceCategory, room.basePricePaise);
      b.notes = JSON.stringify({ guests: b.guestCount, roomTypeId: room.id, roomTypeName: room.name, contact: { name: user.displayName, phone: user.phone }, protection: chance(0.25) });
      b.endsAt = new Date(schedDate.getTime() + nights * DAY_MS + 11 * 3600 * 1000);
    } else if (listing.type === 'service') {
      const svc = pick(listing.catalog);
      const addOns = svc.addOns.filter(() => chance(0.3));
      const startHour = randint(9, 17);
      b.serviceCategory = listing.category;
      b.scheduledDate = dateStr(schedDate);
      b.endDate = b.scheduledDate;
      b.startTime = `${String(startHour).padStart(2, '0')}:00:00`;
      b.endTime = `${String(startHour + randint(1, 2)).padStart(2, '0')}:00:00`;
      const subtotal = (svc.basePrice + addOns.reduce((s, a) => s + a.price, 0)) * 100;
      b.fees = applyFees(subtotal, b.serviceCategory, null);
      b.notes = JSON.stringify({ serviceMode: listing.metadata.serviceModes[0], serviceTitle: listing.name, note: '', selectedServiceCatalogId: svc.id, ...(addOns.length ? { addOns } : {}) });
      b.endsAt = new Date(schedDate.getTime() + (startHour + 2) * 3600 * 1000);
    } else {
      const t = listing.transport;
      const mode = pick(listing.metadata.transportModes);
      const startHour = randint(6, 16);
      let subtotal, days = 1, packageId;
      if (mode === 'day') { days = weighted([[1, 6], [2, 3], [3, 1]]); subtotal = t.pricePerDay * days * 100; }
      else if (mode === 'package' && t.packages.length) { subtotal = t.packages[0].price * 100; packageId = t.packages[0].id; }
      else { subtotal = t.pricePerHour * randint(2, 8) * 100; }
      b.serviceCategory = `driver-${mode}`;
      b.scheduledDate = dateStr(schedDate);
      b.endDate = dateStr(new Date(schedDate.getTime() + (days - 1) * DAY_MS));
      b.startTime = `${String(startHour).padStart(2, '0')}:00:00`;
      b.endTime = `${String(Math.min(startHour + randint(2, 8), 23)).padStart(2, '0')}:00:00`;
      b.fees = applyFees(subtotal, b.serviceCategory, null);
      const pickup = `${pick(PICKUP_SPOTS)}, ${listing.city}`;
      b.notes = JSON.stringify({ transport: true, mode, transportMode: mode, note: '', pickup, pickupLocation: pickup, passengers: randint(1, t.seats), contact: { name: user.displayName, phone: user.phone }, ...(packageId ? { packageId } : {}) });
      b.vehicle = { model: t.vehicleName, plate: listing.metadata.licensePlate, color: pick(VEHICLE_COLORS), phone: `+91${randint(7, 9)}${String(randint(100000000, 999999999))}` };
      b.endsAt = new Date(schedDate.getTime() + (days - 1) * DAY_MS + 20 * 3600 * 1000);
    }

    // status: past bookings mostly completed, future mostly confirmed
    const inPast = b.endsAt < NOW;
    b.status = inPast
      ? weighted([['completed', 70], ['cancelled', 18], ['expired', 12]])
      : weighted([['confirmed', 64], ['pending', 11], ['cancelled', 25]]);

    // respect the partial unique index on active slots (room_type_id IS NULL only)
    if (!b.roomTypeId && (b.status === 'pending' || b.status === 'confirmed')) {
      const key = `${listing.id}|${b.scheduledDate}|${b.startTime}|${b.endTime}`;
      if (activeSlots.has(key)) { skipped++; continue; }
      activeSlots.add(key);
    }

    if (b.status === 'cancelled') {
      b.cancelledAt = new Date(Math.min(b.createdAt.getTime() + randint(1, 72) * 3600 * 1000, NOW.getTime() - 60000));
      b.cancellationReason = weighted(CANCEL_REASONS);
    }
    if (b.status === 'expired') b.expiredAt = new Date(b.createdAt.getTime() + 10 * 60000);
    if (b.status === 'pending') b.holdExpiresAt = new Date(NOW.getTime() + randint(1, 24) * 3600 * 1000);

    bookings.push(b);
  }
  if (skipped) console.log(`  (skipped ${skipped} bookings that would collide on active slots)`);
  return bookings;
}

function makePayments(bookings) {
  const payments = [];
  for (const b of bookings) {
    const paid = b.status === 'completed' || b.status === 'confirmed' || b.status === 'in_progress';
    const insurance = chance(0.25) ? INSURANCE_FLAT_PAISE : 0;
    const amountPaise = b.fees.totalPaise + insurance;
    const feeBreakdown = { subtotalPaise: b.fees.subtotalPaise, platformFeePaise: b.fees.platformFeePaise, taxesPaise: b.fees.taxesPaise, discountPaise: 0, insurancePremiumPaise: insurance, totalPaise: amountPaise };
    const basePayment = (status) => ({
      id: uuid(), bookingId: b.id, userId: b.userId, status,
      amountPaise, insurance, feeBreakdown,
      createdAt: new Date(b.createdAt.getTime() + randint(1, 10) * 60000),
      providerPaymentId: `pay_seed_${uuid().slice(0, 12)}`,
      providerRef: `order_seed_${uuid().slice(0, 12)}`,
    });

    if (paid) {
      // occasional failed first attempt before success
      if (chance(0.05)) {
        const f = basePayment('failed');
        f.failedReason = weighted(FAIL_REASONS);
        payments.push(f);
      }
      const p = basePayment('completed');
      p.completedAt = new Date(p.createdAt.getTime() + randint(1, 5) * 60000);
      payments.push(p);
    } else if (b.status === 'cancelled') {
      const roll = rnd();
      if (roll < 0.35) {
        const p = basePayment('refunded');
        p.completedAt = new Date(p.createdAt.getTime() + 2 * 60000);
        p.refundedAt = new Date(b.cancelledAt.getTime() + randint(5, 240) * 60000);
        p.refundPaise = amountPaise;
        payments.push(p);
      } else if (roll < 0.5) {
        const f = basePayment('failed');
        f.failedReason = weighted(FAIL_REASONS);
        payments.push(f);
      }
    }
  }
  return payments;
}

function makeReviews(bookings) {
  const reviews = [];
  for (const b of bookings) {
    if (b.status !== 'completed' || !chance(0.55)) continue;
    const rating = weighted([[5, 44], [4, 31], [3, 12], [2, 7], [1, 6]]);
    const pool = REVIEW_BODIES[b.listing.type];
    const body = rating >= 4 ? pick(pool.good) : rating <= 2 ? pick(pool.bad) : pick(chance(0.5) ? pool.good : pool.bad);
    let createdAt = new Date(b.endsAt.getTime() + randint(1, 6) * DAY_MS);
    if (createdAt > NOW) createdAt = new Date(NOW.getTime() - randint(1, 24) * 3600 * 1000);
    reviews.push({
      id: uuid(),
      userId: b.userId,
      stayId: b.listing.id,
      providerId: b.providerId,
      bookingId: b.id,
      rating,
      title: pick(REVIEW_TITLES[rating]),
      text: body,
      tags: rating >= 4 ? shuffle([...REVIEW_TAGS[b.listing.type]]).slice(0, randint(1, 3)) : [],
      helpful: weighted([[0, 60], [1, 15], [2, 10], [randint(3, 12), 15]]),
      displayName: chance(0.7) ? b.user.firstName : 'Anonymous',
      createdAt,
    });
  }
  return reviews;
}

// ---------------------------------------------------------------------------
// Analytics rollups (historical days only — the live job owns yesterday+today)
// ---------------------------------------------------------------------------

function makeAnalytics(customers, hosts, listings, bookings, payments, reviews) {
  const lastSeedDay = dateStr(daysAgo(2));
  const firstSeedDay = dateStr(daysAgo(N_DAYS));
  const days = new Map(); // day -> aggregates
  const ensureDay = (day) => {
    if (!days.has(day)) {
      days.set(day, {
        confirmed: 0, cancelled: 0, revenue: 0, refund: 0, failures: 0, reviews: 0, ratingSum: 0, signups: 0, newListings: 0,
        byType: { stay: emptyFunnel(), service: emptyFunnel(), transport: emptyFunnel() },
        byListing: new Map(), geo: new Map(), cancelReasons: new Map(), failReasons: new Map(),
      });
    }
    return days.get(day);
  };
  const emptyFunnel = () => ({ views: 0, cards: 0, modals: 0, payStarts: 0, bookings: 0, revenue: 0 });
  const inWindow = (day) => day >= firstSeedDay && day <= lastSeedDay;
  const bump = (map, key, n = 1) => map.set(key, (map.get(key) || 0) + n);

  for (const u of [...customers, ...hosts]) {
    const d = dateStr(u.createdAt);
    if (inWindow(d)) ensureDay(d).signups++;
  }
  for (const l of listings) {
    const d = dateStr(l.createdAt);
    if (inWindow(d)) ensureDay(d).newListings++;
  }
  const paidStatuses = new Set(['completed', 'confirmed', 'in_progress']);
  for (const b of bookings) {
    const d = dateStr(b.createdAt);
    if (!inWindow(d)) continue;
    const agg = ensureDay(d);
    if (paidStatuses.has(b.status)) {
      agg.confirmed++;
      agg.revenue += b.fees.totalPaise;
      agg.byType[b.listing.type].bookings++;
      agg.byType[b.listing.type].revenue += b.fees.totalPaise;
      if (!agg.byListing.has(b.listing.id)) agg.byListing.set(b.listing.id, emptyFunnel());
      const lf = agg.byListing.get(b.listing.id);
      lf.bookings++; lf.revenue += b.fees.totalPaise;
      bump(agg.geo, b.listing.city);
      const g = agg.geo; // revenue map handled separately below via geoRev
      agg.geoRev = agg.geoRev || new Map();
      bump(agg.geoRev, b.listing.city, b.fees.totalPaise);
      void g;
    }
    if (b.status === 'cancelled' && b.cancelledAt) {
      const cd = dateStr(b.cancelledAt);
      if (inWindow(cd)) {
        const cagg = ensureDay(cd);
        cagg.cancelled++;
        bump(cagg.cancelReasons, b.cancellationReason || 'other');
      }
    }
  }
  for (const p of payments) {
    if (p.status === 'failed') {
      const d = dateStr(p.createdAt);
      if (inWindow(d)) { const agg = ensureDay(d); agg.failures++; bump(agg.failReasons, p.failedReason); }
    }
    if (p.status === 'refunded' && p.refundedAt) {
      const d = dateStr(p.refundedAt);
      if (inWindow(d)) ensureDay(d).refund += p.refundPaise;
    }
  }
  for (const r of reviews) {
    const d = dateStr(r.createdAt);
    if (inWindow(d)) { const agg = ensureDay(d); agg.reviews++; agg.ratingSum += r.rating; }
  }

  // Synthesize upstream funnel from confirmed bookings with plausible drop-off
  // ratios + noise, plus a browse-only baseline so zero-booking days still
  // show traffic.
  const popularListings = [...listings].filter((l) => l.isActive).slice(0, 60);
  const rows = { overview: [], funnel: [], listingFunnel: [], geo: [], acquisition: [], language: [], platform: [], searchTerms: [], cancelReasons: [], payFailures: [] };

  for (let ago = N_DAYS; ago >= 2; ago--) {
    const day = dateStr(daysAgo(ago));
    const agg = days.get(day) || ensureDay(day);
    const noise = () => 0.75 + rnd() * 0.6;
    const growth = 0.5 + 0.5 * (1 - ago / N_DAYS); // platform grows over the window
    const baseViews = Math.round(randint(120, 260) * growth * noise());
    let views = baseViews, cards = Math.round(baseViews * 0.32), modals = Math.round(baseViews * 0.11), payStarts = Math.round(baseViews * 0.035);
    for (const type of ['stay', 'service', 'transport']) {
      const f = agg.byType[type];
      const share = type === 'stay' ? 0.5 : type === 'service' ? 0.3 : 0.2;
      f.payStarts += f.bookings + Math.round(f.bookings * 0.3 * noise()) + Math.round(baseViews * 0.035 * share);
      f.modals = Math.round(f.payStarts * 2.6 * noise()) + Math.round(baseViews * 0.11 * share);
      f.cards = Math.round(f.modals * 2.2 * noise()) + Math.round(baseViews * 0.32 * share);
      f.views = Math.round(f.cards * 2.4 * noise()) + Math.round(baseViews * share);
      views += f.views - Math.round(baseViews * share);
      cards += f.cards - Math.round(baseViews * 0.32 * share);
      modals += f.modals - Math.round(baseViews * 0.11 * share);
      payStarts += f.payStarts - Math.round(baseViews * 0.035 * share);
      rows.funnel.push([day, type, f.views, f.cards, f.modals, f.payStarts, f.bookings, f.revenue]);
    }
    const activeUsers = Math.max(agg.confirmed + agg.signups, Math.round(views * 0.45 * noise()));
    rows.overview.push([
      day, activeUsers, agg.signups, Math.round(activeUsers * 0.8), views,
      agg.byType.stay.views, agg.byType.service.views, agg.byType.transport.views,
      Math.round(views * 0.38 * noise()), cards, modals, payStarts,
      agg.confirmed, randint(0, 8), randint(0, 12), agg.revenue, agg.cancelled, agg.refund,
      agg.reviews, agg.ratingSum, 0, 0, 0,
      randint(0, 15), randint(0, 6), agg.newListings, Math.round(hosts.length * 0.1 * noise()),
      randint(0, 25), 0, 0, agg.failures,
    ]);

    // per-listing funnel: booked listings + a sample of browsed-only popular listings
    const browsed = new Set();
    for (const [lid, f] of agg.byListing) {
      f.payStarts = f.bookings + (chance(0.4) ? 1 : 0);
      f.modals = f.payStarts + randint(1, 4);
      f.cards = f.modals + randint(2, 8);
      f.views = f.cards + randint(4, 20);
      rows.listingFunnel.push([day, lid, f.views, f.cards, f.modals, f.payStarts, f.bookings, f.revenue]);
      browsed.add(lid);
    }
    const extraBrowsed = randint(8, 18);
    for (let i = 0; i < extraBrowsed; i++) {
      const l = popularListings[powerIndex(popularListings.length, 1.6)];
      if (browsed.has(l.id)) continue;
      browsed.add(l.id);
      const v = randint(2, 25);
      rows.listingFunnel.push([day, l.id, v, Math.round(v * 0.4), Math.round(v * 0.15), chance(0.2) ? 1 : 0, 0, 0]);
    }

    for (const [city, count] of agg.geo || []) rows.geo.push([day, city, count, (agg.geoRev && agg.geoRev.get(city)) || 0]);
    for (const [ch, w] of CHANNELS) {
      const sessions = Math.round((activeUsers * w / 100) * noise());
      if (sessions > 0) rows.acquisition.push([day, ch, sessions, Math.round(agg.signups * w / 100)]);
    }
    for (const [lang, w] of LANGS) {
      const ev = Math.round((views * w / 100) * noise());
      if (ev > 0) rows.language.push([day, lang, ev, Math.round((activeUsers * w / 100) * noise())]);
    }
    for (const [plat, w] of PLATFORMS) {
      rows.platform.push([day, plat, Math.round(views * 3 * w / 100 * noise()), Math.round(activeUsers * w / 100 * noise())]);
    }
    for (const [cat, terms] of Object.entries(SEARCH_TERMS)) {
      const nTerms = randint(3, 6);
      for (let i = 0; i < nTerms; i++) {
        rows.searchTerms.push([day, cat, terms[powerIndex(terms.length, 1.5)], randint(1, 30)]);
      }
    }
    for (const [reason, count] of agg.cancelReasons) rows.cancelReasons.push([day, reason, count]);
    for (const [reason, count] of agg.failReasons) rows.payFailures.push([day, reason, count]);
  }

  // dedupe search terms on (day, category, term)
  const seenTerm = new Set();
  rows.searchTerms = rows.searchTerms.filter(([d, c, t]) => {
    const k = `${d}|${c}|${t}`;
    if (seenTerm.has(k)) return false;
    seenTerm.add(k);
    return true;
  });

  // customer profiles (approximation of refreshCustomerBookingStats — the
  // server's rollup job recomputes these from bookings on its next tick)
  const profiles = new Map();
  for (const b of bookings) {
    const isCounted = paidStatuses.has(b.status);
    if (!isCounted && b.status !== 'cancelled') continue;
    if (!profiles.has(b.userId)) {
      profiles.set(b.userId, { user: b.user, first: null, last: null, total: 0, cancelled: 0, revenue: 0, cats: new Map() });
    }
    const p = profiles.get(b.userId);
    if (isCounted) {
      p.total++;
      p.revenue += b.fees.totalPaise;
      bump(p.cats, b.serviceCategory);
      if (!p.first || b.createdAt < p.first) p.first = b.createdAt;
      if (!p.last || b.createdAt > p.last) p.last = b.createdAt;
    } else {
      p.cancelled++;
    }
  }
  rows.customerProfiles = [...profiles.entries()].map(([userId, p]) => {
    let fav = null, favN = 0;
    for (const [c, n] of p.cats) if (n > favN) { fav = c; favN = n; }
    return [userId, p.first, p.last, p.total, p.cancelled, p.revenue, fav, p.user.city.city, p.user.language, p.user.channel, p.last ? dateStr(p.last) : null];
  });

  return rows;
}

// ---------------------------------------------------------------------------
// DB plumbing
// ---------------------------------------------------------------------------

async function bulkInsert(client, table, cols, rows) {
  if (!rows.length) return;
  const chunkSize = Math.max(1, Math.floor(30000 / cols.length));
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const params = [];
    const tuples = chunk.map((row, ri) => `(${cols.map((_, ci) => `$${ri * cols.length + ci + 1}`).join(',')})`);
    for (const row of chunk) params.push(...row);
    await client.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES ${tuples.join(',')}`, params);
  }
}

async function wipe(client) {
  console.log('Wiping previous seed data…');
  // Order respects FKs. payments/insurance/guarantees/slot_locks cascade off bookings;
  // room_types/coupons/overrides cascade off listings.
  await client.query(`DELETE FROM reviews WHERE user_id LIKE 'SEED%'`);
  await client.query(`DELETE FROM bookings WHERE user_id LIKE 'SEED%'`);
  await client.query(`DELETE FROM listings WHERE user_id LIKE 'SEED%'`);
  await client.query(`DELETE FROM provider_profiles WHERE user_id LIKE 'SEED%'`);
  await client.query(`DELETE FROM analytics_customer_profiles WHERE user_id LIKE 'SEED%'`);
  await client.query(`DELETE FROM user_profiles WHERE user_id LIKE 'SEED%'`);
  // Daily rollups can't be split into seeded vs real; clear them (dev-only —
  // the live job regenerates yesterday+today from real events on next tick).
  for (const t of ['analytics_daily_overview', 'analytics_daily_funnel', 'analytics_daily_listing_funnel', 'analytics_daily_geo', 'analytics_daily_acquisition', 'analytics_daily_language', 'analytics_daily_platform', 'analytics_search_terms', 'analytics_daily_cancel_reasons', 'analytics_daily_payment_failures']) {
    await client.query(`DELETE FROM ${t}`);
  }
}

async function run() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await wipe(client);
    if (WIPE_ONLY) {
      await client.query('COMMIT');
      console.log('Wipe complete.');
      return;
    }

    console.log(`Generating (seed=${RNG_SEED}): ${N_USERS} users, ${N_LISTINGS} listings, ${N_BOOKINGS} bookings over ${N_DAYS} days…`);
    const customers = makeUsers();
    const { hosts, listings } = makeHostsAndListings();
    const bookings = makeBookings(customers, listings);
    const payments = makePayments(bookings);
    const reviews = makeReviews(bookings);
    const analytics = makeAnalytics(customers, hosts, listings, bookings, payments, reviews);

    console.log('Inserting users…');
    const userCols = ['user_id', 'display_name', 'email', 'phone', 'location', 'preferred_language', 'verification_status', 'acquisition_channel', 'acquired_at', 'created_at', 'updated_at'];
    await bulkInsert(client, 'user_profiles', userCols, customers.map((u) => [
      u.userId, u.displayName, u.email, u.phone, `${u.city.city}, ${u.city.state}`, u.language,
      u.verified ? 'verified' : 'pending', u.channel, u.createdAt, u.createdAt, u.createdAt,
    ]));
    // hosts must be verified + unsuspended or their listings are invisible to
    // listPublic / /api/search (see listings.repository.ts base clauses)
    await bulkInsert(client, 'user_profiles', userCols, hosts.map((h) => [
      h.userId, h.displayName, h.email, h.phone, `${h.city.city}, ${h.city.state}`, h.language,
      'verified', h.channel, h.createdAt, h.createdAt, h.createdAt,
    ]));

    console.log('Inserting provider profiles…');
    await bulkInsert(client, 'provider_profiles',
      ['id', 'user_id', 'display_name', 'service_categories', 'lat', 'lng', 'working_hours', 'created_at', 'updated_at'],
      hosts.map((h) => [h.providerId, h.userId, h.displayName, [...h.categories], h.city.lat, h.city.lng, JSON.stringify(DEFAULT_WORKING_HOURS), h.createdAt, h.createdAt]));

    console.log('Inserting listings + room types…');
    await bulkInsert(client, 'listings',
      ['id', 'user_id', 'listing_type', 'category', 'name', 'title', 'description', 'location', 'city', 'state', 'country', 'lat', 'lng', 'price', 'photos', 'amenities', 'vehicle_name', 'property_type', 'metadata', 'is_active', 'is_published', 'cancellation_policy', 'created_at', 'updated_at'],
      listings.map((l) => [
        l.id, l.userId, l.type, l.category, l.name, l.name, l.metadata.description || null, l.location, l.city, l.state, 'India',
        l.lat, l.lng, l.price, l.photos, l.amenities, l.vehicleName || null, l.propertyType || null,
        JSON.stringify(l.metadata), l.isActive, true, weighted([['flexible', 6], ['moderate', 3], ['strict', 1]]), l.createdAt, l.createdAt,
      ]));
    await bulkInsert(client, 'listing_room_types',
      ['id', 'listing_id', 'name', 'base_price_paise', 'max_guests', 'quantity', 'bedrooms', 'bathrooms', 'photos', 'sort_order'],
      listings.flatMap((l) => l.rooms.map((r, i) => [r.id, l.id, r.name, r.basePricePaise, r.maxGuests, r.quantity, r.bedrooms, r.bathrooms, photoUrls(`${l.idx}-room${i}`, 2), i])));

    console.log('Inserting bookings…');
    await bulkInsert(client, 'bookings',
      ['id', 'user_id', 'provider_id', 'listing_id', 'service_category', 'scheduled_date', 'end_date', 'start_time', 'end_time', 'status', 'notes', 'agreed_price_paise', 'subtotal_paise', 'platform_fee_paise', 'taxes_paise', 'discount_paise', 'room_type_id', 'room_type_name_snapshot', 'room_count', 'guest_count', 'vehicle_model_snapshot', 'vehicle_plate_snapshot', 'vehicle_color_snapshot', 'driver_phone_snapshot', 'cancelled_at', 'cancellation_reason', 'expired_at', 'hold_expires_at', 'idempotency_key', 'created_at', 'updated_at'],
      bookings.map((b) => [
        b.id, b.userId, b.providerId, b.listing.id, b.serviceCategory, b.scheduledDate, b.endDate, b.startTime, b.endTime,
        b.status, b.notes, b.fees.totalPaise, b.fees.subtotalPaise, b.fees.platformFeePaise, b.fees.taxesPaise, 0,
        b.roomTypeId, b.roomTypeName, b.roomCount, b.guestCount,
        b.vehicle?.model || null, b.vehicle?.plate || null, b.vehicle?.color || null, b.vehicle?.phone || null,
        b.cancelledAt || null, b.cancellationReason || null, b.expiredAt || null, b.holdExpiresAt || null,
        uuid(), b.createdAt, b.cancelledAt || b.createdAt,
      ]));

    console.log('Inserting payments…');
    await bulkInsert(client, 'payments',
      ['id', 'booking_id', 'user_id', 'amount', 'amount_paise', 'currency', 'status', 'provider_ref', 'provider_payment_id', 'subtotal_paise', 'platform_fee_paise', 'taxes_paise', 'insurance_premium_paise', 'discount_paise', 'refund_paise', 'failed_reason', 'metadata', 'completed_at', 'refunded_at', 'created_at', 'updated_at'],
      payments.map((p) => [
        p.id, p.bookingId, p.userId, (p.amountPaise / 100).toFixed(2), p.amountPaise, 'INR', p.status,
        p.providerRef, p.providerPaymentId,
        p.feeBreakdown.subtotalPaise, p.feeBreakdown.platformFeePaise, p.feeBreakdown.taxesPaise, p.insurance, 0,
        p.refundPaise || null, p.failedReason || null,
        JSON.stringify({ feeBreakdown: p.feeBreakdown, seeded: true }),
        p.completedAt || null, p.refundedAt || null, p.createdAt, p.refundedAt || p.completedAt || p.createdAt,
      ]));

    console.log('Inserting reviews…');
    await bulkInsert(client, 'reviews',
      ['id', 'user_id', 'stay_id', 'provider_id', 'booking_id', 'rating', 'title', 'review_text', 'comment', 'tags', 'helpful_count', 'display_name', 'metadata', 'created_at', 'updated_at'],
      reviews.map((r) => [r.id, r.userId, r.stayId, r.providerId, r.bookingId, r.rating, r.title, r.text, r.text, r.tags, r.helpful, r.displayName, '{}', r.createdAt, r.createdAt]));

    console.log('Inserting analytics rollups…');
    await bulkInsert(client, 'analytics_daily_overview',
      ['day', 'active_users', 'new_signups', 'logins', 'listing_views_total', 'listing_views_stay', 'listing_views_service', 'listing_views_transport', 'searches', 'card_clicks', 'booking_modal_opens', 'payment_starts', 'bookings_confirmed', 'call_clicks', 'message_clicks', 'revenue_paise', 'bookings_cancelled', 'refund_paise', 'reviews_submitted', 'reviews_rating_sum', 'coupons_applied', 'coupons_failed', 'discount_paise', 'wishlist_adds', 'wishlist_removes', 'new_listings', 'active_providers', 'ai_messages', 'fraud_signals', 'fraud_critical', 'payment_failures'],
      analytics.overview);
    await bulkInsert(client, 'analytics_daily_funnel', ['day', 'listing_type', 'views', 'card_clicks', 'modal_opens', 'payment_starts', 'bookings', 'revenue_paise'], analytics.funnel);
    await bulkInsert(client, 'analytics_daily_listing_funnel', ['day', 'listing_id', 'views', 'card_clicks', 'modal_opens', 'payment_starts', 'bookings', 'revenue_paise'], analytics.listingFunnel);
    await bulkInsert(client, 'analytics_daily_geo', ['day', 'city', 'bookings', 'revenue_paise'], analytics.geo);
    await bulkInsert(client, 'analytics_daily_acquisition', ['day', 'channel', 'sessions', 'signups'], analytics.acquisition);
    await bulkInsert(client, 'analytics_daily_language', ['day', 'language', 'events', 'active_users'], analytics.language);
    await bulkInsert(client, 'analytics_daily_platform', ['day', 'platform', 'events', 'active_users'], analytics.platform);
    await bulkInsert(client, 'analytics_search_terms', ['day', 'category', 'term', 'count'], analytics.searchTerms);
    await bulkInsert(client, 'analytics_daily_cancel_reasons', ['day', 'reason', 'count'], analytics.cancelReasons);
    await bulkInsert(client, 'analytics_daily_payment_failures', ['day', 'reason_code', 'count'], analytics.payFailures);
    await bulkInsert(client, 'analytics_customer_profiles',
      ['user_id', 'first_booking_at', 'last_booking_at', 'bookings_total', 'cancelled_total', 'revenue_paise_total', 'favorite_category', 'home_city', 'language', 'acquisition_channel', 'last_active_day'],
      analytics.customerProfiles);

    await client.query('COMMIT');

    const statusMix = {};
    for (const b of bookings) statusMix[b.status] = (statusMix[b.status] || 0) + 1;
    console.log('\nSeed complete:');
    console.log(`  users:              ${customers.length} customers + ${hosts.length} hosts`);
    console.log(`  listings:           ${listings.length} (${listings.filter((l) => l.type === 'stay').length} stay / ${listings.filter((l) => l.type === 'service').length} service / ${listings.filter((l) => l.type === 'transport').length} transport)`);
    console.log(`  room types:         ${listings.reduce((s, l) => s + l.rooms.length, 0)}`);
    console.log(`  bookings:           ${bookings.length}  ${JSON.stringify(statusMix)}`);
    console.log(`  payments:           ${payments.length}`);
    console.log(`  reviews:            ${reviews.length}`);
    console.log(`  analytics days:     ${analytics.overview.length} (through ${dateStr(daysAgo(2))}; the live rollup job owns yesterday+today)`);
    console.log(`\nRe-run to regenerate (idempotent). Remove everything with: node scripts/seed-dev.js --wipe`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
