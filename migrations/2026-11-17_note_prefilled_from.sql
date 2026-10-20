-- PedsDesk EI session notes (Kieran, Oct 2026): the date of the earlier
-- note a new note was started from (GET /session-notes/note `previous`),
-- so the "Started from your note of ..." line stays until the note is
-- signed instead of going away at the first save. Additive only; NULL =
-- started blank (or saved before this column).
ALTER TABLE "EiSessionNotes" ADD COLUMN IF NOT EXISTS prefilled_from DATE;
