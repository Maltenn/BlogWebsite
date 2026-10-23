// The social part: friend requests, wall comments, statuses, bulletins, blog entries, and the feed that shows them.
import { fail, json, readBody, int } from './http.js';
import { text, longText } from './text.js';
import { REF_COLS, ref, refOf, visibleUser, friendship, areFriends, blockedEither, pair, limit, NOT_BLOCKED } from './db.js';
import { botAcceptsFriend, botAnswersWall } from './bots.js';

// how much one person may post (statuses, wall comments, bulletins and blog entries together)
const POST_LIMITS = [[6, 60000], [300, 86400000]];
const USER_KINDS = ['status', 'wall', 'bulletin', 'blog'];   // kinds a person writes (and may delete)

/* ---------------------------------------------------------- friends */

// POST /api/friends/:name — send a request, or accept theirs
export async function addFriend(c) {
  const u = await visibleUser(c, c.params.name);
  const me = c.user.id;
  if (u.id === me) fail(400, 'you can\'t friend yourself. (we checked.)');
  if (await blockedEither(c.env, me, u.id)) fail(403, 'you can\'t add this person.');
  const f = await friendship(c.env, me, u.id);
  if (f && f.status === 'accepted') return json({ status: 'friends' });
  if (f && f.requested_by === u.id) {
    const [a, b] = pair(me, u.id);
    await c.env.DB.batch([
      c.env.DB.prepare('UPDATE friendships SET status = \'accepted\', accepted = ? WHERE a = ? AND b = ?').bind(c.now, a, b),
      c.env.DB.prepare('INSERT INTO posts (kind, author_id, target_id, created) VALUES (\'friends\', ?, ?, ?)').bind(u.id, me, c.now),
    ]);
    return json({ status: 'friends' });
  }
  if (f) return json({ status: 'requested' });
  await limit(c, 'friendreq:' + me, [[20, 3600000], [100, 86400000]], 'that\'s a lot of friend requests. take a breather.');
  const [a, b] = pair(me, u.id);
  await c.env.DB.prepare('INSERT INTO friendships (a, b, status, requested_by, created) VALUES (?, ?, \'pending\', ?, ?)')
    .bind(a, b, me, c.now).run();
  if (u.is_bot) {
    await botAcceptsFriend(c, u);
    return json({ status: 'friends' });
  }
  return json({ status: 'requested' });
}

// DELETE /api/friends/:name — cancel my request, decline theirs, or unfriend
export async function removeFriend(c) {
  const u = await visibleUser(c, c.params.name);
  const [a, b] = pair(c.user.id, u.id);
  await c.env.DB.prepare('DELETE FROM friendships WHERE a = ? AND b = ?').bind(a, b).run();
  return json({ status: 'none' });
}

// GET /api/requests — friend requests waiting on me, and mine waiting on others
export async function requests(c) {
  const { results } = await c.env.DB.prepare(`
    SELECT ${REF_COLS('x', '')}, f.requested_by, f.created
    FROM friendships f JOIN users x ON x.id = CASE WHEN f.a = ?1 THEN f.b ELSE f.a END
    WHERE (f.a = ?1 OR f.b = ?1) AND f.status = 'pending' AND x.banned = 0 AND ${NOT_BLOCKED('x.id')}
    ORDER BY f.created DESC LIMIT 200`).bind(c.user.id).all();
  const row = r => ({ user: ref(r), created: r.created });
  return json({
    incoming: results.filter(r => r.requested_by !== c.user.id).map(row),
    outgoing: results.filter(r => r.requested_by === c.user.id).map(row),
  });
}

/* ------------------------------------------------------------ posts */

// POST /api/users/:name/wall { body } — a comment on somebody's page (or your own)
export async function postWall(c) {
  const u = await visibleUser(c, c.params.name);
  const b = await readBody(c.req);
  const body = longText(b.body, 500);
  if (!body) fail(400, 'say something first.');
  const me = c.user.id;
  if (u.id !== me) {
    if (await blockedEither(c.env, me, u.id)) fail(403, 'you can\'t comment here.');
    if (u.wall_policy === 'friends' && !await areFriends(c.env, me, u.id)) fail(403, `${u.name} only takes comments from friends.`);
  }
  await limit(c, 'post:' + me, POST_LIMITS);
  const row = await c.env.DB.prepare('INSERT INTO posts (kind, author_id, target_id, body, created) VALUES (\'wall\', ?, ?, ?, ?) RETURNING id')
    .bind(me, u.id, body, c.now).first();
  if (u.is_bot && u.id !== me) await botAnswersWall(c, u, body);
  return json({ id: row.id, body }, 201);
}

// POST /api/status { body }
export async function postStatus(c) {
  const b = await readBody(c.req);
  const body = text(b.body, 200);
  if (!body) fail(400, 'what\'s on your mind? (you have to type it)');
  await limit(c, 'post:' + c.user.id, POST_LIMITS);
  const row = await c.env.DB.prepare('INSERT INTO posts (kind, author_id, body, created) VALUES (\'status\', ?, ?, ?) RETURNING id')
    .bind(c.user.id, body, c.now).first();
  return json({ id: row.id, body }, 201);
}

// POST /api/bulletins { subject, body } — a post to the bulletin board
export async function postBulletin(c) {
  const b = await readBody(c.req);
  const subject = text(b.subject, 80);
  const body = longText(b.body, 2000);
  if (!subject || !body) fail(400, 'a bulletin needs a subject and a message.');
  await limit(c, 'bulletin:' + c.user.id, [[3, 3600000], [10, 86400000]], 'you\'ve posted plenty of bulletins today.');
  await limit(c, 'post:' + c.user.id, POST_LIMITS);
  const row = await c.env.DB.prepare('INSERT INTO posts (kind, author_id, subject, body, created) VALUES (\'bulletin\', ?, ?, ?, ?) RETURNING id')
    .bind(c.user.id, subject, body, c.now).first();
  return json({ id: row.id }, 201);
}

// POST /api/blog { title, mood, body } — a blog entry on my page
export async function postBlog(c) {
  const b = await readBody(c.req, 40000);
  const title = text(b.title, 80);
  const mood = text(b.mood, 40);
  const body = longText(b.body, 8000);
  if (!title || !body) fail(400, 'a blog entry needs a title and some words.');
  await limit(c, 'blog:' + c.user.id, [[10, 86400000]], 'that\'s a lot of blogging for one day.');
  await limit(c, 'post:' + c.user.id, POST_LIMITS);
  const row = await c.env.DB.prepare('INSERT INTO posts (kind, author_id, subject, mood, body, created) VALUES (\'blog\', ?, ?, ?, ?, ?) RETURNING id')
    .bind(c.user.id, title, mood, body, c.now).first();
  return json({ id: row.id }, 201);
}

// DELETE /api/posts/:id — your own post, a comment on your own wall, or anything (moderators)
export async function deletePost(c) {
  const id = int(c.params.id);
  const p = id && await c.env.DB.prepare('SELECT id, kind, author_id, target_id FROM posts WHERE id = ?').bind(id).first();
  if (!p) fail(404, 'that post is already gone.');
  const me = c.user.id;
  const mine = p.author_id === me || (p.kind === 'wall' && p.target_id === me);
  if (!(c.user.is_admin || (mine && USER_KINDS.includes(p.kind)))) fail(403, 'that isn\'t yours to delete.');
  await c.env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(id).run();
  if (c.user.is_admin && !mine) {
    await c.env.DB.prepare('INSERT INTO mod_log (actor_id, action, target_type, target_id, created) VALUES (?, \'delete\', \'post\', ?, ?)')
      .bind(me, id, c.now).run();
  }
  return json({ ok: true });
}

/* ------------------------------------------------------- reading them */

const POST_COLS = `p.id, p.kind, p.subject, p.body, p.mood, p.created, ${REF_COLS('a', 'a_')}, ${REF_COLS('t', 't_')}`;

function item(c, r, excerpt = 0) {
  const viewer = c.user ? c.user.id : 0;
  const mine = r.a_id === viewer || (r.kind === 'wall' && r.t_id === viewer);
  const body = excerpt && r.body.length > excerpt ? r.body.slice(0, excerpt).trimEnd() + '…' : r.body;
  return {
    id: r.id, kind: r.kind, created: r.created, subject: r.subject || null, body, mood: r.mood || null,
    author: ref(r, 'a_'), target: ref(r, 't_'),
    canDelete: !!(c.user && USER_KINDS.includes(r.kind) && (mine || c.user.is_admin)),
  };
}

// "before" cursor = "<created>:<id>" of the last item already shown
function cursor(c) {
  const [t, id] = String(c.url.searchParams.get('before') || '').split(':').map(x => int(x));
  return t && id ? [t, id] : [c.now + 1, Number.MAX_SAFE_INTEGER];
}

// Posts the viewer may see: not hidden, not "in the future" (a bot reply still on its way), nobody banned, nobody
// blocked in either direction. Binds: ?1 viewer, ?2 now, ?3/?4 cursor.
const VISIBLE = `p.hidden = 0 AND p.created <= ?2 AND a.banned = 0 AND (t.id IS NULL OR t.banned = 0)
  AND (p.created < ?3 OR (p.created = ?3 AND p.id < ?4))
  AND ${NOT_BLOCKED('p.author_id')} AND (p.target_id IS NULL OR ${NOT_BLOCKED('p.target_id')})`;

const MY_FRIENDS = `SELECT CASE WHEN f.a = ?1 THEN f.b ELSE f.a END FROM friendships f WHERE (f.a = ?1 OR f.b = ?1) AND f.status = 'accepted'`;

// GET /api/feed?scope=all|friends|people&before= — what everyone is up to
export async function feed(c) {
  const scope = c.url.searchParams.get('scope');
  const [bt, bi] = cursor(c);
  const viewer = c.user ? c.user.id : 0;
  let extra = '';
  if (scope === 'friends' && c.user) extra = `AND (p.author_id = ?1 OR p.author_id IN (${MY_FRIENDS}))`;
  else if (scope === 'people') extra = 'AND a.is_bot = 0';
  const per = 30;
  const { results } = await c.env.DB.prepare(`
    SELECT ${POST_COLS} FROM posts p JOIN users a ON a.id = p.author_id LEFT JOIN users t ON t.id = p.target_id
    WHERE ${VISIBLE} ${extra}
    ORDER BY p.created DESC, p.id DESC LIMIT ${per + 1}`).bind(viewer, c.now, bt, bi).all();
  const items = results.slice(0, per).map(r => item(c, r, 280));
  const last = items[items.length - 1];
  return json({ items, next: results.length > per && last ? `${last.created}:${last.id}` : null });
}

// GET /api/bulletins?before= — the bulletin board
export async function bulletins(c) {
  const [bt, bi] = cursor(c);
  const per = 20;
  const { results } = await c.env.DB.prepare(`
    SELECT ${POST_COLS} FROM posts p JOIN users a ON a.id = p.author_id LEFT JOIN users t ON t.id = p.target_id
    WHERE p.kind = 'bulletin' AND ${VISIBLE}
    ORDER BY p.created DESC, p.id DESC LIMIT ${per + 1}`).bind(c.user ? c.user.id : 0, c.now, bt, bi).all();
  const items = results.slice(0, per).map(r => item(c, r));
  const last = items[items.length - 1];
  return json({ items, next: results.length > per && last ? `${last.created}:${last.id}` : null });
}

// GET /api/users/:name/blog — every blog entry on somebody's page
export async function blogOf(c) {
  const u = await visibleUser(c, c.params.name);
  const { results } = await c.env.DB.prepare(`
    SELECT ${POST_COLS} FROM posts p JOIN users a ON a.id = p.author_id LEFT JOIN users t ON t.id = p.target_id
    WHERE p.kind = 'blog' AND p.author_id = ?5 AND ${VISIBLE}
    ORDER BY p.created DESC, p.id DESC LIMIT 100`).bind(c.user ? c.user.id : 0, c.now, c.now + 1, Number.MAX_SAFE_INTEGER, u.id).all();
  return json({ user: refOf(u), entries: results.map(r => item(c, r)) });
}

// GET /api/users/:name/statuses — recent status updates (for the profile's "latest status")
export async function statusesOf(c) {
  const u = await visibleUser(c, c.params.name);
  const { results } = await c.env.DB.prepare(`
    SELECT ${POST_COLS} FROM posts p JOIN users a ON a.id = p.author_id LEFT JOIN users t ON t.id = p.target_id
    WHERE p.kind = 'status' AND p.author_id = ?5 AND ${VISIBLE}
    ORDER BY p.created DESC, p.id DESC LIMIT 10`).bind(c.user ? c.user.id : 0, c.now, c.now + 1, Number.MAX_SAFE_INTEGER, u.id).all();
  return json({ items: results.map(r => item(c, r)) });
}
