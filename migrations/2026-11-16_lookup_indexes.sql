-- Indexes for the lookups the busiest pages make (Oct 2026 performance pass).
-- Until now these were full-table reads every time:
--   "Patients"."Name"            every chart, note, billing and workflow lookup
--                                 finds a child by name
--   "Appointments".patient_name  the chart's appointment list, the caseload
--                                 check, the EI workflow and make-up checks
--   "RecurringSeries" by patient / provider   the same, for weekly series
--   open "Tasks" by deadline_type  the automatic tasks' "is one already open?"
--                                 checks (EI intake, make-ups, authorizations)
-- Additive only; safe to run more than once. They build in moments at a
-- clinic's size.
CREATE INDEX IF NOT EXISTS patients_name_idx ON "Patients" ("Name");
CREATE INDEX IF NOT EXISTS appointments_patient_date_idx ON "Appointments" (patient_name, appointment_date);
CREATE INDEX IF NOT EXISTS recurring_series_patient_idx ON "RecurringSeries" (patient_name);
CREATE INDEX IF NOT EXISTS recurring_series_provider_idx ON "RecurringSeries" (provider);
CREATE INDEX IF NOT EXISTS tasks_open_deadline_type_idx ON "Tasks" (deadline_type text_pattern_ops) WHERE status <> 'done';
