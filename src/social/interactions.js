// Replies, likes, reposts, quotes and bookmarks, on statuses, blog posts, replies and quotes. A repost stands for its
// original: replying to, liking, reposting, quoting or bookmarking one acts on the post it reposts. Every count moves
// in the same batch as the write that changes it, and only when that write really happens, so the counts stay exact.
import { fail, json, readBody, int } from '../shared/http.js';
import { text } from '../shared/text.js';
import { canSeePosts, limit, VISIBLE, SEES } from '../shared/db.js';
import { notify } from '../shared/notify.js';
import { claimMedia } from '../shared/media.js';
import { bump, W } from '../shared/affinity.js';
import { POST_LIMITS, THREADED_SQL, POST_COLS, POSTS, EXCERPT, NEWEST, LIVE, page, itemById, writePost, dropRepost, heldOut } from './items.js';

// SQL: the post :id (bound as ?3) stands for: itself, or a repost's original
const STANDS_FOR = '(SELECT CASE WHEN kind = \'repost\' THEN quote_of ELSE id END FROM posts WHERE id = ?3)';

// The post being replied to, liked, reposted, quoted or bookmarked. Anything the viewer may not see, or that takes no
// interactions (Friends' Comments; board threads and comments take votes instead), is "gone".
async function target(c) {
  const id = int(c.params.id);
  const p = id && await c.env.DB.prepare(`SELECT p.id, p.author_id, p.root_id, a.follow_policy FROM posts p JOIN users a ON a.id = p.author_id
    WHERE p.id = ${STANDS_FOR} AND p.kind IN (${THREADED_SQL}) AND ${VISIBLE}`).bind(c.user.id, c.now, id).first();
  if (!p || !await canSeePosts(c, { id: p.author_id, follow_policy: p.follow_policy })) fail(404, 'that post is gone.');
  return p;
}

// Reposts and quotes are only for posts from open profiles (like Twitter's protected accounts): a private profile's
// posts are for its followers.
function shareable(p) {
  if (p.follow_policy === 'approve') fail(403, 'posts from private profiles can\'t be reposted or quoted.');
}

// The post an undo is about: { id, seen }. Undoing works whether or not the viewer may still see the post, but only one
// they may see (seen) gets its count in the answer: for any other, missing or not, the answer is the same, so it never
// says whether a post the viewer can't see is there, or how it's doing. (id is 0 when there's no such post.)
async function undoing(c) {
  const id = int(c.params.id);
  const p = id && await c.env.DB.prepare(`SELECT p.id, p.author_id, a.follow_policy, (p.kind IN (${THREADED_SQL}) AND ${VISIBLE}) AS ok
    FROM posts p JOIN users a ON a.id = p.author_id WHERE p.id = ${STANDS_FOR}`).bind(c.user.id, c.now, id).first();
  if (!p) return { id: 0, seen: false };
  return { id: p.id, seen: !!p.ok && await canSeePosts(c, { id: p.author_id, follow_policy: p.follow_policy }) };
}

const count = (DB, col, id) => DB.prepare(`SELECT ${col} AS n FROM posts WHERE id = ?`).bind(id);

// The answer to a like, repost or bookmark: the last statement of its batch (the post's `col`, or 0 for none) read back.
// A post deleted or hidden between target() and the batch took nothing, so it's gone after all.
const landed = (DB, col, id) => DB.prepare(`SELECT ${col} AS n FROM posts WHERE id = ? AND deleted = 0 AND hidden = 0`).bind(id);
function after(res) {
  const row = res.at(-1).results[0];
  if (!row) fail(404, 'that post is gone.');
  return row.n;
}

/* --------------------------------------------------- replies, quotes */

// POST /api/posts/:id/replies { body, media? } — a reply (up to 500 characters, up to 4 photos: with a photo the words
// may be left out) in the post's conversation. The author of the post it answers hears about it, and so does anyone it
// @mentions, if they may see it.
export async function postReply(c) {
  const parent = await target(c);
  const b = await readBody(c.req);
  const body = text(b.body, 500);
  const media = await claimMedia(c, 'reply', b.media);
  if (!body && !media.length) fail(400, 'say something first.');
  await limit(c, 'post:' + c.user.id, POST_LIMITS);
  const id = await writePost(c, { kind: 'reply', body, reply_to: parent.id, root_id: parent.root_id || parent.id }, {
    mentionIn: body, tagIn: body, tell: [['reply', parent.author_id]], on: parent.id, media,
    more: [c.env.DB.prepare(`UPDATE posts SET reply_count = reply_count + 1 WHERE id = ? AND deleted = 0 AND hidden = 0`).bind(parent.id)],
  });
  return json({ post: await itemById(c, id), ...heldOut(c) }, 201);
}

// POST /api/posts/:id/quote { body, media? } — a post of my own (up to 500 characters, up to 4 photos: with a photo
// the words may be left out) with this one in a box under it
export async function postQuote(c) {
  const p = await target(c);
  shareable(p);
  const b = await readBody(c.req);
  const body = text(b.body, 500);
  const media = await claimMedia(c, 'quote', b.media);
  if (!body && !media.length) fail(400, 'say something about it (or repost it instead).');
  await limit(c, 'post:' + c.user.id, POST_LIMITS);
  const id = await writePost(c, { kind: 'quote', body, quote_of: p.id }, {
    mentionIn: body, tagIn: body, tell: [['quote', p.author_id]], on: p.id, media,
    more: [c.env.DB.prepare(`UPDATE posts SET quote_count = quote_count + 1 WHERE id = ? AND deleted = 0 AND hidden = 0`).bind(p.id)],
  });
  return json({ post: await itemById(c, id), ...heldOut(c) }, 201);
}

/* ------------------------------------------------------------- likes */

// POST /api/posts/:id/like — answers { liked, likes }. Liking twice is liking once (and moves the interaction score once).
export async function likePost(c) {
  const p = await target(c);
  await limit(c, 'like:' + c.user.id, [[300, 3600000]], 'that\'s a lot of likes. take a breather.');
  const DB = c.env.DB;
  const fresh = 'NOT EXISTS (SELECT 1 FROM likes WHERE user_id = ?1 AND post_id = ?2)';
  const res = await DB.batch([
    DB.prepare(`UPDATE posts SET like_count = like_count + 1 WHERE id = ?2 AND deleted = 0 AND hidden = 0 AND ${fresh}`).bind(c.user.id, p.id),
    notify(c, 'like', [p.author_id], p.id, fresh.replace('?2', '?5')),
    bump(c, [[p.author_id, W.like]], `${fresh.replace('?2', '?4')} AND ${LIVE('?4')}`, p.id),
    DB.prepare(`INSERT OR IGNORE INTO likes (user_id, post_id, created) SELECT ?1, ?2, ?3 WHERE ${LIVE('?2')}`).bind(c.user.id, p.id, c.now),
    landed(DB, 'like_count', p.id),
  ].filter(Boolean));
  return json({ liked: true, likes: after(res) });
}

// DELETE /api/posts/:id/like — answers { liked: false, likes } ({ liked: false } for a post I may not see, or none),
// and takes back the notification
export async function unlikePost(c) {
  const { id, seen } = await undoing(c);
  const DB = c.env.DB;
  const res = await DB.batch([
    DB.prepare('UPDATE posts SET like_count = like_count - 1 WHERE id = ?2 AND EXISTS (SELECT 1 FROM likes WHERE user_id = ?1 AND post_id = ?2)').bind(c.user.id, id),
    DB.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').bind(c.user.id, id),
    DB.prepare('DELETE FROM notifications WHERE kind = \'like\' AND actor_id = ? AND post_id = ?').bind(c.user.id, id),
    count(DB, 'like_count', id),
  ]);
  return json(seen ? { liked: false, likes: res.at(-1).results[0].n } : { liked: false });
}

/* ----------------------------------------------------------- reposts */

// POST /api/posts/:id/repost — answers { reposted, reposts }. One repost per person per post; reposting a repost
// reposts its original. You can repost your own posts (from an open profile).
export async function repostPost(c) {
  const p = await target(c);
  shareable(p);
  await limit(c, 'repost:' + c.user.id, [[60, 3600000]], 'that\'s a lot of reposting. take a breather.');
  const DB = c.env.DB;
  const fresh = 'NOT EXISTS (SELECT 1 FROM posts WHERE kind = \'repost\' AND author_id = ?1 AND quote_of = ?2)';
  const res = await DB.batch([
    DB.prepare(`UPDATE posts SET repost_count = repost_count + 1 WHERE id = ?2 AND deleted = 0 AND hidden = 0 AND ${fresh}`).bind(c.user.id, p.id),
    notify(c, 'repost', [p.author_id], p.id, fresh.replace('?2', '?5')),
    bump(c, [[p.author_id, W.repost]], `${fresh.replace('?2', '?4')} AND ${LIVE('?4')}`, p.id),
    DB.prepare(`INSERT OR IGNORE INTO posts (kind, author_id, quote_of, created) SELECT 'repost', ?1, ?2, ?3 WHERE ${LIVE('?2')}`).bind(c.user.id, p.id, c.now),
    landed(DB, 'repost_count', p.id),
  ].filter(Boolean));
  return json({ reposted: true, reposts: after(res) });
}

// DELETE /api/posts/:id/repost — answers { reposted: false, reposts } ({ reposted: false } for a post I may not see, or
// none), and takes back the notification
export async function unrepostPost(c) {
  const { id, seen } = await undoing(c);
  const DB = c.env.DB;
  const res = await DB.batch([...dropRepost(DB, c.user.id, id), count(DB, 'repost_count', id)]);
  return json(seen ? { reposted: false, reposts: res.at(-1).results[0].n } : { reposted: false });
}

/* --------------------------------------------------------- bookmarks */

// POST /api/posts/:id/bookmark — answers { bookmarked }. Bookmarks are private: nobody else is told or can see them.
export async function bookmarkPost(c) {
  const p = await target(c);
  await limit(c, 'bookmark:' + c.user.id, [[300, 3600000]], 'that\'s a lot of bookmarks. take a breather.');
  const DB = c.env.DB;
  after(await DB.batch([
    DB.prepare(`INSERT OR IGNORE INTO bookmarks (user_id, post_id, created) SELECT ?1, ?2, ?3 WHERE ${LIVE('?2')}`).bind(c.user.id, p.id, c.now),
    landed(DB, '0', p.id),
  ]));
  return json({ bookmarked: true });
}

// DELETE /api/posts/:id/bookmark — answers { bookmarked: false }, whatever the post
export async function unbookmarkPost(c) {
  const { id } = await undoing(c);
  await c.env.DB.prepare('DELETE FROM bookmarks WHERE user_id = ? AND post_id = ?').bind(c.user.id, id).run();
  return json({ bookmarked: false });
}

// GET /api/me/bookmarks?before= — my bookmarks, newest bookmark first, 30 a page (only posts I may still see). The
// cursor is "<when I bookmarked it>:<post id>".
export async function bookmarks(c) {
  const per = 30;
  const { results } = await c.env.DB.prepare(`
    SELECT ${POST_COLS}, b.created AS saved FROM bookmarks b CROSS JOIN ${POSTS}
    WHERE b.user_id = ?1 AND p.id = b.post_id AND ${VISIBLE} AND ${SEES('a')} AND (b.created < ?3 OR (b.created = ?3 AND b.post_id < ?4))
    ORDER BY b.created DESC, b.post_id DESC LIMIT ${per + 1}`).bind(c.user.id, c.now, ...NEWEST(c)).all();
  return json(await page(c, results, per, EXCERPT, r => `${r.saved}:${r.id}`));
}
