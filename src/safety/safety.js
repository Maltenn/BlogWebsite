// Safety: blocking, reporting, and the moderator tools that act on reports.
import { fail, json, readBody, int } from '../shared/http.js';
import { text, longText } from '../shared/text.js';
import { REF_COLS, ref, refOf, userByName, visibleUser, limit, profileData } from '../shared/db.js';
import { REPORT_REASONS } from '../catalog/options.js';
import { ALL_MEDIA_OF, mediaByPost, mediaOut, keyOf, dropObjects, keysIn, photoAccess, PHOTO_ROWS } from '../shared/media.js';
import { AVATARS } from '../catalog/avatars.js';
import { tell, kick, signOut, setApart, OURSPACE } from '../shared/live.js';

const REASONS = new Set(REPORT_REASONS.map(r => r.v));
export const TAKEDOWN_MS = 48 * 3600000;       // the Take It Down Act's 48 hours (and what we hold ourselves to for CSAM reports)

/* ------------------------------------------------------------ blocks */

// GET /api/blocks — the people I've blocked
export async function listBlocks(c) {
  const { results } = await c.env.DB.prepare(`
    SELECT ${REF_COLS('u', '')}, b.created FROM blocks b JOIN users u ON u.id = b.blocked_id
    WHERE b.blocker_id = ? ORDER BY b.created DESC`).bind(c.user.id).all();
  return json({ blocked: results.map(r => ({ user: ref(r), created: r.created })) });
}

// POST /api/blocks/:name — they can't message me, comment on my page or follow me, and we stop seeing each other's
// posts and chat messages. Every follow (or request) between us, either way, ends, and our DM closes on both screens;
// in the rooms we both may have open (#ourspace, our groups) our sockets stop showing each other typing or online at once.
export async function block(c) {
  const u = await userByName(c.env, c.params.name);
  if (!u) fail(404, 'nobody by that name lives here.');
  if (u.id === c.user.id) fail(400, 'you can\'t block yourself. (tempting, we know.)');
  await limit(c, 'block:' + c.user.id, [[30, 3600000]]);
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT OR IGNORE INTO blocks (blocker_id, blocked_id, created) VALUES (?, ?, ?)').bind(c.user.id, u.id, c.now),
    c.env.DB.prepare('DELETE FROM follows WHERE (follower_id = ?1 AND followee_id = ?2) OR (follower_id = ?2 AND followee_id = ?1)').bind(c.user.id, u.id),
  ]);
  const dm = await c.env.DB.prepare('SELECT id FROM conversations WHERE dm_key = ?').bind(`${Math.min(c.user.id, u.id)}:${Math.max(c.user.id, u.id)}`).first();
  if (dm) await kick(c.env, dm.id, [c.user.id, u.id]);
  await setApart(c.env, c.user.id, u.id, true);
  return json({ ok: true, blocked: refOf(u) });
}

// DELETE /api/blocks/:name
export async function unblock(c) {
  const u = await userByName(c.env, c.params.name);
  if (!u) fail(404, 'nobody by that name lives here.');
  const [gone, still] = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').bind(c.user.id, u.id),
    c.env.DB.prepare('SELECT 1 AS x FROM blocks WHERE blocker_id = ? AND blocked_id = ?').bind(u.id, c.user.id),
  ]);
  // (open sockets see each other again only once no block is left either way)
  if (gone.meta.changes && !still.results.length) await setApart(c.env, c.user.id, u.id, false);
  return json({ ok: true });
}

/* ----------------------------------------------------------- reports */

// POST /api/reports { type: user|post|message, name | id, reason, details } — a message is a chat message (#ourspace,
// a group or a DM), reported by someone who can read it (a member, for a group or DM) who didn't write it. Anyone signed
// in may report, a new or held account too (a victim must always be able to), and a post they can no longer see.
// Stores a snapshot of what was reported, so the evidence survives the author deleting it: with the reported thing's
// own photos ({ id, url, width, height, alt }: a post's, or a profile's uploaded picture; messages have none), never
// another member's (a quote's original is that member's own post: report it). A `csam` report always lists those photos
// (report_holds), so that until a moderator decides nothing their owner does destroys them, and is always filed, at the
// top of the queue. It also hides them at once (an auto-hide), if it may: its reporter is a verified member in good
// standing who can see them (photoAccess), hasn't had a csam report dismissed in 30 days and hasn't auto-hidden 3 things
// in a day, and no moderator dismissed a csam report about that photo in 30 days. It holds nothing at account level: only
// a moderator's `confirm` does. A repeat while the member's report is open changes nothing.
export async function report(c) {
  const b = await readBody(c.req);
  const type = b.type;
  const reason = b.reason;
  if (!REASONS.has(reason)) fail(400, 'pick a reason.');
  const details = longText(b.details, 1000);
  const DB = c.env.DB;
  let targetId, targetUser, snapshot;

  if (type === 'user') {
    const u = await visibleUser(c, b.name);
    if (u.id === c.user.id) fail(400, 'you can\'t report yourself.');
    const p = await profileData(c.env, u.id);
    targetId = u.id; targetUser = u.id;
    const key = keyOf(u.avatar);
    const pic = key && await DB.prepare('SELECT id, key, width, height, alt FROM media WHERE key = ? AND owner_id = ?').bind(key, u.id).first();
    snapshot = { name: u.name, avatar: u.avatar, tag: p.tag, mood: p.mood, about: p.about, meet: p.meet, interests: p.interests, media: pic ? [mediaOut(pic)] : [] };
  } else if (type === 'post') {
    const p = await DB.prepare(`SELECT p.id, p.kind, p.subject, p.body, p.author_id, p.target_id, p.created, a.name AS author
      FROM posts p JOIN users a ON a.id = p.author_id WHERE p.id = ?`).bind(int(b.id, 0)).first();
    if (!p) fail(404, 'that post is gone.');
    if (p.author_id === c.user.id) fail(400, 'that\'s your own post — you can delete it instead.');
    targetId = p.id; targetUser = p.author_id;
    // its own photos, hidden ones included (moderators can open them, whatever their privacy, and they're kept even if
    // the author deletes the post once a moderator hid it or them; removing one is POST /api/admin/media/:id)
    const { results: photos } = await DB.prepare(ALL_MEDIA_OF).bind(JSON.stringify([p.id])).all();
    const { media, covers } = mediaByPost(photos);
    snapshot = { kind: p.kind, author: p.author, subject: p.subject, body: p.body, created: p.created,
      media: [...(covers.has(p.id) ? [covers.get(p.id)] : []), ...(media.get(p.id) || [])] };
  } else if (type === 'message') {
    const m = await DB.prepare(`SELECT m.id, m.author_id, m.body, m.created, m.conversation_id, m.room, f.name AS author,
        (m.room IS NOT NULL OR EXISTS (SELECT 1 FROM conversation_members cm WHERE cm.conversation_id = m.conversation_id
          AND cm.user_id = ?2 AND cm.status = 'joined')) AS reader
      FROM chat_messages m JOIN users f ON f.id = m.author_id WHERE m.id = ?1 AND m.deleted = 0 AND m.hidden = 0`).bind(int(b.id, 0), c.user.id).first();
    if (!m || !m.reader || m.author_id === c.user.id) fail(404, 'that message is gone.');
    targetId = m.id; targetUser = m.author_id;
    snapshot = { author: m.author, body: m.body, created: m.created, chatId: m.conversation_id, room: m.room, media: [] };
  } else fail(400, 'report a user, a post or a message.');

  await limit(c, 'report:' + c.user.id, [[10, 3600000], [40, 86400000]], 'you\'ve sent a lot of reports. a moderator will get to them.');
  const csam = reason === 'csam';
  const dupe = await DB.prepare('SELECT id FROM reports WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status = \'open\' AND (? = 0 OR reason = \'csam\')')
    .bind(c.user.id, type, targetId, csam ? 1 : 0).first();
  if (dupe) return json({ ok: true }, 201);
  const filed = await DB.prepare(`INSERT INTO reports (reporter_id, target_type, target_id, target_user_id, reason, details, snapshot, created)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).bind(c.user.id, type, targetId, targetUser, reason, details, JSON.stringify(snapshot), c.now).first();
  if (csam && snapshot.media.length) {
    const ids = snapshot.media.map(m => m.id);
    const hide = await autoHides(c, ids);
    await DB.batch([
      ...hideFor(DB, filed.id, ids, hide),
      ...(hide.length ? [DB.prepare('INSERT INTO attempts (k, created) VALUES (?, ?)').bind('autohide:' + c.user.id, c.now)] : []),
    ]);
  }
  return json({ ok: true }, 201);
}

const AUTO_HIDES_A_DAY = 3;
const QUIET_MS = 30 * 86400000;                  // after a dismissal: no auto-hide of that photo, nor by that reporter

// Which of photos `ids` (a new csam report's own) this report may hide at once: those its reporter can see, if the
// reporter may auto-hide at all (above). Anything else is listed, filed, and waits for a moderator.
async function autoHides(c, ids) {
  const DB = c.env.DB;
  if (!(c.user.is_admin || (c.user.email_verified_at && !c.user.held))) return [];
  const [burned, today, quiet, rows] = await DB.batch([
    DB.prepare('SELECT 1 AS x FROM reports WHERE reporter_id = ? AND reason = \'csam\' AND status = \'dismissed\' AND resolved_at > ? LIMIT 1').bind(c.user.id, c.now - QUIET_MS),
    DB.prepare('SELECT COUNT(*) AS n FROM attempts WHERE k = ? AND created > ?').bind('autohide:' + c.user.id, c.now - 86400000),
    // (the photos csam reports a moderator dismissed in the last 30 days listed: a snapshot that isn't a list of photos lists none)
    DB.prepare(`SELECT json_extract(j.value, '$.id') AS id FROM reports d, json_each(CASE WHEN json_valid(d.snapshot) AND json_type(d.snapshot, '$.media') = 'array'
        THEN json_extract(d.snapshot, '$.media') ELSE '[]' END) j
      WHERE d.reason = 'csam' AND d.status = 'dismissed' AND d.resolved_at > ? AND j.type = 'object'`).bind(c.now - QUIET_MS),
    DB.prepare(`${PHOTO_ROWS} WHERE m.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(ids)),
  ]);
  if (!c.user.is_admin && (burned.results.length || today.results[0].n >= AUTO_HIDES_A_DAY)) return [];
  const settled = new Set(quiet.results.map(r => r.id));
  const seen = [];
  // (as it was before any report hid it: a second reporter saw what the first did)
  for (const m of rows.results) if (!settled.has(m.id) && await photoAccess(c, { ...m, hidden: m.hold_hidden ? 0 : m.hidden })) seen.push(m.id);
  return seen;
}

// SQL statements making report `reportId` list photos `ids` (report_holds: while it's open or confirmed the server
// refuses Remove and Unhide on them, and their owner can't destroy them) and hide those of `hide` still shown, marked
// as its own hide (hold_hidden), so that ending the report undoes exactly those. Safe to repeat.
function hideFor(DB, reportId, ids, hide = ids) {
  return [
    DB.prepare('INSERT OR IGNORE INTO report_holds (report_id, kind, target) SELECT ?1, \'media\', id FROM media WHERE id IN (SELECT value FROM json_each(?2))').bind(reportId, JSON.stringify(ids)),
    DB.prepare('UPDATE media SET hidden = 1, hold_hidden = 1 WHERE hidden = 0 AND id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(hide)),
  ];
}

// SQL: photo row `media`'s owner is not under a child-safety hold
const OWNER_FREE = '(media.owner_id IS NULL OR media.owner_id NOT IN (SELECT user_id FROM held_accounts))';

// SQL: the photos report ?1 lists that nothing else holds (another open or confirmed report, a confirmed account hold)
const ONLY_THIS = `id IN (SELECT target FROM report_holds WHERE report_id = ?1 AND kind = 'media') AND id NOT IN (SELECT media_id FROM held_photos)`;

// The cron's part: once no hold is left on an account, what was kept for it goes, as its owner had asked (a deletion
// finishing late): the copies, and the photos the hold itself hid (hold_hidden, keepForHold in src/shared/media.js), out
// of R2; one its owner put back on a post since is simply shown again. A photo hidden for any other reason (a moderator,
// a report still open) is left as it is. And a photo a moderator confirmed as apparent CSAM is deleted once nothing
// holds it any more (its report released, no other report or hold on it): it is never shown again.
export async function sweepEvidence(env) {
  const free = 'user_id NOT IN (SELECT user_id FROM held_accounts)';
  const released = `media.hold_hidden = 1 AND media.csam_confirmed = 0 AND media.id NOT IN (SELECT media_id FROM held_photos) AND media.id IN (
    SELECT source_id FROM evidence WHERE source = 'photo' AND ${free})`;
  const confirmed = `media.csam_confirmed = 1 AND media.id NOT IN (SELECT media_id FROM held_photos) AND ${OWNER_FREE}`;
  const res = await env.DB.batch([
    env.DB.prepare(`UPDATE media SET hidden = 0, hold_hidden = 0 WHERE ${released} AND post_id IS NOT NULL`),
    env.DB.prepare(`DELETE FROM media WHERE ${released} AND post_id IS NULL
      AND (owner_id IS NULL OR purpose != 'avatar' OR '/media/' || key IS NOT (SELECT avatar FROM users WHERE id = media.owner_id)) RETURNING key`),
    env.DB.prepare(`UPDATE users SET avatar = ? WHERE avatar IN (SELECT '/media/' || key FROM media WHERE ${confirmed})`).bind(AVATARS[0].file),
    env.DB.prepare(`DELETE FROM media WHERE ${confirmed} RETURNING key`),
    env.DB.prepare(`DELETE FROM evidence WHERE ${free}`),
  ]);
  await dropObjects(env, keysIn(res[1], res[3]));
}

/* ------------------------------------------------------------- admin */

// a moderation-log line, as a statement for a batch
const logLine = (c, action, targetType, targetId, note = '') => c.env.DB.prepare('INSERT INTO mod_log (actor_id, action, target_type, target_id, note, created) VALUES (?, ?, ?, ?, ?, ?)')
  .bind(c.user.id, action, targetType, targetId, text(note, 300), c.now);
async function log(c, action, targetType, targetId, note = '') {
  await logLine(c, action, targetType, targetId, note).run();
}

async function setBanned(c, userId, banned, note) {
  const u = await c.env.DB.prepare('SELECT id, is_admin FROM users WHERE id = ?').bind(userId).first();
  if (!u) fail(404, 'that account no longer exists.');
  if (u.is_admin && banned) fail(400, 'admins can\'t be banned from here. remove their admin flag first.');
  const stmts = [c.env.DB.prepare('UPDATE users SET banned = ? WHERE id = ?').bind(banned ? 1 : 0, userId)];
  if (banned) stmts.push(c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId));
  await c.env.DB.batch(stmts);
  // a banned member's chat sockets close at once (code 4001), in every room they may have open
  if (banned) await signOut(c.env, userId);
  await log(c, banned ? 'ban' : 'unban', 'user', userId, note);
}

async function setHidden(c, type, id, hidden, note) {
  const table = type === 'post' ? 'posts' : type === 'message' ? 'chat_messages' : null;
  if (!table) fail(400, 'only posts and messages can be hidden.');
  const r = await c.env.DB.prepare(`UPDATE ${table} SET hidden = ? WHERE id = ? RETURNING ${type === 'message' ? 'conversation_id, room' : 'id'}`).bind(hidden ? 1 : 0, id).first();
  if (!r) fail(404, 'that is already gone (deleted by its author).');
  await log(c, hidden ? 'hide' : 'unhide', type, id, note);
  // a chat message taken down leaves the screens of everyone connected
  if (type === 'message' && hidden) await tell(c.env, r.room ? OURSPACE : r.conversation_id, { type: 'deleted', id });
}

// GET /api/admin/reports?status=open|closed — open ones: child-safety (csam) reports first, then oldest first. `deadline`:
// when the 48 hours run out for a csam report or one marked intimate, else null. Each photo in a snapshot says how it
// stands now, whatever it was when reported: hidden, held (by a child-safety hold) and gone (removed). `preserved`: how
// many things are kept for the accounts this report holds (their deletion is waiting for it; migrations/0014).
export async function adminReports(c) {
  const open = c.url.searchParams.get('status') !== 'closed';
  const { results } = await c.env.DB.prepare(`
    SELECT r.*, ${REF_COLS('rp', 'r_')}, ${REF_COLS('tu', 't_')}, tu.banned AS t_banned, rs.name AS resolver,
      CASE r.target_type WHEN 'post' THEN (SELECT hidden FROM posts WHERE id = r.target_id)
                         WHEN 'message' THEN (SELECT hidden FROM chat_messages WHERE id = r.target_id) END AS t_hidden,
      (SELECT COUNT(*) FROM reports o WHERE o.target_user_id = r.target_user_id) AS t_reports,
      (SELECT COUNT(*) FROM evidence e WHERE e.user_id IN (SELECT h.target FROM report_holds h WHERE h.report_id = r.id AND h.kind = 'user')) AS t_preserved
    FROM reports r LEFT JOIN users rp ON rp.id = r.reporter_id LEFT JOIN users tu ON tu.id = r.target_user_id
    LEFT JOIN users rs ON rs.id = r.resolved_by
    WHERE ${open ? 'r.status = \'open\'' : 'r.status != \'open\''}
    ORDER BY ${open ? "r.reason != 'csam', r.created ASC" : 'r.created DESC'} LIMIT 100`).all();
  const parsed = new Map(results.map(r => {
    try { return [r.id, JSON.parse(r.snapshot)]; } catch { return [r.id, {}]; }
  }));
  const ids = [...parsed.values()].flatMap(s => (s.media || []).map(m => m.id));
  const { results: live } = await c.env.DB.prepare('SELECT id, hidden, id IN (SELECT media_id FROM held_photos) AS held FROM media WHERE id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(ids)).all();
  const photos = new Map(live.map(m => [m.id, m]));
  const asItIs = m => {
    const now = photos.get(m.id);
    return { ...m, hidden: !!(now && now.hidden), held: !!(now && now.held), gone: !now };
  };
  return json({
    reports: results.map(r => {
      const s = parsed.get(r.id);
      const snapshot = s.media ? { ...s, media: s.media.map(asItIs) } : s;
      return {
        id: r.id, type: r.target_type, targetId: r.target_id, reason: r.reason, details: r.details, snapshot,
        created: r.created, status: r.status, resolution: r.resolution, resolvedAt: r.resolved_at, resolver: r.resolver,
        reporter: ref(r, 'r_'), target: ref(r, 't_'), targetBanned: !!r.t_banned,
        targetHidden: r.t_hidden == null ? null : !!r.t_hidden,   // null: the post/message was deleted
        targetReports: r.t_reports, intimate: !!r.intimate, preserved: r.t_preserved,
        deadline: r.reason === 'csam' || r.intimate ? r.created + TAKEDOWN_MS : null,   // the 48-hour clock
      };
    }),
  });
}

// POST /api/admin/reports/:id { action, note } — a decision on an open report (409 once it's closed):
//   dismiss                nothing wrong: closes it and the other open reports about the same thing (not csam ones)
//   hide | ban | hide_ban  the post or message hidden, the account banned (a profile has nothing to hide: ban it)
//   intimate               marked "intimate image without consent": the 48-hour clock, from when it was filed; stays open
//   csam                   it turns out to be child safety (the person shown may be under 18): it becomes a csam report and
//                          hides its own photos, its clock unchanged; stays open
// A csam report is decided by itself, one at a time, and only so:
//   confirm  apparent CSAM, with a note (the NCMEC report number). The account-level hold starts (held_accounts) and the
//            account is banned in the same batch, so its owner can never notice the hold; the report's own photos are
//            hidden and listed. Another csam report about the same thing stays for its own decision.
//   dismiss  not CSAM, with a note: what this report hid is shown again, unless something else holds it.
//   release  on a confirmed one, with a note, once the year is over or a lawyer says so: its own photos (the confirmed
//            material) are deleted, or, while another report or hold still has them, by the cron once nothing does;
//            what the account hold kept goes with the next cron (sweepEvidence). A confirmed photo is never shown again
//            but by an override.
// Nothing else ends or starts a hold: a decision on another report about the same thing leaves a csam report open.
export async function resolveReport(c) {
  const b = await readBody(c.req);
  const DB = c.env.DB;
  const r = await DB.prepare('SELECT * FROM reports WHERE id = ?').bind(int(c.params.id, 0)).first();
  if (!r) fail(404, 'no such report.');
  const action = b.action;
  if (!['dismiss', 'hide', 'ban', 'hide_ban', 'intimate', 'csam', 'confirm', 'release'].includes(action)) fail(400, 'unknown action.');
  const note = text(b.note, 300);
  const csam = r.reason === 'csam';
  let snapshot = {};
  try { snapshot = JSON.parse(r.snapshot); } catch { /* nothing listed */ }
  const own = (snapshot.media || []).map(m => m.id).filter(Number.isInteger);
  const closeThis = (status, resolution) => DB.prepare('UPDATE reports SET status = ?2, resolution = ?3, resolved_by = ?4, resolved_at = ?5 WHERE id = ?1')
    .bind(r.id, status, resolution, c.user.id, c.now);

  if (action === 'release') {
    if (r.status !== 'confirmed') fail(409, 'only a confirmed child-safety report has a hold to release.');
    if (!note) fail(400, 'ending a hold needs a note: why, and on whose word.');
    const res = await DB.batch([
      closeThis('released', 'release'),
      // (unless another report or hold still has them, the account included: the cron deletes those when it ends)
      DB.prepare(`UPDATE users SET avatar = ?2 WHERE avatar IN (SELECT '/media/' || key FROM media WHERE ${ONLY_THIS} AND ${OWNER_FREE})`).bind(r.id, AVATARS[0].file),
      DB.prepare(`DELETE FROM media WHERE ${ONLY_THIS} AND ${OWNER_FREE} RETURNING key`).bind(r.id),
      DB.prepare('DELETE FROM report_holds WHERE report_id = ?').bind(r.id),
      logLine(c, 'release_hold', 'report', r.id, note),
    ]);
    await dropObjects(c.env, keysIn(res[2]));
    return json({ ok: true });
  }
  if (r.status !== 'open') fail(409, 'that report is already closed.');
  if (csam && action !== 'confirm' && action !== 'dismiss') fail(409, 'a child-safety report is confirmed (once you have reported it to NCMEC) or dismissed, by itself.');

  if (action === 'confirm') {
    if (!csam) fail(409, 'only a child-safety report can be confirmed: press "may be under 18" first.');
    if (!note) fail(400, 'confirming needs a note: the NCMEC report number, and what you saw.');
    const u = r.target_user_id && await DB.prepare('SELECT id, is_admin FROM users WHERE id = ?').bind(r.target_user_id).first();
    if (u && u.is_admin) fail(400, 'admins can\'t be banned from here. remove their admin flag first.');
    await DB.batch([
      closeThis('confirmed', 'confirm'),
      DB.prepare(`UPDATE reports SET status = 'actioned', resolution = 'confirm', resolved_by = ?3, resolved_at = ?4
        WHERE status = 'open' AND target_type = ?1 AND target_id = ?2 AND reason != 'csam'`).bind(r.target_type, r.target_id, c.user.id, c.now),
      ...hideFor(DB, r.id, own, []),
      // (confirmed: hidden for good, and no longer any report's hide to undo: only an override shows it again)
      DB.prepare('UPDATE media SET hidden = 1, hold_hidden = 0, csam_confirmed = 1 WHERE id IN (SELECT value FROM json_each(?))').bind(JSON.stringify(own)),
      ...(u ? [
        DB.prepare('INSERT OR IGNORE INTO report_holds (report_id, kind, target) VALUES (?, \'user\', ?)').bind(r.id, u.id),
        DB.prepare('UPDATE users SET banned = 1 WHERE id = ?').bind(u.id),
        DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(u.id),
        logLine(c, 'ban', 'user', u.id, 'confirmed child-safety report #' + r.id),
      ] : []),
      logLine(c, 'confirm_csam', 'report', r.id, note),
    ]);
    if (u) await signOut(c.env, u.id);
    return json({ ok: true });
  }
  if (action === 'dismiss' && csam) {
    if (!note) fail(400, 'dismissing a child-safety report needs a note: why it isn\'t what it says.');
    await DB.batch([
      closeThis('dismissed', 'dismiss'),
      DB.prepare(`UPDATE media SET hidden = 0, hold_hidden = 0 WHERE hold_hidden = 1 AND csam_confirmed = 0 AND ${ONLY_THIS}`).bind(r.id),
      DB.prepare('DELETE FROM report_holds WHERE report_id = ?').bind(r.id),
      logLine(c, 'dismiss', 'report', r.id, note),
    ]);
    return json({ ok: true });
  }
  if (action === 'intimate') {
    await DB.prepare('UPDATE reports SET intimate = 1 WHERE id = ?').bind(r.id).run();
    await log(c, 'mark_intimate', 'report', r.id, note);
    return json({ ok: true });
  }
  if (action === 'csam') {
    await DB.batch([
      DB.prepare('UPDATE reports SET reason = \'csam\', intimate = 0 WHERE id = ?').bind(r.id),
      ...hideFor(DB, r.id, own),
      logLine(c, 'mark_csam', 'report', r.id, `was ${r.reason}${note ? ': ' + note : ''}`),
    ]);
    return json({ ok: true });
  }
  if ((action === 'hide' || action === 'hide_ban') && r.target_type === 'user') fail(400, 'a profile has nothing to hide: ban the account, or dismiss the report.');
  if (action === 'hide' || action === 'hide_ban') {
    try { await setHidden(c, r.target_type, r.target_id, true, note); } catch (e) { if (e.status !== 404) throw e; }
  }
  if ((action === 'ban' || action === 'hide_ban') && r.target_user_id) await setBanned(c, r.target_user_id, true, note);
  // one decision closes every open report about the same thing, but never a csam one: only its own decision does
  await DB.prepare(`UPDATE reports SET status = ?1, resolution = ?2, resolved_by = ?3, resolved_at = ?4
    WHERE status = 'open' AND target_type = ?5 AND target_id = ?6 AND reason != 'csam'`)
    .bind(action === 'dismiss' ? 'dismissed' : 'actioned', action, c.user.id, c.now, r.target_type, r.target_id).run();
  if (action === 'dismiss') await log(c, 'dismiss', 'report', r.id, note);
  return json({ ok: true });
}

// POST /api/admin/users/:name { banned: bool, note } — an account under a child-safety hold stays banned until the hold
// is released: unbanned, what the hold keeps (its sweeps paused, its photos kept) would show.
export async function adminUser(c) {
  const b = await readBody(c.req);
  const u = await userByName(c.env, c.params.name);
  if (!u) fail(404, 'nobody by that name.');
  if (typeof b.banned !== 'boolean') fail(400, 'say banned: true or false.');
  if (u.id === c.user.id) fail(400, 'you can\'t ban yourself.');
  if (!b.banned && await c.env.DB.prepare('SELECT 1 AS x FROM held_accounts WHERE user_id = ?').bind(u.id).first()) {
    fail(409, 'this account is under a child-safety hold: it stays banned until the hold is released (docs/operations.md).');
  }
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
