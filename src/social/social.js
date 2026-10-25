// The posting part: statuses, blog posts, Friends' Comments, bulletins, and the feed (statuses and blog posts from the
// people you follow). Everyone here is a real person: there are no bots.
import { fail, json, readBody, int } from '../shared/http.js';
import { text, longText } from '../shared/text.js';
import { REF_COLS, ref, refOf, visibleUser, areFriends, canSeePosts, blockedEither, limit, VISIBLE } from '../shared/db.js';

// how much one person may post (statuses, Friends' Comments, bulletins and blog posts together)
const POST_LIMITS = [[6, 60000], [300, 86400000]];

/* ------------------------------------------------------------ posts */

// POST /api/users/:name/comments { body } — a Friends' Comment on somebody's page. Only their friends write here
// (and the owner, replying).
export async function postComment(c) {
  const u = await visibleUser(c, c.params.name);
  const b = await readBody(c.req);
  const body = longText(b.body, 500);
  if (!body) fail(400, 'say something first.');
  const me = c.user.id;
  if (u.id !== me) {
    if (await blockedEither(c.env, me, u.id)) fail(403, 'you can\'t comment here.');
    if (!await areFriends(c.env, me, u.id)) fail(403, `${u.name} only takes comments from friends.`);
  }
  await limit(c, 'post:' + me, POST_LIMITS);
  const row = await c.env.DB.prepare('INSERT INTO posts (kind, author_id, target_id, body, created) VALUES (\'wall\', ?, ?, ?, ?) RETURNING id')
    .bind(me, u.id, body, c.now).first();
  return json({ id: row.id, body }, 201);
}

// POST /api/status { body } — on my page and in my followers' feeds
export async function postStatus(c) {
  const b = await readBody(c.req);
  const body = text(b.body, 500);
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

// POST /api/blog { title, subtitle, mood, body } — a long post on my page (with a page of its own) and in my
// followers' feeds
export async function postBlog(c) {
  const b = await readBody(c.req, 100000);
  const title = text(b.title, 100);
  const subtitle = text(b.subtitle, 160) || null;
  const mood = text(b.mood, 40);
  const body = longText(b.body, 20000);
  if (!title || !body) fail(400, 'a blog post needs a title and some words.');
  await limit(c, 'blog:' + c.user.id, [[10, 86400000]], 'that\'s a lot of blogging for one day.');
  await limit(c, 'post:' + c.user.id, POST_LIMITS);
  const row = await c.env.DB.prepare('INSERT INTO posts (kind, author_id, subject, subtitle, mood, body, created) VALUES (\'blog\', ?, ?, ?, ?, ?, ?) RETURNING id')
    .bind(c.user.id, title, subtitle, mood, body, c.now).first();
  return json({ id: row.id }, 201);
}

// DELETE /api/posts/:id — your own post, a comment on your own page, or anything (moderators)
export async function deletePost(c) {
  const id = int(c.params.id);
  const p = id && await c.env.DB.prepare('SELECT id, kind, author_id, target_id FROM posts WHERE id = ?').bind(id).first();
  if (!p) fail(404, 'that post is already gone.');
  const me = c.user.id;
  const mine = p.author_id === me || (p.kind === 'wall' && p.target_id === me);
  if (!(mine || c.user.is_admin)) fail(403, 'that isn\'t yours to delete.');
  await c.env.DB.prepare('DELETE FROM posts WHERE id = ?').bind(id).run();
  if (c.user.is_admin && !mine) {
    await c.env.DB.prepare('INSERT INTO mod_log (actor_id, action, target_type, target_id, created) VALUES (?, \'delete\', \'post\', ?, ?)')
      .bind(me, id, c.now).run();
  }
  return json({ ok: true });
}

/* ------------------------------------------------------- reading them */

const POST_COLS = `p.id, p.kind, p.subject, p.subtitle, p.body, p.mood, p.created, ${REF_COLS('a', 'a_')}`;
const EXCERPT = 400;                             // blog bodies in the feed and the blog index are cut at this many characters

// One post as the pages show it. A blog body longer than `cut` characters comes as an excerpt (excerpt: true); the
// post's own page (GET /api/posts/:id) has all of it.
function item(c, r, cut = 0) {
  const chars = cut && r.kind === 'blog' ? Array.from(r.body) : [];
  const excerpt = chars.length > cut;
  return {
    id: r.id, kind: r.kind, created: r.created, subject: r.subject || null, subtitle: r.subtitle || null,
    body: excerpt ? chars.slice(0, cut).join('').trimEnd() + '…' : r.body, excerpt, mood: r.mood || null,
    author: ref(r, 'a_'),
    canDelete: !!(c.user && (r.a_id === c.user.id || c.user.is_admin)),
  };
}

// a "<created>:<id>" cursor (the last item already shown) from ?before= or ?after=, else `fallback`
function cursor(c, key, fallback) {
  const [t, id] = String(c.url.searchParams.get(key) || '').split(':').map(x => int(x));
  return t && id ? [t, id] : fallback;
}
const NEWEST = c => cursor(c, 'before', [c.now + 1, Number.MAX_SAFE_INTEGER]);

// one page of items from `rows` (fetched with one extra), and the cursor for the next page if there is one
function page(c, rows, per, cut) {
  const items = rows.slice(0, per).map(r => item(c, r, cut));
  const last = items[items.length - 1];
  return { items, next: rows.length > per && last ? `${last.created}:${last.id}` : null };
}

// A post older / newer than the cursor ?3/?4 (VISIBLE, from db.js, takes ?1 viewer and ?2 now).
const BEFORE = '(p.created < ?3 OR (p.created = ?3 AND p.id < ?4))';
const AFTER = '(p.created > ?3 OR (p.created = ?3 AND p.id > ?4))';

// Whose statuses and blog posts each feed has. following: the people I follow (accepted) and me. everyone: every open
// profile. "Pick up where I left off" (and the unseen count) leaves out my own posts and anything written before I
// followed its author, so following somebody new doesn't fill the queue with their whole history.
const SCOPES = {
  following: {
    latest: '(p.author_id = ?1 OR p.author_id IN (SELECT followee_id FROM follows WHERE follower_id = ?1 AND status = \'accepted\'))',
    resume: 'p.author_id IN (SELECT followee_id FROM follows WHERE follower_id = ?1 AND status = \'accepted\' AND accepted <= p.created)',
  },
  everyone: { latest: 'a.follow_policy = \'open\'', resume: 'a.follow_policy = \'open\' AND p.author_id != ?1' },
};
const FEED_PER = 30;
const RESUME_BACK = 3 * 86400000;                // with no marker yet, "pick up where I left off" starts three days back

// GET /api/feed?scope=following|everyone&mode=latest|resume&before=|after= — statuses and blog posts. latest: newest
// first, paged with before=. resume ("pick up where I left off"): oldest first from just after my feed marker, paged
// with after=. Logged out, the scope is always everyone. Every answer also says where my marker is and how many posts
// in this scope are waiting after it in resume mode (up to 999).
export async function feed(c) {
  const q = c.url.searchParams;
  const scope = c.user && q.get('scope') !== 'everyone' ? 'following' : 'everyone';
  const resume = q.get('mode') === 'resume';
  const viewer = c.user ? c.user.id : 0;
  const m = c.user && await c.env.DB.prepare('SELECT last_created, last_id FROM markers WHERE user_id = ? AND name = \'feed\'').bind(viewer).first();
  const marker = m ? { created: m.last_created, id: m.last_id } : null;
  const from = marker ? [marker.created, marker.id] : [c.now - RESUME_BACK, 0];
  const base = `p.kind IN ('status', 'blog') AND ${VISIBLE}`;
  const unseen = `${base} AND ${SCOPES[scope].resume} AND ${AFTER}`;
  const order = resume ? 'ASC' : 'DESC';
  const DB = c.env.DB;
  const [rows, count] = await DB.batch([
    DB.prepare(`SELECT ${POST_COLS} FROM posts p JOIN users a ON a.id = p.author_id
      WHERE ${resume ? unseen : `${base} AND ${SCOPES[scope].latest} AND ${BEFORE}`}
      ORDER BY p.created ${order}, p.id ${order} LIMIT ${FEED_PER + 1}`).bind(viewer, c.now, ...(resume ? cursor(c, 'after', from) : NEWEST(c))),
    DB.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM posts p JOIN users a ON a.id = p.author_id WHERE ${unseen} LIMIT 999)`)
      .bind(viewer, c.now, ...from),
  ]);
  return json({ ...page(c, rows.results, FEED_PER, EXCERPT), marker, unseen: count.results[0].n });
}

const MARKERS = ['feed'];

// PUT /api/me/markers/:name { created, id } — how far I've read: the last post I've seen. It only moves forward (an
// older position than the stored one is ignored). Answers with the marker as it now stands.
export async function saveMarker(c) {
  if (!MARKERS.includes(c.params.name)) fail(404, 'no such marker.');
  const b = await readBody(c.req);
  const created = int(b.created), id = int(b.id);
  if (!(created > 0 && id > 0 && created <= c.now)) fail(400, 'send the created time and id of the last post you saw.');
  await limit(c, 'marker:' + c.user.id, [[120, 60000]]);
  const DB = c.env.DB;
  const [, now] = await DB.batch([
    DB.prepare(`INSERT INTO markers (user_id, name, last_created, last_id, updated) VALUES (?1, ?2, ?3, ?4, ?5)
      ON CONFLICT (user_id, name) DO UPDATE SET last_created = excluded.last_created, last_id = excluded.last_id, updated = excluded.updated
      WHERE excluded.last_created > markers.last_created OR (excluded.last_created = markers.last_created AND excluded.last_id > markers.last_id)`)
      .bind(c.user.id, c.params.name, created, id, c.now),
    DB.prepare('SELECT last_created, last_id FROM markers WHERE user_id = ? AND name = ?').bind(c.user.id, c.params.name),
  ]);
  const m = now.results[0];
  return json({ ok: true, marker: { created: m.last_created, id: m.last_id } });
}

// GET /api/bulletins?before= — the bulletin board
export async function bulletins(c) {
  const per = 20;
  const { results } = await c.env.DB.prepare(`
    SELECT ${POST_COLS} FROM posts p JOIN users a ON a.id = p.author_id
    WHERE p.kind = 'bulletin' AND ${VISIBLE} AND ${BEFORE}
    ORDER BY p.created DESC, p.id DESC LIMIT ${per + 1}`).bind(c.user ? c.user.id : 0, c.now, ...NEWEST(c)).all();
  return json(page(c, results, per));
}

// GET /api/users/:name/blog — the blog's index: every post on somebody's page, newest first, long ones cut short
export async function blogOf(c) {
  const u = await visibleUser(c, c.params.name);
  if (!await canSeePosts(c, u)) fail(403, 'this profile is private.');
  const { results } = await c.env.DB.prepare(`
    SELECT ${POST_COLS} FROM posts p JOIN users a ON a.id = p.author_id
    WHERE p.kind = 'blog' AND p.author_id = ?3 AND ${VISIBLE}
    ORDER BY p.created DESC, p.id DESC LIMIT 100`).bind(c.user ? c.user.id : 0, c.now, u.id).all();
  return json({ user: refOf(u), entries: results.map(r => item(c, r, EXCERPT)) });
}

// GET /api/users/:name/statuses?before= — somebody's statuses, newest first, 30 a page
export async function statusesOf(c) {
  const u = await visibleUser(c, c.params.name);
  if (!await canSeePosts(c, u)) fail(403, 'this profile is private.');
  const per = 30;
  const { results } = await c.env.DB.prepare(`
    SELECT ${POST_COLS} FROM posts p JOIN users a ON a.id = p.author_id
    WHERE p.kind = 'status' AND p.author_id = ?5 AND ${VISIBLE} AND ${BEFORE}
    ORDER BY p.created DESC, p.id DESC LIMIT ${per + 1}`).bind(c.user ? c.user.id : 0, c.now, ...NEWEST(c), u.id).all();
  return json(page(c, results, per));
}

const COMMENTS_PER_PAGE = 10;

// GET /api/users/:name/comments?page=N — the Friends' Comments on somebody's page, newest first, 10 a page. A page past
// the end answers with the last one (and says which page that is), so a page that just emptied needs no second call.
export async function commentsOf(c) {
  const u = await visibleUser(c, c.params.name);
  if (!await canSeePosts(c, u)) fail(403, 'this profile is private.');
  const DB = c.env.DB;
  const viewer = c.user ? c.user.id : 0;
  const from = `FROM posts p JOIN users a ON a.id = p.author_id WHERE p.kind = 'wall' AND p.target_id = ?3 AND ${VISIBLE}`;
  const { n: total } = await DB.prepare(`SELECT COUNT(*) AS n ${from}`).bind(viewer, c.now, u.id).first();
  const pages = Math.ceil(total / COMMENTS_PER_PAGE);
  const page = Math.min(Math.max(1, int(c.url.searchParams.get('page'), 1)), Math.max(1, pages));
  const { results } = await DB.prepare(`SELECT p.id, p.body, p.created, ${REF_COLS('a', 'a_')} ${from}
    ORDER BY p.created DESC, p.id DESC LIMIT ${COMMENTS_PER_PAGE} OFFSET ${(page - 1) * COMMENTS_PER_PAGE}`).bind(viewer, c.now, u.id).all();
  return json({
    comments: results.map(w => ({
      id: w.id, body: w.body, created: w.created, author: ref(w, 'a_'),
      canDelete: !!(c.user && (c.user.id === u.id || c.user.id === w.a_id || c.user.is_admin)),
    })),
    total, page, pages,
  });
}

// GET /api/posts/:id — one status or blog post in full: a blog post's own page, or a permalink. A post the viewer may
// not see (a private profile's) answers exactly like a missing one, so the answer doesn't say the post exists.
export async function onePost(c) {
  const id = int(c.params.id);
  const r = id && await c.env.DB.prepare(`
    SELECT ${POST_COLS}, a.follow_policy FROM posts p JOIN users a ON a.id = p.author_id
    WHERE p.id = ?3 AND p.kind IN ('status', 'blog') AND ${VISIBLE}`).bind(c.user ? c.user.id : 0, c.now, id).first();
  if (!r || !await canSeePosts(c, { id: r.a_id, follow_policy: r.follow_policy })) fail(404, 'that post is gone.');
  return json({ post: item(c, r) });
}
