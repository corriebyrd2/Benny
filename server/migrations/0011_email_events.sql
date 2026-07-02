CREATE TABLE IF NOT EXISTS email_events (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  sg_event_id TEXT UNIQUE,
  sg_message_id TEXT NOT NULL DEFAULT '',
  event_type TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  email_type TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  response TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  event_timestamp TIMESTAMPTZ,
  raw_event JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS email_events_booking_id_created_at_idx ON email_events (booking_id, created_at DESC);
CREATE INDEX IF NOT EXISTS email_events_email_created_at_idx ON email_events (LOWER(email), created_at DESC);
CREATE INDEX IF NOT EXISTS email_events_event_type_created_at_idx ON email_events (event_type, created_at DESC);

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS email_delivery_status TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS email_delivery_last_event TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS email_delivery_last_error TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS email_delivery_status_at TIMESTAMPTZ;

ALTER TABLE subscribers
  ADD COLUMN IF NOT EXISTS unsubscribed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_email_event TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS last_email_event_at TIMESTAMPTZ;
