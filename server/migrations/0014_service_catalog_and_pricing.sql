-- Service catalog + pricing integrity.
--
-- Two production defects motivate this migration:
--
-- 1. PRICING. `services.price_label` was free text maintained by hand next to
--    `price_cents`. The two drifted: Doggy Daycare shipped with
--    price_cents = 3000 while the label read "From $35/day" and the homepage
--    card said "$30/day". A label that can disagree with the amount that is
--    actually charged is a commercial defect, not a cosmetic one, so the column
--    is removed entirely. Labels are now derived at read time from
--    (price_cents, billing_unit, price_is_from) by server/pricing.js.
--
--    Rollback is lossless: the column is fully derivable. To reverse:
--      ALTER TABLE services ADD COLUMN price_label TEXT NOT NULL DEFAULT '';
--      UPDATE services SET price_label =
--        CASE WHEN price_is_from THEN 'From ' ELSE '' END ||
--        '$' || (price_cents / 100)::text || '/' || billing_unit;
--
-- 2. CATALOG. `active` conflated two independent questions: "do we show this
--    publicly?" and "can a customer book it right now?". The homepage
--    advertised four services (boarding, daycare, grooming, training) as
--    immediately bookable while only two existed in the bookable catalog.
--    `booking_mode` separates them:
--      bookable    - shown publicly and selectable in the booking form
--      inquiry     - shown publicly, CTA routes to a contact/inquiry flow
--      unavailable - shown publicly with an explicit "temporarily unavailable"
--                    status, never selectable
--    `active = FALSE` remains the "hidden from public marketing" case.

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS booking_mode TEXT NOT NULL DEFAULT 'bookable';

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS price_is_from BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE services
  ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'usd';

-- Preserve the existing "From ..." semantics for rows created before this
-- column existed, while price_label is still readable.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'services' AND column_name = 'price_label'
  ) THEN
    EXECUTE $sql$
      UPDATE services
      SET price_is_from = (lower(price_label) LIKE 'from %')
    $sql$;
  END IF;
END $$;

ALTER TABLE services
  ADD CONSTRAINT services_booking_mode_check
  CHECK (booking_mode IN ('bookable', 'inquiry', 'unavailable'));

ALTER TABLE services
  ADD CONSTRAINT services_billing_unit_check
  CHECK (billing_unit IN ('night', 'day', 'session'));

ALTER TABLE services
  ADD CONSTRAINT services_price_cents_check
  CHECK (price_cents >= 0);

-- Drop the hand-maintained label. See the rollback recipe above.
ALTER TABLE services DROP COLUMN IF EXISTS price_label;

-- Public listing reads active + display_order on every homepage render.
CREATE INDEX IF NOT EXISTS services_active_display_order_idx
  ON services (active, display_order);
