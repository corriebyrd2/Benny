-- Reverse 0015: nothing to restore.
--
-- The migration deleted fabricated placeholder contact details. Re-inserting
-- "123 Pawsome Lane" and "(555) BENNY-PET" would recreate the defect, so this
-- reversal is deliberately a no-op. The migration is safe to re-apply.
SELECT 1;
