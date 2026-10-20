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

// Notes, progress reports and evaluations waiting for `own`'s co-signature:
// three direct lookups (the full Compliance sections cover everyone).
async function cosignFor(db, own, today) {
  const { COSIGN_DAYS } = require('../lib/sessionNotes');
  // The clinic's date it was signed on (a UTC date was a day out in the evening).
  const due = (signedAt) => require('../lib/eiLifecycle').addDays(clinicToday(new Date(signedAt)), COSIGN_DAYS);
  const item = (r, href, what) => {
    const by = due(r.provider_signed_at);
    return { patient_name: r.patient_name, provider: r.provider, date: by, href, kind: 'needs_supervisor', text: `${what}: co-sign by ${by}`, severity: by < today ? 'danger' : 'warning' };
  };
  const q = async (table, cols) => ((await exists(db, table))
    ? (await db.query(`SELECT ${cols}, t.provider, t.provider_signed_at, p."Name" AS patient_name FROM "${table}" t JOIN "Patients" p ON p.id = t.patient_id
        WHERE t.supervisor_name=$1 AND t.supervisor_signed_at IS NULL AND t.provider_signed_at IS NOT NULL ORDER BY t.provider_signed_at`, [own])).rows
    : []);
  const [notes, reports, evals] = await Promise.all([q('EiSessionNotes', 't.session_key, t.session_date'), q('EiProgressReports', 't.id, t.service'), q('EiEvalReports', 't.session_key')]);
  return [
    ...notes.map(r => item(r, `/session-notes/note?key=${encodeURIComponent(r.session_key)}`, `Session note ${day(r.session_date)}`)),
    ...reports.map(r => item(r, `/progress-reports/${r.id}`, `${r.service} progress report`)),
    ...evals.map(r => item(r, `/eval-reports/report?key=${encodeURIComponent(r.session_key)}`, 'Evaluation report')),
  ];
}

async function providerWork(db, own, username, today, all) {
  const { notes, reports, evals } = all;
  const [todayRows, cosign, makeups] = await Promise.all([
    // Today's sessions with their note status: just today's rows
    // (lib/eiNoteMarks.js), not a month of sessions.
    safely(async () => {
      const appts = (await getMergedAppointments(db, { startDate: today, endDate: today, provider: own }))
        .filter(a => !a.deleted && a.appointment_status !== '*HOLD*' && !isHold(a.patient_name))
        .sort((a, b) => String(a.appointment_time).localeCompare(String(b.appointment_time)));
      const marked = await require('../lib/eiNoteMarks').markEiNotes(db, appts);
      return marked.map(a => ({ appointment: a, note_key: a.ei_note ? a.ei_note.key : null, note_done: a.ei_note ? a.ei_note.status === 'complete' : null }));
    }),
    safely(() => cosignFor(db, own, today)),
    safely(async () => {
      const tasks = (await db.query(
        `SELECT t.id, t.deadline_type, t.deadline_date, t.due_date, p."Name" AS patient_name FROM "Tasks" t LEFT JOIN "Patients" p ON p.id = t.related_patient_id
         WHERE t.assigned_to=$1 AND t.status <> 'done' AND t.deadline_type LIKE 'ei_makeup_%' ORDER BY t.due_date`, [username]
      )).rows;
      const ids = tasks.map(t => t.deadline_type.slice('ei_makeup_'.length));
      const appts = ids.length ? (await db.query('SELECT * FROM "Appointments" WHERE id::text = ANY($1)', [ids])).rows : [];
      const byId = Object.fromEntries(appts.map(a => [String(a.id), a]));
      return tasks.map(t => ({ patient_name: t.patient_name, date: day(t.deadline_date), due: day(t.due_date), severity: day(t.due_date) < today ? 'danger' : 'warning', appointment: byId[t.deadline_type.slice('ei_makeup_'.length)] || null }));
    }),
  ]);
  const mine = (list) => (list || []).filter(x => x.provider === own);
  return {
    today: todayRows,
    notes: notes === null ? null : sorted(mine(notes).filter(x => x.kind !== 'needs_supervisor')),
    cosign: cosign === null ? null : sorted(cosign),
    // A report waiting on the supervisor's co-signature isn't the
    // provider's to do (it's under the supervisor's To co-sign).
    reports: reports === null && evals === null ? null : sorted([...mine(reports).filter(x => x.kind === 'due' && x.status !== 'needs_supervisor'), ...mine(evals).filter(x => x.kind !== 'needs_supervisor')]),
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
  const [intake, authorizations] = await Promise.all([safely(() => openTasks('ei_intake')), safely(() => openTasks('ei_auth_ending_'))]);
  return {
    intake,
    authorizations,
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
  // The office needs everyone's paperwork; a provider only their own, which
  // is far less to work out (Oct 2026: My work was slow to open).
  const scope = office ? null : own;
  const [notes, reports, evals, tasks] = await Promise.all([
    safely(() => sections.notes(db, today, scope)),
    safely(() => sections.reports(db, today, scope)),
    safely(() => sections.evals(db, today, scope)),
    db.query(`SELECT count(*)::int AS n FROM "Tasks" WHERE assigned_to=$1 AND status <> 'done'`, [currentUser.username]).then(r => r.rows[0].n),
  ]);
  const all = { notes, reports, evals };
  const [provider, officePart] = await Promise.all([
    own ? providerWork(db, own, currentUser.username, today, all) : null,
    office ? officeWork(db, currentUser, today, all) : null,
  ]);
  return json(200, { today, provider, office: officePart, open_tasks: tasks });
}

module.exports = { handle };
