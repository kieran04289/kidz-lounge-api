// Follow-ups that come from things happening to an EI child's sessions and
// authorizations (the "ei" feature, PedsDesk only; Kieran, Oct 2026). Each
// is a task tied to its cause, made when the cause appears and closed when
// it's dealt with -- no list for staff to remember.
//
//   Make-up to schedule   an EI session the family cancelled / no-showed
//                         (not a family vacation, not a closure) or the
//                         provider cancelled: the session's provider gets
//                         "Schedule a make-up by <date>" (MAKEUP_DAYS after,
//                         as lib/mandates.js). Closed once a make-up is booked
//                         (makeup_for), or the session isn't missed any more.
//                         Key: deadline_type ei_makeup_<appointment id>.
//   Authorization ending  an EI authorization ending within
//                         AUTH_ENDING_LEAD_DAYS while sessions of its service
//                         are booked after it: the case manager (Admins +
//                         Reception when none). Closed once an authorization
//                         covers those sessions, or none are booked after it.
//                         Key: deadline_type ei_auth_ending_<authorization #>.
// Neither cancels, books or changes anything.
const { featureOn } = require('./features');
const { clinicToday } = require('./caseload');
const patientPrograms = require('./patientPrograms');
const life = require('./eiLifecycle');

const MAKEUP_DAYS = 14;            // NYS make-up window (lib/mandates.js)
const AUTH_ENDING_LEAD_DAYS = 30;  // Kieran, Oct 2026
const MAKEUP_PREFIX = 'ei_makeup_';
const AUTH_PREFIX = 'ei_auth_ending_';
const MISSED = ['Canceled', 'No Show'];

const day = life.day;
const addDays = life.addDays;
const disciplinesOf = (spec) => String(spec || '').toUpperCase().split(/[^A-Z]+/).filter(x => ['ST', 'OT', 'PT', 'SI'].includes(x));
const covers = (row, date) => (!row.start_date || day(row.start_date) <= date) && (!row.end_date || day(row.end_date) >= date);

// The EI service a (real) appointment bills under on its date, or null.
async function eiServiceOf(db, appt, patient) {
  const prov = (await db.query('SELECT specialty FROM "Providers" WHERE "Name"=$1', [appt.provider])).rows[0];
  const history = (await patientPrograms.historyFor(db, [patient.id]))[patient.id] || [];
  const date = day(appt.appointment_date);
  return disciplinesOf(prov?.specialty).find(s => history.some(r => r.program === 'EI' && r.service === s && covers(r, date))) || null;
}

// Does this missed session owe a make-up the provider should schedule?
const owesMakeup = (a) => MISSED.includes(a.appointment_status) && !a.is_makeup
  && a.absence_reason !== 'vacation' && a.cancel_reason !== 'holiday' && a.cancel_reason !== 'emergency';

async function hasLiveMakeup(db, apptId) {
  const r = await db.query(
    `SELECT 1 FROM "Appointments" WHERE makeup_for=$1 AND deleted=false AND appointment_status <> ALL($2) LIMIT 1`, [apptId, MISSED]
  ).catch(() => ({ rows: [] }));
  return r.rows.length > 0;
}

const closeKey = (db, key) => db.query(
  `UPDATE "Tasks" SET status='done', completed_at=now() WHERE deadline_type=$1 AND status <> 'done'`, [key]
).catch(() => ({ rowCount: 0 }));

// After an appointment is saved (or a make-up booked for it): opens or
// closes its make-up task. Never throws to the caller's save.
async function syncMakeupTask(db, appt) {
  if (!featureOn('ei') || !appt || !appt.id || appt.is_virtual) return;
  const key = `${MAKEUP_PREFIX}${appt.id}`;
  const patient = (await db.query('SELECT id, "Name" FROM "Patients" WHERE "Name"=$1', [appt.patient_name])).rows[0];
  const service = patient ? await eiServiceOf(db, appt, patient) : null;
  if (!patient || !service || appt.deleted || !owesMakeup(appt) || await hasLiveMakeup(db, appt.id)) { await closeKey(db, key); return; }
  const staff = (await db.query('SELECT username FROM "Staff" WHERE provider_name=$1 AND archived=false', [appt.provider])).rows;
  const date = day(appt.appointment_date);
  const by = addDays(date, MAKEUP_DAYS);
  for (const s of staff) {
    const open = (await db.query(`SELECT 1 FROM "Tasks" WHERE deadline_type=$1 AND assigned_to=$2 AND status <> 'done' LIMIT 1`, [key, s.username])).rows[0];
    if (open) continue;
    await db.query(
      `INSERT INTO "Tasks" (title, description, assigned_to, assigned_by, status, is_automated, related_patient_id, deadline_type, deadline_date, due_date)
       VALUES ($1, $2, $3, 'system', 'open', true, $4, $5, $6, $7)`,
      [`Schedule a make-up: ${patient.Name}`,
        `The ${service} session on ${date} was ${appt.missed_by === 'provider' ? 'cancelled by the provider' : appt.appointment_status === 'No Show' ? 'a no-show' : 'cancelled'}. Book a make-up by ${by} from that appointment's "Schedule make up". This closes when one is booked.`,
        s.username, patient.id, key, date, by]
    );
  }
}

// Daily: closes make-up tasks that are dealt with, and opens ones for EI
// sessions missed in the last MAKEUP_DAYS that somehow have none.
async function syncMakeupTasks(db) {
  const open = (await db.query(`SELECT DISTINCT deadline_type FROM "Tasks" WHERE deadline_type LIKE $1 AND status <> 'done'`, [`${MAKEUP_PREFIX}%`])).rows;
  const ids = new Set(open.map(r => r.deadline_type.slice(MAKEUP_PREFIX.length)));
  const recent = (await db.query(
    `SELECT id::text AS id FROM "Appointments" WHERE deleted=false AND appointment_status = ANY($1) AND appointment_date BETWEEN $2 AND $3`,
    [MISSED, addDays(clinicToday(), -MAKEUP_DAYS), clinicToday()]
  )).rows;
  recent.forEach(r => ids.add(r.id));
  for (const id of ids) {
    const appt = (await db.query('SELECT * FROM "Appointments" WHERE id::text=$1', [id])).rows[0];
    if (appt) await syncMakeupTask(db, appt);
    else await closeKey(db, `${MAKEUP_PREFIX}${id}`);
  }
}

// Daily: authorizations ending soon with sessions booked after them.
async function syncAuthEndingTasks(db) {
  if (!(await life.exists(db, 'EiAuthorizations'))) return 0;
  const today = clinicToday();
  const auths = (await db.query('SELECT * FROM "EiAuthorizations" WHERE patient_id IS NOT NULL AND end_date IS NOT NULL AND end_date >= $1', [today])).rows;
  const byPatient = {};
  auths.forEach(a => { (byPatient[a.patient_id] = byPatient[a.patient_id] || []).push(a); });
  let made = 0;
  for (const [patientId, list] of Object.entries(byPatient)) {
    const patient = (await db.query('SELECT * FROM "Patients" WHERE id=$1', [patientId])).rows[0];
    if (!patient) continue;
    for (const a of list) {
      const key = `${AUTH_PREFIX}${a.authorization_number}`;
      const end = day(a.end_date);
      const ending = end <= addDays(today, AUTH_ENDING_LEAD_DAYS);
      const after = ending ? (await life.futureEiSessions(db, patient, end)).filter(s => s.service === a.service) : [];
      const uncovered = after.filter(s => !list.some(o => o !== a && o.service === a.service && covers(o, s.date)));
      if (!uncovered.length) { await closeKey(db, key); continue; }
      made += await life.openTask(db, patient, {
        deadlineType: key, dueDate: end,
        title: `EI authorization ending: ${patient.Name} (${a.service})`,
        description: `Authorization ${a.authorization_number} (${a.service}) ends ${end}, and ${uncovered.length} session${uncovered.length === 1 ? ' is' : 's are'} booked after it (first ${uncovered[0].date}). Get the new authorization from the service coordinator and import or enter it. This closes once one covers those sessions.`,
      });
    }
  }
  return made;
}

// Does a mandate / authorization cover an EI session on `date` with
// `provider`? For the appointment window's warning. `withAuth` = office.
async function coverageFor(db, { patientName, provider, date, withAuth }) {
  const patient = (await db.query('SELECT id, "Name" FROM "Patients" WHERE "Name"=$1', [patientName])).rows[0];
  if (!patient) return { ei: false };
  const prov = (await db.query('SELECT specialty FROM "Providers" WHERE "Name"=$1', [provider])).rows[0];
  const history = (await patientPrograms.historyFor(db, [patient.id]))[patient.id] || [];
  const disc = disciplinesOf(prov?.specialty);
  const everEi = disc.filter(s => history.some(r => r.program === 'EI' && r.service === s));
  if (!everEi.length) return { ei: false };
  const withMandate = everEi.find(s => history.some(r => r.program === 'EI' && r.service === s && covers(r, date)));
  const service = withMandate || everEi[0];
  const out = { ei: true, service, mandate: !!withMandate };
  if (withAuth && (await life.exists(db, 'EiAuthorizations'))) {
    const auths = (await db.query('SELECT * FROM "EiAuthorizations" WHERE patient_id=$1 AND service=$2', [patient.id, service])).rows;
    out.authorization = auths.length ? auths.some(a => covers(a, date)) : null; // null = none on file yet
  }
  return out;
}

module.exports = { syncMakeupTask, syncMakeupTasks, syncAuthEndingTasks, coverageFor, MAKEUP_PREFIX, AUTH_PREFIX, AUTH_ENDING_LEAD_DAYS, MAKEUP_DAYS };
