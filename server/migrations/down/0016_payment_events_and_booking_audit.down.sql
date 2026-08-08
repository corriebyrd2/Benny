-- Reverse 0016. Loses audit history; no live decision reads these tables.
DROP INDEX IF EXISTS bookings_payment_status_idx;
DROP INDEX IF EXISTS bookings_status_idx;
DROP INDEX IF EXISTS bookings_customer_created_idx;
DROP TABLE IF EXISTS booking_events;
DROP TABLE IF EXISTS stripe_events;
