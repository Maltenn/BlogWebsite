// AI-writing strikes as members and moderators see them: my strikes (each with the flagged text, its score and when it
// expires) and appealing one; the moderators' appeal queue, their decision (uphold or remove: removing lifts the
// timeout it caused), and the list of every score (what shadow mode is for). Everything a moderator decides is logged.
import { fail, json, readBody, int } from '../shared/http.js';
import { longText, text, clip } from '../shared/text.js';
import { REF_COLS, ref, limit } from '../shared/db.js';
import { TIMEOUT_UNTIL } from '../shared/gate.js';
import { detectorName } from './detect.js';
import { enforcement } from './scan.js';
import { step, EXEMPT_AFTER_REMOVAL } from './ladder.js';

const STRIKE_COLS = `s.id, s.user_id, s.post_id, s.level, s.text, s.score, s.label, s.model, s.created, s.expires, s.status, s.appeal_note,
  s.appealed_at, s.appeal_result, s.decided_at, s.decision_note, p.kind AS p_kind, p.deleted AS p_deleted, p.hidden AS p_hidden,
  (SELECT MAX(t.until) FROM posting_timeouts t WHERE t.strike_id = s.id) AS timeout_until`;
const STRIKES = 'ai_strikes s LEFT JOIN posts p ON p.id = s.post_id';

// one strike as the pages show it
function strikeOut(r, now) {
  const st = step(r.level);
  return {
    id: r.id, level: r.level, step: st.action, created: r.created, expires: r.expires, status: r.status,
    counting: (r.status === 'active' || r.status === 'appealed') && r.expires > now,
    text: r.text, score: r.score, label: r.label, model: r.model,
    post: r.post_id ? { id: r.post_id, kind: r.p_kind, deleted: !!r.p_deleted, hidden: !!r.p_hidden } : null,
    timeout: r.timeout_until ? { until: r.timeout_until } : null,
    appeal: r.appealed_at ? { note: r.appeal_note, at: r.appealed_at, result: r.appeal_result || null, decidedAt: r.decided_at || null } : null,
    canAppeal: r.status === 'active' && !r.appealed_at && r.expires > now,
  };
}

// GET /api/me/strikes — { strikes: [strike] (newest first, the last 50), timeoutUntil, enforcement: 'shadow' | 'enforce',
// detector: 'off' | 'on' }
export async function myStrikes(c) {
  const DB = c.env.DB;
  const [{ results }, until] = await DB.batch([
    DB.prepare(`SELECT ${STRIKE_COLS} FROM ${STRIKES} WHERE s.user_id = ? ORDER BY s.created DESC LIMIT 50`).bind(c.user.id),
    DB.prepare(`SELECT ${TIMEOUT_UNTIL} AS until`).bind(c.user.id, c.now),
  ]);
  return json({
    strikes: results.map(r => strikeOut(r, c.now)),
    timeoutUntil: until.results[0].until || null,
    enforcement: enforcement(c.env),
    detector: detectorName(c.env) === 'off' ? 'off' : 'on',
  });
}

// POST /api/me/strikes/:id/appeal { note (1,000) } — once per strike, while it counts → { strike }. The timeout (if
// any) stays until a moderator decides.
export async function appealStrike(c) {
  const b = await readBody(c.req);
  const note = longText(b.note, 1000);
  if (!note) fail(400, 'tell the moderators why this was your own writing.');
  await limit(c, 'appeal:' + c.user.id, [[10, 86400000]], 'that\'s a lot of appeals for one day.');
  const id = int(c.params.id, 0);
  const r = await c.env.DB.prepare(`UPDATE ai_strikes SET status = 'appealed', appeal_note = ?3, appealed_at = ?4
    WHERE id = ?1 AND user_id = ?2 AND status = 'active' AND appealed_at IS NULL AND expires > ?4 RETURNING id`).bind(id, c.user.id, note, c.now).first();
  if (!r) {
    const there = await c.env.DB.prepare('SELECT 1 AS x FROM ai_strikes WHERE id = ? AND user_id = ?').bind(id, c.user.id).first();
    if (!there) fail(404, 'no such strike.');
    fail(409, 'this strike was already appealed, or it no longer counts.');
  }
  const row = await c.env.DB.prepare(`SELECT ${STRIKE_COLS} FROM ${STRIKES} WHERE s.id = ?`).bind(id).first();
  return json({ strike: strikeOut(row, c.now) });
}

/* ------------------------------------------------------------- moderators */

// GET /api/admin/appeals — { strikes: [strike + user] }: waiting appeals, oldest first
export async function adminAppeals(c) {
  const { results } = await c.env.DB.prepare(`SELECT ${STRIKE_COLS}, ${REF_COLS('u', 'u_')}, u.created AS u_created FROM ${STRIKES}
    JOIN users u ON u.id = s.user_id WHERE s.status = 'appealed' ORDER BY s.appealed_at ASC LIMIT 100`).all();
  return json({ strikes: results.map(r => ({ ...strikeOut(r, c.now), user: { ...ref(r, 'u_'), created: r.u_created } })) });
}

// POST /api/admin/strikes/:id { action: uphold | remove, note } → { strike }. uphold: an appealed strike stays (as it
// was). remove: any strike that counts goes, with its timeout, and the member is exempt from automatic strikes for 180
// days. The member is told either way (an ai_appeal notification).
export async function decideStrike(c) {
  const b = await readBody(c.req);
  const action = b.action;
  if (action !== 'uphold' && action !== 'remove') fail(400, 'say uphold or remove.');
  const note = text(b.note, 300);
  const DB = c.env.DB;
  const id = int(c.params.id, 0);
  const s = await DB.prepare('SELECT id, user_id, status, appealed_at FROM ai_strikes WHERE id = ?').bind(id).first();
  if (!s) fail(404, 'no such strike.');
  if (action === 'uphold' && s.status !== 'appealed') fail(409, 'only an appealed strike can be upheld.');
  if (action === 'remove' && s.status !== 'active' && s.status !== 'appealed') fail(409, 'that strike no longer counts.');
  const appealed = !!s.appealed_at;
  await DB.batch([
    DB.prepare(`UPDATE ai_strikes SET status = ?2, appeal_result = ?3, decided_by = ?4, decided_at = ?5, decision_note = ?6 WHERE id = ?1`)
      .bind(id, action === 'remove' ? 'removed' : 'active', appealed ? (action === 'remove' ? 'removed' : 'upheld') : 'removed', c.user.id, c.now, note),
    action === 'remove' && DB.prepare('DELETE FROM posting_timeouts WHERE strike_id = ?').bind(id),
    action === 'remove' && DB.prepare('UPDATE users SET ai_exempt_until = MAX(COALESCE(ai_exempt_until, 0), ?) WHERE id = ?').bind(c.now + EXEMPT_AFTER_REMOVAL, s.user_id),
    DB.prepare('INSERT INTO notifications (user_id, kind, actor_id, created, strike_id) VALUES (?1, \'ai_appeal\', ?1, ?2, ?3)').bind(s.user_id, c.now, id),
    DB.prepare('INSERT INTO mod_log (actor_id, action, target_type, target_id, note, created) VALUES (?, ?, \'strike\', ?, ?, ?)')
      .bind(c.user.id, action === 'remove' ? 'remove_strike' : 'uphold_strike', id, note, c.now),
  ].filter(Boolean));
  const row = await DB.prepare(`SELECT ${STRIKE_COLS} FROM ${STRIKES} WHERE s.id = ?`).bind(id).first();
  return json({ strike: strikeOut(row, c.now) });
}

// GET /api/admin/ai-scans?before=<id>&decision= — every score, newest first, 50 a page: { scans: [{ id, created, score,
// label, model, decision, words, kind, user, post: { id, kind, excerpt, hidden, deleted } | null }], next, detector,
// enforcement }. decision filters (clear, would_strike, strike, same_incident, exempt, error).
export async function adminScans(c) {
  const before = int(c.url.searchParams.get('before'), Number.MAX_SAFE_INTEGER);
  const decision = c.url.searchParams.get('decision');
  const { results } = await c.env.DB.prepare(`SELECT x.id, x.created, x.score, x.label, x.model, x.decision, x.words, x.kind, x.post_id,
      ${REF_COLS('u', 'u_')}, p.subject AS p_subject, p.body AS p_body, p.hidden AS p_hidden, p.deleted AS p_deleted, p.kind AS p_kind
    FROM ai_scans x JOIN users u ON u.id = x.user_id LEFT JOIN posts p ON p.id = x.post_id
    WHERE x.id < ?1 AND (?2 IS NULL OR x.decision = ?2) ORDER BY x.id DESC LIMIT 51`).bind(before, decision || null).all();
  const shown = results.slice(0, 50);
  return json({
    scans: shown.map(r => ({
      id: r.id, created: r.created, score: r.score, label: r.label, model: r.model, decision: r.decision, words: r.words, kind: r.kind,
      user: ref(r, 'u_'),
      post: r.post_id && r.p_kind ? { id: r.post_id, kind: r.p_kind, excerpt: clip([r.p_subject, r.p_body].filter(Boolean).join(' — '), 200) ?? [r.p_subject, r.p_body].filter(Boolean).join(' — '),
        hidden: !!r.p_hidden, deleted: !!r.p_deleted } : null,
    })),
    next: results.length > 50 ? shown[shown.length - 1].id : null,
    detector: detectorName(c.env), enforcement: enforcement(c.env),
  });
}
