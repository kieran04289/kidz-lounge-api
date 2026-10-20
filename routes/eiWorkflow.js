// The EI child's workflow on the chart (the "ei" feature, PedsDesk only;
// Kieran, Oct 2026; lib/eiLifecycle.js):
//
//   GET  /patients/:id/ei-workflow   { intake, outside, discharge }
//        the office, or a provider with the child on their caseload
//        (providers get no authorization checks: they never see auth #s)
//   POST /patients/:id/ei-end        { end_date, reason, note?, off_program? }  (canManage)
//        "End EI services": records it (EiDischarges), ends the child's EI
//        mandates on end_date, makes a close-out task for the case manager,
//        and returns the booked EI sessions after end_date for the office to
//        cancel or delete one by one. Nothing else is changed automatically.
const { json } = require('../lib/http');
const { canManage } = require('../lib/roles');
const { featureOn } = require('../lib/features');
const { currentCaseloads, clinicToday } = require('../lib/caseload');
const programs = require('../lib/patientPrograms');
const life = require('../lib/eiLifecycle');

const MIGRATION = 'migrations/2026-11-15_ei_discharges.sql';
// Kept as they are (Kieran, Oct 19 2026): a note is late 2 days after the
// session; progress reports are due 21 days before the IFSP ends (NYC: 14).
const NOTE_LATE_DAYS = 2;
const PROGRESS_REPORT_LEAD_DAYS = 21;
// Why services ended (the office picks one; NYC's own exit reasons are
// recorded in EI-Hub by the service coordinator).
const END_REASONS = {
  aged_out: 'Turned 3 / aged out', family_withdrew: 'Family withdrew', moved: 'Moved away',
  goals_met: 'Goals met / no longer eligible', transferred: 'Transferred to another agency', other: 'Other',
};

// The appointment window's warning (Kieran, Oct 2026: warn, allow saving):
// does a mandate (office: and an authorization) cover an EI session on that
// date with that provider? GET /ei-coverage?patient=&provider=&date=
async function coverage({ qs, db, currentUser }) {
  if (!featureOn('ei')) return json(404, { error: 'Not available at this clinic.' });
  if (!qs.patient || !qs.provider || !/^\d{4}-\d{2}-\d{2}$/.test(String(qs.date || ''))) return json(400, { error: 'patient, provider and date are required.' });
  const manager = canManage(currentUser);
  if (!manager && currentUser.providerName !== qs.provider) return json(403, { error: 'You can only check your own sessions.' });
  return json(200, await require('../lib/eiFollowUps').coverageFor(db, { patientName: qs.patient, provider: qs.provider, date: qs.date, withAuth: manager }));
}

// "What needs doing" on an EI child's Overview: one line per open item,
// each pointing at the chart tab where it's dealt with. Worked out fresh.
async function todoFor(db, patient, { manager, intake, outside }) {
  const today = clinicToday();
  const soon = life.addDays(today, 30);
  const items = [];
  const nice = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  if (intake && !intake.complete) {
    const left = intake.items.filter(i => !i.done).length;
    items.push({ key: 'intake', text: `EI intake: ${left} step${left === 1 ? '' : 's'} left`, tab: 'services', severity: 'warning' });
  }
  if (outside.length) items.push({ key: 'outside', text: `${outside.length} booked session${outside.length === 1 ? '' : 's'} not covered by a mandate${manager ? ' or authorization' : ''}`, tab: 'services', severity: 'warning' });
  // Session notes not finished (sessions up to today, this month and last).
  try {
    const { eiSessionsFor } = require('./sessionNotes');
    const months = [today.slice(0, 7), life.addDays(`${today.slice(0, 7)}-01`, -1).slice(0, 7)];
    const sessions = [];
    for (const m of months) sessions.push(...await eiSessionsFor(db, { month: m, provider: null, patientName: patient.Name }));
    const done = await require('../lib/sessionNotes').completeNoteKeys(db, sessions.map(s => s.key));
    const open = sessions.filter(s => !done.has(s.key));
    if (open.length) {
      const oldest = open.map(s => s.date).sort()[0];
      const late = oldest < life.addDays(today, -NOTE_LATE_DAYS);
      items.push({ key: 'notes', text: `${open.length} session note${open.length === 1 ? '' : 's'} not signed yet (oldest ${nice(oldest)})`, tab: 'session-notes', severity: late ? 'danger' : 'warning' });
    }
  } catch (err) { console.error('todo notes', err); }
  // The current IFSP: ending soon, and its progress reports due 21 days before.
  if (await life.exists(db, 'EiIfsps')) {
    const ifsp = (await db.query('SELECT * FROM "EiIfsps" WHERE patient_id=$1 AND start_date <= $2 AND (end_date IS NULL OR end_date >= $2) ORDER BY start_date DESC LIMIT 1', [patient.id, today])).rows[0];
    const end = ifsp && life.day(ifsp.end_date);
    if (end && end <= life.addDays(today, 66)) {
      const due = life.addDays(end, -PROGRESS_REPORT_LEAD_DAYS);
      items.push({ key: 'reports', text: `Progress reports due ${nice(due)} (IFSP ends ${nice(end)})`, tab: 'ifsp', severity: due < today ? 'danger' : 'warning' });
    }
  }
  if (manager && await life.exists(db, 'EiAuthorizations')) {
    const ending = (await db.query('SELECT authorization_number, service, end_date FROM "EiAuthorizations" WHERE patient_id=$1 AND end_date BETWEEN $2 AND $3 ORDER BY end_date', [patient.id, today, soon])).rows;
    ending.forEach(a => items.push({ key: `auth-${a.authorization_number}`, text: `${a.service} authorization ends ${nice(life.day(a.end_date))}`, tab: 'services', severity: 'warning' }));
  }
  const makeups = (await db.query(
    `SELECT DISTINCT deadline_date, due_date FROM "Tasks" WHERE related_patient_id=$1 AND deadline_type LIKE 'ei_makeup_%' AND status <> 'done' ORDER BY deadline_date`, [patient.id]
  )).rows;
  makeups.forEach(t => items.push({ key: `makeup-${life.day(t.deadline_date)}`, text: `Make-up to book for ${nice(life.day(t.deadline_date))} (by ${nice(life.day(t.due_date))})`, tab: 'appointments', severity: life.day(t.due_date) < today ? 'danger' : 'warning' }));
  return items;
}

// Current EI mandates per service, with the authorization covering today
// (office only: providers never see auth #s).
async function currentServices(db, patient, manager) {
  const today = clinicToday();
  const rows = (await db.query(
    `SELECT service, sessions, minutes, start_date, end_date FROM "PatientPrograms" WHERE patient_id=$1 AND program='EI' AND service IS NOT NULL
       AND (start_date IS NULL OR start_date <= $2) AND (end_date IS NULL OR end_date >= $2) ORDER BY service`, [patient.id, today]
  ).catch(() => ({ rows: [] }))).rows;
  const auths = manager && (await life.exists(db, 'EiAuthorizations'))
    ? (await db.query('SELECT authorization_number, service, start_date, end_date FROM "EiAuthorizations" WHERE patient_id=$1', [patient.id])).rows : [];
  return rows.map(r => {
    const a = auths.find(x => x.service === r.service && (!x.start_date || life.day(x.start_date) <= today) && (!x.end_date || life.day(x.end_date) >= today));
    return {
      service: r.service, mandate: `${r.sessions}x${r.minutes}`, start_date: life.day(r.start_date),
      ...(manager ? { authorization: a ? { number: a.authorization_number, end_date: life.day(a.end_date) } : null } : {}),
    };
  });
}

async function handle({ path, method, qs, body, db, currentUser }) {
  if (path === '/ei-coverage' && method === 'GET') return coverage({ qs, db, currentUser });
  const m = path.match(/^\/patients\/([^/]+)\/(ei-workflow|ei-end)$/);
  if (!m) return null;
  if (!featureOn('ei')) return json(404, { error: 'Not available at this clinic.' });
  const patient = (await db.query('SELECT * FROM "Patients" WHERE id::text=$1', [m[1]])).rows[0];
  if (!patient) return json(404, { error: 'Patient not found.' });
  const manager = canManage(currentUser);
  if (!manager) {
    const team = currentUser.providerName ? (await currentCaseloads(db, { patientName: patient.Name })).get(patient.Name) : null;
    if (!team || !team.has(currentUser.providerName) || m[2] === 'ei-end') {
      return json(403, { error: m[2] === 'ei-end' ? 'Only the office can end EI services.' : 'Only the office and the child\'s providers can see this.' });
    }
  }
  const hasDischarges = await life.exists(db, 'EiDischarges');
  const latestDischarge = async () => (hasDischarges
    ? (await db.query('SELECT * FROM "EiDischarges" WHERE patient_id=$1 ORDER BY end_date DESC, id DESC LIMIT 1', [patient.id])).rows[0] || null
    : null);
  const shapeDischarge = (d) => (d ? { end_date: life.day(d.end_date), reason: d.reason, reason_label: END_REASONS[d.reason] || d.reason, note: d.note, created_by: d.created_by, created_at: d.created_at } : null);

  if (m[2] === 'ei-workflow' && method === 'GET') {
    const discharge = await latestDischarge();
    const ended = discharge && life.day(discharge.end_date) <= clinicToday();
    const intake = ended ? null : await life.syncIntake(db, patient);
    const outside = (await life.sessionsOutside(db, patient, { withAuth: manager })).filter(x => !discharge || x.date <= life.day(discharge.end_date));
    return json(200, {
      todo: await todoFor(db, patient, { manager, intake, outside }),
      services: await currentServices(db, patient, manager),
      intake,
      // Sessions after a discharge are listed under it instead.
      outside,
      discharge: shapeDischarge(discharge),
      after_discharge: discharge ? await life.futureEiSessions(db, patient, life.day(discharge.end_date)) : [],
      end_reasons: END_REASONS,
      lookahead_days: life.MANDATE_LOOKAHEAD_DAYS,
    });
  }

  if (m[2] === 'ei-end' && method === 'POST') {
    if (!hasDischarges) return json(503, { error: `Ending EI services needs the database update (${MIGRATION}) to be run first.` });
    const b = body || {};
    const endDate = String(b.end_date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return json(400, { error: 'Choose the last day of EI services.' });
    if (!END_REASONS[b.reason]) return json(400, { error: 'Choose why EI services are ending.' });
    const note = typeof b.note === 'string' ? b.note.trim().slice(0, 2000) : '';
    if (b.reason === 'other' && !note) return json(400, { error: 'Say why in the note when the reason is Other.' });
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('INSERT INTO "EiDischarges" (patient_id, end_date, reason, note, created_by) VALUES ($1,$2,$3,$4,$5)',
        [patient.id, endDate, b.reason, note || null, currentUser.username]);
      // EI mandates still running past the end date end on it. Ones that
      // would only start after it are left alone and reported.
      const ended = (await client.query(
        `UPDATE "PatientPrograms" SET end_date=$2 WHERE patient_id=$1 AND program='EI'
           AND (end_date IS NULL OR end_date > $2) AND (start_date IS NULL OR start_date <= $2) RETURNING service`,
        [patient.id, endDate]
      )).rows;
      const later = (await client.query(
        `SELECT service, start_date FROM "PatientPrograms" WHERE patient_id=$1 AND program='EI' AND start_date > $2`, [patient.id, endDate]
      )).rows;
      const now = await programs.currentRows(client, patient.id);
      const { program, mandate } = programs.summarize(now);
      await client.query('UPDATE "Patients" SET "Program"=$1, "Mandate"=$2 WHERE id=$3', [program, mandate, patient.id]);
      if (b.off_program === true) await client.query(`UPDATE "Patients" SET "Status"='Off Program' WHERE id=$1`, [patient.id]);
      await life.closeTasks(client, patient.id, life.INTAKE_TASK);
      await life.openTask(client, patient, {
        deadlineType: life.DISCHARGE_TASK, dueDate: endDate,
        title: `Close out EI services: ${patient.Name}`,
        description: `EI services end ${endDate} (${END_REASONS[b.reason]}). Cancel or delete the sessions booked after it (listed on the chart's Services tab), and finish the child's last notes and reports.`,
      });
      await client.query('COMMIT');
      return json(201, {
        discharge: shapeDischarge(await latestDischarge()),
        mandates_ended: ended.map(r => r.service).filter(Boolean),
        mandates_after: later.map(r => ({ service: r.service, start_date: life.day(r.start_date) })),
        after_discharge: await life.futureEiSessions(db, patient, endDate),
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }
  return json(405, { error: 'Not supported.' });
}

module.exports = { handle, END_REASONS };
