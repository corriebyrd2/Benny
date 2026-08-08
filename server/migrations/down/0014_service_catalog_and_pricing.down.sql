-- Reverse 0014. Lossless: price_label is fully derivable from the structured
-- columns, which is exactly why it was removed.
ALTER TABLE services DROP CONSTRAINT IF EXISTS services_booking_mode_check;
ALTER TABLE services DROP CONSTRAINT IF EXISTS services_billing_unit_check;
ALTER TABLE services DROP CONSTRAINT IF EXISTS services_price_cents_check;
DROP INDEX IF EXISTS services_active_display_order_idx;

ALTER TABLE services ADD COLUMN IF NOT EXISTS price_label TEXT NOT NULL DEFAULT '';
UPDATE services SET price_label =
  CASE WHEN price_is_from THEN 'From ' ELSE '' END ||
  '$' || (price_cents / 100)::text || '/' || billing_unit;

ALTER TABLE services DROP COLUMN IF EXISTS booking_mode;
ALTER TABLE services DROP COLUMN IF EXISTS price_is_from;
ALTER TABLE services DROP COLUMN IF EXISTS currency;
