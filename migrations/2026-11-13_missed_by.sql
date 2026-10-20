-- Who an EI session was missed because of (Kieran, Oct 2026; lib/missedBy.js):
-- 'family' (the child: No Show, or a family cancellation) or 'provider' (the
-- provider cancelled). A provider cancellation bills PA, like a provider's
-- time off, and is never a family absence. NULL = not asked (older rows, other
-- clinics), which reads as before (A). Additive only; safe to run again.
ALTER TABLE "Appointments" ADD COLUMN IF NOT EXISTS missed_by TEXT;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointments_missed_by_check') THEN
    ALTER TABLE "Appointments" ADD CONSTRAINT appointments_missed_by_check CHECK (missed_by IS NULL OR missed_by IN ('family', 'provider'));
  END IF;
END $$;
