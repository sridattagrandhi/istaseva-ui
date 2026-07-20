import { describe, it, expect } from 'vitest';
import { deriveProfilePatchSchema } from '../derive-zod.js';
import { FIELD_REGISTRY } from '../field-registry.js';

const Patch = deriveProfilePatchSchema(FIELD_REGISTRY);

describe('deriveProfilePatchSchema — lenient extraction', () => {
  it('coerces a numeric hourly rate to a string (the "10" bug)', () => {
    // The model sends pricePerHour as a NUMBER; this used to fail the whole
    // extract_fields call. Now it coerces to a string and the field lands.
    const parsed = Patch.parse({ pricePerHour: 10, transportMode: 'hourly' });
    expect(parsed.pricePerHour).toBe('10');
    expect(parsed.transportMode).toBe('hourly');
  });

  it('coerces numbers for other string-typed fields', () => {
    const parsed = Patch.parse({ experience: 5, price: 2500, duration: 2 });
    expect(parsed.experience).toBe('5');
    expect(parsed.price).toBe('2500');
    expect(parsed.duration).toBe('2');
  });

  it('drops a single unsalvageable field but keeps the rest of the patch', () => {
    // maxGuests must be an int; an object can't be coerced → dropped, not fatal.
    const parsed = Patch.parse({ name: 'Ravi Cabs', maxGuests: { bad: true }, location: 'Bangalore' });
    expect(parsed.name).toBe('Ravi Cabs');
    expect(parsed.location).toBe('Bangalore');
    expect(parsed.maxGuests).toBeUndefined();
  });

  it('still accepts well-typed values unchanged', () => {
    const parsed = Patch.parse({ pricePerHour: '350', bedrooms: 2, serviceModes: ['at-home'] });
    expect(parsed.pricePerHour).toBe('350');
    expect(parsed.bedrooms).toBe(2);
    expect(parsed.serviceModes).toEqual(['at-home']);
  });
});
