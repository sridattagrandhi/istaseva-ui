// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { approximateListingGeo, markGeoExact, publicLocationLabel } from './listing-geo-privacy.js';

describe('listing geo privacy (B1 / WS6)', () => {
  const exact = {
    id: 'l1',
    lat: 15.335123,
    lng: 76.460987,
    address: '12 Temple Road, Hampi',
    location: 'Hampi, Karnataka',
    city: 'Hampi',
    state: 'Karnataka',
    name: 'Riverside Homestay',
  };

  it('approximates coordinates to ~1km and drops the street address', () => {
    const out = approximateListingGeo(exact);
    expect(out.lat).toBe(15.34);
    expect(out.lng).toBe(76.46);
    expect(out.address).toBeNull();
    expect(out.geo_exact).toBe(false);
    expect(out.location).toBe('Hampi, Karnataka');
    expect(out.name).toBe('Riverside Homestay');
  });

  it('REBUILDS location from city/state — a street address in the raw text never leaks', () => {
    // The WS6 gap: `location` is untrusted free text. Places autocomplete
    // fills it with the full formatted address, and `address` is NULL on
    // almost every row — so before this fix, the exact address escaped
    // through the one field the mask ignored.
    const leaky = {
      id: 'l2',
      lat: 13.6288,
      lng: 79.4192,
      address: null,
      location: 'Tirumala By-pass Road, Opp. SBI Staff Training Centre, Beside IOC Petrol Bunk, Tirupati, Andhra Pradesh 517501',
      city: 'Tirupati',
      state: 'Andhra Pradesh',
    };
    const out = approximateListingGeo(leaky);
    expect(out.location).toBe('Tirupati, Andhra Pradesh');
    expect(String(out.location)).not.toContain('By-pass');
    expect(String(out.location)).not.toContain('517501');
  });

  it('degrades to the available half and NEVER falls back to the raw text', () => {
    const base = { location: '99 Secret Lane, Somewhere 500001' };
    expect(approximateListingGeo({ ...base, city: 'Hyderabad', state: null }).location).toBe('Hyderabad');
    expect(approximateListingGeo({ ...base, city: null, state: 'Telangana' }).location).toBe('Telangana');
    expect(approximateListingGeo({ ...base, city: null, state: '  ' }).location).toBeNull();
  });

  it('publicLocationLabel composes City, State from the derived columns', () => {
    expect(publicLocationLabel({ city: 'Tirupati', state: 'Andhra Pradesh' })).toBe('Tirupati, Andhra Pradesh');
    expect(publicLocationLabel({ city: 'Kochi' })).toBe('Kochi');
    expect(publicLocationLabel({})).toBeNull();
  });

  it('publicLocationLabel prepends the area when one was derived', () => {
    expect(publicLocationLabel({ area: 'Kukatpally', city: 'Hyderabad', state: 'Telangana' }))
      .toBe('Kukatpally, Hyderabad, Telangana');
    // The common case: the host stated only a city, so no area was derivable
    // and the label is byte-identical to what shipped before the column.
    expect(publicLocationLabel({ area: null, city: 'Hyderabad', state: 'Telangana' }))
      .toBe('Hyderabad, Telangana');
    expect(publicLocationLabel({ area: '  ', city: 'Hyderabad', state: 'Telangana' }))
      .toBe('Hyderabad, Telangana');
    // Degradation with an area but a missing half.
    expect(publicLocationLabel({ area: 'Bandra West', city: 'Mumbai' })).toBe('Bandra West, Mumbai');
    expect(publicLocationLabel({ area: 'Bandra West' })).toBe('Bandra West');
  });

  it('publicLocationLabel dedups area == city (villages geocode both the same)', () => {
    expect(publicLocationLabel({ area: 'Tirumala', city: 'Tirumala', state: 'Andhra Pradesh' }))
      .toBe('Tirumala, Andhra Pradesh');
    expect(publicLocationLabel({ area: 'tirumala', city: 'Tirumala', state: 'Andhra Pradesh' }))
      .toBe('tirumala, Andhra Pradesh');
  });

  it('scrubs metadata.visitAddress unless the host opted in to a public address', () => {
    const salon = {
      lat: 17.4143,
      lng: 78.4353,
      city: 'Hyderabad',
      state: 'Telangana',
      metadata: {
        visitAddress: 'Jubilee Hills Check Post Road, Venkateswara Colony, Hyderabad 500034',
        pricingUnit: 'per_visit',
      },
    };
    const out = approximateListingGeo(salon);
    expect((out.metadata as Record<string, unknown>).visitAddress).toBeNull();
    // Unrelated metadata survives, and the INPUT's metadata is untouched —
    // masked rows must not share (or mutate) the cached raw row's object.
    expect((out.metadata as Record<string, unknown>).pricingUnit).toBe('per_visit');
    expect(salon.metadata.visitAddress).toContain('Jubilee Hills');
    expect(out.metadata).not.toBe(salon.metadata);

    // Host opt-in (walk-in shop): address stays public.
    const optedIn = approximateListingGeo({
      ...salon,
      metadata: { ...salon.metadata, showAddressPublicly: true },
    });
    expect((optedIn.metadata as Record<string, unknown>).visitAddress).toContain('Jubilee Hills');

    // Rows without a visitAddress pass metadata through by reference (no churn).
    const plain = { city: 'Kochi', metadata: { pricingUnit: 'per_hour' } };
    expect(approximateListingGeo(plain).metadata).toBe(plain.metadata);
    expect(approximateListingGeo({ city: 'Kochi' }).metadata).toBeUndefined();
  });

  it('markGeoExact keeps metadata.visitAddress for booked guests', () => {
    const row = { metadata: { visitAddress: 'Shop 4, 2nd Cross, Indiranagar' } };
    expect((markGeoExact(row).metadata as Record<string, unknown>).visitAddress)
      .toBe('Shop 4, 2nd Cross, Indiranagar');
  });

  it('an area does not open a path back to the raw street text', () => {
    const leaky = {
      lat: 17.4239,
      lng: 78.4738,
      address: null,
      location: 'Tank Bund Rd, opposite Hussain Sagar, Hyderabad, Telangana 500080',
      area: 'Khairtabad',
      city: 'Hyderabad',
      state: 'Telangana',
    };
    const out = approximateListingGeo(leaky);
    expect(out.location).toBe('Khairtabad, Hyderabad, Telangana');
    expect(String(out.location)).not.toContain('Tank Bund');
    expect(String(out.location)).not.toContain('500080');
    expect(out.address).toBeNull();
  });

  it('is deterministic — repeated calls cannot be averaged back to the point', () => {
    const a = approximateListingGeo(exact);
    const b = approximateListingGeo(exact);
    expect(a.lat).toBe(b.lat);
    expect(a.lng).toBe(b.lng);
  });

  it('does not mutate the input row', () => {
    approximateListingGeo(exact);
    expect(exact.address).toBe('12 Temple Road, Hampi');
    expect(exact.lat).toBe(15.335123);
    expect(exact.location).toBe('Hampi, Karnataka');
  });

  it('handles string coordinates and nulls without throwing', () => {
    const out = approximateListingGeo({ id: 'l3', lat: '15.339', lng: null, address: 'x' });
    expect(out.lat).toBe(15.34);
    expect(out.lng).toBeNull();
    expect(out.geo_exact).toBe(false);
  });

  it('markGeoExact (owner/admin/booked guest) preserves the exact geo AND raw location', () => {
    const out = markGeoExact(exact);
    expect(out.geo_exact).toBe(true);
    expect(out.lat).toBe(15.335123);
    expect(out.address).toBe('12 Temple Road, Hampi');
    // Raw location survives on the exact path — for the 705/707 rows where
    // `address` is NULL it's the only navigable address a booked guest has.
    expect(out.location).toBe('Hampi, Karnataka');
  });
});
