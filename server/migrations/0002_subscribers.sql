CREATE TABLE subscribers (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'homepage',
  sendgrid_status TEXT NOT NULL DEFAULT 'pending',
  sendgrid_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX subscribers_email_lower_idx ON subscribers (LOWER(email));
