// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { geocodeAddress, autocompleteAddress, placeDetailsForId } = vi.hoisted(() => ({
  geocodeAddress: vi.fn(),
  autocompleteAddress: vi.fn(),
  placeDetailsForId: vi.fn(),
}));
vi.mock('../../../../common/services/geocode.service.js', () => ({
  geocodeAddress,
  autocompleteAddress,
  placeDetailsForId,
}));

import { resolveAddressTool } from './resolve-address.tool.js';

const ctx = {
  userId: 'u1',
  displayLang: 'en',
  requestId: 'r',
  abortSignal: new AbortController().signal,
  toolResultCache: new Map(),
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  autocompleteAddress.mockResolvedValue([]);
  placeDetailsForId.mockResolvedValue(null);
  geocodeAddress.mockResolvedValue(null);
});

describe('resolve_address tool — Places-first', () => {
  it('resolves an establishment via Places and surfaces the alternates (the two-Tridents case)', async () => {
    autocompleteAddress.mockResolvedValue([
      { id: 'p-hitec', description: 'Trident, HITEC City, Madhapur, Hyderabad', mainText: 'Trident', secondaryText: 'HITEC City' },
      { id: 'p-nanak', description: 'Trident, Nanakramguda, Hyderabad', mainText: 'Trident', secondaryText: 'Nanakramguda' },
      { id: 'p-mumbai', description: 'Trident, Nariman Point, Mumbai', mainText: 'Trident', secondaryText: 'Nariman Point' },
    ]);
    placeDetailsForId.mockResolvedValue({ lat: 17.44, lng: 78.38, locality: 'Madhapur', district: 'Hyderabad', state: 'Telangana', country: 'India' });
    const res = await resolveAddressTool.execute({ address: 'Trident Hotels in hyderabad' }, ctx);
    expect(res.resolved).toBe(true);
    expect(res.formattedAddress).toBe('Trident, HITEC City, Madhapur, Hyderabad');
    expect(res.placeId).toBe('p-hitec');
    expect(res.lat).toBe(17.44);
    expect(res.alternates).toEqual([
      { placeId: 'p-nanak', description: 'Trident, Nanakramguda, Hyderabad' },
      { placeId: 'p-mumbai', description: 'Trident, Nariman Point, Mumbai' },
    ]);
    expect(autocompleteAddress).toHaveBeenCalledWith('Trident Hotels in hyderabad', 'address');
    expect(geocodeAddress).not.toHaveBeenCalled();
  });

  it('re-resolves a chosen alternate directly by placeId', async () => {
    placeDetailsForId.mockResolvedValue({ lat: 17.41, lng: 78.34, locality: 'Nanakramguda', district: 'Hyderabad', state: 'Telangana', country: 'India' });
    const res = await resolveAddressTool.execute(
      { address: 'Trident, Nanakramguda, Hyderabad', placeId: 'p-nanak' }, ctx,
    );
    expect(res).toEqual({
      resolved: true,
      formattedAddress: 'Trident, Nanakramguda, Hyderabad',
      lat: 17.41,
      lng: 78.34,
      placeId: 'p-nanak',
    });
    expect(autocompleteAddress).not.toHaveBeenCalled();
  });

  it('single Places match → no alternates key', async () => {
    autocompleteAddress.mockResolvedValue([
      { id: 'p1', description: 'Plot 12, Jubilee Hills, Hyderabad', mainText: 'Plot 12', secondaryText: 'Jubilee Hills' },
    ]);
    placeDetailsForId.mockResolvedValue({ lat: 17.43, lng: 78.41, locality: 'Jubilee Hills', district: 'Hyderabad', state: 'Telangana', country: 'India' });
    const res = await resolveAddressTool.execute({ address: 'Plot 12 Jubilee Hills' }, ctx);
    expect(res.resolved).toBe(true);
    expect(res.alternates).toBeUndefined();
  });

  it('falls back to plain geocoding when autocomplete has nothing (street address / dev without key)', async () => {
    geocodeAddress.mockResolvedValue({ lat: 17.43, lng: 78.41, formattedAddress: 'Plot 12, Jubilee Hills, Hyderabad, Telangana 500033, India' });
    const res = await resolveAddressTool.execute({ address: 'Plot 12, Jubilee Hills, 500033' }, ctx);
    expect(res.resolved).toBe(true);
    expect(res.formattedAddress).toBe('Plot 12, Jubilee Hills, Hyderabad, Telangana 500033, India');
    expect(res.placeId).toBeUndefined();
  });

  it('falls back to the user wording when the geocoder returns no formatted address', async () => {
    geocodeAddress.mockResolvedValue({ lat: 17.43, lng: 78.41 });
    const res = await resolveAddressTool.execute({ address: 'Plot 12, Jubilee Hills' }, ctx);
    expect(res.resolved).toBe(true);
    expect(res.formattedAddress).toBe('Plot 12, Jubilee Hills');
  });

  it('stale placeId falls through to a fresh text resolution', async () => {
    placeDetailsForId.mockResolvedValue(null); // id no longer resolves
    geocodeAddress.mockResolvedValue({ lat: 17.4, lng: 78.4 });
    const res = await resolveAddressTool.execute({ address: 'Trident, Nanakramguda', placeId: 'gone' }, ctx);
    expect(res.resolved).toBe(true);
    expect(res.lat).toBe(17.4);
  });

  it('unresolved everywhere → model-actionable guidance, never a hard failure', async () => {
    const res = await resolveAddressTool.execute({ address: 'my house near the temple' }, ctx);
    expect(res.resolved).toBe(false);
    expect(res.userMessage).toMatch(/street, area, or pincode/i);
    expect(resolveAddressTool.summarize({ address: 'my house near the temple' }, res))
      .toBe('Address not found on the map');
  });

  it('rejects blank/too-short addresses at the schema layer', () => {
    expect(resolveAddressTool.argsSchema.safeParse({ address: 'ab' }).success).toBe(false);
    expect(resolveAddressTool.argsSchema.safeParse({ address: 'MG Road, Bangalore' }).success).toBe(true);
  });
});
