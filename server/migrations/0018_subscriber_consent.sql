-- Marketing consent and unsubscribe.
--
-- The newsletter form previously stated "By subscribing you agree to receive
-- marketing emails" underneath the field, with no separate consent action and
-- no way to record that consent was given, when, or from where. There was also
-- no unsubscribe path at all — only a sentence promising one.
--
-- Rollback: the added columns are nullable/defaulted, so
--   ALTER TABLE subscribers DROP COLUMN consent_at, DROP COLUMN consent_source,
--     DROP COLUMN unsubscribed_at, DROP COLUMN unsubscribe_reason;
-- restores the previous shape without touching existing rows.

ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS consent_at TIMESTAMPTZ;
ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS consent_source TEXT NOT NULL DEFAULT '';
ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS unsubscribed_at TIMESTAMPTZ;
ALTER TABLE subscribers ADD COLUMN IF NOT EXISTS unsubscribe_reason TEXT NOT NULL DEFAULT '';

-- Rows that predate consent tracking have an unknown consent origin. They are
-- marked explicitly rather than back-dated to a timestamp we cannot evidence.
UPDATE subscribers
SET consent_source = 'pre-consent-tracking'
WHERE consent_source = '' AND consent_at IS NULL;

-- Campaign sends must exclude unsubscribed addresses cheaply.
CREATE INDEX IF NOT EXISTS subscribers_active_idx
  ON subscribers (unsubscribed_at) WHERE unsubscribed_at IS NULL;
