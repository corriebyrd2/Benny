-- Normalize services.active and services.is_featured to BOOLEAN across legacy
-- schemas. The older 001_initial.sql created these columns as INTEGER (0/1)
-- while 0001_init.sql creates them as BOOLEAN. Whichever migration created the
-- table first wins, so real deployments diverge: application code compares with
-- a boolean literal (WHERE active = TRUE) and returns these columns to the
-- frontend, so an INTEGER `active` makes GET /api/services and the dashboard
-- stats query fail with "operator does not exist: boolean = integer" on any
-- deployment built from the integer variant (e.g. every fresh database, where
-- 0001_init.sql sorts first). Force BOOLEAN here so the type is consistent.
--
-- Mirrors the approach in 0004_photo_show_on_homepage_bool.sql. Idempotent: the
-- guards only fire while the column is still INTEGER, so re-running is a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'services'
      AND column_name = 'active'
      AND data_type = 'integer'
  ) THEN
    ALTER TABLE services ALTER COLUMN active DROP DEFAULT;
    ALTER TABLE services ALTER COLUMN active TYPE BOOLEAN USING (active <> 0);
    ALTER TABLE services ALTER COLUMN active SET DEFAULT TRUE;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'services'
      AND column_name = 'is_featured'
      AND data_type = 'integer'
  ) THEN
    ALTER TABLE services ALTER COLUMN is_featured DROP DEFAULT;
    ALTER TABLE services ALTER COLUMN is_featured TYPE BOOLEAN USING (is_featured <> 0);
    ALTER TABLE services ALTER COLUMN is_featured SET DEFAULT FALSE;
  END IF;
END $$;
