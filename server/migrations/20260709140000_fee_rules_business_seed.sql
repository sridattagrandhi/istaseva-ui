-- Seed the mandatory global default for the BUSINESS audience (partner-payout
-- commission), mirroring the customer seed in 20260709120000_fee_rules.sql.
--
-- 0% + ₹0 = "no commission" — payout deduction isn't wired yet, so the
-- truthful default is zero; admins raise it from the Fees panel when the
-- payout work lands. Seeding it (rather than leaving the audience empty)
-- keeps two invariants:
--   1. the resolver always matches a real rule for business simulations —
--      otherwise the legacy flat-₹3 CUSTOMER fallback would masquerade as
--      a commission in the simulator;
--   2. the admin service's "can't deactivate the last active global rule"
--      guard is meaningful for business from day one.

INSERT INTO public.fee_rules (audience, category, scope_type, percent_bps, fixed_paise, reason)
SELECT 'business', NULL, 'global', 0, 0, 'Seed: zero business commission (payout deduction not wired yet)'
WHERE NOT EXISTS (
  SELECT 1 FROM public.fee_rules
  WHERE audience = 'business' AND scope_type = 'global' AND active
);
