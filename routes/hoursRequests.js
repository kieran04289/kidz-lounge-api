const { json } = require('../lib/http');
const { canAdminister } = require('../lib/roles');
const { clinicToday } = require('../lib/caseload');
const { hasChangesTable, loadChangesByProvider, scheduleForDate, scheduleChangeProblem, insertScheduleChange } = require('../lib/scheduleChanges');

// Contracted hours change requests (Kieran, Oct 2026): a provider asks for
// new weekly hours from a date (optionally until a date), and an admin
// approves or denies it. Approving creates the same scheduled change an
// admin makes on the provider's profile ("ProviderScheduleChanges"), so
// everything that reads contracted hours -- the schedule's shading, conflicts,
// PTO costs -- only ever sees approved hours. Lunch, meetings and unavailable
// time don't come here: those are the provider's own to set (routes/timeOff.js).
//
//   GET    /hours-change-requests[?status=]     admins: everyone's; others: their own
//   POST   /hours-change-requests               <- { start_date, end_date?, schedule, notes? }
//   DELETE /hours-change-requests/:id           withdraw (yours, not yet approved) / admins: any not approved
//   PUT    /hours-change-requests/:id/approve
//   PUT    /hours-change-requests/:id/deny      <- { review_note? }

const MIGRATION = 'migrations/2026-11-11_hours_change_requests.sql';

// Only a "yes" is cached, so a warm Lambda notices once the migration runs.
let tableReady = false;
async function hasRequestsTable(db) {
  if (tableReady) return true;
  const res = await db.query(`SELECT to_regclass('"HoursChangeRequests"') IS NOT NULL AS ok`).catch(() => null);
  tableReady = !!res?.rows[0]?.ok;
  return tableReady;
}

const cleanSchedule = (schedule) => schedule
  .map(d => ({ weekday: Number(d.weekday), start_time: String(d.start_time).slice(0, 5), end_time: String(d.end_time).slice(0, 5) }))
  .sort((a, b) => a.weekday - b.weekday);

// Each pending request also carries the hours it would replace -- what
// applies on its start date today -- so the admin sees before and after.
async function withCurrentHours(db, rows) {
  const pending = rows.filter(r => r.status === 'pending');
  if (!pending.length) return rows;
  const providers = [...new Set(pending.map(r => r.provider))];
  const standingRes = await db.query('SELECT provider, weekday, start_time, end_time FROM "ProviderUsualSchedule" WHERE provider = ANY($1)', [providers]);
  const standing = {};
  standingRes.rows.forEach(r => { (standing[r.provider] = standing[r.provider] || {})[Number(r.weekday)] = r; });
  const dates = pending.map(r => r.start_date).sort();
  const changes = await loadChangesByProvider(db, { start: dates[0], end: dates[dates.length - 1] });
  return rows.map(r => {
    if (r.status !== 'pending') return r;
    const days = scheduleForDate(standing[r.provider] || {}, changes[r.provider], r.start_date);
    const current_schedule = Object.values(days)
      .map(d => ({ weekday: Number(d.weekday), start_time: String(d.start_time).slice(0, 5), end_time: String(d.end_time).slice(0, 5) }))
      .sort((a, b) => a.weekday - b.weekday);
    return { ...r, current_schedule };
  });
}

async function handle({ path, method, qs, body, db, currentUser }) {
  const listRoute = path === '/hours-change-requests';
  const idRoute = path.match(/^\/hours-change-requests\/([^/]+)$/);
  const actionRoute = path.match(/^\/hours-change-requests\/([^/]+)\/(approve|deny)$/);
  if (!listRoute && !idRoute && !actionRoute) return null;

  if (!(await hasRequestsTable(db))) {
    if (listRoute && method === 'GET') return json(200, []);
    return json(503, { error: `Asking for new contracted hours needs the database update (${MIGRATION}) to be run first.` });
  }
  const isAdmin = canAdminister(currentUser);

  if (listRoute && method === 'GET') {
    const params = [];
    const where = [];
    if (!isAdmin) { params.push(currentUser.username); where.push(`username = $${params.length}`); }
    if (qs.status) { params.push(qs.status); where.push(`status = $${params.length}`); }
    const rows = (await db.query(
      `SELECT * FROM "HoursChangeRequests" ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY requested_at DESC`,
      params
    )).rows;
    return json(200, await withCurrentHours(db, rows));
  }

  if (listRoute && method === 'POST') {
    const provider = currentUser.providerName;
    if (!provider) return json(403, { error: 'Only providers have contracted hours. Your account isn\'t linked to a provider -- ask an admin.' });
    if (!(await db.query('SELECT 1 FROM "Providers" WHERE "Name"=$1', [provider])).rows[0]) {
      return json(400, { error: `Your account is linked to the provider name "${provider}", but no provider record matches it. Ask an admin to fix your Provider Link.` });
    }
    const problem = scheduleChangeProblem(body);
    if (problem) return json(400, { error: problem });
    if (body.start_date < clinicToday()) return json(400, { error: 'New hours can\'t start in the past. Pick today or a later date.' });
    // One at a time keeps it clear which hours an admin is deciding on.
    const waiting = (await db.query(`SELECT 1 FROM "HoursChangeRequests" WHERE username=$1 AND status='pending' LIMIT 1`, [currentUser.username])).rows[0];
    if (waiting) return json(409, { error: 'You already have an hours change waiting for approval. Withdraw it first if you want to ask for different hours.' });
    const notes = typeof body.notes === 'string' ? body.notes.trim().slice(0, 2000) : '';
    const row = (await db.query(
      `INSERT INTO "HoursChangeRequests" (username, provider, start_date, end_date, schedule, notes)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [currentUser.username, provider, body.start_date, body.end_date || null, JSON.stringify(cleanSchedule(body.schedule)), notes || null]
    )).rows[0];
    return json(201, row);
  }

  const id = (idRoute || actionRoute)[1];
  const existing = (await db.query('SELECT * FROM "HoursChangeRequests" WHERE id::text = $1', [String(id)])).rows[0];
  if (!existing) return json(404, { error: 'That hours change request no longer exists.' });

  if (idRoute && method === 'DELETE') {
    if (existing.username !== currentUser.username && !isAdmin) return json(403, { error: 'You can only withdraw your own requests.' });
    // An approved one is already a scheduled change; that's removed from the
    // provider's profile (Contracted hours), not here.
    if (existing.status === 'approved') return json(409, { error: 'This change was already approved. An admin can remove it from the provider\'s contracted hours.' });
    await db.query('DELETE FROM "HoursChangeRequests" WHERE id=$1', [existing.id]);
    return json(200, { deleted: true });
  }

  if (actionRoute && method === 'PUT') {
    if (!isAdmin) return json(403, { error: 'Admin access required.' });
    if (existing.status !== 'pending') return json(409, { error: `This request has already been ${existing.status}.` });

    if (actionRoute[2] === 'deny') {
      const note = typeof body.review_note === 'string' ? body.review_note.trim().slice(0, 2000) : '';
      const row = (await db.query(
        `UPDATE "HoursChangeRequests" SET status='denied', reviewed_by=$1, reviewed_at=now(), review_note=$2 WHERE id=$3 RETURNING *`,
        [currentUser.username, note || null, existing.id]
      )).rows[0];
      return json(200, row);
    }

    if (!(await hasChangesTable(db))) {
      return json(503, { error: 'Scheduling hour changes needs the database update (migrations/2026-09-29_schedule_changes.sql) to be run first.' });
    }
    // Checked again: the provider may have been renamed or removed since.
    if (!(await db.query('SELECT 1 FROM "Providers" WHERE "Name"=$1', [existing.provider])).rows[0]) {
      return json(400, { error: `No provider named "${existing.provider}" exists any more. Deny this request and ask them to send it again.` });
    }
    const change = { start_date: existing.start_date, end_date: existing.end_date, schedule: existing.schedule || [] };
    const problem = scheduleChangeProblem(change);
    if (problem) return json(400, { error: problem });

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const locked = (await client.query('SELECT status FROM "HoursChangeRequests" WHERE id=$1 FOR UPDATE', [existing.id])).rows[0];
      if (!locked || locked.status !== 'pending') {
        await client.query('ROLLBACK');
        return json(409, { error: 'This request was already decided. Refresh to see it.' });
      }
      const changeId = await insertScheduleChange(client, existing.provider, change, currentUser.username);
      const row = (await client.query(
        `UPDATE "HoursChangeRequests" SET status='approved', reviewed_by=$1, reviewed_at=now(), resulting_change_id=$2 WHERE id=$3 RETURNING *`,
        [currentUser.username, changeId, existing.id]
      )).rows[0];
      await client.query('COMMIT');
      return json(200, row);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  return null;
}

module.exports = { handle };
