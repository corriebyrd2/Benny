-- Refunds.
--
-- The cancellation policy published at /legal/cancellation-policy promises
-- tiered refunds, and server/pricing.js implements the calculation — but
-- nothing called it. There was no refund endpoint, no admin action, and no
-- payment status that could represent a refunded booking. Cancelling a paid
-- booking simply marked it cancelled and kept the money, silently.
--
-- Two changes:
--   * payment_status gains 'refunded' and 'partially_refunded', so a booking's
--     state can actually say what happened to the money.
--   * refunds records each refund against its booking with the Stripe refund
--     id, which is what makes a dispute answerable.
--
-- The existing CHECK constraint (if any) is replaced rather than added to, so
-- this is safe to run on a database created by any earlier migration.
--
-- Rollback:
--   DROP TABLE refunds;
--   UPDATE bookings SET payment_status = 'paid'
--     WHERE payment_status IN ('refunded', 'partially_refunded');
--   -- then restore the narrower constraint if one is desired.

ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_payment_status_check;
ALTER TABLE bookings
  ADD CONSTRAINT bookings_payment_status_check
  CHECK (payment_status IN ('unpaid', 'requested', 'paid', 'partially_refunded', 'refunded', 'failed'));

ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refunded_cents INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS refunds (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id        INTEGER NOT NULL,
  amount_cents      INTEGER NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'usd',
  reason            TEXT NOT NULL DEFAULT '',
  tier              TEXT NOT NULL DEFAULT '',
  stripe_refund_id  TEXT NOT NULL DEFAULT '',
  stripe_payment_id TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'succeeded',
  created_by        TEXT NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS refunds_booking_idx ON refunds (booking_id, created_at DESC);

-- One Stripe refund maps to exactly one row, so a replayed webhook or a
-- double-clicked admin button cannot record the same refund twice.
CREATE UNIQUE INDEX IF NOT EXISTS refunds_stripe_id_idx
  ON refunds (stripe_refund_id) WHERE stripe_refund_id <> '';
