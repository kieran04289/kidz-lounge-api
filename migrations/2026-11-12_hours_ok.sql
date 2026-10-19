-- "Okay outside my hours" (Kieran, Oct 2026; lib/hoursOk.js): a session
-- outside its provider's contracted hours stops being a conflict once the
-- provider or an Admin okays it. Stored with the slot it was okayed for
-- (provider|date|time|length, or provider|w<weekday>|time|length on a weekly
-- series), so moving the session makes it count as not okayed again.
-- Additive only; safe to run more than once.
ALTER TABLE "Appointments" ADD COLUMN IF NOT EXISTS hours_ok_slot TEXT;
ALTER TABLE "Appointments" ADD COLUMN IF NOT EXISTS hours_ok_by TEXT;
ALTER TABLE "Appointments" ADD COLUMN IF NOT EXISTS hours_ok_at TIMESTAMPTZ;
ALTER TABLE "Appointments" ADD COLUMN IF NOT EXISTS hours_ok_note TEXT;
ALTER TABLE "RecurringSeries" ADD COLUMN IF NOT EXISTS hours_ok_slot TEXT;
ALTER TABLE "RecurringSeries" ADD COLUMN IF NOT EXISTS hours_ok_by TEXT;
ALTER TABLE "RecurringSeries" ADD COLUMN IF NOT EXISTS hours_ok_at TIMESTAMPTZ;
ALTER TABLE "RecurringSeries" ADD COLUMN IF NOT EXISTS hours_ok_note TEXT;
