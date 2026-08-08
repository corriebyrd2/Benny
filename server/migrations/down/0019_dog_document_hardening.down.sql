-- Reverse 0019. Documents keep working: download falls back to mime_type when
-- detected_mime is absent. Loses the document access trail.
DROP TABLE IF EXISTS document_events;
DROP INDEX IF EXISTS dog_documents_dog_sha_idx;
ALTER TABLE dog_documents DROP CONSTRAINT IF EXISTS dog_documents_scan_status_check;
ALTER TABLE dog_documents DROP COLUMN IF EXISTS detected_mime;
ALTER TABLE dog_documents DROP COLUMN IF EXISTS sha256;
ALTER TABLE dog_documents DROP COLUMN IF EXISTS scan_status;
ALTER TABLE dog_documents DROP COLUMN IF EXISTS scanned_at;
