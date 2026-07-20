// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { areaFromGoogleComponents } from './geocode.service.js';

/**
 * Fixtures are real address_components captured from the Google Geocoding API
 * for the queries named below — the exact payloads geocodeViaGoogle parses.
 */
describe('areaFromGoogleComponents', () => {
  it('returns null when the query named only a city (the common case)', () => {
    // "Hyderabad, Telangana" — no sublocality at all. This null is the whole
    // point: the label must never claim more precision than the host stated.
    expect(areaFromGoogleComponents([
      { long_name: 'Hyderabad', short_name: 'Hyderabad', types: ['locality', 'political'] },
      { long_name: 'Telangana', short_name: 'TG', types: ['administrative_area_level_1', 'political'] },
      { long_name: 'India', short_name: 'IN', types: ['country', 'political'] },
    ])).toBeNull();
  });

  it('picks sublocality_level_1 — matching the full types array, not types[0]', () => {
    // Google puts `political` FIRST on these components; matching types[0]
    // would find nothing.
    expect(areaFromGoogleComponents([
      { long_name: 'Kukatpally', short_name: 'Kukatpally', types: ['political', 'sublocality', 'sublocality_level_1'] },
      { long_name: 'Hyderabad', short_name: 'Hyderabad', types: ['locality', 'political'] },
      { long_name: 'Rangareddy', short_name: 'Rangareddy', types: ['administrative_area_level_3', 'political'] },
      { long_name: 'Telangana', short_name: 'TG', types: ['administrative_area_level_1', 'political'] },
    ])).toBe('Kukatpally');
  });

  it('resolves a full street address to the AREA, never the road', () => {
    // "Tank Bund Rd, opposite Hussain Sagar, Hyderabad" — the safety property:
    // the road is typed `route` and is structurally unreachable from here, so
    // this component cannot leak a street address onto a public read.
    // `sublocality_level_2` (Hussain Sagar) is landmark-grade and skipped.
    const area = areaFromGoogleComponents([
      { long_name: 'Tank Bund Road', short_name: 'Tank Bund Rd', types: ['route'] },
      { long_name: 'Hussain Sagar', short_name: 'Hussain Sagar', types: ['political', 'sublocality', 'sublocality_level_2'] },
      { long_name: 'Khairtabad', short_name: 'Khairtabad', types: ['political', 'sublocality', 'sublocality_level_1'] },
      { long_name: 'Hyderabad', short_name: 'Hyderabad', types: ['locality', 'political'] },
    ]);
    expect(area).toBe('Khairtabad');
    expect(area).not.toContain('Tank Bund');
  });

  it('handles missing / malformed component arrays without throwing', () => {
    expect(areaFromGoogleComponents(undefined)).toBeNull();
    expect(areaFromGoogleComponents([])).toBeNull();
    expect(areaFromGoogleComponents([
      { long_name: '  ', short_name: '', types: ['political', 'sublocality_level_1'] },
    ])).toBeNull();
    expect(areaFromGoogleComponents([
      { long_name: 'Nowhere', short_name: 'Nowhere', types: undefined as unknown as string[] },
    ])).toBeNull();
  });
});
