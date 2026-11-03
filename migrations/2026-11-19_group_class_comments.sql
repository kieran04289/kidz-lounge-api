-- One comment thread per group class sitting (Kieran, Nov 2026): shared by
-- everyone in the class; a weekly class has one per week (its date).
-- routes/groupClasses.js. Same comment format as Appointments.comments.
-- Safe to run more than once.

CREATE TABLE IF NOT EXISTS "GroupClassComments" (
  id BIGSERIAL PRIMARY KEY,
  group_class_id BIGINT NOT NULL REFERENCES "GroupClasses"(id) ON DELETE CASCADE,
  class_date DATE NOT NULL,
  comments TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_class_id, class_date)
);
