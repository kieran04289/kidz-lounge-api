-- "End EI services" on the chart (Kieran, Oct 2026; routes/eiWorkflow.js):
-- when and why a child's EI services ended, and who recorded it. Ending
-- also ends the child's EI mandates that day (PatientPrograms) and makes a
-- close-out task; booked sessions after it are listed for the office to
-- cancel or delete one by one -- nothing is removed automatically.
-- Additive only; safe to run again.
CREATE TABLE IF NOT EXISTS "EiDischarges" (
  id SERIAL PRIMARY KEY,
  patient_id UUID NOT NULL REFERENCES "Patients"(id) ON DELETE CASCADE,
  end_date DATE NOT NULL,
  reason TEXT NOT NULL,
  note TEXT,
  created_by TEXT,
  created_at TIMESTAMP DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ei_discharges_patient ON "EiDischarges" (patient_id, end_date DESC);
