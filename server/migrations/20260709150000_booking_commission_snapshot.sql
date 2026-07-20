-- Business-commission snapshot on bookings — the integration step that makes
-- the admin panel's 'business' fee rules real data instead of config-only.
--
-- Mirrors the customer-fee snapshot pattern (fee_rule_id +
-- platform_fee_paise from 20260709120000/20260516000000): createHold
-- resolves the winning BUSINESS-audience rule for the listing and freezes
-- both the rule id and the computed commission here, so a later rule change
-- never retroactively alters what a host earns on an existing booking.
--
-- commission_paise is computed on the DISCOUNTED subtotal (the host-side
-- amount), same base as the customer platform fee. Partner earnings
-- surfaces render gross − commission = net payout off these columns.
-- Actual payout deduction/settlement still doesn't move money — that's the
-- payouts project — but every booking now carries the number it will need.
--
-- Nullable: legacy bookings (and any hold where resolution fell back) have
-- NULL, which earnings queries COALESCE to 0 (zero commission — matches the
-- seeded 0% business default).

ALTER TABLE public.bookings
  ADD COLUMN IF NOT EXISTS commission_rule_id UUID REFERENCES public.fee_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS commission_paise INTEGER;
