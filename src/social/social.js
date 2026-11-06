// The posting part: statuses, blog posts, Friends' Comments, deleting (board threads and comments too), conversations,
// the feed (statuses, blog posts, quotes and reposts from the people you follow) and #tag pages. Replies, likes, reposts,
// quotes and bookmarks are interactions.js; the item every list shows is items.js; boards are src/boards/. Everyone here
// is a real person: there are no bots.
import { fail, json, readBody, int } from '../shared/http.js';
import { text, longText, tagKey } from '../shared/text.js';
import { REF_COLS, ref, refOf, visibleUser, areFriends, canSeePosts, blockedEither, limit, VISIBLE, IN_THREAD, SEES, SEES_POST, REPOST_OK, CLEAR_TOMBSTONES } from '../shared/db.js';
import { RESORT } from '../shared/ranking.js';
import { claimMedia, dropObjects, keysIn, releaseMedia } from '../shared/media.js';
import { POST_LIMITS, THREADED_SQL, POST_COLS, POSTS, EXCERPT, cursor, NEWEST, BEFORE, AFTER, hydrate, item, page, mentionsOf, writePost, dropRepost, heldOut } from './items.js';

/* ------------------------------------------------------------ posts */

// POST /api/users/:name/comments { body } — a Friends' Comment on somebody's page. Only their friends write here
// (and the owner, replying). The owner hears about it, and so does anyone it @mentions who may see it. No photos.
export async function postComment(c) {
  const u = await visibleUser(c, c.params.name);
  const b = await readBody(c.req);
  if (Array.isArray(b.media) && b.media.length) fail(400, 'photos can\'t go in Friends\' Comments.');
  const body = longText(b.body, 500);
  if (!body) fail(400, 'say something first.');
  const me = c.user.id;
  if (u.id !== me) {
    if (await blockedEither(c.env, me, u.id)) fail(403, 'you can\'t comment here.');
    if (!await areFriends(c.env, me, u.id)) fail(403, `${u.name} only takes comments from friends.`);
  }
  await limit(c, 'post:' + me, POST_LIMITS);
  const id = await writePost(c, { kind: 'wall', target_id: u.id, body }, { mentionIn: body, tell: [['comment', u.id]] });
  return json({ id, body, ...heldOut(c) }, 201);
}

// POST /api/status { body, media? } — on my page and in my followers' feeds. media: up to 4 of my uploads (ids, or
// { id, alt }); with a photo the words may be left out.
export async function postStatus(c) {
  const b = await readBody(c.req);
  const body = text(b.body, 500);
  const media = await claimMedia(c, 'status', b.media);
  if (!body && !media.length) fail(400, 'what\'s on your mind? (you have to type it)');
  await limit(c, 'post:' + c.user.id, POST_LIMITS);
  const id = await writePost(c, { kind: 'status', body }, { mentionIn: body, tagIn: body, media });
  return json({ id, body, ...heldOut(c) }, 201);
}

// POST /api/blog { title, subtitle, mood, body, cover? } — a long post on my page (with a page of its own) and in my
// followers' feeds. @mentions and #tags count in the title and the body. cover: one of my cover uploads (an id, or
// { id, alt }; media: [that] works too).
export async function postBlog(c) {
  const b = await readBody(c.req, 100000);
  const title = text(b.title, 100);
  const subtitle = text(b.subtitle, 160) || null;
  const mood = text(b.mood, 40);
  const body = longText(b.body, 20000);
  if (!title || !body) fail(400, 'a blog post needs a title and some words.');
  const media = await claimMedia(c, 'blog', b.cover == null ? b.media : [b.cover]);
  await limit(c, 'blog:' + c.user.id, [[10, 86400000]], 'that\'s a lot of blogging for one day.');
  await limit(c, 'post:' + c.user.id, POST_LIMITS);
  const words = `${title}\n${body}`;
  const id = await writePost(c, { kind: 'blog', subject: title, subtitle, mood, body }, { mentionIn: words, tagIn: words, media });
  return json({ id, ...heldOut(c) }, 201);
}

// DELETE /api/posts/:id — your own post, a comment on your own page, or anything (moderators). A post that has replies
// or quotes (a board comment: replies; a thread: any comment in it, however deep) stays as a tombstone ("this post was deleted", "[deleted]") so its
// conversation and the quotes keep their shape; otherwise it goes. Either way its likes, votes, bookmarks, reposts,
// mentions, tags and notifications go, and the counts of the post it answered or quoted come down (a board comment's
// thread also counts one comment fewer and is re-sorted); if that one is a tombstone nothing holds any more, it goes too
// (and so on up the conversation). Deleting a repost undoes it. Its photos go either way, out of R2 too,
// except those held as evidence (hidden by a moderator, or the post was): they stay, hidden, for a moderator. Answers
// { ok, tombstone }: whether it stayed as a tombstone.
export async function deletePost(c) {
  const id = int(c.params.id);
  const DB = c.env.DB;
  const p = id && await DB.prepare('SELECT id, kind, author_id, target_id, reply_to, root_id, quote_of FROM posts WHERE id = ? AND deleted = 0').bind(id).first();
  if (!p) fail(404, 'that post is already gone.');
  const me = c.user.id;
  const mine = p.author_id === me || (p.kind === 'wall' && p.target_id === me);
  if (!(mine || c.user.is_admin)) fail(403, 'that isn\'t yours to delete.');
  // (the counts only come down while the post is still there, so two deletes at once change them once)
  const live = 'EXISTS (SELECT 1 FROM posts WHERE id = ?1 AND deleted = 0)';
  const answers = p.kind === 'reply' || p.kind === 'comment';
  const above = answers ? p.reply_to : p.kind === 'quote' ? p.quote_of : null;   // the post it answered or quoted
  const res = await DB.batch(p.kind === 'repost' ? dropRepost(DB, p.author_id, p.quote_of) : [
    answers && DB.prepare(`UPDATE posts SET reply_count = reply_count - 1 WHERE id = ?2 AND ${live}`).bind(id, p.reply_to),
    p.kind === 'comment' && DB.prepare(`UPDATE posts SET comment_count = comment_count - 1 WHERE id = ?2 AND ${live}`).bind(id, p.root_id),
    p.kind === 'quote' && DB.prepare(`UPDATE posts SET quote_count = quote_count - 1 WHERE id = ?2 AND ${live}`).bind(id, p.quote_of),
    DB.prepare('DELETE FROM posts WHERE kind = \'repost\' AND quote_of = ?').bind(id),
    ...['likes', 'votes', 'bookmarks', 'mentions', 'post_tags', 'notifications'].map(t => DB.prepare(`DELETE FROM ${t} WHERE post_id = ?`).bind(id)),
    // (only the delete that really happens answers the keys: two at once take the files out once; photos held as
    // evidence, hidden by a moderator or on a post a moderator hid, stay as hidden photos for a moderator's remove)
    ...releaseMedia(DB, `media.post_id = ?1 AND ${live}`, id),
    DB.prepare(`UPDATE posts SET deleted = 1, subject = NULL, subtitle = NULL, body = '', mood = NULL, quote_of = NULL, like_count = 0, repost_count = 0,
        up_count = 0, down_count = 0
      WHERE id = ?1 AND (EXISTS (SELECT 1 FROM posts WHERE reply_to = ?1) OR EXISTS (SELECT 1 FROM posts WHERE quote_of = ?1 AND kind = 'quote' AND deleted = 0)
        OR EXISTS (SELECT 1 FROM posts WHERE root_id = ?1 AND kind = 'comment'))`).bind(id),
    DB.prepare('DELETE FROM posts WHERE id = ? AND deleted = 0').bind(id),
    above && DB.prepare(CLEAR_TOMBSTONES).bind(JSON.stringify([above])),
    // a board post's tombstone, and its thread: hot counts the comments from others
    (p.kind === 'thread' || p.kind === 'comment') && DB.prepare(`UPDATE posts SET ${RESORT} WHERE id IN (?1, ?2)`).bind(id, p.root_id || id),
    DB.prepare('SELECT 1 AS x FROM posts WHERE id = ?').bind(id),
  ].filter(Boolean));
  await dropObjects(c.env, keysIn(...res));
  if (c.user.is_admin && !mine) {
    await DB.prepare('INSERT INTO mod_log (actor_id, action, target_type, target_id, created) VALUES (?, \'delete\', \'post\', ?, ?)')
      .bind(me, id, c.now).run();
  }
  return json({ ok: true, tombstone: p.kind !== 'repost' && res.at(-1).results.length > 0 });
}

/* ------------------------------------------------------- reading them */

// Whose posts each feed has. following: the people I follow (accepted) and me. everyone: every open profile. "Pick up
// where I left off" (and the unseen count) leaves out my own posts and anything written before I followed its author,
// so following somebody new doesn't fill the queue with their whole history.
const SCOPES = {
  following: {
    latest: '(p.author_id = ?1 OR p.author_id IN (SELECT followee_id FROM follows WHERE follower_id = ?1 AND status = \'accepted\'))',
    resume: 'p.author_id IN (SELECT followee_id FROM follows WHERE follower_id = ?1 AND status = \'accepted\' AND accepted <= p.created)',
  },
  everyone: { latest: 'a.follow_policy = \'open\'', resume: 'a.follow_policy = \'open\' AND p.author_id != ?1' },
};
const FEED_PER = 30;
const RESUME_BACK = 3 * 86400000;                // with no marker yet, "pick up where I left off" starts three days back

// GET /api/feed?scope=following|everyone&mode=latest|resume&before=|after= — statuses, blog posts, quotes and reposts
// (never replies; a repost of something the viewer may not see is left out). latest: newest first, paged with before=.
// resume ("pick up where I left off"): oldest first from just after my feed marker, paged with after=. Logged out, the
// scope is always everyone. Every answer also says where my marker is and how many posts in this scope are waiting
// after it in resume mode (up to 999).
export async function feed(c) {
  const q = c.url.searchParams;
  const scope = c.user && q.get('scope') !== 'everyone' ? 'following' : 'everyone';
  const resume = q.get('mode') === 'resume';
  const viewer = c.user ? c.user.id : 0;
  const m = c.user && await c.env.DB.prepare('SELECT last_created, last_id FROM markers WHERE user_id = ? AND name = \'feed\'').bind(viewer).first();
  const marker = m ? { created: m.last_created, id: m.last_id } : null;
  const from = marker ? [marker.created, marker.id] : [c.now - RESUME_BACK, 0];
  const base = `p.kind IN ('status', 'blog', 'quote', 'repost') AND ${VISIBLE} AND ${REPOST_OK}`;
  const unseen = `${base} AND ${SCOPES[scope].resume} AND ${AFTER}`;
  const order = resume ? 'ASC' : 'DESC';
  const DB = c.env.DB;
  const [rows, count] = await DB.batch([
    DB.prepare(`SELECT ${POST_COLS} FROM ${POSTS}
      WHERE ${resume ? unseen : `${base} AND ${SCOPES[scope].latest} AND ${BEFORE}`}
      ORDER BY p.created ${order}, p.id ${order} LIMIT ${FEED_PER + 1}`).bind(viewer, c.now, ...(resume ? cursor(c, 'after', from) : NEWEST(c))),
    DB.prepare(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${POSTS} WHERE ${unseen} LIMIT 999)`).bind(viewer, c.now, ...from),
  ]);
  return json({ ...await page(c, rows.results, FEED_PER, EXCERPT), marker, unseen: count.results[0].n });
}

const MARKERS = ['feed', 'notifications'];

// PUT /api/me/markers/:name { created, id } — how far I've read: the last post (feed) or notification (notifications)
// I've seen. It only moves forward (an older position than the stored one is ignored). Answers with the marker as it
// now stands.
export async function saveMarker(c) {
  if (!MARKERS.includes(c.params.name)) fail(404, 'no such marker.');
  const b = await readBody(c.req);
  const created = int(b.created), id = int(b.id);
  if (!(created > 0 && id > 0 && created <= c.now)) fail(400, 'send the created time and id of the last one you saw.');
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

// GET /api/users/:name/blog — the blog's index: every post on somebody's page, newest first, long ones cut short
export async function blogOf(c) {
  const u = await visibleUser(c, c.params.name);
  if (!await canSeePosts(c, u)) fail(403, 'this profile is private.');
  const { results } = await c.env.DB.prepare(`
    SELECT ${POST_COLS} FROM ${POSTS}
    WHERE p.kind = 'blog' AND p.author_id = ?3 AND ${VISIBLE}
    ORDER BY p.created DESC, p.id DESC LIMIT 100`).bind(c.user ? c.user.id : 0, c.now, u.id).all();
  const h = await hydrate(c, results);
  return json({ user: refOf(u), entries: results.map(r => item(c, r, h, EXCERPT)) });
}

// somebody's posts of these kinds, newest first, 30 a page (a repost of something the viewer may not see left out)
async function streamOf(c, kinds) {
  const u = await visibleUser(c, c.params.name);
  if (!await canSeePosts(c, u)) fail(403, 'this profile is private.');
  const per = 30;
  const { results } = await c.env.DB.prepare(`
    SELECT ${POST_COLS} FROM ${POSTS}
    WHERE p.kind IN (${kinds}) AND p.author_id = ?5 AND ${VISIBLE} AND ${REPOST_OK} AND ${BEFORE}
    ORDER BY p.created DESC, p.id DESC LIMIT ${per + 1}`).bind(c.user ? c.user.id : 0, c.now, ...NEWEST(c), u.id).all();
  return json(await page(c, results, per));
}

// GET /api/users/:name/statuses?before= — the Posts tab: somebody's statuses, quotes and reposts
export const statusesOf = c => streamOf(c, '\'status\', \'quote\', \'repost\'');
// GET /api/users/:name/replies?before= — the Replies tab: somebody's replies
export const repliesOf = c => streamOf(c, '\'reply\'');

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
  const said = results.length ? await mentionsOf(c, results.map(w => w.id)) : new Map();
  return json({
    comments: results.map(w => ({
      id: w.id, body: w.body, created: w.created, author: ref(w, 'a_'), mentions: said.get(w.id) || [],
      canDelete: !!(c.user && (c.user.id === u.id || c.user.id === w.a_id || c.user.is_admin)),
    })),
    total, page, pages,
  });
}

const THREAD_PER = 50;
const ANCESTORS = 20;
// the replies under the post ?5, however deep (for a reply; the first post of a conversation uses root_id instead)
const SUBTREE = `p.id IN (WITH RECURSIVE sub(id) AS (SELECT id FROM posts WHERE reply_to = ?5
  UNION ALL SELECT x.id FROM posts x JOIN sub ON x.reply_to = sub.id) SELECT id FROM sub)`;

// GET /api/posts/:id?after= — a status, blog post, quote or reply in full, with its conversation: `ancestors`, the
// posts it answers up to the conversation's first (the nearest 20, oldest first), and `replies`, everything under it
// however deep, oldest first, 50 a page (`next` is the cursor for after=). Tombstones of deleted posts keep their place.
// A repost's id opens its original. A post the viewer may not see (a private profile's) answers exactly like a missing
// one, so the answer doesn't say the post exists.
export async function onePost(c) {
  const id = int(c.params.id);
  const viewer = c.user ? c.user.id : 0;
  const DB = c.env.DB;
  const r = id && await DB.prepare(`
    SELECT ${POST_COLS}, a.follow_policy FROM ${POSTS}
    WHERE p.id = (SELECT CASE WHEN kind = 'repost' THEN quote_of ELSE id END FROM posts WHERE id = ?3)
      AND p.kind IN (${THREADED_SQL}) AND ${IN_THREAD}`).bind(viewer, c.now, id).first();
  if (!r || !await canSeePosts(c, { id: r.a_id, follow_policy: r.follow_policy })) fail(404, 'that post is gone.');
  const shown = `${IN_THREAD} AND ${SEES('a')}`;
  const [up, down] = await DB.batch([
    DB.prepare(`WITH RECURSIVE up(id, depth) AS (SELECT reply_to, 1 FROM posts WHERE id = ?3 AND reply_to IS NOT NULL
        UNION ALL SELECT x.reply_to, up.depth + 1 FROM posts x JOIN up ON x.id = up.id WHERE x.reply_to IS NOT NULL AND up.depth < ${ANCESTORS})
      SELECT ${POST_COLS} FROM up CROSS JOIN ${POSTS} WHERE p.id = up.id AND ${shown} ORDER BY up.depth DESC`).bind(viewer, c.now, r.id),
    DB.prepare(`SELECT ${POST_COLS} FROM ${POSTS} WHERE ${r.kind === 'reply' ? SUBTREE : 'p.root_id = ?5'} AND ${shown} AND ${AFTER}
      ORDER BY p.created, p.id LIMIT ${THREAD_PER + 1}`).bind(viewer, c.now, ...cursor(c, 'after', [0, 0]), r.id),
  ]);
  const replies = down.results.slice(0, THREAD_PER);
  const h = await hydrate(c, [r, ...up.results, ...replies]);
  const last = replies[replies.length - 1];
  return json({
    post: item(c, r, h),
    ancestors: up.results.map(x => item(c, x, h, EXCERPT)),
    replies: replies.map(x => item(c, x, h)),
    next: down.results.length > THREAD_PER ? `${last.created}:${last.id}` : null,
  });
}

// GET /api/tags/:tag?before= — the posts with this #tag that the viewer may see (board threads too), newest first, 30
// a page
export async function tagged(c) {
  const tag = tagKey(String(c.params.tag).replace(/^#/, ''));
  if (!tag) fail(404, 'that isn\'t a tag.');
  const per = 30;
  const { results } = await c.env.DB.prepare(`
    SELECT ${POST_COLS} FROM post_tags t CROSS JOIN ${POSTS}
    WHERE t.tag = ?5 AND p.id = t.post_id AND ${VISIBLE} AND ${SEES_POST('p', 'a')} AND (t.created < ?3 OR (t.created = ?3 AND t.post_id < ?4))
    ORDER BY t.created DESC, t.post_id DESC LIMIT ${per + 1}`).bind(c.user ? c.user.id : 0, c.now, ...NEWEST(c), tag).all();
  return json({ tag, ...await page(c, results, per, EXCERPT) });
}
