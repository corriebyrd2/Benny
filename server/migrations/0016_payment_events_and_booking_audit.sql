-- Payment/booking reliability primitives.
--
-- 1. stripe_events — event-level idempotency and replay resistance.
--    The webhook previously relied on the `payment_status != 'paid'` guard in
--    each UPDATE. That makes a *duplicate* delivery harmless but records
--    nothing, so an out-of-order or replayed event cannot be recognised, and a
--    DB failure mid-handler was swallowed and answered 200 — telling Stripe the
--    event was handled when it was not, so it was never retried. Recording the
--    event id first makes the handler exactly-once and lets the route return a
--    retriable 5xx when processing genuinely fails.
--
-- 2. booking_events — append-only audit trail for booking/payment transitions.
--    There was no record of who moved a booking to confirmed/cancelled/paid or
--    when, which makes a payment dispute unanswerable.
--
-- Rollback: DROP TABLE booking_events; DROP TABLE stripe_events;
--    Neither table is read by any pricing or status decision, so dropping them
--    loses history but cannot corrupt live bookings.

CREATE TABLE IF NOT EXISTS stripe_events (
  event_id      TEXT PRIMARY KEY,
  event_type    TEXT NOT NULL,
  booking_id    INTEGER,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at  TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'received',
  error_message TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS stripe_events_booking_idx ON stripe_events (booking_id);

CREATE TABLE IF NOT EXISTS booking_events (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id    INTEGER NOT NULL,
  event         TEXT NOT NULL,
  from_status   TEXT NOT NULL DEFAULT '',
  to_status     TEXT NOT NULL DEFAULT '',
  from_payment_status TEXT NOT NULL DEFAULT '',
  to_payment_status   TEXT NOT NULL DEFAULT '',
  amount_cents  INTEGER,
  actor_type    TEXT NOT NULL DEFAULT 'system',
  actor_id      TEXT NOT NULL DEFAULT '',
  detail        TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS booking_events_booking_idx
  ON booking_events (booking_id, created_at DESC);

-- Bookings are listed by status and by customer on every portal/admin render.
CREATE INDEX IF NOT EXISTS bookings_customer_created_idx
  ON bookings (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bookings_status_idx ON bookings (status);
CREATE INDEX IF NOT EXISTS bookings_payment_status_idx ON bookings (payment_status);
