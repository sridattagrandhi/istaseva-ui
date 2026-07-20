// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { buildBookingNotes, type PrepareBookingIntentInput } from './booking-notes.js';

const base = (over: Partial<PrepareBookingIntentInput>): PrepareBookingIntentInput => ({
  listingType: 'stay',
  listingId: 'l1',
  ...over,
});

function parse(input: PrepareBookingIntentInput): Record<string, unknown> {
  return JSON.parse(buildBookingNotes(input)) as Record<string, unknown>;
}

describe('buildBookingNotes — stay', () => {
  const notes = parse(base({
    listingType: 'stay',
    listingId: 'stay-1',
    listingTitle: 'Trident',
    checkOutDate: '2026-07-16',
    guestCount: 3,
    roomTypeId: 'room-uuid',
    roomName: 'Deluxe',
    roomCount: 2,
    contact: { name: 'Asha', phone: '+919876543210' },
    guestName: 'Asha',
    insuranceOptIn: true,
    note: 'late check-in',
  }));

  it('carries every field the modal + assistant stay notes write', () => {
    expect(notes).toMatchObject({
      checkOut: '2026-07-16',
      guests: 3,
      stayId: 'stay-1',
      stayTitle: 'Trident',
      roomName: 'Deluxe',
      roomTypeId: 'room-uuid',
      roomCount: 2,
      contact: { name: 'Asha', phone: '+919876543210' },
      protection: true,
      note: 'late check-in',
      guestName: 'Asha',     // invoice.service reads notes.guestName
    });
  });

});

describe('buildBookingNotes — service', () => {
  it('at-home: writes serviceAddress (the key invoice.service reads) AND the customerAddress alias', () => {
    const notes = parse(base({
      listingType: 'service',
      listingTitle: 'AC Doctor',
      serviceMode: 'at-home',
      serviceAddress: '12 MG Road, Bangalore',
      slot: 'Mon 9:00 AM',
      serviceHours: 2,
      contact: { name: 'Ravi', phone: '999' },
      guestName: 'Ravi',
      serviceAddOns: [{ id: 'a1', label: 'Deep clean', price: 300 }],
      serviceCatalogId: 'cat1',
      serviceCatalogName: "Split AC service",
      serviceCatalogBasePrice: 499,
      insuranceOptIn: true,
    }));
    // The bug fix: invoice.service reads location||address||serviceAddress.
    expect(notes.serviceAddress).toBe('12 MG Road, Bangalore');
    expect(notes.customerAddress).toBe('12 MG Road, Bangalore'); // legacy alias preserved
    expect(notes).toMatchObject({
      serviceMode: 'at-home',
      serviceTitle: 'AC Doctor',
      slot: 'Mon 9:00 AM',
      serviceHours: 2,
      contact: { name: 'Ravi', phone: '999' },
      guestName: 'Ravi',
      selectedServiceCatalogId: 'cat1',
      selectedServiceName: 'Split AC service',
      selectedServiceBasePrice: 499,
      protection: true,
    });
    expect(notes.addOns).toEqual([{ id: 'a1', label: 'Deep clean', price: 300 }]);
  });

  it('writes addOnIds (assistant path) when only ids are provided — createHold prices them', () => {
    const notes = parse(base({
      listingType: 'service',
      serviceMode: 'at-home',
      serviceAddress: '5 Park St',
      serviceAddOnIds: ['addon-1', 'addon-2'],
    }));
    expect(notes.addOnIds).toEqual(['addon-1', 'addon-2']);
    expect(notes).not.toHaveProperty('addOns'); // ids path doesn't fabricate a snapshot
  });

  it('prefers the addOns snapshot over ids when both are present (modal path)', () => {
    const notes = parse(base({
      listingType: 'service',
      serviceMode: 'at-home',
      serviceAddress: '5 Park St',
      serviceAddOns: [{ id: 'a1', label: 'Deep clean', price: 300 }],
      serviceAddOnIds: ['a1'],
    }));
    expect(notes.addOns).toEqual([{ id: 'a1', label: 'Deep clean', price: 300 }]);
    expect(notes).not.toHaveProperty('addOnIds');
  });

  it('visit-provider writes visitAddress; online writes meetingDetails; neither leaks the other', () => {
    const visit = parse(base({ listingType: 'service', serviceMode: 'visit-provider', visitAddress: 'Studio 5' }));
    expect(visit).toMatchObject({ serviceMode: 'visit-provider', visitAddress: 'Studio 5' });
    expect(visit).not.toHaveProperty('serviceAddress');

    const online = parse(base({ listingType: 'service', serviceMode: 'online', meetingDetails: 'Zoom link 30m before' }));
    expect(online).toMatchObject({ serviceMode: 'online', meetingDetails: 'Zoom link 30m before' });
    expect(online).not.toHaveProperty('visitAddress');
  });
});

describe('buildBookingNotes — transport', () => {
  it('hourly: includes vehicleType + selectedSlots (which the assistant used to drop, breaking invoices)', () => {
    const notes = parse(base({
      listingType: 'transport',
      transportMode: 'hourly',
      pickupLocation: 'Banjara Hills',
      passengerCount: 2,
      scheduledDate: '2026-07-15',
      scheduledTime: '10:00',
      vehicleType: 'sedan_cab',
      transportationType: 'sedan_cab',
      transportationLabel: 'Sedan',
      transportHours: 3,
      transportStartTime: '10:00',
      transportEndTime: '13:00',
      transportSelectedSlots: ['12:00', '10:00', '11:00'],
      contact: { name: 'Sam', phone: '888' },
      guestName: 'Sam',
      insuranceOptIn: true,
    }));
    expect(notes).toMatchObject({
      transport: true,
      mode: 'hourly',
      transportMode: 'hourly',
      pickup: 'Banjara Hills',
      pickupLocation: 'Banjara Hills',
      passengers: 2,
      scheduledDate: '2026-07-15',
      scheduledTime: '10:00',
      vehicleType: 'sedan_cab',                       // invoice.service reads this
      selectedTransportationType: 'sedan_cab',
      selectedTransportationLabel: 'Sedan',
      protection: true,
      contact: { name: 'Sam', phone: '888' },
      guestName: 'Sam',
      durationHours: 3,
      startTime: '10:00',
      endTime: '13:00',
    });
    expect(notes.selectedSlots).toEqual(['10:00', '11:00', '12:00']); // sorted
  });

  it('day: includes days + endDate', () => {
    const notes = parse(base({
      listingType: 'transport', transportMode: 'day', transportDays: 3, transportEndDate: '2026-07-18',
    }));
    expect(notes).toMatchObject({ mode: 'day', days: 3, endDate: '2026-07-18' });
    expect(notes).not.toHaveProperty('durationHours');
  });

  it('package: includes packageId + label + price + hours', () => {
    const notes = parse(base({
      listingType: 'transport', transportMode: 'package',
      transportPackageId: 'pkg1', transportPackageLabel: 'Heritage Tour',
      transportPackagePrice: 3500, transportPackageHours: 8,
    }));
    expect(notes).toMatchObject({
      mode: 'package', packageId: 'pkg1', packageLabel: 'Heritage Tour',
      packagePrice: 3500, packageHours: 8,
    });
    expect(notes).not.toHaveProperty('days');
  });
});
