// An EI child's workflow around the records PedsDesk already keeps (the "ei"
// feature; Kieran, Oct 2026). Nothing here is a new source of truth: every
// step is worked out from the chart's own data each time.
//
//   intakeChecklist  what a new EI child needs before services run smoothly,
//                    ticked from real data (EI child ID, IFSP + its PDF, a
//                    mandate, an authorization covering it, the Initial
//                    Clearance forms, a session booked per mandated service).
//                    A new EI patient gets one "EI intake" task for their case
//                    manager (Admins + Reception when none), closed once every
//                    step is done (here, and by the daily check).
//   sessionsOutside  booked EI sessions (next MANDATE_LOOKAHEAD_DAYS) with no
//                    mandate or no authorization covering their date -- what a
//                    mandate or authorization change can leave behind. Shown on
//                    the Services tab; nothing is cancelled or changed.
//   futureEiSessions the sessions after a date, for "End EI services".
const { getMergedAppointments } = require('./recurring');
const { resolveCaseManagerAssignees } = require('./utils');
const { getsPatientTasks, PATIENT_TASK_FALLBACK_ROLES } = require('./roles');
const { clinicToday } = require('./caseload');
const patientPrograms = require('./patientPrograms');

const MANDATE_LOOKAHEAD_DAYS = 90;
const DISCHARGE_LOOKAHEAD_DAYS = 365;
const INTAKE_TASK = 'ei_intake';
const DISCHARGE_TASK = 'ei_discharge';
const INITIAL_PACKAGE_RE = /^initial clearance/i;

const day = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const covers = (row, date) => (!row.start_date || day(row.start_date) <= date) && (!row.end_date || day(row.end_date) >= date);
const exists = async (db, table) => !!(await db.query(`SELECT to_regclass($1) AS t`, [`"${table}"`])).rows[0]?.t;
const disciplinesOf = (spec) => String(spec || '').toUpperCase().split(/[^A-Z]+/).filter(x => ['ST', 'OT', 'PT', 'SI'].includes(x));

// Current EI mandates (program EI, a service) per service.
async function eiMandates(db, patientId) {
  const rows = (await db.query(
    `SELECT * FROM "PatientPrograms" WHERE patient_id=$1 AND program='EI' AND service IS NOT NULL ORDER BY start_date NULLS FIRST`, [patientId]
  ).catch(() => ({ rows: [] }))).rows;
  return rows;
}
async function authorizations(db, patientId) {
  if (!(await exists(db, 'EiAuthorizations'))) return [];
  return (await db.query('SELECT * FROM "EiAuthorizations" WHERE patient_id=$1', [patientId])).rows;
}

// The patient's booked sessions in [from, to] that bill as one of their EI
// services (a provider of that discipline), with that service.
async function eiSessionsBetween(db, patient, from, to) {
  const appts = await getMergedAppointments(db, { startDate: from, endDate: to, patientName: patient.Name });
  const live = appts.filter(a => !a.deleted && !['Canceled', 'No Show', '*HOLD*'].includes(a.appointment_status));
  if (!live.length) return [];
  const provs = (await db.query('SELECT "Name", specialty FROM "Providers" WHERE "Name" = ANY($1)', [[...new Set(live.map(a => a.provider))]])).rows;
  const spec = Object.fromEntries(provs.map(p => [p.Name, disciplinesOf(p.specialty)]));
  const history = (await patientPrograms.historyFor(db, [patient.id]))[patient.id] || [];
  const eiServicesOn = (date) => history.filter(r => r.program === 'EI' && r.service && covers(r, date)).map(r => r.service);
  const everEi = new Set(history.filter(r => r.program === 'EI' && r.service).map(r => r.service));
  const out = [];
  for (const a of live) {
    const date = day(a.appointment_date);
    const disc = spec[a.provider] || [];
    const onDate = disc.filter(s => eiServicesOn(date).includes(s));
    const service = onDate[0] || disc.find(s => everEi.has(s)) || null;
    if (!service) continue;
    out.push({
      key: a.is_virtual ? `series:${a.series_id}:${date}` : `appt:${a.id}`,
      id: a.is_virtual ? null : a.id, series_id: a.series_id || a.exception_of_series_id || null, is_virtual: !!a.is_virtual,
      date, time: String(a.appointment_time).slice(0, 5), duration: Number(a.duration) || 30,
      provider: a.provider, service, has_mandate: onDate.includes(service),
    });
  }
  return out.sort((x, y) => (x.date + x.time).localeCompare(y.date + y.time));
}

// Booked EI sessions with no mandate, or (office only) no authorization,
// covering their date.
async function sessionsOutside(db, patient, { withAuth }) {
  const today = clinicToday();
  const sessions = await eiSessionsBetween(db, patient, today, addDays(today, MANDATE_LOOKAHEAD_DAYS));
  const auths = withAuth ? await authorizations(db, patient.id) : [];
  const out = [];
  for (const s of sessions) {
    const problems = [];
    if (!s.has_mandate) problems.push(`No ${s.service} mandate on this date`);
    if (withAuth && auths.some(a => a.service === s.service) && !auths.some(a => a.service === s.service && covers(a, s.date))) {
      problems.push(`No ${s.service} authorization covering this date`);
    }
    if (problems.length) out.push({ ...s, problems });
  }
  return out;
}

async function intakeChecklist(db, patient) {
  const today = clinicToday();
  const items = [];
  const push = (key, label, done, detail = null) => items.push({ key, label, done: !!done, detail });

  push('child_id', 'EI child ID on file', String(patient.ID_Number || '').trim(), patient.ID_Number ? `ID # ${patient.ID_Number}` : 'Patient form → ID #, or import from EI-Hub');

  const ifsp = (await exists(db, 'EiIfsps'))
    ? (await db.query('SELECT * FROM "EiIfsps" WHERE patient_id=$1 AND start_date <= $2 AND (end_date IS NULL OR end_date >= $2) ORDER BY start_date DESC LIMIT 1', [patient.id, today])).rows[0]
    : null;
  push('ifsp', 'Current IFSP entered', ifsp, ifsp ? `${ifsp.ifsp_type}, ${day(ifsp.start_date)} to ${day(ifsp.end_date) || 'open'}` : 'IFSP tab → New IFSP');
  push('ifsp_pdf', 'IFSP PDF attached', ifsp && ifsp.document_id, ifsp && !ifsp.document_id ? 'Edit the IFSP and attach its PDF' : null);

  const mandates = (await eiMandates(db, patient.id)).filter(r => covers(r, today));
  push('mandate', 'EI mandate for each service', mandates.length, mandates.length ? mandates.map(m => `${m.service} ${m.sessions}x${m.minutes}`).join(', ') : 'Services tab → New mandate');

  const auths = await authorizations(db, patient.id);
  const unauth = mandates.filter(m => !auths.some(a => a.service === m.service && covers(a, today)));
  push('authorization', 'Authorization covering each mandated service', mandates.length && !unauth.length,
    unauth.length ? `Missing for ${unauth.map(m => m.service).join(', ')} (Services tab, or EI-Hub import)` : null);

  if (await exists(db, 'PowerFormPackages')) {
    const pkg = (await db.query('SELECT name, template_ids FROM "PowerFormPackages"')).rows.find(p => INITIAL_PACKAGE_RE.test(p.name || ''));
    const ids = (pkg?.template_ids || []).map(Number).filter(Boolean);
    if (ids.length) {
      const done = new Set((await db.query(
        `SELECT DISTINCT template_id FROM "PowerFormRequests" WHERE patient_id=$1 AND status='completed' AND template_id = ANY($2)`, [patient.id, ids]
      )).rows.map(r => Number(r.template_id)));
      const left = ids.filter(id => !done.has(id)).length;
      push('forms', `${pkg.name} completed`, !left, left ? `${left} of ${ids.length} still to complete (Power Forms tab)` : null);
    }
  }

  const booked = new Set((await eiSessionsBetween(db, patient, today, addDays(today, MANDATE_LOOKAHEAD_DAYS))).map(s => s.service));
  const unbooked = mandates.filter(m => !booked.has(m.service));
  push('scheduled', 'A provider booked for each mandated service', mandates.length && !unbooked.length,
    unbooked.length ? `Nothing booked for ${unbooked.map(m => m.service).join(', ')} in the next ${MANDATE_LOOKAHEAD_DAYS} days` : null);

  return { items, complete: items.every(i => i.done) };
}

// Who gets the child's EI tasks: the case manager, else Admins + Reception.
async function caseManagerTargets(db, patient) {
  const staff = (await db.query('SELECT username, role FROM "Staff" WHERE archived=false')).rows;
  const office = staff.filter(s => PATIENT_TASK_FALLBACK_ROLES.includes(s.role)).map(s => s.username);
  return resolveCaseManagerAssignees(patient.case_manager_username, staff.filter(s => getsPatientTasks(s.role)), office);
}

// One open task per person and kind for the child (no duplicates).
async function openTask(db, patient, { deadlineType, title, description, dueDate }) {
  let made = 0;
  for (const username of await caseManagerTargets(db, patient)) {
    const open = (await db.query(
      `SELECT 1 FROM "Tasks" WHERE related_patient_id=$1 AND deadline_type=$2 AND assigned_to=$3 AND status <> 'done' LIMIT 1`,
      [patient.id, deadlineType, username]
    )).rows[0];
    if (open) continue;
    await db.query(
      `INSERT INTO "Tasks" (title, description, assigned_to, assigned_by, status, is_automated, related_patient_id, deadline_type, deadline_date, due_date)
       VALUES ($1, $2, $3, 'system', 'open', true, $4, $5, $6, $6)`,
      [title, description, username, patient.id, deadlineType, dueDate]
    );
    made++;
  }
  return made;
}

async function closeTasks(db, patientId, deadlineType) {
  const r = await db.query(
    `UPDATE "Tasks" SET status='done', completed_at=now() WHERE related_patient_id=$1 AND deadline_type=$2 AND status <> 'done'`,
    [patientId, deadlineType]
  ).catch(() => ({ rowCount: 0 }));
  return r.rowCount || 0;
}

// A new EI patient (POST /patients): the intake task, unless already complete.
async function onNewEiPatient(db, patient) {
  const { complete } = await intakeChecklist(db, patient);
  if (complete) return 0;
  return openTask(db, patient, {
    deadlineType: INTAKE_TASK, dueDate: addDays(clinicToday(), 14),
    title: `EI intake: ${patient.Name}`,
    description: 'Finish setting up this EI child: the checklist is on their chart (Services tab → EI intake). This task closes itself when every step is done.',
  });
}

// Closes a child's intake task once the checklist is complete. Returns
// the checklist.
async function syncIntake(db, patient) {
  const list = await intakeChecklist(db, patient);
  if (list.complete) await closeTasks(db, patient.id, INTAKE_TASK);
  return list;
}

// Daily: every child with an open intake task.
async function syncIntakeTasks(db) {
  const rows = (await db.query(
    `SELECT DISTINCT p.* FROM "Patients" p JOIN "Tasks" t ON t.related_patient_id = p.id WHERE t.deadline_type=$1 AND t.status <> 'done'`, [INTAKE_TASK]
  )).rows;
  let closed = 0;
  for (const p of rows) if ((await syncIntake(db, p)).complete) closed++;
  return closed;
}

async function futureEiSessions(db, patient, afterDate) {
  return eiSessionsBetween(db, patient, addDays(afterDate, 1), addDays(afterDate, DISCHARGE_LOOKAHEAD_DAYS));
}

module.exports = {
  MANDATE_LOOKAHEAD_DAYS, INTAKE_TASK, DISCHARGE_TASK, intakeChecklist, sessionsOutside, futureEiSessions,
  onNewEiPatient, syncIntake, syncIntakeTasks, openTask, closeTasks, exists, addDays, day,
};
