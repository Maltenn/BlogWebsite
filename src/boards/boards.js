// Boards: topic channels (Music, Cooking, Random …) holding forum threads with nested comments, the Reddit way: every
// thread and comment takes likes and dislikes (votes.js), threads sort hot / new / top / best and comments best / new /
// old, by the keys in shared/ranking.js. Boards are public spaces: a thread or comment shows to everyone, even when its
// writer's profile is private; what hides any post still hides it (a banned writer, a block either way, a moderator's
// hide). Board threads are never in the feed. Asking for a new board is requests.js.
import { fail, json, readBody, int } from '../shared/http.js';
import { text, longText, clip } from '../shared/text.js';
import { REF_COLS, ref, limit, NOT_BLOCKED, VISIBLE, IN_THREAD, REACHABLE } from '../shared/db.js';
import { hot, RESORT } from '../shared/ranking.js';
import { claimMedia, MEDIA_OF, mediaByPost } from '../shared/media.js';
import { POST_LIMITS, POST_COLS, POSTS, hydrate, item, itemById, writePost } from '../social/items.js';
import { growTree, readCursor } from './tree.js';

const PER = 25;                                  // threads on a page of a board
const STICKIES = 20;                             // the most sticky threads a board's first page shows
const EXCERPT = 200;                             // a thread's words in a board's list
const SKELETON = 5000;                           // the most comments of one thread that are read (the oldest)

// SQL: post `x` (a thread, or a comment in one) still takes comments and votes: it's there (not deleted or hidden) and
// so is its thread, which isn't locked, on a board that isn't archived. Checked in the same batch as the write, so a
// thread locked or a post deleted at the same moment gets nothing.
export const OPEN = x => `EXISTS (SELECT 1 FROM posts op JOIN posts ot ON ot.id = COALESCE(op.root_id, op.id) JOIN boards ob ON ob.id = ot.board_id
  WHERE op.id = ${x} AND op.deleted = 0 AND op.hidden = 0 AND ot.deleted = 0 AND ot.hidden = 0 AND ot.locked = 0 AND ob.archived = 0)`;

// SQL: comment `p`'s thread shows to the viewer ?1 (for a board's last post)
const THREAD_SHOWN = `EXISTS (SELECT 1 FROM posts st JOIN users sa ON sa.id = st.author_id
  WHERE st.id = p.root_id AND st.deleted = 0 AND st.hidden = 0 AND sa.banned = 0 AND ${NOT_BLOCKED('st.author_id')})`;

export const boardOut = b => ({ slug: b.slug, name: b.name, description: b.description, icon: b.icon, archived: !!b.archived });

async function boardOf(c) {
  const b = await c.env.DB.prepare('SELECT id, slug, name, description, icon, archived FROM boards WHERE slug = ?')
    .bind(String(c.params.slug).toLowerCase()).first();
  if (!b) fail(404, 'no such board.');
  return b;
}

/* ------------------------------------------------------------ boards */

// GET /api/boards — the boards index, in order: each board's threads (that the viewer may see) and its last post (a
// thread or a comment, with the thread it's in). Archived boards aren't listed.
export async function boardList(c) {
  const { results } = await c.env.DB.prepare(`WITH x AS (
      SELECT b.*, (SELECT COUNT(*) FROM posts p JOIN users a ON a.id = p.author_id WHERE p.board_id = b.id AND p.kind = 'thread' AND ${VISIBLE}) AS threads,
        (SELECT p.id FROM posts p JOIN users a ON a.id = p.author_id WHERE p.board_id = b.id AND p.kind IN ('thread', 'comment') AND ${VISIBLE}
          AND (p.kind = 'thread' OR ${THREAD_SHOWN}) ORDER BY p.created DESC, p.id DESC LIMIT 1) AS last_id
      FROM boards b WHERE b.archived = 0)
    SELECT x.slug, x.name, x.description, x.icon, x.threads, lp.created AS l_created, ${REF_COLS('la', 'l_')}, lt.id AS t_id, lt.subject AS t_subject
    FROM x LEFT JOIN posts lp ON lp.id = x.last_id LEFT JOIN users la ON la.id = lp.author_id LEFT JOIN posts lt ON lt.id = COALESCE(lp.root_id, lp.id)
    ORDER BY x.position, x.id`).bind(c.user ? c.user.id : 0, c.now).all();
  return json({
    boards: results.map(b => ({
      slug: b.slug, name: b.name, description: b.description, icon: b.icon, threads: b.threads,
      lastPost: b.l_created == null ? null : { created: b.l_created, author: ref(b, 'l_'), thread: { id: b.t_id, subject: b.t_subject } },
    })),
  });
}

// the stored key each board sort reads (all of them tie on newest first)
const SORTS = { hot: 'p.hot', new: 'p.created', top: 'p.score', best: 'p.best' };

// GET /api/boards/:slug?sort=hot|new|top|best&before= — a board's threads, 25 a page, the sticky ones first (on the
// first page). `next` is the cursor for before=: "<sort key>:<created>:<id>" of the last thread.
export async function board(c) {
  const b = await boardOf(c);
  const q = c.url.searchParams;
  const sort = Object.hasOwn(SORTS, q.get('sort')) ? q.get('sort') : 'hot';
  const key = SORTS[sort];
  const at = String(q.get('before') || '').split(':').map(Number);
  const first = !(at.length === 3 && at.every(Number.isFinite));
  const viewer = c.user ? c.user.id : 0;
  const DB = c.env.DB;
  const cols = `p.id, p.subject, p.body, p.created, p.sticky, p.locked, p.up_count, p.down_count, p.comment_count, ${key} AS k, ${REF_COLS('a', 'a_')}`;
  const from = `posts p JOIN users a ON a.id = p.author_id WHERE p.board_id = ?3 AND p.kind = 'thread' AND ${VISIBLE}`;
  const order = `ORDER BY ${key} DESC, p.created DESC, p.id DESC`;
  const [rows, pinned = { results: [] }] = await DB.batch([
    DB.prepare(`SELECT ${cols} FROM ${from} AND p.sticky = 0 AND (${key} < ?4 OR (${key} = ?4 AND (p.created < ?5 OR (p.created = ?5 AND p.id < ?6))))
      ${order} LIMIT ${PER + 1}`).bind(viewer, c.now, b.id, ...(first ? [1e300, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER] : at)),
    first && DB.prepare(`SELECT ${cols} FROM ${from} AND p.sticky = 1 ${order} LIMIT ${STICKIES}`).bind(viewer, c.now, b.id),
  ].filter(Boolean));
  const shown = [...pinned.results, ...rows.results.slice(0, PER)];
  const list = JSON.stringify(shown.map(r => r.id));
  // the newest comment the viewer may see in each, the viewer's votes, and their photos
  const [last, votes, photos] = shown.length ? await DB.batch([
    DB.prepare(`SELECT * FROM (SELECT c.root_id, c.created, ${REF_COLS('ca', 'l_')},
        ROW_NUMBER() OVER (PARTITION BY c.root_id ORDER BY c.created DESC, c.id DESC) AS n
      FROM posts c JOIN users ca ON ca.id = c.author_id WHERE c.root_id IN (SELECT value FROM json_each(?2)) AND c.kind = 'comment'
        AND c.deleted = 0 AND c.hidden = 0 AND c.created <= ?3 AND ca.banned = 0 AND ${NOT_BLOCKED('c.author_id')}) WHERE n = 1`).bind(viewer, list, c.now),
    DB.prepare('SELECT post_id, value FROM votes WHERE user_id = ?1 AND post_id IN (SELECT value FROM json_each(?2))').bind(viewer, list),
    DB.prepare(MEDIA_OF).bind(list),
  ]) : [{ results: [] }, { results: [] }, { results: [] }];
  const lastOf = new Map(last.results.map(r => [r.root_id, r]));
  const { media } = mediaByPost(photos.results);
  const voted = new Map(votes.results.map(r => [r.post_id, r.value]));
  const end = rows.results.length > PER ? rows.results[PER - 1] : null;
  return json({
    board: boardOut(b), sort,
    items: shown.map(r => {
      const l = lastOf.get(r.id);
      return {
        id: r.id, subject: r.subject, excerpt: clip(r.body, EXCERPT) ?? r.body, author: ref(r, 'a_'), created: r.created,
        sticky: !!r.sticky, locked: !!r.locked, counts: { up: r.up_count, down: r.down_count, comments: r.comment_count },
        lastComment: l ? { created: l.created, author: ref(l, 'l_') } : null, viewer: { vote: voted.get(r.id) || 0 },
        media: media.get(r.id) || [],
      };
    }),
    next: end ? `${end.k}:${end.created}:${end.id}` : null,
  });
}

/* ----------------------------------------------------------- threads */

// POST /api/boards/:slug/threads { subject, body, media? } — a new thread: a title up to 120 characters, words up to
// 10,000 and up to 4 photos (with a photo the words may be left out). @mentions and #tags count in the title and words.
// 3 an hour and 10 a day, and they count as posts.
export async function postThread(c) {
  const b = await boardOf(c);
  if (b.archived) fail(403, 'this board is archived.');
  const x = await readBody(c.req, 100000);
  const subject = text(x.subject, 120);
  const body = longText(x.body, 10000);
  const media = await claimMedia(c, 'thread', x.media);
  if (!subject || (!body && !media.length)) fail(400, 'a thread needs a title and a message.');
  await limit(c, 'thread:' + c.user.id, [[3, 3600000], [10, 86400000]], 'you\'ve started plenty of threads today.');
  await limit(c, 'post:' + c.user.id, POST_LIMITS);
  const words = `${subject}\n${body}`;
  const id = await writePost(c, { kind: 'thread', board_id: b.id, subject, body, hot: hot(0, 0, 0, c.now) }, {
    mentionIn: words, tagIn: words, guard: `EXISTS (SELECT 1 FROM boards WHERE id = ${b.id} AND archived = 0)`, media,
  });
  return json({ thread: await itemById(c, id) }, 201);
}

// the thread :id as the viewer may see it (a tombstone too), with whether its board is archived; else 404
async function threadOf(c) {
  const id = int(c.params.id);
  const t = id && await c.env.DB.prepare(`SELECT ${POST_COLS}, p.board_id FROM ${POSTS}
    WHERE p.id = ?3 AND p.kind = 'thread' AND ${IN_THREAD}`).bind(c.user ? c.user.id : 0, c.now, id).first();
  if (!t) fail(404, 'that thread is gone.');
  return t;
}

const COMMENT_SORTS = ['best', 'new', 'old'];

// The comments under `parent` (the thread `t` itself or one of its comments) as tree nodes, after the cursor `after`
// (tree.js; null: from the first), with their items: two queries (the whole thread in brief, then the comments that
// show in full) and one batch for what their items need. `also`: rows to hydrate with them (the thread, or the parent
// comment). Answers { nodes, h, rows } or null when `parent` doesn't show.
async function commentsUnder(c, t, parent, sort, after, also = []) {
  const DB = c.env.DB;
  const viewer = c.user ? c.user.id : 0;
  const { results: all } = await DB.prepare(`SELECT p.id, p.reply_to, p.created, p.best, p.deleted,
      (p.hidden = 0 AND p.created <= ?2 AND a.banned = 0 AND ${NOT_BLOCKED('p.author_id')}) AS ok
    FROM posts p JOIN users a ON a.id = p.author_id WHERE p.root_id = ?3 AND p.kind = 'comment' ORDER BY p.created, p.id LIMIT ${SKELETON}`)
    .bind(viewer, c.now, t.id).all();
  const { found, nodes, ids } = growTree(all, t.id, parent, sort, after);
  if (!found) return null;
  const want = parent === t.id ? ids : [parent, ...ids];
  const { results } = want.length ? await DB.prepare(`SELECT ${POST_COLS} FROM ${POSTS} WHERE p.id IN (SELECT value FROM json_each(?2))`)
    .bind(viewer, JSON.stringify(want)).all() : { results: [] };
  const h = await hydrate(c, [...also, ...results]);
  const rows = new Map(results.map(r => [r.id, r]));
  const fill = list => list.map(n => n.more !== undefined ? n : { item: item(c, rows.get(n.item), h), children: fill(n.children) });
  return { nodes: fill(nodes), h, rows };
}

const commentSort = c => (COMMENT_SORTS.includes(c.url.searchParams.get('sort')) ? c.url.searchParams.get('sort') : 'best');

// GET /api/threads/:id?sort=best|new|old — a thread in full (with its board, counts and the viewer's vote) and its
// comments as a tree: [{ item, children: [...] }], up to 200 comments and 8 levels, 10 replies to a comment; what's cut
// is a stub { more, parent, after } for GET /api/threads/:id/comments/:parent?after=. Deleted comments that still have
// replies stay as tombstones.
export async function boardThread(c) {
  const t = await threadOf(c);
  const sort = commentSort(c);
  const { nodes, h } = await commentsUnder(c, t, t.id, sort, null, [t]);
  return json({ thread: item(c, t, h), sort, comments: nodes });
}

// GET /api/threads/:id/comments/:commentId?sort=&after= — more of a thread's tree: the comments under one of its
// comments (or under the thread itself, when :commentId is the thread's id), after the sibling the stub's cursor
// `after` names (none: from the first), with the same caps. `parent` is that comment as an item (null for the thread).
export async function threadComments(c) {
  const t = await threadOf(c);
  const parent = int(c.params.commentId);
  const sort = commentSort(c);
  const got = parent && await commentsUnder(c, t, parent, sort, readCursor(c.url.searchParams.get('after'), sort));
  if (!got) fail(404, 'that comment is gone.');
  return json({ parent: parent === t.id ? null : item(c, got.rows.get(parent), got.h), sort, comments: got.nodes });
}

// POST /api/threads/:id/comments { body, parent?, media? } — a comment (up to 10,000 characters and 1 photo: with the
// photo the words may be left out) on the thread, or a reply to
// one of its comments (`parent`). Not in a locked thread or an archived board, and only to a comment the writer can see
// in the tree (it and every comment above it show to them: REACHABLE). Whoever wrote what it answers is told (as a
// reply), and so is anyone it @mentions. It counts as a post.
export async function postThreadComment(c) {
  const t = await threadOf(c);
  const x = await readBody(c.req, 100000);
  const body = longText(x.body, 10000);
  const media = await claimMedia(c, 'comment', x.media);
  if (!body && !media.length) fail(400, 'say something first.');
  const DB = c.env.DB;
  const parent = x.parent == null || int(x.parent) === t.id ? { id: t.id, author_id: t.a_id }
    : await DB.prepare(`SELECT p.id, p.author_id FROM posts p JOIN users a ON a.id = p.author_id
      WHERE p.id = ?3 AND p.kind = 'comment' AND p.root_id = ?4 AND ${VISIBLE} AND ${REACHABLE('p.id')}`).bind(c.user.id, c.now, int(x.parent, 0), t.id).first();
  if (t.deleted || !parent) fail(404, parent ? 'that thread is gone.' : 'that comment is gone.');
  if (t.locked) fail(403, 'this thread is locked.');
  if (t.b_archived) fail(403, 'this board is archived.');
  await limit(c, 'post:' + c.user.id, POST_LIMITS);
  const id = await writePost(c, { kind: 'comment', board_id: t.board_id, body, reply_to: parent.id, root_id: t.id }, {
    mentionIn: body, tell: [['reply', parent.author_id]], guard: OPEN(parent.id), media,
    more: [
      DB.prepare(`UPDATE posts SET reply_count = reply_count + 1 WHERE id = ?1 AND ${OPEN('?1')}`).bind(parent.id),
      DB.prepare(`UPDATE posts SET comment_count = comment_count + 1 WHERE id = ?2 AND ${OPEN('?1')}`).bind(parent.id, t.id),
      DB.prepare(`UPDATE posts SET ${RESORT} WHERE id = ?`).bind(t.id),
    ],
  });
  return json({ comment: await itemById(c, id) }, 201);
}

/* -------------------------------------------------------- moderators */

async function logged(c, actions, type, id) {
  await c.env.DB.batch(actions.map(a => c.env.DB.prepare('INSERT INTO mod_log (actor_id, action, target_type, target_id, created) VALUES (?, ?, ?, ?, ?)')
    .bind(c.user.id, a, type, id, c.now)));
}

// POST /api/admin/threads/:id { sticky?, locked? } — pin a thread above every sort, or lock it (no new comments or
// votes; moderators can still delete and hide). Answers { thread: { id, sticky, locked } }.
export async function moderateThread(c) {
  const b = await readBody(c.req);
  const keys = ['sticky', 'locked'].filter(k => typeof b[k] === 'boolean');
  if (!keys.length) fail(400, 'say sticky and/or locked: true or false.');
  const t = await c.env.DB.prepare(`UPDATE posts SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE id = ? AND kind = 'thread' AND deleted = 0
    RETURNING id, sticky, locked`).bind(...keys.map(k => (b[k] ? 1 : 0)), int(c.params.id, 0)).first();
  if (!t) fail(404, 'that thread is gone.');
  await logged(c, keys.map(k => ({ sticky: ['unsticky', 'sticky'], locked: ['unlock', 'lock'] })[k][b[k] ? 1 : 0]), 'post', t.id);
  return json({ thread: { id: t.id, sticky: !!t.sticky, locked: !!t.locked } });
}

// POST /api/admin/boards/:slug { archived } — archive a board (off the index, no new threads, comments or votes, still
// readable) or bring it back. Answers { board }.
export async function moderateBoard(c) {
  const x = await readBody(c.req);
  if (typeof x.archived !== 'boolean') fail(400, 'say archived: true or false.');
  const b = await c.env.DB.prepare('UPDATE boards SET archived = ? WHERE slug = ? RETURNING *').bind(x.archived ? 1 : 0, String(c.params.slug).toLowerCase()).first();
  if (!b) fail(404, 'no such board.');
  await logged(c, [x.archived ? 'archive' : 'unarchive'], 'board', b.id);
  return json({ board: boardOut(b) });
}
