// A session's billing codes, from one place (Kieran, Oct 2026): the session
// note. Codes are stored per session in "EiSessionCodes" (the override of
// the provider's defaults, lib/eiHubCodes.js codesFor), the same row EI-Hub
// claims bill from, so there is never a second copy:
//   - the provider sets them on the note (PUT /session-notes/note/codes)
//     until they sign it; signing snapshots them in the note's header;
//   - after that, the office can re-code in EI-Hub claims only with a reason
//     (recode_reason, migrations/2026-11-14_session_codes_reason.sql), and the
//     claims list warns while the codes differ from the signed note.
const { ALLOWED_CODES } = require('./eiHubCodes');

const MAX_LINES = 8;

// { codes } (null = back to the provider's defaults) or { error }.
function cleanCodes(service, list) {
  if (list === null || list === undefined || (Array.isArray(list) && !list.length)) return { codes: null };
  if (!Array.isArray(list)) return { error: 'Codes must be a list.' };
  const allowed = (ALLOWED_CODES[service] || []).map(x => x.code);
  if (!allowed.length) return { error: 'Unknown service.' };
  const codes = list.map(c => String(c || '').trim().toUpperCase());
  const bad = codes.find(c => !allowed.includes(c));
  if (bad !== undefined) return { error: `${bad || 'A blank line'} isn't one of the ${service} codes.` };
  if (codes.length > MAX_LINES) return { error: `A session can have up to ${MAX_LINES} lines.` };
  return { codes };
}

let reasonSeen = false;
async function hasRecodeReason(db) {
  if (reasonSeen) return true;
  const r = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_name='EiSessionCodes' AND column_name='recode_reason'`).catch(() => ({ rows: [] }));
  if (r.rows.length) reasonSeen = true;
  return reasonSeen;
}

async function saveCodes(db, key, codes, username, reason = null) {
  if (!codes) {
    await db.query('DELETE FROM "EiSessionCodes" WHERE session_key=$1', [key]);
    return null;
  }
  const withReason = await hasRecodeReason(db);
  await db.query(
    `INSERT INTO "EiSessionCodes" (session_key, codes, updated_by, updated_at${withReason ? ', recode_reason' : ''}) VALUES ($1, $2, $3, now()${withReason ? ', $4' : ''})
     ON CONFLICT (session_key) DO UPDATE SET codes=$2, updated_by=$3, updated_at=now()${withReason ? ', recode_reason=$4' : ''}`,
    withReason ? [key, JSON.stringify(codes), username, reason] : [key, JSON.stringify(codes), username]
  );
  return codes;
}

// The codes a provider-signed note was signed with, per session key.
async function signedNoteCodes(db, keys) {
  if (!keys.length) return {};
  const t = (await db.query(`SELECT to_regclass('"EiSessionNotes"') AS t`)).rows[0];
  if (!t?.t) return {};
  const rows = (await db.query(
    `SELECT session_key, header FROM "EiSessionNotes" WHERE session_key = ANY($1) AND provider_signed_at IS NOT NULL`, [keys]
  )).rows;
  return Object.fromEntries(rows.map(r => [r.session_key, [...((r.header || {}).cpt_codes || []), ...((r.header || {}).hcpcs_codes || [])]]));
}

const sameCodes = (a, b) => (a || []).join(',') === (b || []).join(',');

module.exports = { cleanCodes, saveCodes, signedNoteCodes, sameCodes, hasRecodeReason, MAX_LINES };
