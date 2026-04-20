-- Password reset tokens for customer accounts. We store only a SHA-256 hash of
-- the token so a database read never reveals a usable reset link.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_customer_id_idx
  ON password_reset_tokens (customer_id);
CREATE INDEX IF NOT EXISTS password_reset_tokens_expires_at_idx
  ON password_reset_tokens (expires_at);
