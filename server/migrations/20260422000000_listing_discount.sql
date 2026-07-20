-- Host-controlled flat-percent discount displayed on listing cards, detail page,
-- and applied to the per-night rate at booking. Coupons stack on top of this.
-- Bounded to 0..90 to prevent zero/negative pricing and keep margin sensible.
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS discount_percent INTEGER NOT NULL DEFAULT 0
  CHECK (discount_percent >= 0 AND discount_percent <= 90);
