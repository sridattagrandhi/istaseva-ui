// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { canonicalState, deriveCityState, ensureCityState } from './india-location.js';

describe('india-location', () => {
  it('canonicalizes state spellings case-insensitively', () => {
    expect(canonicalState('telangana')).toBe('Telangana');
    expect(canonicalState(' TAMIL NADU ')).toBe('Tamil Nadu');
    expect(canonicalState('Hyderabad')).toBeNull(); // a city, not a state
  });

  it('derives city/state from a full address in `location`', () => {
    const d = deriveCityState({
      location: 'Tirumala By-pass Road, Beside IOC Petrol Bunk, Tirupati, Andhra Pradesh 517501',
    });
    expect(d).toEqual({ city: 'Tirupati', state: 'Andhra Pradesh' });
  });

  it('replaces a city-as-state value and keeps the real city', () => {
    const payload = { city: 'Hyderabad', state: 'Hyderabad', location: 'Hyderabad, Telangana' };
    ensureCityState(payload);
    expect(payload.state).toBe('Telangana');
    expect(payload.city).toBe('Hyderabad');
  });

  it('fills a missing city from the segment before the state, stripping PINs', () => {
    const payload = {
      state: '', city: '',
      location: 'Tank Bund Rd, opposite Hussain Sagar, Lake, Hyderabad, Telangana 500080, India',
    };
    ensureCityState(payload);
    expect(payload.state).toBe('Telangana');
    expect(payload.city).toBe('Hyderabad');
  });

  it('treats a state name in the city column as absent', () => {
    const d = deriveCityState({ city: 'Telangana', location: 'Kukatpally, Hyderabad, Telangana' });
    expect(d.city).toBe('Hyderabad');
  });

  it('never blanks values it cannot improve', () => {
    const payload = { city: 'Ooty', state: 'Nowhere Land', location: 'no state mentioned here' };
    ensureCityState(payload);
    expect(payload.city).toBe('Ooty');
    expect(payload.state).toBe('Nowhere Land'); // nothing derivable — left alone
  });
});
