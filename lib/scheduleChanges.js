// Scheduled changes to providers' contracted weekly hours
// (migrations/2026-09-29_schedule_changes.sql).
//
// Which hours apply on a date: among the changes covering that date
// (start_date <= date, and no end_date or end_date >= date), the one that
// started most recently wins; with none, the standing hours
// (ProviderUsualSchedule) apply. So a permanent change on Nov 1 plus a
// temporary Dec 20 - Jan 2 change gives: Nov 1 hours, holiday hours over
// the holidays, then Nov 1 hours again.

let tablePromise = null;
function hasChangesTable(db) {
  if (!tablePromise) {
    tablePromise = db.query(`SELECT to_regclass('"ProviderScheduleChanges"') IS NOT NULL AND to_regclass('"ProviderScheduleChangeDays"') IS NOT NULL AS ok`)
      .then(r => !!r.rows[0]?.ok)
      .catch(() => false);
  }
  return tablePromise;
}

// Changes that could apply anywhere in [start, end], grouped by provider:
// { providerName: [{ id, start_date, end_date, days: { weekday: { start_time, end_time } } }] }
async function loadChangesByProvider(db, { start, end, provider = null }) {
  if (!(await hasChangesTable(db))) return {};
  const params = [start, end];
  let sql = `SELECT id, provider, start_date, end_date FROM "ProviderScheduleChanges"
             WHERE start_date <= $2 AND (end_date IS NULL OR end_date >= $1)`;
  if (provider) { params.push(provider); sql += ` AND provider = $3`; }
  const changes = (await db.query(sql, params)).rows;
  if (!changes.length) return {};
  const days = (await db.query(
    'SELECT change_id, weekday, start_time, end_time FROM "ProviderScheduleChangeDays" WHERE change_id::text = ANY($1)',
    [changes.map(c => String(c.id))]
  )).rows;
  const byProvider = {};
  for (const c of changes) {
    const entry = { id: c.id, start_date: c.start_date, end_date: c.end_date, days: {} };
    days.filter(d => String(d.change_id) === String(c.id)).forEach(d => { entry.days[Number(d.weekday)] = d; });
    (byProvider[c.provider] = byProvider[c.provider] || []).push(entry);
  }
  return byProvider;
}

// The weekday -> hours map in effect on `dateStr`.
function scheduleForDate(standingByWeekday, changes, dateStr) {
  let pick = null;
  for (const c of changes || []) {
    if (c.start_date > dateStr || (c.end_date && c.end_date < dateStr)) continue;
    if (!pick || c.start_date > pick.start_date || (c.start_date === pick.start_date && Number(c.id) > Number(pick.id))) pick = c;
  }
  return pick ? pick.days : standingByWeekday;
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const toMinutes = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };

// What's wrong with a change's { start_date, end_date, schedule }, or null.
// Shared by an admin scheduling a change (routes/officeHours.js) and a
// provider asking for one (routes/hoursRequests.js), so both are held to the
// same rules. `schedule` lists only the days worked.
function scheduleChangeProblem({ start_date, end_date, schedule }) {
  const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
  if (!isDate(start_date)) return 'A start date is required.';
  if (end_date && !isDate(end_date)) return 'The end date is not a valid date.';
  if (end_date && end_date < start_date) return 'The end date is before the start date.';
  if (!Array.isArray(schedule)) return 'schedule must be an array.';
  const seen = new Set();
  for (const d of schedule) {
    const wd = Number(d.weekday);
    if (!Number.isInteger(wd) || wd < 0 || wd > 6) return 'Each day needs a weekday (0-6).';
    if (seen.has(wd)) return 'Each weekday can only appear once.';
    seen.add(wd);
    if (!d.start_time || !d.end_time || toMinutes(d.end_time) <= toMinutes(d.start_time)) return `${WEEKDAY_NAMES[wd]}: the end time must be after the start time.`;
  }
  return null;
}

// Saves the weekday rows of change `changeId` (replacing any it had).
async function saveChangeDays(q, changeId, schedule) {
  await q.query('DELETE FROM "ProviderScheduleChangeDays" WHERE change_id=$1', [changeId]);
  for (const d of schedule) {
    await q.query('INSERT INTO "ProviderScheduleChangeDays" (change_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4)', [changeId, Number(d.weekday), d.start_time, d.end_time]);
  }
}

// A new scheduled change for `provider`; returns its id. `q` is a client
// inside the caller's transaction.
async function insertScheduleChange(q, provider, { start_date, end_date, schedule }, createdBy) {
  const res = await q.query(
    'INSERT INTO "ProviderScheduleChanges" (provider, start_date, end_date, created_by) VALUES ($1,$2,$3,$4) RETURNING id',
    [provider, start_date, end_date || null, createdBy]
  );
  await saveChangeDays(q, res.rows[0].id, schedule);
  return res.rows[0].id;
}

module.exports = { hasChangesTable, loadChangesByProvider, scheduleForDate, scheduleChangeProblem, saveChangeDays, insertScheduleChange };
