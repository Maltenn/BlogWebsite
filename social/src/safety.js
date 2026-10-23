// Safety: blocking, reporting, and the moderator tools that act on reports.
import { fail, json, readBody, int } from './http.js';
import { text, longText } from './text.js';
import { REF_COLS, ref, refOf, userByName, visibleUser, pair, limit, profileData } from './db.js';
import { REPORT_REASONS } from './options.js';

const REASONS = new Set(REPORT_REASONS.map(r => r.v));

/* ------------------------------------------------------------ blocks */

// GET /api/blocks — the people I've blocked
export async function listBlocks(c) {
  const { results } = await c.env.DB.prepare(`
    SELECT ${REF_COLS('u', '')}, b.created FROM blocks b JOIN users u ON u.id = b.blocked_id
    WHERE b.blocker_id = ? ORDER BY b.created DESC`).bind(c.user.id).all();
  return json({ blocked: results.map(r => ({ user: ref(r), created: r.created })) });
}

// POST /api/blocks/:name — they can't message me, comment on my wall or friend me, and we stop seeing each other's
// posts. Any friendship or pending request between us ends.
export async function block(c) {
  const u = await userByName(c.env, c.params.name);
  if (!u) fail(404, 'nobody by that name lives here.');
  if (u.id === c.user.id) fail(400, 'you can\'t block yourself. (tempting, we know.)');
  await limit(c, 'block:' + c.user.id, [[30, 3600000]]);
  const [a, b] = pair(c.user.id, u.id);
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created) VALUES (?, ?, ?)').bind(c.user.id, u.id, c.now),
    c.env.DB.prepare('DELETE FROM friendships WHERE a = ? AND b = ?').bind(a, b),
  ]);
  return json({ ok: true, blocked: refOf(u) });
}

// DELETE /api/blocks/:name
export async function unblock(c) {
  const u = await userByName(c.env, c.params.name);
  if (!u) fail(404, 'nobody by that name lives here.');
  await c.env.DB.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').bind(c.user.id, u.id).run();
  return json({ ok: true });
}

/* ----------------------------------------------------------- reports */

// POST /api/reports { type: user|post|message, name | id, reason, details }
// Stores a snapshot of what was reported, so the evidence survives the author deleting it.
export async function report(c) {
  const b = await readBody(c.req);
  const type = b.type;
  const reason = b.reason;
  if (!REASONS.has(reason)) fail(400, 'pick a reason.');
  const details = longText(b.details, 1000);
  let targetId, targetUser, snapshot;

  if (type === 'user') {
    const u = await visibleUser(c, b.name);
    if (u.id === c.user.id) fail(400, 'you can\'t report yourself.');
    const p = await profileData(c.env, u.id);
    targetId = u.id; targetUser = u.id;
    snapshot = { name: u.name, avatar: u.avatar, tag: p.tag, mood: p.mood, about: p.about, meet: p.meet, interests: p.interests };
  } else if (type === 'post') {
    const p = await c.env.DB.prepare(`SELECT p.id, p.kind, p.subject, p.body, p.author_id, p.target_id, p.created, a.name AS author
      FROM posts p JOIN users a ON a.id = p.author_id WHERE p.id = ?`).bind(int(b.id, 0)).first();
    if (!p || !['status', 'wall', 'bulletin', 'blog'].includes(p.kind)) fail(404, 'that post is gone.');
    if (p.author_id === c.user.id) fail(400, 'that\'s your own post — you can delete it instead.');
    targetId = p.id; targetUser = p.author_id;
    snapshot = { kind: p.kind, author: p.author, subject: p.subject, body: p.body, created: p.created };
  } else if (type === 'message') {
    const m = await c.env.DB.prepare(`SELECT m.id, m.from_id, m.to_id, m.body, m.created, f.name AS author
      FROM messages m JOIN users f ON f.id = m.from_id WHERE m.id = ?`).bind(int(b.id, 0)).first();
    // only the person who received a message can report it
    if (!m || m.to_id !== c.user.id || m.created > c.now) fail(404, 'that message is gone.');
    targetId = m.id; targetUser = m.from_id;
    snapshot = { author: m.author, body: m.body, created: m.created };
  } else fail(400, 'report a user, a post or a message.');

  await limit(c, 'report:' + c.user.id, [[10, 3600000], [40, 86400000]], 'you\'ve sent a lot of reports. a moderator will get to them.');
  const dupe = await c.env.DB.prepare('SELECT 1 AS x FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status = \'open\'')
    .bind(c.user.id, type, targetId).first();
  if (!dupe) {
    await c.env.DB.prepare(`INSERT INTO reports (reporter_id, target_type, target_id, target_user_id, reason, details, snapshot, created)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(c.user.id, type, targetId, targetUser, reason, details, JSON.stringify(snapshot), c.now).run();
  }
  return json({ ok: true }, 201);
}

/* ------------------------------------------------------------- admin */

async function log(c, action, targetType, targetId, note = '') {
  await c.env.DB.prepare('INSERT INTO mod_log (actor_id, action, target_type, target_id, note, created) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(c.user.id, action, targetType, targetId, text(note, 300), c.now).run();
}

async function setBanned(c, userId, banned, note) {
  const u = await c.env.DB.prepare('SELECT id, is_admin FROM users WHERE id = ?').bind(userId).first();
  if (!u) fail(404, 'that account no longer exists.');
  if (u.is_admin && banned) fail(400, 'admins can\'t be banned from here. remove their admin flag first.');
  const stmts = [c.env.DB.prepare('UPDATE users SET banned = ? WHERE id = ?').bind(banned ? 1 : 0, userId)];
  if (banned) stmts.push(c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId));
  await c.env.DB.batch(stmts);
  await log(c, banned ? 'ban' : 'unban', 'user', userId, note);
}

async function setHidden(c, type, id, hidden, note) {
  const table = type === 'post' ? 'posts' : type === 'message' ? 'messages' : null;
  if (!table) fail(400, 'only posts and messages can be hidden.');
  const r = await c.env.DB.prepare(`UPDATE ${table} SET hidden = ? WHERE id = ?`).bind(hidden ? 1 : 0, id).run();
  if (!r.meta.changes) fail(404, 'that is already gone (deleted by its author).');
  await log(c, hidden ? 'hide' : 'unhide', type, id, note);
}

// GET /api/admin/reports?status=open|closed
export async function adminReports(c) {
  const open = c.url.searchParams.get('status') !== 'closed';
  const { results } = await c.env.DB.prepare(`
    SELECT r.*, ${REF_COLS('rp', 'r_')}, ${REF_COLS('tu', 't_')}, tu.banned AS t_banned, rs.name AS resolver,
      CASE r.target_type WHEN 'post' THEN (SELECT hidden FROM posts WHERE id = r.target_id)
                         WHEN 'message' THEN (SELECT hidden FROM messages WHERE id = r.target_id) END AS t_hidden,
      (SELECT COUNT(*) FROM reports o WHERE o.target_user_id = r.target_user_id) AS t_reports
    FROM reports r LEFT JOIN users rp ON rp.id = r.reporter_id LEFT JOIN users tu ON tu.id = r.target_user_id
    LEFT JOIN users rs ON rs.id = r.resolved_by
    WHERE ${open ? 'r.status = \'open\'' : 'r.status != \'open\''}
    ORDER BY r.created ${open ? 'ASC' : 'DESC'} LIMIT 100`).all();
  return json({
    reports: results.map(r => {
      let snapshot = {};
      try { snapshot = JSON.parse(r.snapshot); } catch { /* keep {} */ }
      return {
        id: r.id, type: r.target_type, targetId: r.target_id, reason: r.reason, details: r.details, snapshot,
        created: r.created, status: r.status, resolution: r.resolution, resolvedAt: r.resolved_at, resolver: r.resolver,
        reporter: ref(r, 'r_'), target: ref(r, 't_'), targetBanned: !!r.t_banned,
        targetHidden: r.t_hidden == null ? null : !!r.t_hidden,   // null: the post/message was deleted
        targetReports: r.t_reports,
      };
    }),
  });
}

// POST /api/admin/reports/:id { action: dismiss | hide | ban | hide_ban, note }
export async function resolveReport(c) {
  const b = await readBody(c.req);
  const r = await c.env.DB.prepare('SELECT * FROM reports WHERE id = ?').bind(int(c.params.id, 0)).first();
  if (!r) fail(404, 'no such report.');
  const action = b.action;
  if (!['dismiss', 'hide', 'ban', 'hide_ban'].includes(action)) fail(400, 'unknown action.');
  const note = b.note || '';
  if ((action === 'hide' || action === 'hide_ban') && r.target_type !== 'user') {
    try { await setHidden(c, r.target_type, r.target_id, true, note); } catch (e) { if (e.status !== 404) throw e; }
  }
  if ((action === 'ban' || action === 'hide_ban') && r.target_user_id) await setBanned(c, r.target_user_id, true, note);
  // one decision closes every open report about the same thing
  await c.env.DB.prepare(`UPDATE reports SET status = ?, resolution = ?, resolved_by = ?, resolved_at = ?
    WHERE status = 'open' AND target_type = ? AND target_id = ?`)
    .bind(action === 'dismiss' ? 'dismissed' : 'actioned', action, c.user.id, c.now, r.target_type, r.target_id).run();
  if (action === 'dismiss') await log(c, 'dismiss', 'report', r.id, note);
  return json({ ok: true });
}

// POST /api/admin/users/:name { banned: bool, note }
export async function adminUser(c) {
  const b = await readBody(c.req);
  const u = await userByName(c.env, c.params.name);
  if (!u) fail(404, 'nobody by that name.');
  if (typeof b.banned !== 'boolean') fail(400, 'say banned: true or false.');
  if (u.id === c.user.id) fail(400, 'you can\'t ban yourself.');
  await setBanned(c, u.id, b.banned, b.note);
  return json({ ok: true });
}

// POST /api/admin/content { type: post|message, id, hidden: bool, note }
export async function adminContent(c) {
  const b = await readBody(c.req);
  if (typeof b.hidden !== 'boolean') fail(400, 'say hidden: true or false.');
  await setHidden(c, b.type, int(b.id, 0), b.hidden, b.note);
  return json({ ok: true });
}

// GET /api/admin/log
export async function adminLog(c) {
  const { results } = await c.env.DB.prepare(`
    SELECT l.id, l.action, l.target_type, l.target_id, l.note, l.created, a.name AS actor
    FROM mod_log l LEFT JOIN users a ON a.id = l.actor_id ORDER BY l.created DESC LIMIT 200`).all();
  return json({ log: results.map(l => ({ id: l.id, action: l.action, targetType: l.target_type, targetId: l.target_id, note: l.note, created: l.created, actor: l.actor })) });
}
