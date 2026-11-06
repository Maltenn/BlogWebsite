// The moderators' side of verifying humans: the held sign-ups (approve, or refuse with a reason), and the alerts
// (clusters, duplicate text, held sign-ups, 5th AI strikes). Nothing here acts on its own: every ban is a moderator's
// decision, logged in mod_log.
import { fail, json, readBody, int } from '../shared/http.js';
import { text, clip } from '../shared/text.js';
import { REF_COLS, ref, userByName } from '../shared/db.js';
import { signOut } from '../shared/live.js';
import { releaseHeld, HELD } from './duplicates.js';

async function log(c, action, targetType, targetId, note = '') {
  await c.env.DB.prepare('INSERT INTO mod_log (actor_id, action, target_type, target_id, note, created) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(c.user.id, action, targetType, targetId, text(note, 300), c.now).run();
}

const parse = s => { try { return JSON.parse(s) || {}; } catch { return {}; } };

// a moderator's ban (refusing a held sign-up, a 5th-strike review): signed out everywhere, logged by the caller
async function ban(c, userId) {
  const u = await c.env.DB.prepare('SELECT id, is_admin FROM users WHERE id = ?').bind(userId).first();
  if (!u) fail(404, 'that account no longer exists.');
  if (u.is_admin) fail(400, 'admins can\'t be banned from here. remove their admin flag first.');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET banned = 1, held = 0 WHERE id = ?').bind(userId),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId),
  ]);
  await signOut(c.env, userId);
}

/* ----------------------------------------------------------- held sign-ups */

// GET /api/admin/held — { accounts: [{ user, created, verified, emailDomain, risk, reasons, network: { asn, asOrg, country },
// formMs, posts }] }: accounts waiting for a moderator, oldest first (100). No addresses: the network is its provider.
export async function heldAccounts(c) {
  const { results } = await c.env.DB.prepare(`SELECT ${REF_COLS('u', '')}, u.created, u.email_verified_at, u.held_reason,
      s.asn, s.as_org, s.country, s.email_domain, s.form_ms, s.risk, s.reasons
    FROM users u LEFT JOIN signup_signals s ON s.user_id = u.id
    WHERE u.held = 1 AND u.banned = 0 ORDER BY u.created ASC LIMIT 100`).all();
  return json({
    accounts: results.map(r => ({
      user: ref(r), created: r.created, verified: !!r.email_verified_at, emailDomain: r.email_domain || null,
      risk: r.risk ?? null, reasons: r.reasons ? parse(r.reasons) : parse(r.held_reason),
      network: { asn: r.asn || null, asOrg: r.as_org || null, country: r.country || null }, formMs: r.form_ms ?? null,
    })),
  });
}

// POST /api/admin/held/:name { action: approve | refuse, reason } → { ok, user: { id, name, held, banned } }.
// approve: the account works like any other (once its email is confirmed). refuse: the account is suspended (a ban;
// the reason goes in the log). Either way its held_signup alert closes.
export async function decideHeld(c) {
  const b = await readBody(c.req);
  const action = b.action;
  if (action !== 'approve' && action !== 'refuse') fail(400, 'say approve or refuse.');
  const reason = text(b.reason, 300);
  if (action === 'refuse' && !reason) fail(400, 'say why (the member can ask about it).');
  const u = await userByName(c.env, c.params.name);
  if (!u) fail(404, 'nobody by that name.');
  const row = await c.env.DB.prepare('SELECT held FROM users WHERE id = ?').bind(u.id).first();
  if (!row.held) fail(409, 'that account isn\'t waiting for review.');
  if (action === 'approve') {
    // an account without an email (a sign-in provider that vouched for none: no_verified_email) counts as confirmed
    // once a moderator has looked at it: there is no address to send a link to
    await c.env.DB.prepare(`UPDATE users SET held = 0, held_reason = NULL,
      email_verified_at = COALESCE(email_verified_at, CASE WHEN email IS NULL THEN ?2 END) WHERE id = ?1`).bind(u.id, c.now).run();
  } else {
    await ban(c, u.id);
  }
  await c.env.DB.prepare(`UPDATE mod_alerts SET resolved_by = ?, resolved_at = ?, resolution = ? WHERE kind = 'held_signup' AND key = ? AND resolved_at IS NULL`)
    .bind(c.user.id, c.now, action === 'approve' ? 'approved' : 'refused', 'user:' + u.id).run();
  await log(c, action === 'approve' ? 'approve_signup' : 'refuse_signup', 'user', u.id, reason);
  return json({ ok: true, user: { id: u.id, name: u.name, held: false, banned: action === 'refuse' } });
}

/* ----------------------------------------------------------------- alerts */

// GET /api/admin/alerts?status=open|closed — { alerts: [{ id, kind, created, rule, users: [{ id, name, avatar, created,
// held, banned }], posts: [{ id, kind, excerpt, hidden, held, deleted, author }], details, resolvedAt, resolvedBy,
// resolution }] }: open ones oldest first, or the last 100 closed. A post's `hidden`: a moderator hid it; `held`: it
// waits for a moderator as duplicate text. details: the rest of what the check found (count, asn, asOrg, domain,
// window, risk, reasons, level, strike; for duplicates `held`, the ids that alert held).
export async function adminAlerts(c) {
  const open = c.url.searchParams.get('status') !== 'closed';
  const DB = c.env.DB;
  const { results } = await DB.prepare(`SELECT a.*, r.name AS resolver FROM mod_alerts a LEFT JOIN users r ON r.id = a.resolved_by
    WHERE ${open ? 'a.resolved_at IS NULL' : 'a.resolved_at IS NOT NULL'} ORDER BY ${open ? 'a.created ASC' : 'a.resolved_at DESC'} LIMIT 100`).all();
  const payloads = results.map(a => parse(a.payload));
  const userIds = [...new Set(payloads.flatMap(p => p.users || []))];
  const postIds = [...new Set(payloads.flatMap(p => p.posts || []))];
  const [users, posts] = await DB.batch([
    DB.prepare(`SELECT ${REF_COLS('u', '')}, u.created, u.held, u.banned FROM users u WHERE u.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(userIds)),
    DB.prepare(`SELECT p.id, p.kind, p.subject, p.body, p.hidden, p.deleted, ${REF_COLS('a', 'a_')} FROM posts p JOIN users a ON a.id = p.author_id
      WHERE p.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(postIds)),
  ]);
  const U = new Map(users.results.map(u => [u.id, { ...ref(u), created: u.created, held: !!u.held, banned: !!u.banned }]));
  const P = new Map(posts.results.map(p => {
    const words = [p.subject, p.body].filter(Boolean).join(' — ');
    return [p.id, { id: p.id, kind: p.kind, excerpt: clip(words, 200) ?? words, hidden: p.hidden === 1, held: p.hidden === HELD, deleted: !!p.deleted, author: ref(p, 'a_') }];
  }));
  return json({
    alerts: results.map((a, i) => {
      const { users: us = [], posts: ps = [], rule = null, ...details } = payloads[i];
      return {
        id: a.id, kind: a.kind, created: a.created, rule,
        users: us.map(id => U.get(id) || { id, name: null, gone: true }),
        posts: ps.map(id => P.get(id) || { id, gone: true }),
        details, resolvedAt: a.resolved_at, resolvedBy: a.resolver || null, resolution: a.resolution,
      };
    }),
  });
}

// POST /api/admin/alerts/:id { action: dismiss | release | ban, note } → { ok }. dismiss: close it. release (duplicate
// alerts): show again the posts this alert held (never a post a moderator hid, nor one it didn't hold). ban (ban_review alerts, a 5th strike): suspend the member. Logged.
export async function resolveAlert(c) {
  const b = await readBody(c.req);
  const action = b.action;
  if (!['dismiss', 'release', 'ban'].includes(action)) fail(400, 'say dismiss, release or ban.');
  const note = text(b.note, 300);
  const a = await c.env.DB.prepare('SELECT * FROM mod_alerts WHERE id = ?').bind(int(c.params.id, 0)).first();
  if (!a) fail(404, 'no such alert.');
  if (a.resolved_at) fail(409, 'that alert is already closed.');
  const p = parse(a.payload);
  if (action === 'release') {
    if (a.kind !== 'duplicate') fail(400, 'only held duplicates can be released.');
    await releaseHeld(c.env, p);     // only the posts this alert held, and only while they're still held
  }
  if (action === 'ban') {
    if (a.kind !== 'ban_review') fail(400, 'bans from here are for a 5th strike only. use the member\'s page or a report.');
    await ban(c, (p.users || [])[0]);
    await log(c, 'ban', 'user', (p.users || [])[0], note || '5th AI-writing strike');
  }
  await c.env.DB.prepare('UPDATE mod_alerts SET resolved_by = ?, resolved_at = ?, resolution = ? WHERE id = ?')
    .bind(c.user.id, c.now, action === 'dismiss' ? 'dismissed' : action === 'release' ? 'released' : 'banned', a.id).run();
  await log(c, 'resolve_alert', 'alert', a.id, `${action}${note ? ': ' + note : ''}`);
  return json({ ok: true });
}
