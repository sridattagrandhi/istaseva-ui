// @vitest-environment node

import { describe, expect, it } from 'vitest';
import { validateListingReadiness, type ReadinessInput } from './listing-readiness.js';

const verifiedUser = { verification_status: 'verified' };
const aadhaarApproved = [{ document_type: 'aadhaar', status: 'approved' }];
const aadhaarAndLicense = [
  { document_type: 'aadhaar', status: 'approved' },
  { document_type: 'driving_license', status: 'approved' },
];

function input(overrides: Partial<ReadinessInput>): ReadinessInput {
  return {
    listing: {},
    roomTypes: [],
    user: verifiedUser,
    documents: aadhaarApproved,
    ...overrides,
  };
}

function fullStay(extra: Record<string, unknown> = {}) {
  return {
    listing_type: 'stay',
    name: 'Lakeview Homestay',
    category: 'homestay',
    description: 'A nice place',
    location: 'Pune',
    property_type: 'cottage',
    availability: 'Always',
    price: '2500',
    bedrooms: 2,
    bathrooms: 1,
    max_guests: 4,
    photos: ['1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg'],
    ...extra,
  };
}

function fullService(extra: Record<string, unknown> = {}) {
  return {
    listing_type: 'service',
    name: 'Quick Plumber',
    category: 'plumber',
    description: 'Plumbing',
    location: 'Pune',
    price: '500',
    availability: 'Mon-Fri',
    // SERVICE_PHOTO_MIN bumped to 5 to match the FE form's quality bar.
    photos: ['1.jpg', '2.jpg', '3.jpg', '4.jpg', '5.jpg'],
    metadata: {
      pricingUnit: 'per_visit',
      // "60" as a bare number parses as 60 HOURS (the parser treats
      // unitless digits as hours), which trips the registry's
      // "duration must be ≤ 24h" guard. Use explicit minutes.
      duration: '60 minutes',
      workingHours: { mon: ['09:00', '18:00'] },
      serviceModes: ['at-home'],
      serviceRadius: 10,
      // experience is required for services (registry + AI agent + FE
      // form all agree). The original listing-readiness didn't enforce
      // it — that was a drift bug closed by the Phase 2 refactor that
      // routes shared rules through FIELD_REGISTRY.
      experience: '5 years',
      // languages is now required for service + transport (registry
      // requiredFor + the manual forms). Must be from the supported set.
      languages: ['English', 'Hindi'],
    },
    ...extra,
  };
}

function fullTransport(extra: Record<string, unknown> = {}) {
  return {
    listing_type: 'transport',
    name: 'Driver Ravi',
    category: 'driver-cab',
    description: 'Daily rides',
    location: 'Pune',
    vehicle_name: 'Swift Dzire',
    vehicle_year: 2020,
    photos: ['1.jpg'],
    metadata: {
      serviceRadius: 50,
      languages: ['English', 'Hindi'],
      transportMode: 'hourly',
      pricePerHour: 300,
      // The activation gate (validateTransport in listing-readiness.ts) requires:
      //   - transportationTypes[] OR (vehicle_name + transportType) legacy pair
      //   - experience (string, non-empty)
      //   - workingHours with at least one 2-tuple day window
      // Anyone can create a listing without these (the AI agent's
      // submit_listing tool / FE form only need core+mode-specific
      // pricing), but ACTIVATION needs them so the listing publishes
      // bookable. The fixture mirrors a verified, ready-to-activate
      // transport row.
      transportType: 'sedan_cab',
      experience: '5 years',
      // Vehicle identity trio — all three required for transport activation.
      // vehicle_name (model) lives on the row above; colour + plate in metadata.
      vehicleColor: 'White',
      licensePlate: 'MH 12 AB 1234',
      workingHours: {
        mon: ['09:00', '18:00'], tue: ['09:00', '18:00'],
        wed: ['09:00', '18:00'], thu: ['09:00', '18:00'],
        fri: ['09:00', '18:00'], sat: null, sun: null,
      },
    },
    ...extra,
  };
}

describe('validateListingReadiness', () => {
  describe('stay', () => {
    it('passes when all stay fields + 5 photos + KYC are present', () => {
      const result = validateListingReadiness(input({ listing: fullStay() }));
      expect(result.ready).toBe(true);
      expect(result.missing).toEqual([]);
    });

    it('blocks activation when photos are below the stay minimum', () => {
      const result = validateListingReadiness(input({
        listing: fullStay({ photos: ['1.jpg', '2.jpg'] }),
      }));
      expect(result.ready).toBe(false);
      expect(result.missing.map((m) => m.code)).toContain('photos_required');
    });

    it('blocks activation when the photos array is empty', () => {
      const result = validateListingReadiness(input({
        listing: fullStay({ photos: [] }),
      }));
      expect(result.missing.map((m) => m.code)).toContain('photos_required');
    });

    it('blocks activation when user is not KYC verified', () => {
      const result = validateListingReadiness(input({
        listing: fullStay(),
        documents: [],
      }));
      expect(result.ready).toBe(false);
      expect(result.missing.map((m) => m.code)).toContain('kyc_aadhaar_required');
    });

    it('marks pending Aadhaar with a specific message', () => {
      const result = validateListingReadiness(input({
        listing: fullStay(),
        documents: [{ document_type: 'aadhaar', status: 'pending' }],
      }));
      expect(result.missing.map((m) => m.code)).toContain('kyc_aadhaar_pending');
    });

    it('blocks hotel activation when no room types are configured', () => {
      const result = validateListingReadiness(input({
        listing: fullStay({ category: 'hotel', listing_type: 'stay' }),
      }));
      expect(result.missing.map((m) => m.code)).toContain('room_types_required');
    });

    it('allows hotel activation with priced room types even without listing-level price', () => {
      const result = validateListingReadiness(input({
        listing: fullStay({
          category: 'hotel',
          price: null,
          bedrooms: null,
          bathrooms: null,
          max_guests: null,
        }),
        roomTypes: [
          { name: 'Deluxe', base_price_paise: 500000, max_guests: 2, quantity: 5, photos: ['1.jpg'] },
        ],
      }));
      expect(result.ready).toBe(true);
    });

    it('blocks hotel activation when an active room type has no photos', () => {
      const result = validateListingReadiness(input({
        listing: fullStay({ category: 'hotel' }),
        roomTypes: [
          { name: 'Deluxe', base_price_paise: 500000, max_guests: 2, quantity: 5, photos: [] },
        ],
      }));
      expect(result.missing.map((m) => m.code)).toContain('room_type_photos_required');
    });

    it('blocks hotel activation when room types are incomplete', () => {
      const result = validateListingReadiness(input({
        listing: fullStay({ category: 'hotel' }),
        roomTypes: [
          { name: 'Deluxe', base_price_paise: 0, max_guests: 0, quantity: 0, photos: [] },
        ],
      }));
      expect(result.missing.map((m) => m.code)).toContain('room_types_incomplete');
    });
  });

  describe('service', () => {
    it('passes for a fully filled service', () => {
      const result = validateListingReadiness(input({ listing: fullService() }));
      expect(result.ready).toBe(true);
    });

    it('blocks activation when no service modes are selected', () => {
      const result = validateListingReadiness(input({
        listing: fullService({ metadata: { ...(fullService().metadata as object), serviceModes: [] } }),
      }));
      expect(result.missing.map((m) => m.code)).toContain('service_modes_required');
    });

    it('requires pricingUnit + working hours', () => {
      const result = validateListingReadiness(input({
        listing: fullService({ metadata: { serviceModes: ['at-home'], serviceRadius: 10 } }),
      }));
      const codes = result.missing.map((m) => m.code);
      expect(codes).toContain('pricing_unit_required');
      expect(codes).toContain('working_hours_required');
    });

    it('requires visitAddress when visit-provider mode is selected', () => {
      const result = validateListingReadiness(input({
        listing: fullService({
          metadata: {
            ...(fullService().metadata as object),
            serviceModes: ['visit-provider'],
          },
        }),
      }));
      expect(result.missing.map((m) => m.code)).toContain('visit_address_required');
    });

    it('blocks when photos array is empty', () => {
      const result = validateListingReadiness(input({
        listing: fullService({ photos: [] }),
      }));
      expect(result.missing.map((m) => m.code)).toContain('photos_required');
    });
  });

  describe('transport', () => {
    it('passes for hourly mode with a price-per-hour', () => {
      const result = validateListingReadiness(input({
        listing: fullTransport(),
        documents: aadhaarAndLicense,
      }));
      expect(result.ready).toBe(true);
    });

    it('blocks activation without an approved driving license', () => {
      const result = validateListingReadiness(input({
        listing: fullTransport(),
      }));
      expect(result.missing.map((m) => m.code)).toContain('kyc_driving_license_required');
    });

    it('requires pricePerHour when transportMode=hourly', () => {
      const result = validateListingReadiness(input({
        listing: fullTransport({
          metadata: { ...(fullTransport().metadata as object), pricePerHour: 0 },
        }),
        documents: aadhaarAndLicense,
      }));
      expect(result.missing.map((m) => m.code)).toContain('price_per_hour_required');
    });

    it('requires pricePerDay when transportMode=day', () => {
      const result = validateListingReadiness(input({
        listing: fullTransport({
          metadata: { ...(fullTransport().metadata as object), transportMode: 'day' },
        }),
        documents: aadhaarAndLicense,
      }));
      expect(result.missing.map((m) => m.code)).toContain('price_per_day_required');
    });

    it('requires at least one package row when transportMode=package', () => {
      const result = validateListingReadiness(input({
        listing: fullTransport({
          metadata: {
            ...(fullTransport().metadata as object),
            transportMode: 'package',
            packageOptions: [],
          },
        }),
        documents: aadhaarAndLicense,
      }));
      expect(result.missing.map((m) => m.code)).toContain('package_options_required');
    });

    it('requires the vehicle model (vehicle_name)', () => {
      const { vehicle_name, ...rest } = fullTransport();
      const result = validateListingReadiness(input({
        listing: rest,
        documents: aadhaarAndLicense,
      }));
      expect(result.missing.map((m) => m.code)).toContain('vehicle_name_required');
    });

    it('requires the vehicle colour', () => {
      const meta = { ...(fullTransport().metadata as Record<string, unknown>) };
      delete meta.vehicleColor;
      const result = validateListingReadiness(input({
        listing: fullTransport({ metadata: meta }),
        documents: aadhaarAndLicense,
      }));
      expect(result.missing.map((m) => m.code)).toContain('vehicle_color_required');
    });

    it('requires the number plate', () => {
      const meta = { ...(fullTransport().metadata as Record<string, unknown>) };
      delete meta.licensePlate;
      const result = validateListingReadiness(input({
        listing: fullTransport({ metadata: meta }),
        documents: aadhaarAndLicense,
      }));
      expect(result.missing.map((m) => m.code)).toContain('license_plate_required');
    });

    it('accepts a valid package option row', () => {
      const result = validateListingReadiness(input({
        listing: fullTransport({
          metadata: {
            ...(fullTransport().metadata as object),
            transportMode: 'package',
            packageOptions: [{
              label: 'Half day',
              price: 1500,
              stops: [{ place: 'City center' }],
              distanceKmMin: 25,
              distanceKmMax: 25,
            }],
          },
        }),
        documents: aadhaarAndLicense,
      }));
      expect(result.ready).toBe(true);
    });
  });

  it('surfaces user_not_verified when docs pass but user row is unverified', () => {
    const result = validateListingReadiness(input({
      listing: fullService(),
      user: { verification_status: 'pending' },
      documents: aadhaarApproved,
    }));
    expect(result.missing.map((m) => m.code)).toContain('user_not_verified');
  });
});
