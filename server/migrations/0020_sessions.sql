-- Server-side sessions.
--
-- Authentication was a stateless JWT held in localStorage: readable by any
-- script on the page, valid for its full lifetime (7 days for customers, 24
-- hours for admins) no matter what happened afterwards, and impossible to
-- revoke. Logging out cleared the browser's copy and nothing else; a password
-- reset did not invalidate tokens already issued, so an attacker holding one
-- kept access through the very action taken to lock them out.
--
-- A session is now a random 256-bit token stored ONLY as a SHA-256 hash here
-- and delivered to browsers in an HttpOnly cookie. That gives three properties
-- the JWT could not:
--
--   * Revocation. Setting revoked_at kills the session immediately, everywhere.
--   * Idle expiry. last_seen_at moves forward on use, so an abandoned session
--     dies even though its absolute expiry is further out.
--   * Auditability. Who signed in, from what user agent, and when it ended.
--
-- The raw token is never stored, so a database disclosure does not yield usable
-- sessions.
--
-- Rollback: DROP TABLE sessions. Everyone is signed out; nothing else breaks.

CREATE TABLE IF NOT EXISTS sessions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  subject_type  TEXT NOT NULL,
  subject_id    INTEGER NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  revoked_reason TEXT NOT NULL DEFAULT '',
  user_agent    TEXT NOT NULL DEFAULT '',
  ip_hash       TEXT NOT NULL DEFAULT ''
);

ALTER TABLE sessions
  ADD CONSTRAINT sessions_subject_type_check
  CHECK (subject_type IN ('customer', 'admin'));

-- Every authenticated request looks a session up by hash.
CREATE INDEX IF NOT EXISTS sessions_lookup_idx
  ON sessions (token_hash) WHERE revoked_at IS NULL;

-- Revoking every session for one person (password reset, account deletion)
-- and listing a person's active sessions.
CREATE INDEX IF NOT EXISTS sessions_subject_idx
  ON sessions (subject_type, subject_id, revoked_at);

-- Sweeping expired rows.
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);
