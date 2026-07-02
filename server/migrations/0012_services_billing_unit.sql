-- Bill from an explicit unit instead of parsing the marketing price_label.
-- computeAmountCents used to infer per-night / per-day / flat by searching for
-- the words "night"/"day" in price_label, so renaming a service's label (e.g.
-- "From $45/night" -> "$45 per overnight stay") could silently change how much
-- every booking for that service costs, and an unrelated label like "Same-day
-- grooming" could flip a flat service into per-day billing.
--
-- Add a first-class billing_unit and backfill it from the current label so
-- existing pricing is unchanged at migration time; from here the label is
-- purely cosmetic and only billing_unit drives the amount.
ALTER TABLE services
  ADD COLUMN IF NOT EXISTS billing_unit TEXT NOT NULL DEFAULT 'session';

UPDATE services
SET billing_unit = CASE
  WHEN lower(price_label) LIKE '%night%' THEN 'night'
  WHEN lower(price_label) LIKE '%day%' THEN 'day'
  ELSE 'session'
END
WHERE billing_unit = 'session';
