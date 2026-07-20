// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError, ListingNotReadyError } from '../../../common/errors/app-error.js';

const listForUser = vi.fn();
const listPublicRepo = vi.fn();
const getById = vi.fn();
const create = vi.fn();
const update = vi.fn();

// In-memory stand-in for the Redis page cache so tests never touch a real
// Redis (and so we can simulate an outage).
const cacheStore = new Map<string, unknown>();
const cacheGetMock = vi.fn(async (key: string) => cacheStore.get(key) ?? null);
const cacheSetMock = vi.fn(async (key: string, value: unknown) => {
  cacheStore.set(key, value);
});

const roomTypesListForListing = vi.fn();
const providersGetByUserId = vi.fn();
const providersUpdateServiceCategories = vi.fn();
const providersCreate = vi.fn();
const providersDeleteAvailabilityForProvider = vi.fn();
const providersCreateAvailability = vi.fn();
const providersUpdate = vi.fn();
const verificationListDocumentsForUser = vi.fn();
const verificationGetStatusForUser = vi.fn();

vi.mock('../repositories/listings.repository.js', () => ({
  listingsRepository: {
    listForUser,
    listPublic: listPublicRepo,
    getById,
    create,
    update,
  },
}));

vi.mock('../../../common/cache/redis.js', () => ({
  cacheGet: (key: string) => cacheGetMock(key),
  cacheSet: (key: string, value: unknown, ttl?: number) => cacheSetMock(key, value, ttl),
}));

vi.mock('../repositories/room-types.repository.js', () => ({
  roomTypesRepository: { listForListing: roomTypesListForListing },
}));

vi.mock('../../providers/repositories/providers.repository.js', () => ({
  providersRepository: {
    getByUserId: providersGetByUserId,
    updateServiceCategories: providersUpdateServiceCategories,
    create: providersCreate,
    deleteAvailabilityForProvider: providersDeleteAvailabilityForProvider,
    createAvailability: providersCreateAvailability,
    update: providersUpdate,
  },
}));

vi.mock('../../verification/repositories/verification.repository.js', () => ({
  verificationRepository: {
    listDocumentsForUser: verificationListDocumentsForUser,
    getVerificationStatusForUser: verificationGetStatusForUser,
  },
}));

vi.mock('../../../common/services/geocode.service.js', () => ({
  geocodeAddress: vi.fn().mockResolvedValue(null),
  buildAddressString: vi.fn().mockReturnValue(''),
}));

vi.mock('../../infrastructure/services/storage.service.js', () => ({
  storageService: {
    rewriteS3UrlToCdn: (v: unknown) => v,
    rewriteS3UrlArrayToCdn: (v: unknown) => v,
  },
}));

vi.mock('../../providers/services/smart-schedule.service.js', () => ({
  smartScheduleService: { findSlots: vi.fn() },
  // Real TZ-independent weekday helper so the date-availability filter resolves
  // the correct working-hours day in tests.
  dayOfWeekForYmd: (ymd: string) => {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  },
}));

const bookedIntervals = vi.fn(async () => ({ rows: [] as Array<{ listing_id: string; scheduled_date: string; start_time: string | null; end_time: string | null }> }));
vi.mock('../../bookings/repositories/bookings.repository.js', () => ({
  bookingsRepository: { bookedIntervalsForListingsOnDate: (...args: unknown[]) => bookedIntervals(...(args as [])) },
}));

// Guardrails + analytics run inside create()/update() and were previously
// UNMOCKED: the semantic guardrail resolves the LLM provider from config
// (process.env, which vitest workers SHARE across test files) and analytics
// fire-and-forgets to the event provider. Either could behave differently
// depending on which files ran earlier in the same worker — the source of a
// rare full-suite-only flake in "forces is_active=false on create". Pin both.
vi.mock('../../../common/guardrails/listing-guardrails.js', () => ({
  runListingGuardrails: vi.fn(async () => []),
  formatGuardrailIssues: vi.fn(() => 'guardrail issues'),
}));

vi.mock('../../analytics/services/analytics-track.js', () => ({
  trackServerEvent: vi.fn(),
}));

function readyServiceListing(extra: Record<string, unknown> = {}) {
  return {
    id: 'listing-1',
    user_id: 'user-1',
    listing_type: 'service',
    name: 'Quick Plumber',
    category: 'plumber',
    description: 'Plumbing',
    location: 'Pune',
    price: '500',
    availability: 'Mon-Fri',
    // SERVICE_PHOTO_MIN is 5 — fixture mirrors a ready-to-activate
    // service row, so it must clear the photos gate.
    photos: ['1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg'],
    metadata: {
      pricingUnit: 'per_visit',
      // Use unit-explicit duration — the registry's duration custom-gate
      // treats bare digits as hours, which trips the ≤24h rule.
      duration: '60 minutes',
      workingHours: { mon: ['09:00', '18:00'] },
      serviceModes: ['at-home'],
      serviceRadius: 10,
      // experience is required for services by the unified registry +
      // listing-readiness contract (Phase 2 refactor closed the drift
      // where listing-readiness alone didn't enforce it).
      experience: '5 years',
      // languages is now required for service + transport (registry
      // requiredFor). Supported set only.
      languages: ['English', 'Hindi'],
    },
    ...extra,
  };
}

describe('ListingsService listPublic page cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheStore.clear();
  });

  const repoRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `listing-${i}`,
      updated_at: new Date(Date.UTC(2026, 0, 1, 0, 0, n - i)),
      avg_rating: '4.5',
      review_count: 3,
    }));

  it('serves the second identical request from cache without hitting the repository', async () => {
    listPublicRepo.mockResolvedValue({ rows: repoRows(5) });
    const { listingsService } = await import('./listings.service.js');

    const first = await listingsService.listPublic({ type: 'stay', limit: 20 });
    expect(listPublicRepo).toHaveBeenCalledTimes(1);
    expect(first.data).toHaveLength(5);
    expect(first.nextCursor).toBeNull();

    const second = await listingsService.listPublic({ type: 'stay', limit: 20 });
    expect(listPublicRepo).toHaveBeenCalledTimes(1); // cache hit — no second query
    expect(second).toEqual(first);
  });

  it('keys the cache by query params — a different type misses', async () => {
    listPublicRepo.mockResolvedValue({ rows: repoRows(2) });
    const { listingsService } = await import('./listings.service.js');

    await listingsService.listPublic({ type: 'stay', limit: 20 });
    await listingsService.listPublic({ type: 'service', limit: 20 });
    expect(listPublicRepo).toHaveBeenCalledTimes(2);
  });

  it('degrades to the repository when the cache is down instead of failing', async () => {
    cacheGetMock.mockRejectedValueOnce(new Error('redis down'));
    cacheSetMock.mockRejectedValueOnce(new Error('redis down'));
    listPublicRepo.mockResolvedValue({ rows: repoRows(1) });
    const { listingsService } = await import('./listings.service.js');

    const page = await listingsService.listPublic({ type: 'stay', limit: 20 });
    expect(page.data).toHaveLength(1);
    expect(listPublicRepo).toHaveBeenCalledTimes(1);
  });

  it('returns hasMore paging with a cursor when the repo yields limit+1 rows', async () => {
    listPublicRepo.mockResolvedValue({ rows: repoRows(21) });
    const { listingsService } = await import('./listings.service.js');

    const page = await listingsService.listPublic({ type: 'stay', limit: 20 });
    expect(page.data).toHaveLength(20);
    expect(page.nextCursor).toEqual(expect.any(String));
  });
});

describe('ListingsService listPublic date availability (services/transport)', () => {
  // 2026-08-03 is a Monday, 2026-08-02 a Sunday.
  const MON = '2026-08-03';
  const TUE = '2026-08-04';
  const SUN = '2026-08-02';

  const svcRow = (id: string, meta: Record<string, unknown> = {}) => ({
    id,
    updated_at: new Date(Date.UTC(2026, 0, 1)),
    listing_type: 'service',
    avg_rating: '4.5',
    review_count: 1,
    metadata: { workingHours: { mon: ['09:00', '18:00'], sun: null }, ...meta },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    cacheStore.clear();
    bookedIntervals.mockResolvedValue({ rows: [] });
  });

  it('keeps a service with no bookings on an open day', async () => {
    listPublicRepo.mockResolvedValue({ rows: [svcRow('a')] });
    const { listingsService } = await import('./listings.service.js');
    const page = await listingsService.listPublic({ type: 'service', limit: 20, from: MON, to: TUE });
    expect(page.data.map((r: { id: string }) => r.id)).toEqual(['a']);
  });

  it('hides a service that is a weekly off on the chosen day', async () => {
    listPublicRepo.mockResolvedValue({ rows: [svcRow('a')] });
    const { listingsService } = await import('./listings.service.js');
    const page = await listingsService.listPublic({ type: 'service', limit: 20, from: SUN, to: MON });
    expect(page.data).toHaveLength(0);
  });

  it('hides a service the host blocked on the chosen day', async () => {
    listPublicRepo.mockResolvedValue({ rows: [svcRow('a', { blockedDates: [MON] })] });
    const { listingsService } = await import('./listings.service.js');
    const page = await listingsService.listPublic({ type: 'service', limit: 20, from: MON, to: TUE });
    expect(page.data).toHaveLength(0);
  });

  it('hides a service booked solid across its whole working day', async () => {
    listPublicRepo.mockResolvedValue({ rows: [svcRow('a')] });
    bookedIntervals.mockResolvedValue({ rows: [{ listing_id: 'a', scheduled_date: MON, start_time: '09:00', end_time: '18:00' }] });
    const { listingsService } = await import('./listings.service.js');
    const page = await listingsService.listPublic({ type: 'service', limit: 20, from: MON, to: TUE });
    expect(page.data).toHaveLength(0);
  });

  it('keeps a service that still has a free gap (slot-level, not asset-level)', async () => {
    listPublicRepo.mockResolvedValue({ rows: [svcRow('a')] });
    // One 09:00–10:00 booking leaves the rest of the day open.
    bookedIntervals.mockResolvedValue({ rows: [{ listing_id: 'a', scheduled_date: MON, start_time: '09:00', end_time: '10:00' }] });
    const { listingsService } = await import('./listings.service.js');
    const page = await listingsService.listPublic({ type: 'service', limit: 20, from: MON, to: TUE });
    expect(page.data.map((r: { id: string }) => r.id)).toEqual(['a']);
  });

  it('multi-day window keeps a listing free on ANY day in it (weekly-off Sunday, open Monday)', async () => {
    listPublicRepo.mockResolvedValue({ rows: [svcRow('a')] });
    const { listingsService } = await import('./listings.service.js');
    // [SUN, TUE) = Sunday + Monday. Sunday is a weekly off, but Monday is
    // open — ANY-day semantics must keep the listing.
    const page = await listingsService.listPublic({ type: 'service', limit: 20, from: SUN, to: TUE });
    expect(page.data.map((r: { id: string }) => r.id)).toEqual(['a']);
  });

  it('multi-day window drops a listing with no free slot on EVERY day in it', async () => {
    listPublicRepo.mockResolvedValue({ rows: [svcRow('a', { blockedDates: [MON] })] });
    const { listingsService } = await import('./listings.service.js');
    // [SUN, TUE): Sunday is the weekly off and Monday is host-blocked —
    // nothing free anywhere in the window.
    const page = await listingsService.listPublic({ type: 'service', limit: 20, from: SUN, to: TUE });
    expect(page.data).toHaveLength(0);
  });

  it('does not date-filter stays through the service-layer path', async () => {
    listPublicRepo.mockResolvedValue({ rows: [{ id: 's', updated_at: new Date(Date.UTC(2026, 0, 1)), listing_type: 'stay', avg_rating: '4', review_count: 0, metadata: {} }] });
    const { listingsService } = await import('./listings.service.js');
    const page = await listingsService.listPublic({ type: 'stay', limit: 20, from: MON, to: TUE });
    // Stays rely on the repository SQL clause; the service layer must not touch them.
    expect(bookedIntervals).not.toHaveBeenCalled();
    expect(page.data).toHaveLength(1);
  });
});

describe('ListingsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheStore.clear();
    roomTypesListForListing.mockResolvedValue({ rows: [] });
    providersGetByUserId.mockResolvedValue({ rows: [] });
    providersUpdateServiceCategories.mockResolvedValue({ rows: [{ id: 'prov-1' }] });
    providersCreate.mockResolvedValue({ rows: [{ id: 'prov-1' }] });
    providersDeleteAvailabilityForProvider.mockResolvedValue({ rows: [] });
    providersCreateAvailability.mockResolvedValue({ rows: [] });
    providersUpdate.mockResolvedValue({ rows: [{ id: 'prov-1' }] });
    verificationListDocumentsForUser.mockResolvedValue({ rows: [] });
    verificationGetStatusForUser.mockResolvedValue({ rows: [{ verification_status: 'pending' }] });
  });

  it('forces is_active=false on create even if payload requests true', async () => {
    create.mockResolvedValueOnce({ rows: [{ id: 'listing-1', user_id: 'user-1' }] });
    const { listingsService } = await import('./listings.service.js');

    // city satisfies the WS6 create guard (public location is built from
    // city/state, so create now rejects listings that carry neither).
    await listingsService.create('user-1', { title: 'Heritage Stay', is_active: true, city: 'Hampi', state: 'Karnataka' });

    // The repository must have been called with is_active=false regardless of input.
    const passed = create.mock.calls[0][1] as Record<string, unknown>;
    expect(passed.is_active).toBe(false);
  });

  it('create SAVES but returns the message when guardrails yield a warn-severity issue', async () => {
    create.mockResolvedValueOnce({ rows: [{ id: 'listing-1', user_id: 'user-1' }] });
    const { runListingGuardrails } = await import('../../../common/guardrails/listing-guardrails.js');
    vi.mocked(runListingGuardrails).mockResolvedValueOnce([
      { field: 'description', code: 'address_in_prose', severity: 'warn', message: 'Your description appears to contain a street address.' },
    ]);
    const { listingsService } = await import('./listings.service.js');

    const result = await listingsService.create('user-1', {
      title: 'Heritage Stay',
      description: 'Find us at D.No 12/4, Temple Street, Hampi 583239',
      city: 'Hampi',
      state: 'Karnataka',
    });

    expect(create).toHaveBeenCalledTimes(1); // warn-only: the listing was created
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toMatch(/street address/i);
  });

  it('rejects create when no city/state can be determined (WS6 — public location is built from them)', async () => {
    const { listingsService } = await import('./listings.service.js');
    await expect(
      listingsService.create('user-1', { title: 'Mystery Stay', is_active: false }),
    ).rejects.toThrow(/city/i);
    expect(create).not.toHaveBeenCalled();
  });

  it('updates a listing when not activating', async () => {
    getById.mockResolvedValueOnce({
      rows: [{ id: 'listing-1', user_id: 'user-1', is_active: false }],
    });
    update.mockResolvedValueOnce({ rows: [{ id: 'listing-1', title: 'Updated Stay' }] });
    const { listingsService } = await import('./listings.service.js');

    const result = await listingsService.update('listing-1', 'user-1', { title: 'Updated Stay' });
    expect(result.data.title).toBe('Updated Stay');
  });

  it('allows an inactive draft to save incomplete data', async () => {
    getById.mockResolvedValueOnce({
      rows: [{ id: 'listing-1', user_id: 'user-1', is_active: false, photos: [] }],
    });
    update.mockResolvedValueOnce({ rows: [{ id: 'listing-1', photos: [] }] });
    const { listingsService } = await import('./listings.service.js');

    const result = await listingsService.update('listing-1', 'user-1', { photos: [] });
    expect(result.data).toBeTruthy();
    expect(update).toHaveBeenCalled();
  });

  it('rejects an active service update that clears serviceModes', async () => {
    const ready = readyServiceListing({ is_active: true });
    getById.mockResolvedValueOnce({ rows: [ready] });
    providersGetByUserId.mockResolvedValue({ rows: [{ id: 'prov-1' }] });
    verificationGetStatusForUser.mockResolvedValue({
      rows: [{ verification_status: 'verified' }],
    });
    verificationListDocumentsForUser.mockResolvedValue({
      rows: [{ document_type: 'aadhaar', status: 'approved' }],
    });
    const { listingsService } = await import('./listings.service.js');

    await expect(
      listingsService.update('listing-1', 'user-1', {
        metadata: { ...(ready.metadata as object), serviceModes: [] },
      }),
    ).rejects.toBeInstanceOf(ListingNotReadyError);
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects an active listing update that removes all photos', async () => {
    const ready = readyServiceListing({ is_active: true });
    getById.mockResolvedValueOnce({ rows: [ready] });
    providersGetByUserId.mockResolvedValue({ rows: [{ id: 'prov-1' }] });
    verificationGetStatusForUser.mockResolvedValue({
      rows: [{ verification_status: 'verified' }],
    });
    verificationListDocumentsForUser.mockResolvedValue({
      rows: [{ document_type: 'aadhaar', status: 'approved' }],
    });
    const { listingsService } = await import('./listings.service.js');

    await expect(
      listingsService.update('listing-1', 'user-1', { photos: [] }),
    ).rejects.toBeInstanceOf(ListingNotReadyError);
    expect(update).not.toHaveBeenCalled();
  });

  it('allows explicit deactivation of an active listing even if data is now incomplete', async () => {
    const broken = readyServiceListing({ is_active: true, photos: [] });
    getById.mockResolvedValueOnce({ rows: [broken] });
    update.mockResolvedValueOnce({ rows: [{ ...broken, is_active: false }] });
    const { listingsService } = await import('./listings.service.js');

    const result = await listingsService.update('listing-1', 'user-1', { is_active: false });
    expect(result.data.is_active).toBe(false);
  });

  it('readiness endpoint rejects non-owner access', async () => {
    getById.mockResolvedValueOnce({
      rows: [{ id: 'listing-1', user_id: 'user-1', listing_type: 'service' }],
    });
    const { listingsService } = await import('./listings.service.js');

    await expect(
      listingsService.getReadiness('listing-1', 'someone-else'),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects activation with ListingNotReadyError when validator fails', async () => {
    getById.mockResolvedValueOnce({
      rows: [{ id: 'listing-1', user_id: 'user-1', listing_type: 'service', photos: [], category: 'plumber' }],
    });
    const { listingsService } = await import('./listings.service.js');

    await expect(
      listingsService.update('listing-1', 'user-1', { is_active: true }),
    ).rejects.toBeInstanceOf(ListingNotReadyError);
    // The repository must NOT have been hit if validation failed.
    expect(update).not.toHaveBeenCalled();
  });

  it('allows activation when the listing passes the readiness validator', async () => {
    const ready = readyServiceListing();
    getById.mockResolvedValueOnce({ rows: [ready] });
    providersGetByUserId.mockResolvedValue({ rows: [{ id: 'prov-1' }] });
    verificationGetStatusForUser.mockResolvedValue({
      rows: [{ verification_status: 'verified' }],
    });
    verificationListDocumentsForUser.mockResolvedValue({
      rows: [{ document_type: 'aadhaar', status: 'approved' }],
    });
    update.mockResolvedValueOnce({ rows: [{ ...ready, is_active: true }] });
    const { listingsService } = await import('./listings.service.js');

    const result = await listingsService.update('listing-1', 'user-1', { is_active: true });
    expect(result.data.is_active).toBe(true);
  });

  it('blocks transport activation when driving license is not approved', async () => {
    const transport = {
      id: 'listing-2',
      user_id: 'user-1',
      listing_type: 'transport',
      name: 'Driver Ravi',
      category: 'driver-cab',
      description: 'Daily rides',
      location: 'Pune',
      vehicle_name: 'Swift',
      vehicle_year: 2020,
      photos: ['1.jpg'],
      metadata: {
        serviceRadius: 50,
        languages: ['English'],
        transportMode: 'hourly',
        pricePerHour: 300,
      },
    };
    getById.mockResolvedValueOnce({ rows: [transport] });
    providersGetByUserId.mockResolvedValue({ rows: [{ id: 'prov-1' }] });
    verificationGetStatusForUser.mockResolvedValue({
      rows: [{ verification_status: 'verified' }],
    });
    verificationListDocumentsForUser.mockResolvedValue({
      rows: [{ document_type: 'aadhaar', status: 'approved' }],
    });
    const { listingsService } = await import('./listings.service.js');

    await expect(
      listingsService.update('listing-2', 'user-1', { is_active: true }),
    ).rejects.toBeInstanceOf(ListingNotReadyError);
  });

  it('exposes no self-serve delete — listing removal is admin-only (soft archive)', async () => {
    const { listingsService } = await import('./listings.service.js');

    expect((listingsService as unknown as Record<string, unknown>).delete).toBeUndefined();
  });

  it('throws when trying to update a missing listing', async () => {
    getById.mockResolvedValueOnce({ rows: [] });
    const { listingsService } = await import('./listings.service.js');

    await expect(
      listingsService.update('missing', 'user-1', { title: 'Nope' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
