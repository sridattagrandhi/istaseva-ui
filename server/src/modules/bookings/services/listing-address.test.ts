// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { shapeListingAddress, bookingHasExactAddress } from './listing-address.js';

describe('shapeListingAddress — hasExactAddress (WS6)', () => {
  const hyderabad = { listing_city: 'Hyderabad', listing_state: 'Telangana' };

  it('a genuine street address counts as exact', () => {
    expect(shapeListingAddress({
      ...hyderabad,
      listing_area: 'Kavadiguda',
      listing_location: 'Tank Bund Rd, opposite Hussain Sagar, Bhagyalaxmi Nagar, Hyderabad, Telangana 500080',
    }).hasExactAddress).toBe(true);

    // Structured address column, location city-only.
    expect(shapeListingAddress({
      ...hyderabad,
      listing_address: '12 Temple Road, Hampi',
      listing_location: 'Hyderabad, Telangana',
    }).hasExactAddress).toBe(true);
  });

  it('area + city + state is NOT an address — the guest still needs the directions hint', () => {
    // The bug this guards: "Kukatpally, Hyderabad, Telangana" is the host
    // naming their neighbourhood, not giving a street address. Before `area`
    // was part of the comparison this read as exact, and the booked guest
    // silently lost the "message your host for directions" line.
    expect(shapeListingAddress({
      ...hyderabad,
      listing_area: 'Kukatpally',
      listing_location: 'Kukatpally, Hyderabad, Telangana',
    }).hasExactAddress).toBe(false);

    // Subsets and orderings of the same three names, none of them addresses.
    expect(shapeListingAddress({
      ...hyderabad, listing_area: 'Kukatpally', listing_location: 'Kukatpally, Hyderabad',
    }).hasExactAddress).toBe(false);
    expect(shapeListingAddress({
      ...hyderabad, listing_area: 'Kukatpally', listing_location: 'Kukatpally',
    }).hasExactAddress).toBe(false);
    expect(shapeListingAddress({
      ...hyderabad, listing_area: 'Kukatpally', listing_location: 'Telangana, Hyderabad, Kukatpally',
    }).hasExactAddress).toBe(false);
  });

  it('city-only / state-only still behave exactly as before the area column', () => {
    expect(shapeListingAddress({ ...hyderabad, listing_location: 'Hyderabad, Telangana' }).hasExactAddress).toBe(false);
    expect(shapeListingAddress({ ...hyderabad, listing_location: 'Hyderabad' }).hasExactAddress).toBe(false);
    expect(shapeListingAddress({ ...hyderabad, listing_location: 'Telangana' }).hasExactAddress).toBe(false);
    // Seed rows sometimes hold a bare city name in `address` too.
    expect(shapeListingAddress({
      ...hyderabad, listing_address: 'Hyderabad', listing_location: 'Hyderabad, Telangana',
    }).hasExactAddress).toBe(false);
  });

  it('a null area does not make everything exact', () => {
    expect(shapeListingAddress({
      ...hyderabad, listing_area: null, listing_location: 'Hyderabad, Telangana',
    }).hasExactAddress).toBe(false);
    expect(shapeListingAddress({
      ...hyderabad, listing_area: '  ', listing_location: 'Hyderabad, Telangana',
    }).hasExactAddress).toBe(false);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(shapeListingAddress({
      ...hyderabad, listing_area: 'Kukatpally', listing_location: '  kukatpally ,  HYDERABAD , telangana ',
    }).hasExactAddress).toBe(false);
  });

  it('no location and no address is not exact', () => {
    expect(shapeListingAddress(hyderabad).hasExactAddress).toBe(false);
    expect(shapeListingAddress({}).hasExactAddress).toBe(false);
  });
});

describe('bookingHasExactAddress — the single booking-level rule (all surfaces)', () => {
  const hydPlace = { listing_area: 'Banjara Hills', listing_city: 'Hyderabad', listing_state: 'Telangana' };

  it('at-home / online / transport never warn — the guest does not travel to the host', () => {
    expect(bookingHasExactAddress({
      ...hydPlace, notes: JSON.stringify({ serviceMode: 'at-home', serviceAddress: 'customer street' }),
    })).toBe(true);
    expect(bookingHasExactAddress({
      ...hydPlace, notes: JSON.stringify({ serviceMode: 'online' }),
    })).toBe(true);
    // Legacy/unknown non-visit modes ("remote" exists in seed data) fail
    // safe: no spurious directions warning.
    expect(bookingHasExactAddress({
      ...hydPlace, notes: JSON.stringify({ serviceMode: 'remote' }),
    })).toBe(true);
    // Transport via category and via notes shape.
    expect(bookingHasExactAddress({ ...hydPlace, service_category: 'driver-cab', notes: null })).toBe(true);
    expect(bookingHasExactAddress({
      ...hydPlace, booking_service_category: 'driver-suv', notes: JSON.stringify({ transportMode: 'hourly' }),
    })).toBe(true);
  });

  it('visit-provider with a REAL street address → true', () => {
    expect(bookingHasExactAddress({
      ...hydPlace,
      booking_address: 'Jubilee Hills Check Post Road, Venkateswara Colony, Hyderabad 500034',
      notes: JSON.stringify({ serviceMode: 'visit-provider' }),
    })).toBe(true);
  });

  it('visit-provider whose booking snapshotted the masked area label → false (the old SQL bug)', () => {
    // The old SQL counted ANY non-empty booking address as exact — so
    // "Banjara Hills, Hyderabad, Telangana" read as a street address and the
    // guest got no "message the provider" hint while holding no real address.
    expect(bookingHasExactAddress({
      ...hydPlace,
      booking_address: 'Banjara Hills, Hyderabad, Telangana',
      notes: JSON.stringify({ serviceMode: 'visit-provider' }),
    })).toBe(false);
    // No address anywhere → definitely false.
    expect(bookingHasExactAddress({
      ...hydPlace, notes: JSON.stringify({ serviceMode: 'visit-provider' }),
    })).toBe(false);
    // notes.visitAddress is the fallback source when the column is empty.
    expect(bookingHasExactAddress({
      ...hydPlace,
      notes: JSON.stringify({ serviceMode: 'visit-provider', visitAddress: 'Shop 4, 2nd Cross, Indiranagar' }),
    })).toBe(true);
  });

  it('stays fall through to the listing columns (area+city+state still ≠ address)', () => {
    expect(bookingHasExactAddress({
      ...hydPlace, listing_location: 'Banjara Hills, Hyderabad, Telangana', notes: JSON.stringify({ stayId: 'x' }),
    })).toBe(false);
    expect(bookingHasExactAddress({
      ...hydPlace, listing_location: 'Tank Bund Rd, opposite Hussain Sagar, Hyderabad 500080', notes: null,
    })).toBe(true);
  });

  it('legacy free-text notes never throw', () => {
    expect(bookingHasExactAddress({
      ...hydPlace, listing_location: 'Hyderabad, Telangana', notes: 'please come after 6pm',
    })).toBe(false);
  });
});

describe('shapeListingAddress — hotelAddress', () => {
  it('prefers the structured address, then appends city/state once', () => {
    expect(shapeListingAddress({
      listing_address: '12 Temple Road, Hampi',
      listing_city: 'Hampi',
      listing_state: 'Karnataka',
    }).hotelAddress).toBe('12 Temple Road, Hampi, Karnataka');
  });

  it('does not duplicate city/state already present in the text', () => {
    // The "Pune, Maharashtra, Pune, Maharashtra" regression.
    expect(shapeListingAddress({
      listing_location: 'Pune, Maharashtra',
      listing_city: 'Pune',
      listing_state: 'Maharashtra',
    }).hotelAddress).toBe('Pune, Maharashtra');
  });

  it('keeps the raw street text a booked guest needs to navigate', () => {
    expect(shapeListingAddress({
      listing_location: 'Tank Bund Rd, opposite Hussain Sagar, Hyderabad, Telangana 500080',
      listing_area: 'Kavadiguda',
      listing_city: 'Hyderabad',
      listing_state: 'Telangana',
    }).hotelAddress).toBe('Tank Bund Rd, opposite Hussain Sagar, Hyderabad, Telangana 500080');
  });

  it('is null when there is nothing to show', () => {
    expect(shapeListingAddress({}).hotelAddress).toBeNull();
  });
});
