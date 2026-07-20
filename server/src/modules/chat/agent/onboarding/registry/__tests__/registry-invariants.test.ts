/**
 * Invariants over FIELD_REGISTRY. These catch the "I added a field and
 * forgot to gate it correctly" class of bug at test-time rather than at
 * staging-time. Run in milliseconds.
 */
import { describe, it, expect } from 'vitest';
import { FIELD_REGISTRY } from '../field-registry.js';
import type { FieldSpec, ListingType } from '../field-registry.types.js';
import { z } from 'zod';

const ALL_LISTING_TYPES: ListingType[] = ['stay', 'service', 'transport'];

describe('FIELD_REGISTRY invariants', () => {
  it('every spec has matching `name` key and value', () => {
    for (const [key, spec] of Object.entries(FIELD_REGISTRY)) {
      expect(spec.name).toBe(key);
    }
  });

  it('every spec has a non-empty description', () => {
    for (const spec of Object.values(FIELD_REGISTRY)) {
      expect(spec.description.length).toBeGreaterThan(0);
    }
  });

  it('every spec has both a zodSchema and a jsonSchema', () => {
    for (const spec of Object.values(FIELD_REGISTRY)) {
      expect(spec.zodSchema).toBeDefined();
      expect(spec.zodSchema).toBeInstanceOf(z.ZodType);
      expect(spec.jsonSchema).toBeDefined();
      expect(typeof spec.jsonSchema).toBe('object');
    }
  });

  it('requiredFor entries are a subset of appliesTo', () => {
    for (const spec of Object.values(FIELD_REGISTRY)) {
      if (!spec.requiredFor) continue;
      for (const t of spec.requiredFor) {
        if (spec.appliesTo === 'all') continue;
        expect(spec.appliesTo).toContain(t);
      }
    }
  });

  // The fields named in CLAUDE.md's "Field name parity" invariant MUST
  // exist with exactly these names. Renaming any of them breaks shipped
  // contracts (booking notes JSON, email templates, host dashboard
  // booking-notes parser).
  it('preserves load-bearing field names', () => {
    const loadBearing = [
      'servicesCatalog',
      'subcategories',
      'subcategory',
      'transportationTypes',
      'serviceModes',
      'visitAddress',
      'meetingDetails',
    ];
    for (const name of loadBearing) {
      expect(FIELD_REGISTRY[name]).toBeDefined();
    }
  });

  // servicesCatalog is REQUIRED for services (CLAUDE.md invariant).
  it('servicesCatalog is required for service listings', () => {
    const spec = FIELD_REGISTRY.servicesCatalog;
    expect(spec.requiredFor).toContain('service');
    expect(spec.appliesTo).toContain('service');
    // Must NOT be required for stays or transport.
    expect(spec.requiredFor).not.toContain('stay');
    expect(spec.requiredFor).not.toContain('transport');
  });

  // languages applies-to-all, and is REQUIRED for service + transport
  // (stays don't require it). Restricted to the supported allow-list.
  it('languages applies to every listing type and is required for service + transport', () => {
    const spec = FIELD_REGISTRY.languages;
    expect(spec.appliesTo).toBe('all');
    expect(spec.requiredFor).toEqual(['service', 'transport']);
    expect(spec.requiredFor).not.toContain('stay');
  });

  // subcategories <-> subcategory mirror — both present so the legacy
  // scalar readers don't break (CLAUDE.md "Don't drop the legacy scalar
  // mirror").
  it('keeps subcategories and subcategory as a mirrored pair', () => {
    expect(FIELD_REGISTRY.subcategory).toBeDefined();
    expect(FIELD_REGISTRY.subcategories).toBeDefined();
  });

  // Every field's appliesTo must reference only known listing types.
  it('appliesTo entries are valid listing types', () => {
    for (const spec of Object.values(FIELD_REGISTRY)) {
      if (spec.appliesTo === 'all') continue;
      for (const t of spec.appliesTo) {
        expect(ALL_LISTING_TYPES).toContain(t);
      }
    }
  });

  // requiredFor entries must be valid listing types too.
  it('requiredFor entries are valid listing types', () => {
    for (const spec of Object.values(FIELD_REGISTRY)) {
      if (!spec.requiredFor) continue;
      for (const t of spec.requiredFor) {
        expect(ALL_LISTING_TYPES).toContain(t);
      }
    }
  });

  // requiredWhen is a function (not accidentally a boolean from a bad merge).
  it('requiredWhen is always callable when present', () => {
    for (const spec of Object.values(FIELD_REGISTRY)) {
      if (spec.requiredWhen === undefined) continue;
      expect(typeof spec.requiredWhen).toBe('function');
    }
  });

  // Sanity: each field's jsonSchema should at minimum have a `type`.
  it('each jsonSchema declares a top-level type', () => {
    for (const spec of Object.values(FIELD_REGISTRY)) {
      const t = (spec.jsonSchema as { type?: unknown }).type;
      expect(typeof t).toBe('string');
    }
  });
});

// Spot-check the actual specs against the design's hard-set invariants.
describe('FIELD_REGISTRY hard-set invariants from design doc', () => {
  it('location is required for everyone EXCEPT online-only services', () => {
    const spec: FieldSpec = FIELD_REGISTRY.location;
    expect(spec.requiredWhen).toBeDefined();
    // online-only service → not required
    const onlineOnly = { category: 'yoga-teacher', serviceModes: ['online'] as const };
    const verdictOnline = spec.requiredWhen!(onlineOnly as never);
    expect(verdictOnline === true || (typeof verdictOnline === 'object' && verdictOnline.required))
      .toBe(false);
    // mixed-mode service → still required
    const mixedMode = { category: 'yoga-teacher', serviceModes: ['at-home', 'online'] as const };
    const verdictMixed = spec.requiredWhen!(mixedMode as never);
    const requiredMixed = verdictMixed === true
      || (typeof verdictMixed === 'object' && !!verdictMixed.required);
    expect(requiredMixed).toBe(true);
  });

  it('serviceRadius required for transport always, and for at-home services', () => {
    const spec = FIELD_REGISTRY.serviceRadius;
    expect(spec.requiredWhen).toBeDefined();
    // transport → required
    expect(spec.requiredWhen!({ category: 'driver-cab' } as never)).toBe(true);
    // service at-home → required
    expect(spec.requiredWhen!({
      category: 'plumber', serviceModes: ['at-home'],
    } as never)).toBe(true);
    // service visit-provider only → not required
    expect(spec.requiredWhen!({
      category: 'salon', serviceModes: ['visit-provider'],
    } as never)).toBe(false);
  });

  it('visitAddress / meetingDetails gated by serviceModes', () => {
    const va = FIELD_REGISTRY.visitAddress.requiredWhen!;
    const md = FIELD_REGISTRY.meetingDetails.requiredWhen!;
    expect(va({ serviceModes: ['visit-provider'] } as never)).toBe(true);
    expect(va({ serviceModes: ['at-home'] } as never)).toBe(false);
    expect(md({ serviceModes: ['online'] } as never)).toBe(true);
    expect(md({ serviceModes: ['at-home'] } as never)).toBe(false);
  });

  it('pricePerHour / pricePerDay / packageOptions gated by transportMode', () => {
    expect(FIELD_REGISTRY.pricePerHour.requiredWhen!({ transportMode: 'hourly' } as never)).toBe(true);
    expect(FIELD_REGISTRY.pricePerHour.requiredWhen!({ transportMode: 'day' } as never)).toBe(false);
    expect(FIELD_REGISTRY.pricePerDay.requiredWhen!({ transportMode: 'day' } as never)).toBe(true);
    expect(FIELD_REGISTRY.packageOptions.requiredWhen!({ transportMode: 'package' } as never)).toBe(true);
  });
});
