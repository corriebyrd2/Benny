-- Email verification, and the schema behind anti-enumeration on registration.
--
-- Registration answered 409 "An account with this email already exists", which
-- is a user-enumeration oracle: anyone could test an address list against the
-- site and learn who is a customer. Registration now answers identically
-- whether or not the address is already registered, and issues no session
-- either way — so there is nothing in the response to tell the two apart.
--
-- Making that safe needs somewhere to record whether an address has actually
-- been proven to belong to the person using it, hence verification.
--
-- Deliberately NOT gated by default: sign-in does not require a verified email
-- unless REQUIRE_EMAIL_VERIFICATION=1. Transactional email is an unverified
-- dependency in this deployment, and gating sign-in on it would turn a
-- misconfigured mail provider into "nobody can register" — a worse failure than
-- the one being fixed. The switch is there for the owner to flip once sending
-- is confirmed working.
--
-- Rollback:
--   DROP TABLE email_verification_tokens;
--   ALTER TABLE customers DROP COLUMN email_verified_at;

ALTER TABLE customers ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS email_verification_customer_idx
  ON email_verification_tokens (customer_id, used_at);

-- Accounts that existed before verification was introduced are marked verified.
-- Retroactively treating them as unverified would lock out real customers to
-- fix a problem they did not have.
UPDATE customers SET email_verified_at = created_at WHERE email_verified_at IS NULL;
