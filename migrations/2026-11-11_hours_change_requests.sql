-- Providers asking for a change to their contracted hours (Kieran, Oct 2026).
-- A request holds the same thing an admin schedules in
-- "ProviderScheduleChanges" (start date, optional end date, the weekly hours
-- as JSON: [{ weekday, start_time, end_time }], only the days worked) and
-- waits for an admin. Approving it creates that scheduled change
-- (resulting_change_id); nothing reads a request's hours before then, so a
-- pending or denied one never touches the schedule. Safe to run more than once.
CREATE TABLE IF NOT EXISTS "HoursChangeRequests" (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  provider TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE,
  schedule JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  resulting_change_id BIGINT REFERENCES "ProviderScheduleChanges"(id) ON DELETE SET NULL,
  CHECK (end_date IS NULL OR end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS hours_change_requests_status ON "HoursChangeRequests" (status, requested_at);
CREATE INDEX IF NOT EXISTS hours_change_requests_username ON "HoursChangeRequests" (username, requested_at);
