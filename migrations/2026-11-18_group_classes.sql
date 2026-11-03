-- Group classes (Kieran, Nov 2026; PedsDesk first, the "groupclasses"
-- feature). A class is one provider with several children at the same time.
-- Each child still has their own ordinary appointment (or weekly series),
-- so billing, session notes, make-ups and the chart work as for any other
-- session; group_class_id ties them together so the schedule shows one card.
-- routes/groupClasses.js. Safe to run more than once.

CREATE TABLE IF NOT EXISTS "GroupClasses" (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE "Appointments"    ADD COLUMN IF NOT EXISTS group_class_id BIGINT REFERENCES "GroupClasses"(id) ON DELETE SET NULL;
ALTER TABLE "RecurringSeries" ADD COLUMN IF NOT EXISTS group_class_id BIGINT REFERENCES "GroupClasses"(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS appointments_group_class ON "Appointments" (group_class_id) WHERE group_class_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS recurring_series_group_class ON "RecurringSeries" (group_class_id) WHERE group_class_id IS NOT NULL;
