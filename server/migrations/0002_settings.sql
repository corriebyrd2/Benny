CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO settings (key, value) VALUES
  ('contact_address', E'123 Pawsome Lane\nDogtown, CA 90210'),
  ('contact_phone', E'(555) BENNY-PET\n(555) 236-6973'),
  ('contact_email', 'woof@bennyandthepets.com'),
  ('contact_hours', E'Mon-Sat: 7am - 7pm\nSun: 8am - 5pm'),
  ('social_facebook_url', 'https://www.facebook.com/profile.php?id=61563336148397'),
  ('social_instagram_url', ''),
  ('social_tiktok_url', '');
