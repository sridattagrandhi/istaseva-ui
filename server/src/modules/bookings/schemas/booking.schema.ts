import { z } from 'zod';
import { BOOKING_STATUSES } from './booking-status.js';

export const createBookingSchema = z.object({
  providerId: z.string().uuid().optional(),
  listingId: z.string().uuid().optional(),
  serviceCategory: z.string().min(1),
  scheduledDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  // Check-out date for stays (exclusive — guest occupies nights up to but
  // not including this date). Omit (or set equal to scheduledDate) for
  // services and transport, which are same-day time-slot bookings.
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  agreedPrice: z.number().min(0).optional(),
  address: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  notes: z.string().optional(),
  idempotencyKey: z.string().min(8).max(255).optional(),
  couponCode: z.string().trim().min(1).max(32).optional(),
  // Hotel-style listings have multiple bookable rooms — when present, the
  // booking is for this specific room and price comes from the room.
  roomTypeId: z.string().uuid().optional(),
  // Number of rooms of the chosen room type the guest is booking in one
  // shot (e.g. 3 "Non-AC" rooms in a sathram). Capped by the room type's
  // `quantity` minus rooms already booked for the same nights — enforced
  // server-side in createHold. Defaults to 1 for legacy callers.
  numberOfRooms: z.number().int().min(1).max(50).optional(),
}).refine((value) => Boolean(value.providerId || value.listingId), {
  message: 'providerId or listingId is required',
  path: ['providerId'],
}).refine((value) => {
  // Same-day bookings (services + transport hourly/day/package) require a
  // non-degenerate time range. Multi-night stays don't — a 14:00 check-in /
  // 11:00 next-day check-out is valid and would fail a naive comparison.
  const isSameDay = !value.endDate || value.endDate === value.scheduledDate;
  if (!isSameDay) return true;
  return value.endTime > value.startTime;
}, {
  message: 'endTime must be after startTime for same-day bookings',
  path: ['endTime'],
});

export type CreateBookingInput = z.infer<typeof createBookingSchema>;

// Contact for the walk-up guest a host books on behalf of. `phone` is required
// — it's where the Razorpay Payment Link SMS goes. Email is optional (adds an
// email copy of the link).
export const onBehalfGuestSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().min(6).max(20),
  email: z.string().trim().email().max(200).optional(),
});

export const bookingStatusSchema = z.enum(BOOKING_STATUSES);

/**
 * Structured request for the unified prepare-booking endpoint
 * (POST /api/bookings/prepare → bookingIntentService.prepare). The superset of
 * what both the marketplace modal and the chat assistant collect; the server
 * owns notes, hold, order, authoritative price, and the result shape.
 *
 * Listing ids accept non-UUID values here because the redesign's mock-backed
 * listings can carry slug-style ids; createHold + pricing validate the real
 * listing downstream.
 */
const time = z.string().regex(/^\d{2}:\d{2}$/);
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const prepareBookingRequestSchema = z.object({
  listingType: z.enum(['stay', 'service', 'transport']),
  listingId: z.string().min(1),
  serviceCategory: z.string().min(1),
  scheduledDate: ymd,
  startTime: time.optional(),
  endTime: time.optional(),
  checkOutDate: ymd.optional(),
  endDate: ymd.optional(),
  numberOfRooms: z.number().int().min(1).max(50).optional(),
  couponCode: z.string().trim().min(1).max(32).optional(),
  address: z.string().max(1000).optional(),
  idempotencyKey: z.string().max(120).optional(),

  // Display / result decoration
  listingTitle: z.string().max(200).optional(),
  listingName: z.string().max(200).optional(),
  listingImage: z.string().max(2000).optional(),
  listingLocation: z.string().max(300).optional(),
  roomPricePerNight: z.number().nonnegative().optional(),

  // Shared / audit
  note: z.string().max(500).optional(),
  contact: z.object({ name: z.string().max(120).optional(), phone: z.string().max(40).optional() }).optional(),
  guestName: z.string().max(120).optional(),
  insuranceOptIn: z.boolean().optional(),

  // Stay
  guestCount: z.number().int().min(1).max(50).optional(),
  roomTypeId: z.string().min(1).optional(),
  roomName: z.string().max(200).optional(),
  roomCount: z.number().int().min(1).max(50).optional(),

  // Service
  serviceMode: z.enum(['at-home', 'visit-provider', 'online']).optional(),
  serviceAddress: z.string().max(1000).optional(),
  visitAddress: z.string().max(1000).optional(),
  meetingDetails: z.string().max(1000).optional(),
  serviceHours: z.number().positive().max(24).optional(),
  slot: z.string().max(120).optional(),
  serviceAddOns: z.array(z.object({ id: z.string().optional(), label: z.string(), price: z.number() })).optional(),
  serviceCatalogId: z.string().optional(),
  serviceCatalogName: z.string().optional(),
  serviceCatalogBasePrice: z.number().optional(),

  // Transport
  transportMode: z.enum(['hourly', 'day', 'package']).optional(),
  pickupLocation: z.string().max(1000).optional(),
  passengerCount: z.number().int().min(1).max(50).optional(),
  scheduledTime: time.optional(),
  vehicleType: z.string().max(80).optional(),
  transportationType: z.string().max(80).optional(),
  transportationLabel: z.string().max(120).optional(),
  transportHours: z.number().positive().max(24).optional(),
  transportStartTime: time.optional(),
  transportEndTime: time.optional(),
  transportSelectedSlots: z.array(z.string()).optional(),
  transportDays: z.number().int().min(1).max(30).optional(),
  transportEndDate: ymd.optional(),
  transportPackageId: z.string().optional(),
  transportPackageLabel: z.string().optional(),
  transportPackagePrice: z.number().optional(),
  transportPackageHours: z.number().optional(),
});

export type PrepareBookingRequest = z.infer<typeof prepareBookingRequestSchema>;

// Host-books-on-behalf: the SAME structured payload the marketplace modal sends
// to /api/bookings/prepare (so notes/pricing are built identically server-side),
// plus the walk-up guest to bill via a Razorpay Payment Link.
export const createOnBehalfRequestSchema = prepareBookingRequestSchema.and(
  z.object({ guest: onBehalfGuestSchema }),
);

export type CreateOnBehalfRequest = z.infer<typeof createOnBehalfRequestSchema>;
