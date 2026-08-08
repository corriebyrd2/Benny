-- Guest inquiries.
--
-- The site had no way for a visitor to ask a question. Every "contact us" and
-- "ask about this service" call to action pointed at the #contact section,
-- which rendered contact DETAILS — and those details are hidden while the owner
-- has not supplied verified ones. So a prospect who was not ready to create an
-- account reached a dead end, and the enquiry-only services (grooming,
-- training) had no route to enquire through at all.
--
-- Storing enquiries rather than only emailing them matters: transactional email
-- is not yet verified for this deployment, so an email-only channel would drop
-- messages silently. The database is the record; email is the notification.
--
-- Rollback: DROP TABLE inquiries.

CREATE TABLE IF NOT EXISTS inquiries (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         TEXT NOT NULL,
  email        TEXT NOT NULL,
  phone        TEXT NOT NULL DEFAULT '',
  service_id   INTEGER,
  service_name TEXT NOT NULL DEFAULT '',
  message      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'new',
  customer_id  INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  handled_at   TIMESTAMPTZ,
  handled_by   TEXT NOT NULL DEFAULT '',
  admin_notes  TEXT NOT NULL DEFAULT '',
  ip_hash      TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE inquiries
  ADD CONSTRAINT inquiries_status_check
  CHECK (status IN ('new', 'in_progress', 'answered', 'spam'));

-- The admin queue is "new first, newest first".
CREATE INDEX IF NOT EXISTS inquiries_status_created_idx
  ON inquiries (status, created_at DESC);
