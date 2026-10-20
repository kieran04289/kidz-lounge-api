// Session-note status on schedule cards (the "ei" feature, PedsDesk only;
// Kieran, Oct 2026: "Write note" right on the card). For each EI session on
// or before today -- not an evaluation, a HOLD, or on an office closure for an
// in-office session -- adds `ei_note`: { key, status } where status is the
// note's (lib/sessionNotes.js noteStatus: none, draft, needs_parent,
// needs_provider, needs_supervisor, complete). Everything else is unchanged.
// A failure leaves the rows as they were: the schedule never breaks for it.
const { clinicToday, isHold } = require('./caseload');
const patientPrograms = require('./patientPrograms');
const { getMergedOOO } = require('./recurring');
const { providerCancelled } = require('./missedBy');
const { inOffice } = require('./cancelReason');

const day = (v) => String(v || '').slice(0, 10);

async function markEiNotes(db, rows) {
  try {
    const today = clinicToday();
    const first = rows.filter(a => day(a.appointment_date) <= today && !a.is_eval && a.appointment_status !== '*HOLD*'
      && !isHold(a.patient_name) && a.patient_name && a.provider && !providerCancelled(a));
    if (!first.length) return rows;
    // The same sessions the notes list takes (routes/sessionNotes.js
    // eiSessionsFor): not while the provider was out, not an in-office
    // session on a closed day.
    const dates = first.map(a => day(a.appointment_date)).sort();
    const [from, to] = [dates[0], dates[dates.length - 1]];
    const closed = new Set((await db.query('SELECT closure_date FROM "OfficeClosures" WHERE closure_date BETWEEN $1 AND $2', [from, to])).rows.map(c => day(c.closure_date)));
    const ooo = await getMergedOOO(db, { startDate: from, endDate: to });
    const mins = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };
    const out = (a) => ooo.some(o => o.provider === a.provider && day(o.ooo_date) === day(a.appointment_date)
      && mins(o.start_time) < mins(a.appointment_time) + (Number(a.duration) || 30) && mins(a.appointment_time) < mins(o.end_time));
    const candidates = first.filter(a => !(closed.has(day(a.appointment_date)) && inOffice(a.treatment_area)) && !out(a));
    if (!candidates.length) return rows;
    const billing = require('../routes/billing');
    const notes = require('./sessionNotes');
    const names = [...new Set(candidates.map(a => a.patient_name))];
    const patients = (await db.query('SELECT id, "Name", "Program" FROM "Patients" WHERE "Name" = ANY($1)', [names])).rows;
    const byName = Object.fromEntries(patients.map(p => [p.Name, p]));
    const history = await patientPrograms.historyFor(db, patients.map(p => p.id));
    const provs = (await db.query('SELECT "Name", specialty FROM "Providers" WHERE "Name" = ANY($1)', [[...new Set(candidates.map(a => a.provider))]])).rows;
    const spec = Object.fromEntries(provs.map(p => [p.Name, billing.disciplinesOf(p.specialty)]));
    const ei = new Map();
    for (const a of candidates) {
      const p = byName[a.patient_name];
      if (!p || !billing.eiServiceFor(history[p.id], day(a.appointment_date), spec[a.provider] || [], p.Program)) continue;
      ei.set(a, billing.sessionKey(a));
    }
    if (!ei.size) return rows;
    const found = (await db.query('SELECT * FROM "EiSessionNotes" WHERE session_key = ANY($1)', [[...ei.values()]])).rows;
    const byKey = Object.fromEntries(found.map(n => [n.session_key, n]));
    return rows.map(a => (ei.has(a) ? { ...a, ei_note: { key: ei.get(a), status: notes.noteStatus(byKey[ei.get(a)] || null) } } : a));
  } catch (err) {
    console.error('EI note marks', err);
    return rows;
  }
}

module.exports = { markEiNotes };
