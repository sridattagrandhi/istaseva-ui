-- Razorpay keeps a payment in captured state after a partial refund; it moves
-- to refunded only after the full amount has been refunded. Mirror that
-- distinction locally so cancellation policy refunds do not look like full
-- refunds in dashboards, notifications, or later reconciliation.
ALTER TYPE public.payment_status ADD VALUE IF NOT EXISTS 'partially_refunded';
