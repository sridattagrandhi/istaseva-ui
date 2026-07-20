-- Transport bookings should show the customer which car is coming and how to
-- reach the driver — even after the host later edits or removes the listing.
-- Mirrors the receipt-snapshot pattern (guest_name_snapshot, etc.): copy the
-- vehicle model / plate / color and the driver's phone onto the booking row at
-- hold creation so My Bookings, the confirmation screen, and the tax invoice
-- always render a stable record of the booked vehicle.
--
-- Driver NAME is intentionally NOT snapshotted here — it's already surfaced on
-- every booking payload as provider_name (provider_profiles.display_name,
-- live-joined). Plate/color/model on the LISTING live in listings.metadata
-- (licensePlate / vehicleColor / vehicleName) and need no column.
--
-- All nullable: existing bookings and non-transport bookings leave these NULL.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS vehicle_model_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_plate_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS vehicle_color_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS driver_phone_snapshot TEXT;
