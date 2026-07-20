// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { buildPriceableOptions } from './priceable-options.js';

describe('buildPriceableOptions', () => {
  it('enumerates every service variant with its OWN add-ons (the salon case)', () => {
    const listing = {
      id: 'l-salon',
      title: 'Truefitt & Hill',
      listing_type: 'service',
      price: 700,
      metadata: {
        pricingUnit: 'per_visit',
        servicesCatalog: [
          { id: 'svc-0', name: "Men's Haircut", basePrice: 700, addOns: [] },
          { id: 'svc-1', name: "Women's Haircut", basePrice: 1200, addOns: [
            { id: 'a-blow', label: 'Blow Dry', price: 300 },
            { id: 'a-wash', label: 'Hair Wash', price: 147 },
          ] },
          { id: 'svc-2', name: "Kid's Haircut", basePrice: 396, addOns: [] },
        ],
      },
    };
    expect(buildPriceableOptions(listing)).toEqual([
      { group: 'Services', name: "Men's Haircut", price: 700, unit: 'per_visit' },
      { group: 'Services', name: "Women's Haircut", price: 1200, unit: 'per_visit', addOns: [
        { name: 'Blow Dry', price: 300 },
        { name: 'Hair Wash', price: 147 },
      ] },
      { group: 'Services', name: "Kid's Haircut", price: 396, unit: 'per_visit' },
    ]);
  });

  it('lists service-wide add-ons once, on their own', () => {
    const listing = {
      listing_type: 'service',
      price: 999,
      metadata: {
        pricingUnit: 'per_visit',
        servicesCatalog: [{ id: 's', name: 'Deep Clean', basePrice: 999, addOns: [] }],
        addOns: [{ id: 'a', label: 'Fridge clean', price: 200 }],
      },
    };
    expect(buildPriceableOptions(listing)).toEqual([
      { group: 'Services', name: 'Deep Clean', price: 999, unit: 'per_visit' },
      { group: 'Add-ons', name: 'Fridge clean', price: 200, unit: 'per_visit' },
    ]);
  });

  it('uses per_hour unit when pricingUnit is per_hour', () => {
    const listing = {
      listing_type: 'service',
      metadata: { pricingUnit: 'per_hour', servicesCatalog: [{ id: 's', name: 'Yoga', basePrice: 600, addOns: [] }] },
    };
    expect(buildPriceableOptions(listing)).toEqual([
      { group: 'Services', name: 'Yoga', price: 600, unit: 'per_hour' },
    ]);
  });

  it('enumerates stay room types with maxGuests', () => {
    const listing = {
      listing_type: 'stay',
      room_types: [
        { id: 'r1', name: 'Deluxe', base_price_paise: 480000, max_guests: 2 },
        { id: 'r2', name: 'Suite', base_price_paise: 820000, max_guests: 4 },
      ],
    };
    expect(buildPriceableOptions(listing)).toEqual([
      { group: 'Rooms', name: 'Deluxe', price: 4800, unit: 'per_night', maxGuests: 2 },
      { group: 'Rooms', name: 'Suite', price: 8200, unit: 'per_night', maxGuests: 4 },
    ]);
  });

  it('enumerates transport priced modes (hourly + day + packages)', () => {
    const listing = {
      listing_type: 'transport',
      metadata: {
        pricePerHour: '350',
        pricePerDay: '2500',
        packageOptions: [{ id: 'p1', label: 'Airport drop', price: 800 }],
      },
    };
    expect(buildPriceableOptions(listing)).toEqual([
      { group: 'Transport', name: 'Hourly rental', price: 350, unit: 'per_hour' },
      { group: 'Transport', name: 'Day rental', price: 2500, unit: 'per_day' },
      { group: 'Transport', name: 'Airport drop', price: 800, unit: 'package' },
    ]);
  });

  it('falls back to a single-price option for a stay with one nightly rate', () => {
    const listing = { listing_type: 'stay', title: 'Cozy Homestay', price_paise: 300000, guests: 3 };
    expect(buildPriceableOptions(listing)).toEqual([
      { group: 'Stay', name: 'Cozy Homestay', price: 3000, unit: 'per_night', maxGuests: 3 },
    ]);
  });

  it('returns [] when nothing is priceable', () => {
    expect(buildPriceableOptions({ listing_type: 'service', metadata: {} })).toEqual([]);
  });
});
