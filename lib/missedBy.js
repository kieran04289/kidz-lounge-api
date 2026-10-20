// Who an EI session was missed because of (Kieran, Oct 2026;
// migrations/2026-11-13_missed_by.sql): 'family' | 'provider' | null.
// The appointment window asks it when an EI session is Canceled (where the
// "mandates" feature is on); a No Show is always the family's.
//   provider  bills PA (lib/billingMarks.js), so the mandates view treats it
//             like the provider's time off (no family make-up rule), it needs
//             no session note (like PA), and Compliance's Provider absences
//             asks for the family / SC to be told 5 business days ahead. It
//             clears the child-absence reason, which is about the child.
//   family    as before: A, with the absence reason.
// Kept only while the session is Canceled / No Show (and not a holiday /
// emergency closure); any other status clears it. `family_notified: true`
// with a provider cancellation records that notice (EiAbsenceNotices), the
// same record Compliance's "Told family & SC" makes.
const { clinicToday } = require('./caseload');

const CHILD_ABSENT = ['Canceled', 'No Show'];

function normalizeMissedBy(row, requested) {
  if (!CHILD_ABSENT.includes(row.appointment_status)) return null;
  if (row.cancel_reason === 'holiday' || row.cancel_reason === 'emergency') return null;
  if (row.appointment_status === 'No Show') return requested ? 'family' : null;
  return ['family', 'provider'].includes(requested) ? requested : null;
}

// Positive-only cache: works before the migration (it just isn't saved).
let columnSeen = false;
async function hasMissedByColumn(db) {
  if (columnSeen) return true;
  const r = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'Appointments' AND column_name = 'missed_by'`);
  if (r.rows.length) columnSeen = true;
  return columnSeen;
}

// A provider cancellation (Canceled, missed_by provider): what billing and
// the session-note list treat as the provider being out.
const providerCancelled = (a) => a.appointment_status === 'Canceled' && a.missed_by === 'provider';

// After the row is written and its cancel / absence reasons are settled.
async function applyMissedBy(db, row, body, user) {
  if (!row || !(await hasMissedByColumn(db))) return row;
  const requested = body.missed_by !== undefined ? body.missed_by : row.missed_by;
  const value = normalizeMissedBy(row, requested);
  let saved = row;
  if ((row.missed_by ?? null) !== value || (value === 'provider' && row.absence_reason)) {
    const clearsReason = value === 'provider' && row.absence_reason !== undefined;
    saved = (await db.query(
      `UPDATE "Appointments" SET missed_by=$1${clearsReason ? ', absence_reason=NULL' : ''} WHERE id=$2 RETURNING *`,
      [value, row.id]
    )).rows[0] || row;
  }
  if (value === 'provider' && body.family_notified === true && user) {
    const t = (await db.query(`SELECT to_regclass('"EiAbsenceNotices"') IS NOT NULL AS ok`)).rows[0];
    const patient = t?.ok ? (await db.query('SELECT id FROM "Patients" WHERE "Name"=$1', [saved.patient_name])).rows[0] : null;
    if (patient) {
      await db.query(
        `INSERT INTO "EiAbsenceNotices" (provider, absence_date, patient_id, notified_on, notified_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (provider, absence_date, patient_id) DO NOTHING`,
        [saved.provider, String(saved.appointment_date).slice(0, 10), patient.id, clinicToday(), user.username]
      );
    }
  }
  return saved;
}

module.exports = { normalizeMissedBy, applyMissedBy, providerCancelled, hasMissedByColumn };
