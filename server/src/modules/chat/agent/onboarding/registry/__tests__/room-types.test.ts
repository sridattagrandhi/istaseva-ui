/**
 * roomTypes — the stay parallel to servicesCatalog / transportationTypes.
 * Covers the three things that make an "array of sub-units" field behave:
 * required-gating (multi-room only), per-row customGate, and normalize
 * (drop junk, dedupe, stamp ids, spread per-room amenities).
 */
import { describe, it, expect } from 'vitest';
import { FIELD_REGISTRY } from '../field-registry.js';
import { getMissingRequiredFields } from '../derive-submit-gate.js';
import { getReadinessMissingFromRegistry } from '../derive-readiness.js';
import type { OnboardingProfileState } from '../../types.js';

const spec = FIELD_REGISTRY.roomTypes;

function missingNames(profile: OnboardingProfileState): string[] {
  return getMissingRequiredFields(FIELD_REGISTRY, profile)
    .map((s) => s.replace(/\s*\(.*\)$/, ''));
}

describe('roomTypes does NOT participate in the registry activation gate', () => {
  // Rooms live in the listing_room_types table, NOT on the listing row /
  // metadata. The registry-derived activation gate reconstructs a profile
  // from the listing row, so roomTypes is always empty there — it must NOT
  // be flagged (listing-readiness.ts checks the real table). Regression
  // guard for the "can't activate, add room types" bug where rooms existed.
  it('has no readinessCode (so the registry skips it at activation)', () => {
    expect(spec.readinessCode).toBeUndefined();
  });

  it('a multi-room sathram listing row is not flagged for room types by the registry', () => {
    const listingRow = {
      category: 'sathram',
      property_type: 'sathram',
      name: 'Sriari Sannidhi',
      location: 'Tirupati',
      metadata: { propertyType: 'sathram' },
    };
    const missing = getReadinessMissingFromRegistry(listingRow);
    expect(missing.some((m) => m.code === 'room_types_required')).toBe(false);
    expect(missing.some((m) => m.label === 'Room types')).toBe(false);
  });
});

describe('roomTypes registry entry', () => {
  it('applies only to stays', () => {
    expect(spec.appliesTo).toEqual(['stay']);
  });

  it('is required for multi-room stays (sathram / hotel / lodge / heritage)', () => {
    expect(spec.requiredWhen!({ category: 'homestay', propertyType: 'sathram' } as never)).toBe(true);
    expect(spec.requiredWhen!({ category: 'hotel' } as never)).toBe(true);
    expect(spec.requiredWhen!({ category: 'lodge' } as never)).toBe(true);
    expect(spec.requiredWhen!({ category: 'heritage' } as never)).toBe(true);
  });

  it('is NOT required for single-unit stays or non-stays', () => {
    expect(spec.requiredWhen!({ category: 'homestay' } as never)).toBe(false);
    expect(spec.requiredWhen!({ category: 'farm-stay' } as never)).toBe(false);
    expect(spec.requiredWhen!({ category: 'plumber' } as never)).toBe(false);
    expect(spec.requiredWhen!({ category: 'driver-cab' } as never)).toBe(false);
  });

  it('surfaces as missing on a sathram with no rooms, satisfied once a complete room is added', () => {
    const base: OnboardingProfileState = {
      category: 'homestay',
      propertyType: 'sathram',
      name: 'Srivari Sannidhi',
      location: 'Tirupati',
    };
    expect(missingNames(base)).toContain('roomTypes');
    // and crucially does NOT demand property-level bedrooms/maxGuests/price
    expect(missingNames(base)).not.toContain('bedrooms');
    expect(missingNames(base)).not.toContain('maxGuests');
    expect(missingNames(base)).not.toContain('price');

    // A complete room clears both the array gate and every per-row check.
    const withRooms: OnboardingProfileState = {
      ...base,
      roomTypes: [{
        name: 'Single Room', pricePerNight: 200, maxGuests: 2, quantity: 10,
        amenities: ['AC', 'Wi-Fi', 'Hot water'],
      }],
    };
    const missing = missingNames(withRooms);
    expect(missing).not.toContain('roomTypes');
    expect(missing.some((m) => m.startsWith('roomTypes['))).toBe(false);
  });

  it('customGate flags rows missing name / price / guests / quantity / amenities', () => {
    const errs = spec.customGate!({
      category: 'hotel',
      roomTypes: [
        // missing price, guests, quantity, amenities
        { name: 'Double Room', pricePerNight: 0 } as never,
        // missing name
        { name: '', pricePerNight: 300, maxGuests: 2, quantity: 4, amenities: ['AC', 'TV', 'WiFi'] } as never,
      ],
    } as never);
    expect(errs.some((e) => e.includes('pricePerNight'))).toBe(true);
    expect(errs.some((e) => e.includes('maxGuests'))).toBe(true);
    expect(errs.some((e) => e.includes('quantity'))).toBe(true);
    expect(errs.some((e) => e.includes('amenities'))).toBe(true);
    expect(errs.some((e) => e.includes('name'))).toBe(true);
  });

  it('customGate passes a fully-specified room', () => {
    const errs = spec.customGate!({
      category: 'hotel',
      roomTypes: [{
        name: 'Deluxe King', pricePerNight: 1500, maxGuests: 2, quantity: 6,
        amenities: ['AC', 'Wi-Fi', 'Balcony'],
      }],
    } as never);
    expect(errs).toEqual([]);
  });

  describe('normalize', () => {
    const norm = (v: unknown) => spec.normalize!(v, {} as never) as Array<Record<string, unknown>>;

    it('extracts the sathram transcript: single ₹200 + double ₹300, shared amenities on each', () => {
      const out = norm([
        { name: 'Single Room', pricePerNight: 200, amenities: ['parking', 'wifi', 'ac', 'heater', 'hot water'] },
        { name: 'Double Room', pricePerNight: 300, amenities: ['parking', 'wifi', 'ac', 'heater', 'hot water'] },
      ]);
      expect(out).toHaveLength(2);
      expect(out[0].name).toBe('Single Room');
      expect(out[0].pricePerNight).toBe(200);
      expect(out[1].pricePerNight).toBe(300);
      expect(out[0].amenities).toEqual(['parking', 'wifi', 'ac', 'heater', 'hot water']);
      expect(out[1].amenities).toEqual(['parking', 'wifi', 'ac', 'heater', 'hot water']);
    });

    it('drops rows with no name or non-positive price', () => {
      const out = norm([
        { name: '', pricePerNight: 300 },
        { name: 'Deluxe', pricePerNight: 0 },
        { name: 'Valid', pricePerNight: 500 },
      ]);
      expect(out).toHaveLength(1);
      expect(out[0].name).toBe('Valid');
    });

    it('dedupes by case-insensitive name and stamps stable ids', () => {
      const out = norm([
        { name: 'Deluxe King', pricePerNight: 1000 },
        { name: 'deluxe king', pricePerNight: 1200 },
      ]);
      expect(out).toHaveLength(1);
      expect(typeof out[0].id).toBe('string');
      expect((out[0].id as string).length).toBeGreaterThan(0);
    });

    it('rounds price and coerces optional int fields', () => {
      const out = norm([
        { name: 'Suite', pricePerNight: 999.7, maxGuests: 4, quantity: 3, bedrooms: 2, bathrooms: 1 },
      ]);
      expect(out[0].pricePerNight).toBe(1000);
      expect(out[0].maxGuests).toBe(4);
      expect(out[0].quantity).toBe(3);
      expect(out[0].bedrooms).toBe(2);
      expect(out[0].bathrooms).toBe(1);
    });
  });
});
