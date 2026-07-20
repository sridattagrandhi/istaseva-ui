/**
 * Mirror-integrity test for the FE onboarding field registry.
 *
 * Goal: catch the most common drift mode where someone adds a required
 * field to the server registry but forgets the FE mirror (or vice
 * versa). This test asserts that the set of field NAMES we treat as
 * registry-managed on the FE matches the canonical list — same list
 * that the server registry exposes. If a field is added to one side
 * only, the EXPECTED_FIELD_NAMES constant goes out of sync and the
 * test fails on whichever side wasn't updated.
 *
 * What this test CANNOT catch: a field whose SEMANTICS drifted (e.g.
 * server makes it required for transport while FE keeps it
 * service-only). Those need careful manual review whenever the
 * underlying rule changes; the FE registry's per-field comments
 * reference the server's line number for that reason.
 */
import { describe, it, expect } from 'vitest';
import {
  FE_FIELD_REGISTRY,
  getRegistryMissingFields,
  inferListingType,
  isOnlineOnlyService,
} from '../field-registry.shared';
import type { OnboardingProfile } from '@/hooks/useConversationEngine';

/** Field names the FE registry MUST cover. Keep alphabetized so diffs
 *  on a missed addition are obvious. Update both this constant and the
 *  server registry when adding / removing a field on either side. */
const EXPECTED_FIELD_NAMES = [
  'category',
  'description',
  'duration',
  'experience',
  'languages',
  'licensePlate',
  'location',
  'maxGuests',
  'meetingDetails',
  'name',
  'packageOptions',
  'price',
  'pricePerDay',
  'pricePerHour',
  'pricingUnit',
  'seatingCapacity',
  'serviceModes',
  'serviceRadius',
  'servicesCatalog',
  'transportMode',
  'transportationTypes',
  'vehicleColor',
  'vehicleName',
  'vehicleType',
  'visitAddress',
  'workingHours',
  'bedrooms',
].sort();

// Minimal profile factory — produces a typed OnboardingProfile so the
// registry can run without a real React tree. Only fields we exercise
// need realistic values; everything else gets the empty default of its
// declared type.
function makeProfile(overrides: Partial<OnboardingProfile> = {}): OnboardingProfile {
  const defaults = {
    category: '', name: '', location: '', lat: 0, lng: 0,
    serviceArea: '', price: '', availability: '', description: '',
    photos: [], vehicleName: '', vehicleYear: '', vehicleType: '',
    seatingCapacity: '', pricePerKm: '', acceptsQuotes: false,
    duration: '', languages: [], experience: '',
    subcategory: '', subcategories: [], serviceRadius: 0,
    amenities: [],
    bedrooms: 0, bathrooms: 0, maxGuests: 0, propertyType: '',
    checkInTime: '', checkOutTime: '',
    vehicleClass: 'walk' as const, maxJobsPerDay: 0,
    workingHours: { sun: null, mon: null, tue: null, wed: null, thu: null, fri: null, sat: null },
    bufferMinutes: 0, serviceModes: [], visitAddress: '',
    meetingDetails: '', pricingUnit: '',
    transportMode: '' as never, transportModes: [],
    pricePerHour: '', pricePerDay: '',
    packageOptions: [], transportationTypes: [],
    serviceSlots: [], hotelRoomTypes: [], heroPhoto: '', servicesCatalog: [],
  } as unknown as OnboardingProfile;
  return { ...defaults, ...overrides };
}

describe('FE field-registry — mirror integrity', () => {
  it('covers exactly the expected set of field names', () => {
    const got = FE_FIELD_REGISTRY.map((s) => s.name).sort();
    expect(got).toEqual(EXPECTED_FIELD_NAMES);
  });

  it('every spec has an appliesTo', () => {
    for (const s of FE_FIELD_REGISTRY) {
      expect(s.appliesTo).toBeDefined();
    }
  });

  // Spot-check the load-bearing rules so a future refactor that flips
  // a default doesn't slip through silently.
  it('servicesCatalog is required for service listings', () => {
    const spec = FE_FIELD_REGISTRY.find((s) => s.name === 'servicesCatalog')!;
    expect(spec.requiredFor).toContain('service');
  });

  it('languages applies to service + transport (not stays)', () => {
    const spec = FE_FIELD_REGISTRY.find((s) => s.name === 'languages')!;
    expect(spec.appliesTo).toEqual(['service', 'transport']);
  });

  it('online-only services do NOT require location', () => {
    expect(isOnlineOnlyService(makeProfile({
      category: 'yoga-teacher',
      serviceModes: ['online'],
    }))).toBe(true);
    const m = getRegistryMissingFields(makeProfile({
      category: 'yoga-teacher',
      serviceModes: ['online'],
    }));
    expect(m.has('location')).toBe(false);
  });
});

describe('FE registry — behavior parity with server registry', () => {
  it('listing-type inference recognizes the wider driver-* family', () => {
    for (const cat of [
      'driver-cab', 'driver-auto', 'driver-bus', 'driver-tempo',
      'driver-scooter', 'driver-motorcycle',
    ]) {
      expect(inferListingType(makeProfile({ category: cat }))).toBe('transport');
    }
  });

  it('description is required everywhere', () => {
    const stayMiss = getRegistryMissingFields(makeProfile({ category: 'homestay', propertyType: 'homestay' }));
    expect(stayMiss.has('description')).toBe(true);
    const svcMiss = getRegistryMissingFields(makeProfile({ category: 'plumber' }));
    expect(svcMiss.has('description')).toBe(true);
    const txMiss = getRegistryMissingFields(makeProfile({ category: 'driver-cab' }));
    expect(txMiss.has('description')).toBe(true);
  });

  it('workingHours required (open day) for service + transport, not stays', () => {
    const stay = getRegistryMissingFields(makeProfile({ category: 'homestay' }));
    expect(stay.has('workingHours')).toBe(false);
    const svc = getRegistryMissingFields(makeProfile({ category: 'plumber' }));
    expect(svc.has('workingHours')).toBe(true);
    const open = getRegistryMissingFields(makeProfile({
      category: 'plumber',
      workingHours: { sun: null, mon: ['09:00', '18:00'], tue: null, wed: null, thu: null, fri: null, sat: null },
    }));
    expect(open.has('workingHours')).toBe(false);
  });

  it('transport modes drive pricePerHour / pricePerDay / packageOptions requirement', () => {
    const hourly = getRegistryMissingFields(makeProfile({
      category: 'driver-cab', transportMode: 'hourly' as never, transportModes: ['hourly'],
    }));
    expect(hourly.has('pricePerHour')).toBe(true);
    expect(hourly.has('pricePerDay')).toBe(false);

    const day = getRegistryMissingFields(makeProfile({
      category: 'driver-cab', transportMode: 'day' as never, transportModes: ['day'],
    }));
    expect(day.has('pricePerDay')).toBe(true);

    const pkg = getRegistryMissingFields(makeProfile({
      category: 'driver-cab', transportMode: 'package' as never, transportModes: ['package'],
    }));
    expect(pkg.has('packageOptions')).toBe(true);
  });

  it('serviceModes drive visitAddress / meetingDetails / serviceRadius requirement', () => {
    const visit = getRegistryMissingFields(makeProfile({
      category: 'salon', serviceModes: ['visit-provider'],
    }));
    expect(visit.has('visitAddress')).toBe(true);
    expect(visit.has('meetingDetails')).toBe(false);
    expect(visit.has('serviceRadius')).toBe(false);

    const home = getRegistryMissingFields(makeProfile({
      category: 'plumber', serviceModes: ['at-home'],
    }));
    expect(home.has('serviceRadius')).toBe(true);
    expect(home.has('visitAddress')).toBe(false);

    const online = getRegistryMissingFields(makeProfile({
      category: 'yoga-teacher', serviceModes: ['online'],
    }));
    expect(online.has('meetingDetails')).toBe(true);
    expect(online.has('serviceRadius')).toBe(false);
  });
});
