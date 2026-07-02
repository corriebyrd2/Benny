CREATE TABLE IF NOT EXISTS dog_documents (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dog_id INTEGER NOT NULL REFERENCES dogs(id) ON DELETE CASCADE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes INTEGER NOT NULL DEFAULT 0,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dog_documents_dog_id_uploaded_at_idx ON dog_documents (dog_id, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS dog_documents_customer_id_uploaded_at_idx ON dog_documents (customer_id, uploaded_at DESC);
