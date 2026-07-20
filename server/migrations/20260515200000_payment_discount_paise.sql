-- Track the applied discount (rupees off the total) on the payment row so the
-- invoice + email can render a "Discount" line on the fare summary, and so
-- cancellation refunds can reason about pre-discount totals if needed.
--
-- Nullable on purpose — legacy rows + bookings without a coupon stay NULL
-- and the renderers omit the line gracefully.
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS discount_paise INTEGER;
