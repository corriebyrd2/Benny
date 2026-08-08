-- Reverse 0023. Verification state is lost; nothing gates on it by default.
DROP TABLE IF EXISTS email_verification_tokens;
ALTER TABLE customers DROP COLUMN IF EXISTS email_verified_at;
