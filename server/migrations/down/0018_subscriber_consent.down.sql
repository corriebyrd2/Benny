-- Reverse 0018. DESTROYS CONSENT AND OPT-OUT RECORDS — export first:
--   \copy (SELECT email, consent_at, consent_source, unsubscribed_at FROM subscribers) TO 'consent.csv' CSV HEADER
DROP INDEX IF EXISTS subscribers_active_idx;
ALTER TABLE subscribers DROP COLUMN IF EXISTS consent_at;
ALTER TABLE subscribers DROP COLUMN IF EXISTS consent_source;
ALTER TABLE subscribers DROP COLUMN IF EXISTS unsubscribed_at;
ALTER TABLE subscribers DROP COLUMN IF EXISTS unsubscribe_reason;
