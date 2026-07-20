// @vitest-environment node
//
// Tests the booking_confirmed email template directly — the same code path
// SES delivery uses, minus the network. Verifies that each of the three
// booking categories (stay / transport / service) renders the spec-required
// fields: base / platform fee / GST / total + GSTIN block + cancellation
// policy + customer name + reference id. Also covers the fallback path when
// optional fields are missing so the email never shows undefined/null.

import { describe, expect, it } from 'vitest';
import { templates, type EmailData } from './email.service.js';

const basePricing = {
  description: 'Trident Hotels',
  subtotal: '₹1,000',
  gstLabel: 'CGST + SGST @ 12%',
  gstAmount: '₹132',
  total: '₹1,252',
  platformFee: '₹100',
  insurance: '₹20',
};

describe('booking_confirmed email template — stay', () => {
  const data: EmailData = {
    title: 'Booking Confirmed ✅',
    message: 'Your reservation at Trident Hotels is confirmed.',
    bookingId: 'c4047da0-86d7-4df4-8ff6-ef0625f40dd6',
    listing: 'Trident Hotels',
    hotelAddress: 'KSR Prime, RB Junction, Visakhapatnam',
    checkInDate: '2026-06-01',
    checkInTime: '03:00 PM',
    checkOutDate: '2026-06-02',
    checkOutTime: '12:00 PM',
    nights: 1,
    guestCount: 2,
    roomType: 'Deluxe Twin',
    guest: 'Sridatta Grandhi',
    providerGstin: '27ABCDE1234F1Z5',
    platformGstin: '27AAACI1234J1Z5',
    paymentMethod: 'UPI',
    cancellationPolicyText: 'Strict policy: 50% refund within 24–72h.',
    bookedOn: '15 May 2026, 10:15 AM',
    pricing: basePricing,
  };

  it('renders all required hotel-specific rows', () => {
    const { html, text, subject } = templates.booking_confirmed!(data);
    expect(subject).toContain('Trident Hotels');
    expect(html).toContain('Hotel');
    expect(html).toContain('Trident Hotels');
    expect(html).toContain('KSR Prime');
    expect(html).toContain('2026-06-01');
    expect(html).toContain('03:00 PM');
    expect(html).toContain('2026-06-02');
    expect(html).toContain('12:00 PM');
    expect(html).toContain('Duration');
    expect(html).toContain('1 Night');
    expect(html).toContain('Deluxe Twin');
    expect(html).toContain('Sridatta Grandhi');
    expect(text).toContain('Sridatta Grandhi');
  });

  it('adds the "Getting there" note when the host gave no street-level address (WS6)', () => {
    const { html } = templates.booking_confirmed!({ ...data, hotelAddress: 'Visakhapatnam, Andhra Pradesh', hasExactAddress: false });
    expect(html).toContain('Getting there');
    expect(html).toContain('message or call your host');
  });

  it('omits the note when a real street address is present', () => {
    const { html } = templates.booking_confirmed!({ ...data, hasExactAddress: true });
    expect(html).not.toContain('message or call your host');
  });

  it('renders the fare summary with platform fee + GST + total', () => {
    const { html } = templates.booking_confirmed!(data);
    expect(html).toContain('Base Cost');
    expect(html).toContain('₹1,000');
    expect(html).toContain('Platform Fee (10%)');
    expect(html).toContain('₹100');
    expect(html).toContain('CGST + SGST @ 12%');
    expect(html).toContain('₹132');
    expect(html).toContain('Insurance Premium');
    expect(html).toContain('Total Paid');
    expect(html).toContain('₹1,252');
  });

  it('renders both vendor and platform GSTINs', () => {
    const { html, text } = templates.booking_confirmed!(data);
    expect(html).toContain('27ABCDE1234F1Z5');
    expect(html).toContain('27AAACI1234J1Z5');
    expect(text).toContain('Vendor GSTIN: 27ABCDE1234F1Z5');
    expect(text).toContain('IstaSeva GSTIN: 27AAACI1234J1Z5');
  });

  it('renders the cancellation policy box and payment method', () => {
    const { html } = templates.booking_confirmed!(data);
    expect(html).toContain('Cancellation Policy');
    expect(html).toContain('Strict policy');
    expect(html).toContain('Paid via UPI');
  });
});

describe('booking_confirmed email template — transport', () => {
  const data: EmailData = {
    title: 'Booking Confirmed ✅',
    message: 'Your driver is booked.',
    bookingId: 'a1234567-7890-4abc-def0-123456789abc',
    listing: 'Priya',
    serviceType: 'Transport · cab',
    vehicleModel: 'Maruti Swift Dzire',
    vehicleColor: 'White',
    licensePlate: 'KA 01 AB 1234',
    driverName: 'Raji B',
    driverPhone: '+15103007219',
    pickup: 'Hyderabad Airport',
    drop: 'Hitech City',
    estimatedKm: 35,
    date: '2026-06-01 14:00',
    guest: 'Sridatta Grandhi',
    providerGstin: '36ABCDE1234F1Z5',
    platformGstin: '27AAACI1234J1Z5',
    paymentMethod: 'Card',
    cancellationPolicyText: 'Flexible: free cancellation any time.',
    bookedOn: '15 May 2026, 11:00 AM',
    pricing: {
      ...basePricing,
      description: 'Cab — Hyderabad → Hitech City',
      gstLabel: 'CGST + SGST @ 5%',
      gstAmount: '₹50',
      subtotal: '₹900',
      platformFee: '₹90',
      total: '₹1,040',
    },
  };

  it('renders transport-specific rows', () => {
    const { html, text } = templates.booking_confirmed!(data);
    expect(html).toContain('Service');
    expect(html).toContain('Transport · cab');
    expect(html).toContain('Pickup');
    expect(html).toContain('Hyderabad Airport');
    expect(html).toContain('Drop');
    expect(html).toContain('Hitech City');
    expect(html).toContain('~35 km');
    // Pickup date and time render on separate rows for scannability —
    // the email previously concatenated them as "Pickup Date / Time"
    // which forced the customer to parse a combined string.
    expect(html).toContain('Pickup Date');
    expect(html).toContain('Pickup Time');
    expect(html).toContain('Passenger');
    expect(text).toContain('Pickup: Hyderabad Airport');
  });

  it('renders the vehicle identity + driver contact rows', () => {
    const { html, text } = templates.booking_confirmed!(data);
    // Vehicle the rider should look for.
    expect(html).toContain('Vehicle');
    expect(html).toContain('Maruti Swift Dzire');
    expect(html).toContain('Colour');
    expect(html).toContain('White');
    expect(html).toContain('Number plate');
    expect(html).toContain('KA 01 AB 1234');
    // Driver = the person (not the listing/provider business name) + phone.
    expect(html).toContain('Driver');
    expect(html).toContain('Raji B');
    expect(html).toContain('Driver phone');
    expect(html).toContain('+15103007219');
    // Plain-text mirror.
    expect(text).toContain('Vehicle: Maruti Swift Dzire');
    expect(text).toContain('Colour: White');
    expect(text).toContain('Number plate: KA 01 AB 1234');
    expect(text).toContain('Driver: Raji B');
    expect(text).toContain('Driver phone: +15103007219');
  });

  it('renders transport fare summary with Trip Fare label', () => {
    const { html } = templates.booking_confirmed!(data);
    expect(html).toContain('Trip Fare');
    expect(html).toContain('Platform Fee (10%)');
    expect(html).toContain('CGST + SGST @ 5%');
    expect(html).toContain('Total Paid');
    expect(html).toContain('₹1,040');
  });

  it('includes both GSTINs and payment method', () => {
    const { html } = templates.booking_confirmed!(data);
    expect(html).toContain('36ABCDE1234F1Z5');
    expect(html).toContain('27AAACI1234J1Z5');
    expect(html).toContain('Paid via Card');
  });
});

describe('booking_confirmed email template — service', () => {
  const data: EmailData = {
    title: 'Booking Confirmed ✅',
    message: 'Your cleaning service is booked.',
    bookingId: 'b1234567-7890-4abc-def0-123456789abc',
    listing: 'Super Cleanings',
    provider: 'Super Cleanings',
    serviceLocation: 'HSR Layout, Bengaluru',
    serviceDuration: '3 hours',
    date: '2026-06-05 09:00',
    guest: 'Sridatta Grandhi',
    providerGstin: '29ABCDE1234F1Z5',
    platformGstin: '27AAACI1234J1Z5',
    paymentMethod: 'Net banking',
    cancellationPolicyText: 'Moderate: 50% refund within 48h.',
    bookedOn: '15 May 2026, 12:00 PM',
    pricing: {
      ...basePricing,
      description: 'Deep cleaning, 2BHK',
      gstLabel: 'CGST + SGST @ 18%',
      gstAmount: '₹360',
      subtotal: '₹2,000',
      platformFee: '₹200',
      total: '₹2,560',
      insurance: undefined,
    },
  };

  it('renders service-specific rows including location + duration', () => {
    const { html, text } = templates.booking_confirmed!(data);
    expect(html).toContain('Super Cleanings');
    expect(html).toContain('Location');
    expect(html).toContain('HSR Layout, Bengaluru');
    expect(html).toContain('Duration');
    expect(html).toContain('3 hours');
    expect(html).toContain('Customer');
    expect(text).toContain('Sridatta Grandhi');
  });

  it('renders "Where to go" for a visit-provider booking WITHOUT flipping into the stay layout (WS6)', () => {
    // The confirmed customer travels to the provider — the email is where the
    // exact address lands, since the public listing may withhold it until
    // booking. Must use `visitAddress`, never `hotelAddress`: the template
    // infers the stay layout from hotelAddress's presence.
    const { html, text } = templates.booking_confirmed!({
      ...data,
      visitAddress: 'Jubilee Hills Check Post Road, Venkateswara Colony, Hyderabad 500034',
    });
    expect(html).toContain('Where to go');
    expect(html).toContain('Jubilee Hills Check Post Road');
    expect(text).toContain('Where to go: Jubilee Hills Check Post Road');
    // Still the SERVICE layout — no hotel rows.
    expect(html).not.toContain('Check-In');
    expect(html).toContain('Service');
  });

  it('omits the "Where to go" row when no visit address exists (at-home / online)', () => {
    const { html } = templates.booking_confirmed!(data);
    expect(html).not.toContain('Where to go');
  });

  it('adds the "Getting there" note for a visit-provider booking without a street address (WS6)', () => {
    // hasExactAddress false = the provider only ever gave an area name — the
    // service email must be as upfront as the stay email and the dashboard.
    const { html, text } = templates.booking_confirmed!({
      ...data,
      visitAddress: 'Banjara Hills, Hyderabad, Telangana',
      hasExactAddress: false,
    });
    expect(html).toContain('Getting there');
    expect(html).toContain('message or call them in the app');
    expect(text).toContain('Getting there: message or call your host');
    // Still the service layout.
    expect(html).not.toContain('Check-In');
  });

  it('renders service fare summary with Service Cost label', () => {
    const { html } = templates.booking_confirmed!(data);
    expect(html).toContain('Service Cost');
    expect(html).toContain('Platform Fee (10%)');
    expect(html).toContain('CGST + SGST @ 18%');
    expect(html).toContain('₹360');
    expect(html).toContain('Total Paid');
    expect(html).toContain('₹2,560');
    // Insurance line is hidden when not opted-in.
    expect(html).not.toContain('Insurance Premium');
  });

  it('includes vendor + platform GSTINs and payment method', () => {
    const { html } = templates.booking_confirmed!(data);
    expect(html).toContain('29ABCDE1234F1Z5');
    expect(html).toContain('27AAACI1234J1Z5');
    expect(html).toContain('Paid via Net banking');
  });
});

describe('booking_confirmed email template — missing-field resilience', () => {
  it('renders even when only the bare minimum is provided', () => {
    const { html, text, subject } = templates.booking_confirmed!({
      title: 'Booking Confirmed',
      message: 'Your booking is confirmed.',
      bookingId: 'c0000000-0000-0000-0000-000000000000',
      listing: 'Listing Name',
    });
    expect(subject).toContain('Listing Name');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('null');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
    // GSTIN block falls back gracefully when neither party has a number.
    expect(html).toContain('not GST-registered');
    expect(text).toContain('not GST-registered');
  });

  it('omits payment-method line when paymentMethod is undefined', () => {
    const { html } = templates.booking_confirmed!({
      title: 'Booking Confirmed',
      message: 'Done',
      listing: 'X',
      pricing: basePricing,
    });
    expect(html).not.toContain('Paid via');
  });

  it('omits insurance/discount rows when not provided', () => {
    const { html } = templates.booking_confirmed!({
      title: 'Booking Confirmed',
      message: 'Done',
      listing: 'X',
      pricing: { ...basePricing, insurance: undefined, discount: undefined },
    });
    expect(html).not.toContain('Insurance Premium');
    expect(html).not.toContain('Discount');
  });
});
