// Posts out and in. Out: the item every list and page shows, with what a page of them needs besides their own columns
// (a repost's or quote's original, the viewer's likes, reposts and bookmarks, @mentions, #tags) fetched for the whole
// page in one batch (their photos too). In: a new post together with its photos, @mentions, #tags, counts and
// notifications, in one batch. Board
// threads and comments (src/boards/) are items too, with votes instead of likes.
import { fail, int } from '../shared/http.js';
import { mentionsIn, tagsIn, clip } from '../shared/text.js';
import { REF_COLS, ref, lite, NOT_BLOCKED, SEES, SEES_POST, IN_THREAD, REPOSTED, JUST_WRITTEN } from '../shared/db.js';
import { notify } from '../shared/notify.js';
import { MEDIA_OF, mediaByPost, attachTo, attachFailed } from '../shared/media.js';
import { bump, W } from '../shared/affinity.js';

// how much one person may post (statuses, replies, quotes, Friends' Comments, blog posts, threads and comments together)
export const POST_LIMITS = [[6, 60000], [300, 86400000]];

// the kinds people reply to, like, repost, quote and bookmark (a repost stands for its original)
const THREADED = ['status', 'blog', 'reply', 'quote'];
export const THREADED_SQL = THREADED.map(k => `'${k}'`).join(', ');
// the kinds that live on boards: they take votes and comments instead
const BOARDED = ['thread', 'comment'];

// Every list selects POST_COLS FROM POSTS (with the viewer bound as ?1): the post `p`, its author `a`, its board `bd`
// (threads and comments), the post `rp` it answers (r_post: still there; r_ok: the viewer may see it, as in a
// conversation, tombstones included) by `ra`, and for a repost its original `o` (by `oa`, for REPOST_OK).
export const POST_COLS = `p.id, p.kind, p.subject, p.subtitle, p.body, p.mood, p.created, p.reply_to, p.root_id, p.quote_of, p.deleted,
  p.like_count, p.reply_count, p.repost_count, p.quote_count, p.up_count, p.down_count, p.comment_count, p.sticky, p.locked,
  bd.slug AS b_slug, bd.name AS b_name, bd.icon AS b_icon, bd.archived AS b_archived, ${REF_COLS('a', 'a_')}, ${REF_COLS('ra', 'r_')}, rp.id AS r_post,
  (rp.hidden = 0 AND ra.banned = 0 AND ${NOT_BLOCKED('rp.author_id')} AND ${SEES_POST('rp', 'ra')}) AS r_ok`;
export const POSTS = `posts p JOIN users a ON a.id = p.author_id LEFT JOIN boards bd ON bd.id = p.board_id
  LEFT JOIN posts rp ON rp.id = p.reply_to LEFT JOIN users ra ON ra.id = rp.author_id ${REPOSTED}`;

export const EXCERPT = 400;                      // blog and thread bodies in lists are cut at this many characters

// a "<created>:<id>" cursor (the last item already shown) from ?before= or ?after=, else `fallback`
export function cursor(c, key, fallback) {
  const [t, id] = String(c.url.searchParams.get(key) || '').split(':').map(x => int(x));
  return t && id ? [t, id] : fallback;
}
export const NEWEST = c => cursor(c, 'before', [c.now + 1, Number.MAX_SAFE_INTEGER]);

// A post older / newer than the cursor ?3/?4 (VISIBLE, from db.js, takes ?1 viewer and ?2 now).
export const BEFORE = '(p.created < ?3 OR (p.created = ?3 AND p.id < ?4))';
export const AFTER = '(p.created > ?3 OR (p.created = ?3 AND p.id > ?4))';

// SQL: who the posts in the JSON list ?2 @mention, leaving out anyone banned or hidden from the viewer ?1 by a block
const MENTIONS = `SELECT m.post_id, u.id, u.name FROM mentions m JOIN users u ON u.id = m.user_id
  WHERE m.post_id IN (SELECT value FROM json_each(?2)) AND u.banned = 0 AND ${NOT_BLOCKED('u.id')}`;

// rows → Map(post_id → [each(row)])
function byPost(rows, each) {
  const m = new Map();
  for (const r of rows) m.set(r.post_id, [...(m.get(r.post_id) || []), each(r)]);
  return m;
}

// who each of these posts @mentions: Map(post id → [{ id, name }])
export async function mentionsOf(c, ids) {
  const { results } = await c.env.DB.prepare(MENTIONS).bind(c.user ? c.user.id : 0, JSON.stringify(ids)).all();
  return byPost(results, r => ({ id: r.id, name: r.name }));
}

// What the items for `rows` need besides their own columns, in one batch: the originals of reposts and quotes (and the
// post a reposted quote quotes), with whether the viewer may see them (ok: tombstones too, which show as deleted rather
// than unavailable); the viewer's likes, reposts and bookmarks, and votes on threads and comments;
// @mentions and #tags; the photos (and blog covers) of all of them and of the posts they quote. Nothing at all for
// Friends' Comments.
export async function hydrate(c, rows) {
  const h = { posts: new Map(), liked: new Set(), reposted: new Set(), bookmarked: new Set(), votes: new Map(), mentions: new Map(), tags: new Map(),
    media: new Map(), covers: new Map() };
  const originals = rows.filter(r => r.kind === 'repost' && r.quote_of).map(r => r.quote_of);
  const targets = [...new Set(rows.filter(r => THREADED.includes(r.kind) || BOARDED.includes(r.kind)).map(r => r.id).concat(originals))];
  if (!targets.length) return h;
  const quoted = rows.filter(r => r.kind === 'quote' && r.quote_of).map(r => r.quote_of).concat(originals);
  const viewer = c.user ? c.user.id : 0;
  const DB = c.env.DB;
  const list = JSON.stringify(targets);
  const q = {
    mentions: DB.prepare(MENTIONS).bind(viewer, list),
    tags: DB.prepare('SELECT post_id, tag FROM post_tags WHERE post_id IN (SELECT value FROM json_each(?))').bind(list),
    media: DB.prepare(MEDIA_OF).bind(JSON.stringify([...new Set(targets.concat(quoted))])),
  };
  if (quoted.length) {
    q.posts = DB.prepare(`SELECT ${POST_COLS}, (${IN_THREAD} AND ${SEES('a')}) AS ok FROM ${POSTS}
      WHERE p.id IN (SELECT value FROM json_each(?3) UNION SELECT quote_of FROM posts WHERE kind = 'quote' AND id IN (SELECT value FROM json_each(?4)))`)
      .bind(viewer, c.now, JSON.stringify(quoted), JSON.stringify(originals));
  }
  if (viewer) {
    q.flags = DB.prepare(`SELECT post_id, 'liked' AS flag FROM likes WHERE user_id = ?1 AND post_id IN (SELECT value FROM json_each(?2))
      UNION ALL SELECT post_id, 'bookmarked' FROM bookmarks WHERE user_id = ?1 AND post_id IN (SELECT value FROM json_each(?2))
      UNION ALL SELECT quote_of, 'reposted' FROM posts WHERE kind = 'repost' AND author_id = ?1 AND quote_of IN (SELECT value FROM json_each(?2))`)
      .bind(viewer, list);
    q.votes = DB.prepare('SELECT post_id, value FROM votes WHERE user_id = ?1 AND post_id IN (SELECT value FROM json_each(?2))').bind(viewer, list);
  }
  const keys = Object.keys(q);
  const got = Object.fromEntries((await DB.batch(Object.values(q))).map((r, i) => [keys[i], r.results]));
  h.mentions = byPost(got.mentions, r => ({ id: r.id, name: r.name }));
  h.tags = byPost(got.tags, r => r.tag);
  for (const r of got.posts || []) h.posts.set(r.id, r);
  for (const r of got.flags || []) h[r.flag].add(r.post_id);
  for (const r of got.votes || []) h.votes.set(r.post_id, r.value);
  Object.assign(h, mediaByPost(got.media));
  return h;
}

const UNAVAILABLE = { unavailable: true };

// One post as the pages show it, from POST_COLS and hydrate()'s `h`. A blog body longer than `cut` characters comes as
// an excerpt (excerpt: true); the post's own page has all of it. A repost's author is the person who reposted it; its
// original is `quoted` (a whole item), and its counts and viewer flags are the original's, because liking, replying to,
// reposting or bookmarking a repost acts on the original. A quote's `quoted` is the original in brief (lite, from
// db.js). Either is { unavailable: true } when the original is gone or the viewer may not see it, and says deleted: true
// when it's a tombstone. A deleted post is a tombstone: deleted: true, no words. A reply's replyTo names the post it
// answers only when the viewer may see that one: { id, author }; { id, author: null } when it went with its writer's
// account; { id: null, author: null } when it's there but not for this viewer (private, blocked, banned or hidden).
// A board thread or comment has votes instead: counts { up, down, comments } (a thread's comments however deep, a
// comment's direct replies) and viewer { vote: 1, -1 or 0 }, plus its board ({ slug, name, icon, archived }: an
// archived board takes no comments or votes); a thread also says sticky and locked. Every item has its photos, media:
// [{ id, url, width, height, alt }] (a repost's are its original's, inside quoted; a quote's box has the quoted post's);
// a blog post also has its cover ({ id, url, width, height, alt } or null).
export function item(c, r, h, cut = 0) {
  const repost = r.kind === 'repost';
  const board = BOARDED.includes(r.kind);
  const orig = r.quote_of ? h.posts.get(r.quote_of) : null;
  const shown = repost && orig ? orig : r;
  const short = cut && (r.kind === 'blog' || r.kind === 'thread') ? clip(r.body, cut) : null;
  return {
    id: r.id, kind: r.kind, created: r.created, subject: r.subject || null, subtitle: r.subtitle || null,
    body: short ?? r.body, excerpt: short !== null, mood: r.mood || null,
    author: ref(r, 'a_'),
    canDelete: !!(c.user && !r.deleted && (r.a_id === c.user.id || c.user.is_admin)),
    replyTo: !r.reply_to ? null : r.r_ok ? { id: r.reply_to, author: ref(r, 'r_') } : { id: r.r_post == null ? r.reply_to : null, author: null },
    rootId: r.root_id,
    quoted: r.deleted || !(repost || r.kind === 'quote') ? null : !orig || !orig.ok ? UNAVAILABLE : repost ? item(c, orig, h, cut)
      : { ...lite(orig), media: h.media.get(orig.id) || [] },
    counts: board ? { up: r.up_count, down: r.down_count, comments: r.kind === 'thread' ? r.comment_count : r.reply_count }
      : { likes: shown.like_count, replies: shown.reply_count, reposts: shown.repost_count, quotes: shown.quote_count },
    viewer: board ? { vote: h.votes.get(r.id) || 0 }
      : { liked: h.liked.has(shown.id), reposted: h.reposted.has(shown.id), bookmarked: h.bookmarked.has(shown.id) },
    mentions: h.mentions.get(r.id) || [],
    tags: h.tags.get(r.id) || [],
    media: h.media.get(r.id) || [],
    ...(r.kind === 'blog' ? { cover: h.covers.get(r.id) || null } : {}),
    deleted: !!r.deleted,
    ...(board ? { board: r.b_slug ? { slug: r.b_slug, name: r.b_name, icon: r.b_icon, archived: !!r.b_archived } : null } : {}),
    ...(r.kind === 'thread' ? { sticky: !!r.sticky, locked: !!r.locked } : {}),
  };
}

// One page of items from `rows` (fetched with one extra), and the cursor for the next page if there is one: by default
// the last item's "<created>:<id>", or what `at` makes of the last row.
export async function page(c, rows, per, cut, at = r => `${r.created}:${r.id}`) {
  const shown = rows.slice(0, per);
  const h = await hydrate(c, shown);
  return { items: shown.map(r => item(c, r, h, cut)), next: rows.length > per && shown.length ? at(shown[shown.length - 1]) : null };
}

// one post as an item (the answer to writing a reply or a quote)
export async function itemById(c, id) {
  const r = await c.env.DB.prepare(`SELECT ${POST_COLS} FROM ${POSTS} WHERE p.id = ?2`).bind(c.user ? c.user.id : 0, id).first();
  return item(c, r, await hydrate(c, [r]));
}

// The people a text @mentions, as stored: up to 10 who exist, aren't me or banned, and have no block with me either way
// (user ids, in the order they're mentioned). Of the names a mention could be, the longest that exists counts.
async function mentioned(c, s) {
  const found = mentionsIn(s);
  if (!found.length) return [];
  const { results } = await c.env.DB.prepare(`SELECT u.id, u.name_key, (u.banned = 0 AND u.id != ?1 AND ${NOT_BLOCKED('u.id')}) AS ok
    FROM users u WHERE u.name_key IN (SELECT value FROM json_each(?2))`).bind(c.user.id, JSON.stringify(found.flat())).all();
  const byKey = new Map(results.map(u => [u.name_key, u]));
  const ids = [];
  for (const tries of found) {
    const u = tries.map(k => byKey.get(k)).find(Boolean);
    if (u && u.ok && !ids.includes(u.id)) ids.push(u.id);
  }
  return ids.slice(0, 10);
}

// SQL: the post `id` (SQL: a parameter like '?2', or a number) is still there to interact with: not deleted, not hidden.
// Every write that lands on a post carries it, so a post deleted at the same moment gets nothing: the check and the write
// happen in the same batch.
export const LIVE = id => `EXISTS (SELECT 1 FROM posts lv WHERE lv.id = ${id} AND lv.deleted = 0 AND lv.hidden = 0)`;

// Writes a new post (`cols`: its columns besides the author and the time) in one batch with everything that comes with
// it: `more` statements (the counts it changes), the people it @mentions (found in `mentionIn`), its #tags (found in
// `tagIn`) and its notifications: `tell` ([kind, user id] pairs, like a reply's [reply, the parent's author]), then a
// mention for each person mentioned who wasn't told already. `on`: the id of the post it answers or quotes; if that one
// was deleted or hidden in the meantime nothing is written at all (the `more` statements must check LIVE themselves) and
// it's a 404. `guard`: SQL that must hold instead (a comment's: its thread is still open), with the same effect.
// `media`: the writer's uploads to attach, from claimMedia (shared/media.js); if one of them went on another post in the
// meantime, nothing at all is written and it's a 409. The interaction scores (shared/affinity.js) toward the people told
// (by the kind they're told: a reply, a quote, a comment) and mentioned move in the same batch. Answers the new post's id.
export async function writePost(c, cols, { mentionIn = '', tagIn = '', tell = [], more = [], on = null, guard = null, media = [] } = {}) {
  const DB = c.env.DB;
  const people = await mentioned(c, mentionIn);
  const tags = tagsIn(tagIn);
  const fresh = JUST_WRITTEN(`'${cols.kind}'`);
  const still = guard || (on ? LIVE(Number(on)) : '1');   // (`on` is a post id read from the database: a plain number)
  const keys = Object.keys(cols);
  const [made] = await DB.batch([
    DB.prepare(`INSERT INTO posts (${keys.join(', ')}, author_id, created) SELECT ${keys.map(() => '?').join(', ')}, ?, ? WHERE ${still} RETURNING id`)
      .bind(...Object.values(cols), c.user.id, c.now),
    ...more,
    people.length && DB.prepare(`INSERT INTO mentions (post_id, user_id) SELECT ${fresh}, value FROM json_each(?3) WHERE ${still}`).bind(c.user.id, c.now, JSON.stringify(people)),
    tags.length && DB.prepare(`INSERT INTO post_tags (tag, post_id, created) SELECT value, ${fresh}, ?2 FROM json_each(?3) WHERE ${still}`).bind(c.user.id, c.now, JSON.stringify(tags)),
    ...tell.map(([kind, id]) => notify(c, kind, [id], fresh, still)),
    notify(c, 'mention', people.filter(id => !tell.some(t => t[1] === id)), fresh, still),
    ...attachTo(DB, c.user.id, c.now, media, fresh, still),
    bump(c, [...tell.map(([kind, id]) => [id, W[kind] || 0]), ...people.filter(id => !tell.some(t => t[1] === id)).map(id => [id, W.mention])], still),
  ].filter(Boolean)).catch(e => {
    if (attachFailed(e)) fail(409, 'one of those photos just went on another post. upload it again.');
    throw e;
  });
  if (!made.results.length) fail(404, 'that post is gone.');
  return made.results[0].id;
}

// The statements that undo `author`'s repost of post `id`: its count, its notification and the repost itself. (The
// count only comes down if the repost is really there, so undoing twice changes nothing.)
export function dropRepost(DB, author, id) {
  return [
    DB.prepare('UPDATE posts SET repost_count = repost_count - 1 WHERE id = ?2 AND EXISTS (SELECT 1 FROM posts WHERE kind = \'repost\' AND author_id = ?1 AND quote_of = ?2)').bind(author, id),
    DB.prepare('DELETE FROM notifications WHERE kind = \'repost\' AND actor_id = ? AND post_id = ?').bind(author, id),
    DB.prepare('DELETE FROM posts WHERE kind = \'repost\' AND author_id = ? AND quote_of = ?').bind(author, id),
  ];
}
