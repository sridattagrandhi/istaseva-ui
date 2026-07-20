/**
 * extract_fields → `outstanding` contract.
 *
 * The agent's in-loop validation signal: every extract_fields result
 * carries the SAME submit-gate misses submit_listing would refuse on,
 * evaluated on the post-patch profile. Born from a real session where
 * the host gave 2 amenities per room, the agent said "great!" and wound
 * down to photos, and the user hit the form's 3-amenity wall with no
 * warning. With `outstanding`, the per-row failure is visible to the
 * model the moment the short room is saved.
 */
import { describe, it, expect } from 'vitest';
import { extractFieldsTool } from '../tools/extract-fields.tool.js';
import type { OnboardingAgentContext } from '../types.js';

function ctxWith(profile: Record<string, unknown>): OnboardingAgentContext {
  return {
    userId: 'u1',
    displayLang: 'en',
    requestId: 'r1',
    abortSignal: new AbortController().signal,
    toolResultCache: new Map(),
    profile,
    pickerAction: 'none',
  } as OnboardingAgentContext;
}

describe('extract_fields outstanding', () => {
  it('surfaces the per-room amenity floor the moment a short room is saved', async () => {
    const ctx = ctxWith({
      category: 'hotel',
      propertyType: 'hotel',
      name: 'Sky Hotels',
      location: 'Jubilee Hills, Hyderabad',
    });
    const result = await extractFieldsTool.execute(
      {
        roomTypes: [
          { name: 'Single Room', pricePerNight: 200, maxGuests: 1, quantity: 5, amenities: ['AC', 'WiFi'] },
          { name: 'Double Room', pricePerNight: 300, maxGuests: 2, quantity: 5, amenities: ['AC', 'WiFi'] },
        ],
      } as never,
      ctx,
    );
    expect(result.outstanding).toContain('roomTypes[Single Room]: amenities (>=3)');
    expect(result.outstanding).toContain('roomTypes[Double Room]: amenities (>=3)');
  });

  it('clears once every row passes the gate and required core fields are in', async () => {
    const ctx = ctxWith({
      category: 'hotel',
      propertyType: 'hotel',
      name: 'Sky Hotels',
      location: 'Jubilee Hills, Hyderabad',
      description: 'A luxury hotel in Jubilee Hills with a chill vibe, restaurant, pool, gym, and parking.',
    });
    const result = await extractFieldsTool.execute(
      {
        roomTypes: [
          { name: 'Single Room', pricePerNight: 200, maxGuests: 1, quantity: 5, amenities: ['AC', 'WiFi', 'Hot water'] },
          { name: 'Double Room', pricePerNight: 300, maxGuests: 2, quantity: 5, amenities: ['AC', 'WiFi', 'Hot water'] },
        ],
      } as never,
      ctx,
    );
    expect(result.outstanding).toEqual([]);
  });
});
