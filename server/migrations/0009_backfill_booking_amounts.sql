-- Backfill amounts for multi-night bookings created before duration pricing.
-- Earlier code stored amount_cents as the service's flat per-night/per-day rate
-- regardless of length of stay, so a 7-night boarding was billed one night.
--
-- We only touch rows that are clearly still in that buggy state:
--   * a real date range (end_date > start_date),
--   * a per-night/per-day service (inferred from price_label),
--   * not already paid (don't rewrite settled amounts), and
--   * amount_cents still equal to the service's current flat rate (a single
--     unit) — so manually adjusted amounts are left alone.
-- This is idempotent: once an amount is multiplied it no longer equals the
-- flat rate, so re-running selects nothing.
UPDATE bookings b
SET amount_cents = s.price_cents * (
      CASE
        WHEN lower(s.price_label) LIKE '%night%'
          THEN GREATEST(1, (b.end_date - b.start_date))
        ELSE GREATEST(1, (b.end_date - b.start_date) + 1)
      END
    ),
    updated_at = NOW()
FROM services s
WHERE b.service_id = s.id
  AND b.start_date IS NOT NULL
  AND b.end_date IS NOT NULL
  AND b.end_date > b.start_date
  AND b.payment_status <> 'paid'
  AND (lower(s.price_label) LIKE '%night%' OR lower(s.price_label) LIKE '%day%')
  AND b.amount_cents = s.price_cents;
