ALTER TABLE photos ADD COLUMN IF NOT EXISTS section TEXT NOT NULL DEFAULT 'gallery';
CREATE INDEX IF NOT EXISTS photos_section_idx ON photos (section);
