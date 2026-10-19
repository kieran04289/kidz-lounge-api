// "Okay outside my hours" (Kieran, Oct 2026): a session outside its
// provider's contracted hours is a scheduling conflict until the provider
// (or an Admin / Developer) okays it. Retiring the Outside hours tickbox
// (Oct 15 2026) took away the only way to say a session there was on
// purpose; this replaces it, per session, with who and when.
//
// The okay is stored with the SLOT it was given for -- provider, date (or a
// series' weekday), start time and length -- and only counts while the
// session still has that slot. Moving it any way at all (the appointment
// window, drag and drop, a "this & all future" change, a rename) makes the
// slot differ, so it's flagged again without every write path having to
// remember to clear it. The frontend's src/hoursOk.js works the slot out the
// same way; change both together.
//
// A weekly series is okayed as a whole (Kieran): the okay sits on the
// "RecurringSeries" row with a weekday slot, and lib/recurring.js hands it
// to every occurrence (virtual or edited) as `series_hours_ok`. The old
// `outside_hours` column is deliberately not reused, so old data can't
// quietly clear conflicts.
const { canAdminister } = require('./roles');

const MIGRATION = 'migrations/2026-11-12_hours_ok.sql';
const NOTE_MAX = 500;

const time5 = (t) => String(t || '').slice(0, 5);
const weekdayOf = (dateStr) => new Date(`${String(dateStr).slice(0, 10)}T00:00:00`).getDay();
const appointmentSlot = (a) => `${a.provider}|${String(a.appointment_date).slice(0, 10)}|${time5(a.appointment_time)}|${Number(a.duration) || 30}`;
const seriesSlot = (s) => `${s.provider}|w${Number(s.weekday)}|${time5(s.appointment_time)}|${Number(s.duration) || 30}`;

// Only a "yes" is cached, so a warm Lambda notices once the migration runs.
let columnsSeen = false;
async function hasHoursOkColumns(db) {
  if (columnsSeen) return true;
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM information_schema.columns
     WHERE table_name IN ('Appointments', 'RecurringSeries') AND column_name = 'hours_ok_slot'`
  ).catch(() => null);
  columnsSeen = r?.rows[0]?.n === 2;
  return columnsSeen;
}

// The session's own provider, or an Admin / Developer (not Reception).
const canOkay = (currentUser, provider) => canAdminister(currentUser)
  || (!!currentUser?.providerName && currentUser.providerName === provider);

const cleanNote = (note) => (typeof note === 'string' ? note.trim().slice(0, NOTE_MAX) : '') || null;

// Sets (`ok` true) or clears the okay on one row of `table`
// ('Appointments' or 'RecurringSeries'), stamped with that row's current slot.
async function setOkay(q, table, row, { ok, note, username }) {
  const slot = table === 'RecurringSeries' ? seriesSlot(row) : appointmentSlot(row);
  const res = await q.query(
    `UPDATE "${table}" SET hours_ok_slot=$1, hours_ok_by=$2, hours_ok_at=${ok ? 'now()' : 'NULL'}, hours_ok_note=$3 WHERE id=$4 RETURNING *`,
    ok ? [slot, username, cleanNote(note), row.id] : [null, null, null, row.id]
  );
  return res.rows[0] || row;
}

// After a create or save that carried `hours_ok: { note }` (the appointment
// window's "Okay outside my hours" tickbox): okays the saved row. Ignored when
// it wasn't sent, before the migration, or when the person can't okay it --
// the window only offers it to those who can. Returns the (updated) row.
async function applyHoursOkFromBody(db, table, row, body, currentUser) {
  if (!row || !body || !body.hours_ok || typeof body.hours_ok !== 'object') return row;
  if (!(await hasHoursOkColumns(db)) || !canOkay(currentUser, row.provider)) return row;
  return okayRow(db, table, row, { ok: true, note: body.hours_ok.note, username: currentUser.username });
}

// Okays (or clears) a row the way Kieran wants it to reach: an edited
// occurrence of a weekly series takes the whole series with it, and a
// session in a fixed set of weeks (`fin`) takes its later sessions at the
// same slot. Returns the row itself, updated.
async function okayRow(q, table, row, opts) {
  const saved = await setOkay(q, table, row, opts);
  if (table !== 'Appointments') return saved;
  if (row.exception_of_series_id) {
    const series = (await q.query('SELECT * FROM "RecurringSeries" WHERE id=$1', [row.exception_of_series_id])).rows[0];
    if (series) await setOkay(q, 'RecurringSeries', series, opts);
  }
  if (row.fin) {
    const later = (await q.query(
      `SELECT * FROM "Appointments" WHERE fin=$1 AND id<>$2 AND deleted=false AND appointment_date > $3
         AND provider=$4 AND substring(appointment_time::text, 1, 5)=$5 AND duration=$6`,
      [row.fin, row.id, String(row.appointment_date).slice(0, 10), row.provider, time5(row.appointment_time), Number(row.duration) || 30]
    )).rows;
    for (const r of later) await setOkay(q, 'Appointments', r, opts);
  }
  return saved;
}

// The series' okay, as handed to its occurrences: { slot, by, at, note } or null.
const seriesOkayOf = (series) => (series && series.hours_ok_by
  ? { slot: series.hours_ok_slot, by: series.hours_ok_by, at: series.hours_ok_at, note: series.hours_ok_note }
  : null);

module.exports = {
  MIGRATION, appointmentSlot, seriesSlot, hasHoursOkColumns, canOkay, setOkay, okayRow, applyHoursOkFromBody, seriesOkayOf, weekdayOf,
};
