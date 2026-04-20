-- Normalize photos.show_on_homepage to BOOLEAN across legacy schemas.
-- Earlier bootstraps created it as INTEGER (001_initial.sql) while 0001_init.sql
-- creates it as BOOLEAN. The route code and homepage query only work when the
-- type is consistent, so force BOOLEAN here.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'photos'
      AND column_name = 'show_on_homepage'
      AND data_type = 'integer'
  ) THEN
    ALTER TABLE photos ALTER COLUMN show_on_homepage DROP DEFAULT;
    ALTER TABLE photos ALTER COLUMN show_on_homepage TYPE BOOLEAN USING (show_on_homepage <> 0);
    ALTER TABLE photos ALTER COLUMN show_on_homepage SET DEFAULT TRUE;
  END IF;
END $$;
