-- Preserve every Checkout Session id we create for a booking, not just the
-- latest. If a customer retries and then pays via an older (still valid)
-- session while the Stripe webhook is down, the sync fallback needs to be
-- able to inspect every session we ever minted for the booking to discover
-- the paid one. The scalar stripe_session_id column (the "latest") stays in
-- place for UI affordances and for backwards compatibility.
ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS stripe_session_ids TEXT[] NOT NULL DEFAULT '{}';

UPDATE bookings
SET stripe_session_ids = ARRAY[stripe_session_id]
WHERE stripe_session_id <> ''
  AND (stripe_session_ids IS NULL OR cardinality(stripe_session_ids) = 0);
