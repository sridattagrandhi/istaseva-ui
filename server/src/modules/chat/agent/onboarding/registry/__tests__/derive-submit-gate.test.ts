/**
 * Parity test: the derived submit-gate MUST produce the same "missing
 * fields" outcome as the hand-rolled logic in submit-listing.tool.ts
 * for representative profiles. When Phase B swaps the gate in, this
 * test guarantees no profile that previously submitted will fail (or
 * vice versa).
 *
 * Each case asserts a property on the output rather than the exact
 * string list — the two implementations have slightly different field
 * orderings and may attach different "(reason)" suffixes; what we care
 * about is which field NAMES surface as missing.
 */
import { describe, it, expect } from 'vitest';
import { FIELD_REGISTRY } from '../field-registry.js';
import { getMissingRequiredFields } from '../derive-submit-gate.js';
import type { OnboardingProfileState } from '../../types.js';

function missingNames(profile: OnboardingProfileState): string[] {
  return getMissingRequiredFields(FIELD_REGISTRY, profile)
    // Strip "(reason)" suffix so we compare bare names.
    .map((s) => s.replace(/\s*\(.*\)$/, ''));
}

describe('derived submit-gate — parity with submit-listing.tool.ts', () => {
  it('empty profile flags the core trio at minimum', () => {
    const m = missingNames({});
    // category, name surface immediately. location surfaces only once
    // listing type is known (online-only check needs serviceModes),
    // so an empty profile lists at least category and name.
    expect(m).toContain('category');
    expect(m).toContain('name');
  });

  it('online-only service does NOT require location', () => {
    const profile: OnboardingProfileState = {
      category: 'yoga-teacher',
      name: 'Asha',
      serviceModes: ['online'],
      meetingDetails: 'Zoom link sent 30 min before',
      experience: '5 years',
      duration: '1 hour',
      pricingUnit: 'per_session',
      servicesCatalog: [{ name: 'Yoga session', basePrice: 600, addOns: [] }],
    };
    const m = missingNames(profile);
    expect(m).not.toContain('location');
  });

  it('mixed-mode service (at-home + online) requires location, meetingDetails, serviceRadius', () => {
    const profile: OnboardingProfileState = {
      category: 'yoga-teacher',
      name: 'Asha',
      serviceModes: ['at-home', 'online'],
      experience: '5 years',
      duration: '1 hour',
      pricingUnit: 'per_session',
      servicesCatalog: [{ name: 'Yoga', basePrice: 600, addOns: [] }],
    };
    const m = missingNames(profile);
    expect(m).toContain('location');
    expect(m).toContain('meetingDetails');
    expect(m).toContain('serviceRadius');
  });

  it('service with valid servicesCatalog clears servicesCatalog requirement', () => {
    const profile: OnboardingProfileState = {
      category: 'salon',
      name: 'Smart Cuts',
      location: 'Banjara Hills, Hyderabad',
      experience: '5 years',
      duration: '1 hour',
      pricingUnit: 'per_visit',
      serviceModes: ['visit-provider'],
      visitAddress: 'Shop 3, Road No 5, Banjara Hills, Hyderabad 500034',
      servicesCatalog: [
        { name: "Men's Haircut", basePrice: 500, addOns: [{ label: 'Beard trim', price: 100 }] },
      ],
    };
    const m = missingNames(profile);
    expect(m).not.toContain('servicesCatalog');
  });

  it('service WITHOUT servicesCatalog and WITHOUT legacy price flags servicesCatalog', () => {
    const profile: OnboardingProfileState = {
      category: 'salon',
      name: 'Smart Cuts',
      location: 'Banjara Hills, Hyderabad',
      experience: '5 years',
      duration: '1 hour',
      pricingUnit: 'per_visit',
      serviceModes: ['visit-provider'],
      visitAddress: 'Shop 3, Road No 5, Banjara Hills, Hyderabad 500034',
    };
    const m = missingNames(profile);
    expect(m).toContain('servicesCatalog');
  });

  it('duration > 24h triggers the duration custom gate', () => {
    const profile: OnboardingProfileState = {
      category: 'cleaning',
      name: 'A',
      location: 'X',
      experience: '5 years',
      duration: '2 days',
      pricingUnit: 'per_visit',
      serviceModes: ['at-home'],
      serviceRadius: 5,
      servicesCatalog: [{ name: 'Deep clean', basePrice: 500, addOns: [] }],
    };
    const m = getMissingRequiredFields(FIELD_REGISTRY, profile);
    expect(m.some((s) => s.startsWith('duration'))).toBe(true);
  });

  it('transport requires transportationTypes, experience, serviceRadius, transportMode', () => {
    const profile: OnboardingProfileState = {
      category: 'driver-cab',
      name: 'Ravi',
      location: 'Coorg',
    };
    const m = missingNames(profile);
    expect(m).toContain('experience');
    expect(m).toContain('serviceRadius');
    expect(m).toContain('transportMode');
    expect(m).toContain('transportationTypes');
  });

  it('transport with mode=hourly requires pricePerHour', () => {
    const profile: OnboardingProfileState = {
      category: 'driver-cab',
      name: 'Ravi',
      location: 'Coorg',
      experience: '5 years',
      serviceRadius: 25,
      transportMode: 'hourly',
      transportationTypes: [
        { type: 'sedan_cab', details: { basePrice: 100, seatingCapacity: 4, acAvailable: true } },
      ],
    };
    const m = missingNames(profile);
    expect(m).toContain('pricePerHour');
  });

  it('transport with mode=package and at least one valid package row is satisfied', () => {
    const profile: OnboardingProfileState = {
      category: 'driver-cab',
      name: 'Ravi',
      location: 'Coorg',
      experience: '5 years',
      serviceRadius: 25,
      transportMode: 'package',
      packageOptions: [{
        label: 'Coorg loop', price: 3500, hours: 8,
        stops: [{ place: 'Abbey Falls' }],
        distanceKmMin: 80, distanceKmMax: 100,
      }],
      transportationTypes: [
        { type: 'sedan_cab', details: { basePrice: 100, seatingCapacity: 4, acAvailable: true } },
      ],
    };
    const m = missingNames(profile);
    expect(m).not.toContain('packageOptions');
  });

  it('multi-room stay (hotel) does NOT require price/bedrooms/maxGuests at property level', () => {
    const profile: OnboardingProfileState = {
      category: 'hotel',
      propertyType: 'hotel',
      name: 'Grand Plaza',
      location: 'Banjara Hills, Hyderabad',
    };
    const m = missingNames(profile);
    expect(m).not.toContain('price');
    expect(m).not.toContain('bedrooms');
    expect(m).not.toContain('maxGuests');
  });

  it('single-unit stay (homestay) requires price, bedrooms, maxGuests', () => {
    const profile: OnboardingProfileState = {
      category: 'homestay',
      propertyType: 'homestay',
      name: 'Coffee Estate Stay',
      location: 'Madikeri, Coorg',
    };
    const m = missingNames(profile);
    expect(m).toContain('price');
    expect(m).toContain('bedrooms');
    expect(m).toContain('maxGuests');
  });

  // Drift-bug fixes: align submit gate with listing-readiness activation gate.
  it('description is required for every listing type (closes drift with listing-readiness:190)', () => {
    const cases: Array<[string, OnboardingProfileState]> = [
      ['homestay', { category: 'homestay', propertyType: 'homestay', name: 'A', location: 'X', price: '1000', bedrooms: 2, maxGuests: 4 }],
      ['service', {
        category: 'plumber', name: 'A', location: 'X',
        experience: '5 years', duration: '1 hour', pricingUnit: 'per_visit',
        serviceModes: ['at-home'], serviceRadius: 5,
        servicesCatalog: [{ name: 'Fix tap', basePrice: 500, addOns: [] }],
        workingHours: { mon: ['09:00', '18:00'], tue: null, wed: null, thu: null, fri: null, sat: null, sun: null },
      }],
      ['transport', {
        category: 'driver-cab', name: 'A', location: 'X',
        experience: '5 years', serviceRadius: 25, transportMode: 'hourly', pricePerHour: '350',
        transportationTypes: [{ type: 'sedan_cab', details: { basePrice: 100, seatingCapacity: 4, acAvailable: true } }],
        workingHours: { mon: ['09:00', '18:00'], tue: null, wed: null, thu: null, fri: null, sat: null, sun: null },
      }],
    ];
    for (const [label, profile] of cases) {
      const m = missingNames(profile);
      expect(m, `${label} should flag description as missing`).toContain('description');
    }
  });

  it('workingHours required (≥1 open day) for service + transport (closes drift with listing-readiness:350,466)', () => {
    const serviceNoHours: OnboardingProfileState = {
      category: 'plumber', name: 'A', location: 'X', description: 'desc',
      experience: '5 years', duration: '1 hour', pricingUnit: 'per_visit',
      serviceModes: ['at-home'], serviceRadius: 5,
      servicesCatalog: [{ name: 'Fix tap', basePrice: 500, addOns: [] }],
    };
    expect(missingNames(serviceNoHours)).toContain('workingHours');

    const serviceAllNull: OnboardingProfileState = {
      ...serviceNoHours,
      workingHours: { mon: null, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null },
    };
    expect(missingNames(serviceAllNull)).toContain('workingHours');

    const serviceOneOpen: OnboardingProfileState = {
      ...serviceNoHours,
      workingHours: { mon: ['09:00', '18:00'], tue: null, wed: null, thu: null, fri: null, sat: null, sun: null },
    };
    expect(missingNames(serviceOneOpen)).not.toContain('workingHours');
  });

  it('workingHours NOT required for stays', () => {
    const homestay: OnboardingProfileState = {
      category: 'homestay', propertyType: 'homestay', name: 'A', location: 'X',
      description: 'A cozy place.',
      price: '1500', bedrooms: 2, maxGuests: 4,
    };
    expect(missingNames(homestay)).not.toContain('workingHours');
  });

  it('languages is required for service + transport, optional for stays', () => {
    // Stay: not required → never flagged missing.
    expect(missingNames({ category: 'homestay', propertyType: 'homestay' } as OnboardingProfileState))
      .not.toContain('languages');
    // Service + transport: required → flagged missing when absent.
    expect(missingNames({ category: 'plumber' } as OnboardingProfileState)).toContain('languages');
    expect(missingNames({ category: 'driver-cab' } as OnboardingProfileState)).toContain('languages');
  });
});
