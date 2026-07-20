import { describe, it, expect } from 'vitest';
import {
  runDeterministicListingGuardrails,
  checkViability,
  summaryFromListingPayload,
  summaryFromOnboardingProfile,
  formatGuardrailIssues,
} from '../listing-guardrails.js';

// NOTE: payloads here deliberately omit `location` so the deterministic
// pass never makes a geocode network call — the India check is exercised
// separately against the live geocoder, not in unit tests.

describe('runDeterministicListingGuardrails', () => {
  it('passes a clean payload (no location → no network)', async () => {
    const issues = await runDeterministicListingGuardrails({
      name: 'Sunrise Homestay',
      description: 'A cozy lakeside place.',
      category: 'homestay',
    });
    expect(issues).toEqual([]);
  });

  it('flags prohibited content in a top-level free-text field', async () => {
    const issues = await runDeterministicListingGuardrails({
      vehicle_name: 'Toyota with a gun',
      category: 'driver-cab',
    });
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('prohibited_weapons');
    expect(issues[0].field).toBe('vehicle_name');
  });

  it('scans nested metadata catalog rows', async () => {
    const issues = await runDeterministicListingGuardrails({
      category: 'salon',
      metadata: { servicesCatalog: [{ name: 'Haircut' }, { name: 'escort service' }] },
    });
    expect(issues.some((i) => i.code === 'prohibited_sexual_services' && i.field === 'servicesCatalog'))
      .toBe(true);
  });
});

describe('viability summary builders', () => {
  it('maps onboarding profile (camelCase) to the summary shape', () => {
    const s = summaryFromOnboardingProfile({ vehicleName: 'Toyota Innova', category: 'driver-cab' });
    expect(s.vehicle_name).toBe('Toyota Innova');
    expect(s.category).toBe('driver-cab');
  });

  it('maps listing payload (snake_case + metadata) to the summary shape', () => {
    const s = summaryFromListingPayload({
      category: 'salon',
      metadata: { servicesCatalog: [{ name: 'Haircut' }, { name: 'Shave' }] },
    });
    expect(s.services).toEqual(['Haircut', 'Shave']);
  });
});

describe('checkViability', () => {
  it('short-circuits to [] when the summary has no content (no LLM call)', async () => {
    expect(await checkViability({ category: '', name: '', services: [] })).toEqual([]);
  });
});

describe('formatGuardrailIssues', () => {
  it('joins issue messages into one string', () => {
    expect(formatGuardrailIssues([
      { field: 'location', code: 'x', message: 'Use an Indian location.' },
      { field: 'name', code: 'y', message: 'Pick a real name.' },
    ])).toBe('Use an Indian location. Pick a real name.');
  });
});
