-- Receipt-critical booking details should not depend only on mutable profile
-- rows or free-form notes JSON. Store stable snapshots at hold creation so
-- booking confirmation emails and tax invoices can always show who the
-- booking is for, how many guests, and the selected room type.
ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS guest_name_snapshot TEXT,
  ADD COLUMN IF NOT EXISTS guest_count INTEGER,
  ADD COLUMN IF NOT EXISTS room_type_name_snapshot TEXT;
