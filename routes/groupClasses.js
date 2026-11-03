const { json } = require('../lib/http');
const { featureOn } = require('../lib/features');
const { getMergedAppointments } = require('../lib/recurring');
const { isHold } = require('../lib/caseload');
const { signedRecordsFor } = require('../lib/sessionNotes');
const { canManage } = require('../lib/roles');
const { displayNameFor } = require('../lib/utils');

// Group classes (Kieran, Nov 2026; the "groupclasses" feature, PedsDesk
// first). One provider with several children at the same time, booked from
// the appointment window ("Group class" in place of a patient).
//
// Each child gets an ordinary appointment -- a one-time row, or their own
// weekly RecurringSeries -- tied to the class by group_class_id
// (migrations/2026-11-18_group_classes.sql). Billing, session notes,
// make-ups, the caseload and the chart therefore treat each child exactly
// like an individual session (Kieran: each child bills under their own
// program). Each child's status is changed with the usual appointment
// routes; this file only does what touches the class as a whole: booking
// it, adding or removing a child ("this week only" / "this & all future"),
// moving it and deleting it. Every write is one transaction, and a child's
// session with a signed EI record is never moved or removed (the same locks
// as routes/appointments.js).
const MIN_CHILDREN = 2;
// NYC's EI group sessions are 2 to 10 children (lib/sessionNotes.js).
const MAX_CHILDREN = 10;
const MIGRATION = '2026-11-18_group_classes.sql';
const COMMENTS_MIGRATION = '2026-11-19_group_class_comments.sql';

let tableSeen = false; // only a "yes" is remembered
async function hasGroupTable(db) {
  if (tableSeen) return true;
  const r = await db.query(`SELECT to_regclass('"GroupClasses"') IS NOT NULL AS ok`);
  tableSeen = !!r.rows[0]?.ok;
  return tableSeen;
}

let commentsSeen = false; // only a "yes" is remembered
async function hasCommentsTable(db) {
  if (commentsSeen) return true;
  const r = await db.query(`SELECT to_regclass('"GroupClassComments"') IS NOT NULL AS ok`);
  commentsSeen = !!r.rows[0]?.ok;
  return commentsSeen;
}

// Thrown inside a transaction to roll back and answer with `response`.
class Refusal extends Error {
  constructor(response) { super('refused'); this.response = response; }
}
const refuse = (status, error, extra = {}) => { throw new Refusal(json(status, { error, ...extra })); };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}/;
const day = (v) => (v ? String(v).slice(0, 10) : null);
const hm = (v) => String(v || '').slice(0, 5);
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const weekdayOf = (dateStr) => new Date(`${dateStr}T00:00:00Z`).getUTCDay();
const seriesIdOf = (row) => (row.is_virtual ? row.series_id : row.exception_of_series_id) || null;
const keyOf = (row) => (row.is_virtual
  ? `series:${row.series_id}:${day(row.appointment_date)}`
  : row.exception_of_series_id ? `series:${row.exception_of_series_id}:${day(row.exception_occurrence_date)}` : `appt:${row.id}`);

// Late require: routes/appointments.js is loaded before this file and
// shares its locks and setting rules.
const appt = () => require('./appointments');

// Refuses (throws) when this child's session has a signed EI record.
async function lockOne(db, row) {
  const found = await signedRecordsFor(db, [keyOf(row)]);
  if (found[0]) refuse(409, `${row.patient_name}'s session has a signed ${found[0].kind}, so it can't be moved or removed. Correct the record with an addendum instead.`, { locked: true });
}
// ...and for a weekly series from a date on (signed notes, or sessions
// already entered in EI-Hub: both are keyed by the series id).
async function lockSeriesFrom(db, seriesId, from, name) {
  const lock = await appt().signedSeriesFrom(db, seriesId, from);
  if (lock) refuse(409, `${name}: ${JSON.parse(lock.body).error}`, { locked: true });
  if ((await db.query(`SELECT to_regclass('"EiHubEntries"') AS t`)).rows[0]?.t) {
    const entered = (await db.query(`SELECT session_key FROM "EiHubEntries" WHERE session_key LIKE $1 AND split_part(session_key, ':', 3) >= $2 LIMIT 1`, [`series:${seriesId}:%`, from])).rows[0];
    if (entered) refuse(409, `${name}'s session on ${entered.session_key.split(':')[2]} is already entered in EI-Hub, so the class can't change from ${from}. Change it from a later week, or this week only.`);
  }
}

// The class's children on one date (the class shown as one card). `fromTime`
// narrows it to one sitting when the class meets twice that day.
async function membersOn(db, groupId, date, fromTime = null) {
  const rows = await getMergedAppointments(db, { startDate: date, endDate: date });
  return rows.filter(r => String(r.group_class_id) === String(groupId) && (!fromTime || hm(r.appointment_time) === hm(fromTime)));
}

async function loadGroup(db, id) {
  if (!/^\d+$/.test(String(id))) return null;
  return (await db.query('SELECT * FROM "GroupClasses" WHERE id=$1', [id])).rows[0] || null;
}

async function checkPatients(db, names) {
  const clean = [...new Set((names || []).map(n => String(n || '').trim()).filter(Boolean))];
  const hold = clean.find(n => isHold(n));
  if (hold) refuse(400, 'The HOLD placeholder can\'t be added to a group class.');
  if (!clean.length) return clean;
  const found = new Set((await db.query('SELECT "Name" FROM "Patients" WHERE "Name" = ANY($1)', [clean])).rows.map(r => r.Name));
  const missing = clean.find(n => !found.has(n));
  if (missing) refuse(400, `${missing} isn't a patient. Pick each child from the list.`);
  return clean;
}

async function checkProvider(db, name) {
  const found = (await db.query('SELECT 1 FROM "Providers" WHERE "Name"=$1', [name])).rows[0];
  if (!found) refuse(400, `${name} isn't a provider. Pick one from the list.`);
}

// The time, length, provider and setting a class session is saved with.
function sessionFields(body, fallback = {}) {
  const pick = (k) => (body[k] !== undefined && body[k] !== null && body[k] !== '' ? body[k] : fallback[k]);
  const f = {
    provider: pick('provider'),
    appointment_time: pick('appointment_time') ? hm(pick('appointment_time')) : null,
    duration: Number(pick('duration')) || 30,
    treatment_area: body.treatment_area !== undefined ? (body.treatment_area || null) : (fallback.treatment_area ?? null),
  };
  if (!f.provider) refuse(400, 'Pick the provider.');
  if (!f.appointment_time || !TIME_RE.test(f.appointment_time)) refuse(400, 'Pick the time.');
  return f;
}

const insertOne = (db, groupId, name, date, f, status) => db.query(
  `INSERT INTO "Appointments" (patient_name, provider, appointment_date, appointment_time, duration, treatment_area, appointment_status, group_class_id, updated_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now()) RETURNING *`,
  [name, f.provider, date, f.appointment_time, f.duration, appt().areaAfterStatus(status, f.treatment_area), status, groupId]
);
const insertSeries = (db, groupId, name, startDate, endDate, f, status) => db.query(
  `INSERT INTO "RecurringSeries" (patient_name, provider, weekday, appointment_time, duration, treatment_area, appointment_status, start_date, end_date, group_class_id)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
  [name, f.provider, weekdayOf(startDate), f.appointment_time, f.duration, f.treatment_area, status, startDate, endDate || null, groupId]
);
// One date of a series as its own row (the same "exception" the appointment
// window makes), with the given fields; `deleted` = removed for that date.
const insertException = (db, row, f, { deleted = false } = {}) => db.query(
  `INSERT INTO "Appointments"
     (patient_name, provider, appointment_date, appointment_time, duration, treatment_area, appointment_status, exception_of_series_id, exception_occurrence_date, deleted, group_class_id, updated_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now()) RETURNING *`,
  [row.patient_name, f.provider, f.appointment_date, f.appointment_time, f.duration, appt().areaAfterStatus(row.appointment_status, f.treatment_area),
    row.appointment_status, row.series_id, day(row.appointment_date), deleted, row.group_class_id]
);

// Takes one child out of the class on `date` (scope 'one') or from it on
// ('future': their weekly series ends the day before, and their later rows
// in this class go too).
async function removeChild(db, row, date, scope) {
  const sid = seriesIdOf(row);
  if (scope !== 'future' || !sid) {
    await lockOne(db, row);
    if (row.is_virtual) {
      await insertException(db, row, { provider: row.provider, appointment_date: day(row.appointment_date), appointment_time: hm(row.appointment_time), duration: row.duration, treatment_area: row.treatment_area }, { deleted: true });
    } else {
      await db.query('UPDATE "Appointments" SET deleted=true, updated_at=now() WHERE id=$1', [row.id]);
    }
    if (scope !== 'future') return;
  } else {
    await lockSeriesFrom(db, sid, date, row.patient_name);
    await db.query('UPDATE "RecurringSeries" SET end_date=$1, updated_at=now() WHERE id=$2', [addDays(date, -1), sid]);
    await db.query('UPDATE "Appointments" SET deleted=true, updated_at=now() WHERE exception_of_series_id=$1 AND exception_occurrence_date >= $2', [sid, date]);
  }
  // Their one-time sessions in this class after this date ("this week
  // only" additions), unless signed.
  const later = (await db.query(
    `SELECT * FROM "Appointments" WHERE group_class_id=$1 AND patient_name=$2 AND exception_of_series_id IS NULL AND deleted=false AND appointment_date > $3`,
    [row.group_class_id, row.patient_name, date]
  )).rows;
  for (const r of later) {
    await lockOne(db, r);
    await db.query('UPDATE "Appointments" SET deleted=true, updated_at=now() WHERE id=$1', [r.id]);
  }
}

// Moves one child's session on its date to `f` (date, time, length,
// provider, setting).
async function moveOne(db, row, f) {
  const moved = day(f.appointment_date) !== day(row.appointment_date) || f.appointment_time !== hm(row.appointment_time)
    || Number(f.duration) !== Number(row.duration) || f.provider !== row.provider;
  if (moved) await lockOne(db, row);
  if (row.is_virtual) return insertException(db, row, f);
  return db.query(
    `UPDATE "Appointments" SET appointment_date=$1, appointment_time=$2, duration=$3, provider=$4, treatment_area=$5, updated_at=now() WHERE id=$6`,
    [f.appointment_date, f.appointment_time, f.duration, f.provider, appt().areaAfterStatus(row.appointment_status, f.treatment_area), row.id]
  );
}

// Moves one child's weekly series from `date` on. The series ends the day
// before and a copy starts with the new pattern (in place when `date` is its
// first day). Their later one-off rows follow: re-pointed to the copy and
// given the new pattern, or -- when the weekday changes, so their dates no
// longer fit -- removed.
async function moveSeriesFrom(db, row, date, f) {
  const sid = seriesIdOf(row);
  const series = (await db.query('SELECT * FROM "RecurringSeries" WHERE id=$1', [sid])).rows[0];
  if (!series) return moveOne(db, row, f);
  const newStart = f.appointment_date;
  const weekdayChanged = weekdayOf(newStart) !== Number(series.weekday);
  const inPlace = date === day(series.start_date);
  // Always: even in place, signed or claimed sessions from `date` on would change.
  await lockSeriesFrom(db, sid, date, row.patient_name);
  let target = series;
  if (inPlace) {
    target = (await db.query(
      `UPDATE "RecurringSeries" SET weekday=$1, appointment_time=$2, duration=$3, provider=$4, treatment_area=$5, start_date=$6, updated_at=now() WHERE id=$7 RETURNING *`,
      [weekdayOf(newStart), f.appointment_time, f.duration, f.provider, f.treatment_area, newStart, sid]
    )).rows[0];
  } else {
    await db.query('UPDATE "RecurringSeries" SET end_date=$1, updated_at=now() WHERE id=$2', [addDays(date, -1), sid]);
    // Every column of the series, so newer ones (hours okay...) come along.
    const skip = ['id', 'created_at', 'updated_at', 'start_date', 'weekday', 'appointment_time', 'duration', 'provider', 'treatment_area'];
    const cols = Object.keys(series).filter(c => !skip.includes(c));
    const all = [...cols, 'start_date', 'weekday', 'appointment_time', 'duration', 'provider', 'treatment_area'];
    target = (await db.query(
      `INSERT INTO "RecurringSeries" (${all.map(c => `"${c}"`).join(', ')}) VALUES (${all.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      [...cols.map(c => series[c]), newStart, weekdayOf(newStart), f.appointment_time, f.duration, f.provider, f.treatment_area]
    )).rows[0];
  }
  if (weekdayChanged) {
    await db.query('UPDATE "Appointments" SET deleted=true, updated_at=now() WHERE exception_of_series_id=$1 AND exception_occurrence_date >= $2', [sid, date]);
    return;
  }
  await db.query(
    `UPDATE "Appointments" SET exception_of_series_id=$1,
       appointment_time = CASE WHEN deleted THEN appointment_time ELSE $4 END,
       duration = CASE WHEN deleted THEN duration ELSE $5 END,
       provider = CASE WHEN deleted THEN provider ELSE $6 END,
       treatment_area = CASE WHEN deleted OR appointment_status IN ('Canceled', 'No Show') THEN treatment_area ELSE $7 END,
       updated_at=now()
     WHERE exception_of_series_id=$2 AND exception_occurrence_date >= $3`,
    [target.id, sid, date, f.appointment_time, f.duration, f.provider, f.treatment_area]
  );
}

async function inTransaction(db, fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof Refusal) return err.response;
    throw err;
  } finally {
    client.release();
  }
}

async function handle({ path, method, body, db, currentUser }) {
  if (!path.startsWith('/group-classes')) return null;
  if (!featureOn('groupclasses')) return json(404, { error: 'Not found.' });
  if (!(await hasGroupTable(db))) return json(503, { error: `Group classes need the database update (${MIGRATION}) to be run first.` });
  const b = body || {};

  // Books a class: { name, provider, date, appointment_time, duration,
  // treatment_area, appointment_status, weekly, end_date, patients: [names] }.
  // Weekly = each child's own series from `date` (no end unless end_date).
  if (path === '/group-classes' && method === 'POST') {
    return inTransaction(db, async (client) => {
      const name = String(b.name || '').trim().slice(0, 120);
      if (!name) refuse(400, 'Give the class a name.');
      const date = day(b.date);
      if (!date || !DATE_RE.test(date)) refuse(400, 'Pick the date.');
      const endDate = b.weekly && b.end_date ? day(b.end_date) : null;
      if (endDate && endDate < date) refuse(400, 'The last week can\'t be before the first.');
      const refused = appt().retiredAreaRefusal(b.treatment_area, null);
      if (refused) throw new Refusal(refused);
      const f = sessionFields(b);
      await checkProvider(client, f.provider);
      const kids = await checkPatients(client, b.patients);
      if (kids.length < MIN_CHILDREN) refuse(400, `Add at least ${MIN_CHILDREN} children.`);
      if (kids.length > MAX_CHILDREN) refuse(400, `A class can have up to ${MAX_CHILDREN} children.`);
      const status = String(b.appointment_status || 'Scheduled');
      const group = (await client.query('INSERT INTO "GroupClasses" (name, created_by) VALUES ($1,$2) RETURNING *', [name, currentUser.username])).rows[0];
      for (const kid of kids) {
        if (b.weekly) await insertSeries(client, group.id, kid, date, endDate, f, status);
        else await insertOne(client, group.id, kid, date, f, status);
      }
      return json(201, { group, children: kids.length });
    });
  }

  const m = path.match(/^\/group-classes\/(\d+)(?:\/([a-z-]+))?(?:\/([a-z-]+))?$/);
  if (!m) return null;
  const group = await loadGroup(db, m[1]);
  if (!group) return json(404, { error: 'That group class no longer exists. Refresh the schedule.' });
  const step = [m[2], m[3]].filter(Boolean).join('/');

  if (!step && method === 'GET') {
    const weekly = (await db.query('SELECT 1 FROM "RecurringSeries" WHERE group_class_id=$1 LIMIT 1', [group.id])).rows.length > 0;
    return json(200, { id: group.id, name: group.name, weekly });
  }

  // Renames the class (everywhere: the name lives on the class).
  if (!step && method === 'PUT') {
    const name = String(b.name || '').trim().slice(0, 120);
    if (!name) return json(400, { error: 'Give the class a name.' });
    const row = (await db.query('UPDATE "GroupClasses" SET name=$1, updated_at=now() WHERE id=$2 RETURNING *', [name, group.id])).rows[0];
    return json(200, row);
  }

  // The class's comments for one sitting (its date): { date, action:
  // 'append', text } or { date, action: 'delete', commentId }. Same format
  // and rules as an appointment's comments (routes/appointments.js).
  if (step === 'comments' && method === 'PUT') {
    if (!(await hasCommentsTable(db))) return json(503, { error: `Class comments need the database update (${COMMENTS_MIGRATION}) to be run first.` });
    const date = day(b.date);
    if (!date || !DATE_RE.test(date)) return json(400, { error: 'date is required.' });
    const row = (await db.query('SELECT comments FROM "GroupClassComments" WHERE group_class_id=$1 AND class_date=$2', [group.id, date])).rows[0];
    let list = [];
    try { list = row?.comments ? JSON.parse(row.comments) : []; } catch { list = []; }
    if (b.action === 'append') {
      const text = String(b.text || '').trim();
      if (!text) return json(400, { error: 'Comment text is required.' });
      list.push({
        id: list.reduce((max, c) => Math.max(max, c.id || 0), 0) + 1,
        author_username: currentUser.username,
        author_display: displayNameFor({ username: currentUser.username, first_name: currentUser.firstName, last_name: currentUser.lastName, preferred_name: currentUser.preferredName }),
        timestamp: new Date().toISOString(),
        text,
      });
    } else if (b.action === 'delete') {
      const target = list.find(c => c.id === b.commentId);
      if (!target) return json(404, { error: 'Comment not found.' });
      if (target.author_username !== currentUser.username && !canManage(currentUser)) return json(403, { error: 'You can only delete your own comments.' });
      list = list.filter(c => c.id !== b.commentId);
    } else {
      return json(400, { error: 'Unknown comment action.' });
    }
    const stored = list.length ? JSON.stringify(list) : null;
    await db.query(
      `INSERT INTO "GroupClassComments" (group_class_id, class_date, comments) VALUES ($1,$2,$3)
       ON CONFLICT (group_class_id, class_date) DO UPDATE SET comments=EXCLUDED.comments, updated_at=now()`,
      [group.id, date, stored]
    );
    return json(200, { comments: stored });
  }

  if (method !== 'POST') return null;
  const date = day(b.date);
  if (!date || !DATE_RE.test(date)) return json(400, { error: 'date is required.' });
  const scope = b.scope === 'future' ? 'future' : 'one';

  // Adds a child: { patient_name, date, scope, and the session as shown that
  // day: provider, appointment_time, duration, treatment_area }. 'future' on
  // a weekly class starts their own series from `date` (with the class's
  // pattern and last week); otherwise one session on `date`.
  if (step === 'attendees') {
    return inTransaction(db, async (client) => {
      const [kid] = await checkPatients(client, [b.patient_name]);
      if (!kid) refuse(400, 'Pick the child from the list.');
      const members = await membersOn(client, group.id, date, b.from_time);
      if (members.some(r => r.patient_name === kid)) refuse(409, `${kid} is already in this class that day.`);
      if (members.length >= MAX_CHILDREN) refuse(400, `A class can have up to ${MAX_CHILDREN} children.`);
      const f = sessionFields(b, members[0] || {});
      const status = 'Scheduled';
      const pattern = scope === 'future' && (await client.query(
        `SELECT * FROM "RecurringSeries" WHERE group_class_id=$1 AND weekday=$2 AND start_date <= $3 AND (end_date IS NULL OR end_date >= $3) ORDER BY id LIMIT 1`,
        [group.id, weekdayOf(date), date]
      )).rows[0];
      if (!pattern) {
        const row = (await insertOne(client, group.id, kid, date, f, status)).rows[0];
        return json(201, { added: kid, scope: 'one', id: row.id });
      }
      const series = (await insertSeries(client, group.id, kid, date, pattern.end_date ? day(pattern.end_date) : null, {
        provider: pattern.provider, appointment_time: hm(pattern.appointment_time), duration: pattern.duration, treatment_area: pattern.treatment_area,
      }, status)).rows[0];
      // This week's class was moved on its own: the new child joins it there.
      if (f.provider !== series.provider || f.appointment_time !== hm(series.appointment_time) || Number(f.duration) !== Number(series.duration) || (f.treatment_area || null) !== (series.treatment_area || null)) {
        await insertException(client, { ...series, series_id: series.id, appointment_date: date }, { ...f, appointment_date: date });
      }
      return json(201, { added: kid, scope: 'future', series_id: series.id });
    });
  }

  // Takes a child out: { patient_name, date, scope }.
  if (step === 'attendees/remove') {
    return inTransaction(db, async (client) => {
      const row = (await membersOn(client, group.id, date, b.from_time)).find(r => r.patient_name === b.patient_name);
      if (!row) refuse(404, `${b.patient_name || 'That child'} isn't in this class that day. Refresh the schedule.`);
      await removeChild(client, row, date, scope);
      return json(200, { removed: row.patient_name, scope });
    });
  }

  // Moves the class: { date, from_time, scope, and any of appointment_date,
  // appointment_time, duration, provider, treatment_area }. Every child
  // moves, missed ones included (they're still in the class that day).
  if (step === 'move') {
    return inTransaction(db, async (client) => {
      const members = await membersOn(client, group.id, date, b.from_time);
      if (!members.length) refuse(404, 'Nobody is in this class that day. Refresh the schedule.');
      const first = members[0];
      if (b.treatment_area !== undefined) {
        const refused = appt().retiredAreaRefusal(b.treatment_area, first.treatment_area);
        if (refused) throw new Refusal(refused);
      }
      const f = { ...sessionFields(b, first), appointment_date: day(b.appointment_date) || date };
      if (f.provider !== first.provider) await checkProvider(client, f.provider);
      if (!DATE_RE.test(f.appointment_date)) refuse(400, 'Pick the date.');
      for (const row of members) {
        if (scope === 'future' && seriesIdOf(row)) await moveSeriesFrom(client, row, date, f);
        else await moveOne(client, row, f);
      }
      // The sitting's comments go with it to its new date (unless that date
      // already has its own thread).
      if (f.appointment_date !== date && (await hasCommentsTable(client))) {
        await client.query(
          `UPDATE "GroupClassComments" SET class_date=$1, updated_at=now() WHERE group_class_id=$2 AND class_date=$3
             AND NOT EXISTS (SELECT 1 FROM "GroupClassComments" WHERE group_class_id=$2 AND class_date=$1)`,
          [f.appointment_date, group.id, date]
        );
      }
      return json(200, { moved: members.length, scope });
    });
  }

  // Deletes the class on `date`, or from it on: { date, from_time, scope }.
  if (step === 'delete') {
    return inTransaction(db, async (client) => {
      const members = await membersOn(client, group.id, date, b.from_time);
      for (const row of members) await removeChild(client, row, date, scope);
      return json(200, { removed: members.length, scope });
    });
  }

  return null;
}

module.exports = { handle, MAX_CHILDREN, MIN_CHILDREN };
