-- Dog document hardening.
--
-- The upload endpoint accepted ANY file type, kept the client's extension on
-- the stored filename, recorded the client-declared MIME type, and echoed that
-- MIME type back on download. An `.html` or `.svg` upload was therefore stored
-- and served under a Content-Type its uploader chose. There was also no record
-- of who downloaded a document — these are veterinary records, so "who looked
-- at this" is a question that has to be answerable.
--
-- Columns added:
--   detected_mime  the type derived from the file's own bytes; this is what is
--                  sent on download. mime_type keeps the client's claim purely
--                  for forensics.
--   sha256         content hash; detects duplicate submissions and makes an
--                  after-the-fact integrity check possible.
--   scan_status    malware scanning state. 'not_scanned' is the honest default
--                  until a scanner is wired up (see server/malwareScan.js);
--                  'quarantined' files are never served.
--
-- Rollback:
--   DROP TABLE document_events;
--   ALTER TABLE dog_documents
--     DROP COLUMN detected_mime, DROP COLUMN sha256,
--     DROP COLUMN scan_status, DROP COLUMN scanned_at, DROP COLUMN deleted_at;
-- Existing rows keep working: download falls back to mime_type when
-- detected_mime is empty.

ALTER TABLE dog_documents ADD COLUMN IF NOT EXISTS detected_mime TEXT NOT NULL DEFAULT '';
ALTER TABLE dog_documents ADD COLUMN IF NOT EXISTS sha256 TEXT NOT NULL DEFAULT '';
ALTER TABLE dog_documents ADD COLUMN IF NOT EXISTS scan_status TEXT NOT NULL DEFAULT 'not_scanned';
ALTER TABLE dog_documents ADD COLUMN IF NOT EXISTS scanned_at TIMESTAMPTZ;

ALTER TABLE dog_documents
  ADD CONSTRAINT dog_documents_scan_status_check
  CHECK (scan_status IN ('not_scanned', 'pending', 'clean', 'quarantined', 'error'));

-- Duplicate-submit protection: the same bytes cannot be attached to the same
-- dog twice. A partial index so historical rows with an empty hash are exempt.
CREATE UNIQUE INDEX IF NOT EXISTS dog_documents_dog_sha_idx
  ON dog_documents (dog_id, sha256) WHERE sha256 <> '';

-- Append-only access log for upload, download and deletion.
CREATE TABLE IF NOT EXISTS document_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  document_id INTEGER,
  dog_id      INTEGER,
  event       TEXT NOT NULL,
  actor_type  TEXT NOT NULL DEFAULT 'customer',
  actor_id    TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS document_events_document_idx
  ON document_events (document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS document_events_actor_idx
  ON document_events (actor_type, actor_id, created_at DESC);
