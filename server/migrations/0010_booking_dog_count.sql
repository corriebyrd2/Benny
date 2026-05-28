-- Multi-dog bookings: rates that scale per-night/per-day need to multiply by
-- how many dogs are on the stay. Backfilling 1 keeps every existing booking's
-- computed amount stable.
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS dog_count INTEGER NOT NULL DEFAULT 1;
