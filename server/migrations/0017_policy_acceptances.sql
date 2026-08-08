-- Versioned policy acceptance.
--
-- The site had no Privacy Policy or Terms of Service at all, and therefore no
-- record that any customer had ever agreed to anything. This table is the
-- evidence side of that: which identified person accepted which policy, at
-- which version, when, and — for per-booking agreements such as the boarding
-- agreement and the emergency veterinary authorisation — against which booking.
--
-- Design notes:
--   * The policy TEXT is versioned in code (server/legal.js), not here. Storing
--     the version string means a customer who accepted v1 is never retroactively
--     treated as having accepted v2; bumping the version in code is what forces
--     re-acceptance.
--   * Rows are append-only. A withdrawal is a new row with accepted = FALSE, so
--     the history of what someone agreed to at a point in time survives.
--   * customer_id is nullable so a guest booking can still record acceptance
--     against an email address.
--
-- Rollback: DROP TABLE policy_acceptances. No other table depends on it and no
-- runtime decision reads it, so dropping loses evidence but breaks nothing.

CREATE TABLE IF NOT EXISTS policy_acceptances (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id    INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  email          TEXT NOT NULL DEFAULT '',
  policy_slug    TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  accepted       BOOLEAN NOT NULL DEFAULT TRUE,
  context        TEXT NOT NULL DEFAULT '',
  booking_id     INTEGER,
  ip_hash        TEXT NOT NULL DEFAULT '',
  user_agent     TEXT NOT NULL DEFAULT '',
  accepted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS policy_acceptances_customer_idx
  ON policy_acceptances (customer_id, policy_slug, accepted_at DESC);

CREATE INDEX IF NOT EXISTS policy_acceptances_booking_idx
  ON policy_acceptances (booking_id);
