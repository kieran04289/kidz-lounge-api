// My work (the "ei" feature, PedsDesk only; Kieran, Oct 2026): everything
// waiting on the signed-in person, on one page, each with the action that
// deals with it. Nothing new is decided here: it reuses Compliance's
// sections (routes/compliance.js), the automatic tasks (lib/eiLifecycle.js,
// lib/eiFollowUps.js) and the schedule, filtered to who's asking.
//
//   GET /my-work  { provider: {...} | null, office: {...} | null, today }
//     provider (a linked provider): today's sessions, notes to finish,
//       co-signs, reports and evaluations to write, make-ups to book
//     office (Reception, Admins, Developers): children in intake,
//       authorizations ending, late notes by provider, reports to approve,
//       Power Forms to review, time-off and hours requests (Admins)
//   Tasks stay in the task drawer; the page links to it with a count.
const { json } = require('../lib/http');
const { canManage, canAdminister } = require('../lib/roles');
const { featureOn } = require('../lib/features');
const { clinicToday, isHold } = require('../lib/caseload');
const { getMergedAppointments } = require('../lib/recurring');

const exists = async (db, t) => !!(await db.query('SELECT to_regclass($1) AS t', [`"${t}"`])).rows[0]?.t;
const day = (v) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : null);
const sorted = (list) => list.sort((a, b) => (a.severity === 'danger' ? 0 : 1) - (b.severity === 'danger' ? 0 : 1) || String(a.date || '').localeCompare(String(b.date || '')));
// One section can fail without taking the page down (as on Compliance).
const safely = async (fn) => { try { return await fn(); } catch (err) { console.error('my-work', err); return null; } };

async function providerWork(db, own, username, today, all) {
  const { notes, reports, evals } = all;
  // Today's sessions (the HOLD placeholder isn't a session).
  const todayRows = await safely(async () => {
    const appts = (await getMergedAppointments(db, { startDate: today, endDate: today, provider: own }))
      .filter(a => !a.deleted && a.appointment_status !== '*HOLD*' && !isHold(a.patient_name))
      .sort((a, b) => String(a.appointment_time).localeCompare(String(b.appointment_time)));
    const { eiSessionsFor } = require('./sessionNotes');
    const ei = new Map((await eiSessionsFor(db, { month: today.slice(0, 7), provider: own, patientName: null })).filter(s => s.date === today).map(s => [s.key, s]));
    const done = await require('../lib/sessionNotes').completeNoteKeys(db, [...ei.keys()]);
    return appts.map(a => {
      const key = a.is_virtual ? `series:${a.series_id}:${day(a.appointment_date)}` : `appt:${a.id}`;
      const e = ei.get(key) || ei.get(a.exception_of_series_id ? `series:${a.exception_of_series_id}:${day(a.exception_occurrence_date)}` : '') || null;
      return { appointment: a, note_key: e ? e.key : null, note_done: e ? done.has(e.key) : null };
    });
  });
  const mine = (list) => (list || []).filter(x => x.provider === own);
  const toCosign = (list) => (list || []).filter(x => x.kind === 'needs_supervisor' && x.supervisor === own);
  const makeups = await safely(async () => {
    const tasks = (await db.query(
      `SELECT t.id, t.deadline_type, t.deadline_date, t.due_date, p."Name" AS patient_name FROM "Tasks" t LEFT JOIN "Patients" p ON p.id = t.related_patient_id
       WHERE t.assigned_to=$1 AND t.status <> 'done' AND t.deadline_type LIKE 'ei_makeup_%' ORDER BY t.due_date`, [username]
    )).rows;
    const ids = tasks.map(t => t.deadline_type.slice('ei_makeup_'.length));
    const appts = ids.length ? (await db.query('SELECT * FROM "Appointments" WHERE id::text = ANY($1)', [ids])).rows : [];
    const byId = Object.fromEntries(appts.map(a => [String(a.id), a]));
    return tasks.map(t => ({ patient_name: t.patient_name, date: day(t.deadline_date), due: day(t.due_date), severity: day(t.due_date) < today ? 'danger' : 'warning', appointment: byId[t.deadline_type.slice('ei_makeup_'.length)] || null }));
  });
  return {
    today: todayRows,
    notes: notes === null ? null : sorted(mine(notes).filter(x => x.kind !== 'needs_supervisor')),
    cosign: notes === null && reports === null ? null : sorted([...toCosign(notes), ...toCosign(reports), ...toCosign(evals)]),
    reports: reports === null && evals === null ? null : sorted([...mine(reports).filter(x => x.kind === 'due'), ...mine(evals).filter(x => x.kind !== 'needs_supervisor')]),
    makeups,
  };
}

async function officeWork(db, user, today, all) {
  const openTasks = async (prefix) => {
    const rows = (await db.query(
      `SELECT DISTINCT ON (t.related_patient_id, t.deadline_type) t.deadline_type, t.title, t.due_date, p."Name" AS patient_name
       FROM "Tasks" t JOIN "Patients" p ON p.id = t.related_patient_id
       WHERE t.status <> 'done' AND t.deadline_type LIKE $1 ORDER BY t.related_patient_id, t.deadline_type, t.due_date`, [`${prefix}%`]
    )).rows;
    // The task's title is "<label>: <child> (<service>)"; the row already
    // names the child, so only the service is kept.
    const detail = (title) => { const m = String(title).match(/\(([A-Z]{2})\)$/); return m ? `${m[1]} authorization` : null; };
    return sorted(rows.map(r => ({ patient_name: r.patient_name, text: detail(r.title), date: day(r.due_date), severity: day(r.due_date) && day(r.due_date) < today ? 'danger' : 'warning', href: `/patients/${encodeURIComponent(r.patient_name)}` })));
  };
  const lateByProvider = all.notes === null ? null : (() => {
    const late = all.notes.filter(x => x.kind === 'to_write' && x.severity === 'danger');
    const by = {};
    for (const x of late) (by[x.provider] = by[x.provider] || []).push(x);
    return Object.entries(by).map(([provider, list]) => ({ provider, count: list.length, oldest: list.map(x => x.date).sort()[0] }))
      .sort((a, b) => b.count - a.count || a.oldest.localeCompare(b.oldest));
  })();
  const staff = lateByProvider && lateByProvider.length
    ? Object.fromEntries((await db.query('SELECT username, provider_name FROM "Staff" WHERE archived=false AND provider_name = ANY($1)', [lateByProvider.map(x => x.provider)])).rows.map(s => [s.provider_name, s.username]))
    : {};
  const forms = await safely(async () => ((await exists(db, 'PowerFormRequests'))
    ? (await db.query(`SELECT r.id, r.form_name, r.completed_at, p."Name" AS patient_name FROM "PowerFormRequests" r JOIN "Patients" p ON p.id = r.patient_id WHERE r.status='completed' AND r.reviewed_at IS NULL ORDER BY r.completed_at`)).rows
      .map(r => ({ patient_name: r.patient_name, text: r.form_name, date: day(r.completed_at), href: `/patients/${encodeURIComponent(r.patient_name)}`, severity: 'warning' }))
    : []));
  const approvals = canAdminister(user) ? await safely(async () => {
    const timeOff = (await db.query(`SELECT count(*)::int AS n FROM "TimeOffRequests" WHERE status='pending'`)).rows[0].n;
    const hours = (await exists(db, 'HoursChangeRequests')) ? (await db.query(`SELECT count(*)::int AS n FROM "HoursChangeRequests" WHERE status='pending'`)).rows[0].n : 0;
    return { time_off: timeOff, hours };
  }) : undefined;
  return {
    intake: await safely(() => openTasks('ei_intake')),
    authorizations: await safely(() => openTasks('ei_auth_ending_')),
    late_notes: lateByProvider && lateByProvider.map(x => ({ ...x, username: staff[x.provider] || null })),
    to_approve: all.reports === null ? null : sorted(all.reports.filter(x => x.kind === 'to_approve' || x.kind === 'not_sent')),
    forms,
    approvals,
  };
}

async function handle({ path, method, db, currentUser }) {
  if (path !== '/my-work') return null;
  if (!featureOn('ei')) return json(404, { error: 'Not available at this clinic.' });
  if (method !== 'GET') return json(405, { error: 'Not supported.' });
  const today = clinicToday();
  const office = canManage(currentUser);
  const own = currentUser.providerName || null;
  const { sections } = require('./compliance');
  const all = {
    notes: await safely(() => sections.notes(db, today)),
    reports: await safely(() => sections.reports(db, today)),
    evals: await safely(() => sections.evals(db, today)),
  };
  const tasks = (await db.query(`SELECT count(*)::int AS n FROM "Tasks" WHERE assigned_to=$1 AND status <> 'done'`, [currentUser.username])).rows[0].n;
  return json(200, {
    today,
    provider: own ? await providerWork(db, own, currentUser.username, today, all) : null,
    office: office ? await officeWork(db, currentUser, today, all) : null,
    open_tasks: tasks,
  });
}

module.exports = { handle };
