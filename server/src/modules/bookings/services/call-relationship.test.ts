// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { shapeCallRelationship } from './call-relationship.js';

describe('shapeCallRelationship', () => {
  it('reports no active booking for empty rows', () => {
    expect(shapeCallRelationship([])).toEqual({ hasActiveBooking: false, phone: null, roles: [] });
  });

  it('reports an active booking with the peer phone + role', () => {
    const r = shapeCallRelationship([{ peer_role: 'host', peer_phone: '+919876543210' }]);
    expect(r).toEqual({ hasActiveBooking: true, phone: '+919876543210', roles: ['host'] });
  });

  it('de-dupes roles across multiple bookings (multi-hat peer)', () => {
    const r = shapeCallRelationship([
      { peer_role: 'host', peer_phone: '+911111111111' },
      { peer_role: 'driver', peer_phone: '+911111111111' },
      { peer_role: 'host', peer_phone: '+911111111111' },
    ]);
    expect(r.hasActiveBooking).toBe(true);
    expect(r.roles).toEqual(['host', 'driver']);
    expect(r.phone).toBe('+911111111111');
  });

  it('picks the first non-empty phone when some rows lack one', () => {
    const r = shapeCallRelationship([
      { peer_role: 'provider', peer_phone: null },
      { peer_role: 'provider', peer_phone: '  ' },
      { peer_role: 'provider', peer_phone: '+912222222222' },
    ]);
    expect(r.phone).toBe('+912222222222');
    expect(r.roles).toEqual(['provider']);
  });

  it('is active-but-uncallable when the peer has no phone on file', () => {
    const r = shapeCallRelationship([{ peer_role: 'guest', peer_phone: null }]);
    expect(r).toEqual({ hasActiveBooking: true, phone: null, roles: ['guest'] });
  });
});
