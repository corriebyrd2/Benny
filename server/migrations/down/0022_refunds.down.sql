-- Reverse 0022. Any booking already marked refunded is folded back to 'paid',
-- because the narrower constraint cannot represent it.
DROP TABLE IF EXISTS refunds;
UPDATE bookings SET payment_status = 'paid'
  WHERE payment_status IN ('refunded', 'partially_refunded', 'failed');
ALTER TABLE bookings DROP COLUMN IF EXISTS refunded_cents;
ALTER TABLE bookings DROP CONSTRAINT IF EXISTS bookings_payment_status_check;
ALTER TABLE bookings
  ADD CONSTRAINT bookings_payment_status_check
  CHECK (payment_status IN ('unpaid', 'requested', 'paid'));
