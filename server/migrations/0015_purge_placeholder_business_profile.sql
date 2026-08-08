-- Remove fabricated business-identity data that shipped as seed defaults.
--
-- "123 Pawsome Lane / Dogtown, CA 90210", "(555) BENNY-PET" and
-- "woof@bennyandthepets.com" were inserted on first boot and rendered on the
-- public homepage. A visitor cannot tell seeded placeholder text from a real
-- address, and search engines will index it as this business's NAP data, which
-- actively damages local discoverability. There is no correct default for these
-- fields, so they are deleted rather than replaced: server/businessProfile.js
-- treats an absent value as "hide the component and block launch".
--
-- Rollback: re-running the old seed would reinstate placeholders, which is not
-- a state worth restoring. To reverse, insert the owner's real values.

DELETE FROM site_settings
WHERE key IN (
  'contact_address_line1',
  'contact_address_line2',
  'contact_phone_display',
  'contact_phone_secondary',
  'contact_email'
)
AND (
  lower(btrim(value)) IN (
    '123 pawsome lane',
    'dogtown, ca 90210',
    '(555) benny-pet',
    '(555) 236-6973',
    'woof@bennyandthepets.com'
  )
  OR btrim(value) = ''
  -- Any US directory-reserved 555 number is fictional by definition.
  OR btrim(value) ~ '^\(?555\)?[\s.-]'
);

-- The legacy `settings` table (superseded by site_settings) carried the same
-- placeholders. Clear them too so nothing can read them back.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'settings'
  ) THEN
    EXECUTE $sql$
      DELETE FROM settings
      WHERE key IN ('contact_address', 'contact_phone', 'contact_email')
        AND (
          btrim(value) ~ '555'
          OR lower(value) LIKE '%pawsome lane%'
          OR lower(value) LIKE '%dogtown%'
          OR lower(btrim(value)) = 'woof@bennyandthepets.com'
        )
    $sql$;
  END IF;
END $$;
