-- Record the Stripe Checkout Session id on the booking as soon as the session
-- is created. Having the id lets the app reconcile payment status with Stripe
-- directly (independent of the webhook) when a customer returns from checkout
-- or an admin asks to re-sync a booking.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS stripe_session_id TEXT NOT NULL DEFAULT '';
