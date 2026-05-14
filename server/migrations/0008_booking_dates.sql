ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS start_date DATE,
  ADD COLUMN IF NOT EXISTS end_date DATE;

CREATE INDEX IF NOT EXISTS bookings_start_date_end_date_idx ON bookings (start_date, end_date);
