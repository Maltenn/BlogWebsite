// Database helpers shared by the routes: user lookups, the shape a user takes in every answer, follows (and the
// friends and privacy that come from them), blocks, which posts the viewer may see, and rate limits.
import { fail } from './http.js';
import { clip } from './text.js';

export const ONLINE_MS = 5 * 60 * 1000;          // "Online Now!" = seen in the last five minutes

// The columns every "who is this" answer needs, from users table alias `a` → { id, name, avatar }
export const REF_COLS = (alias, prefix) =>
  `${alias}.id AS ${prefix}id, ${alias}.name AS ${prefix}name, ${alias}.avatar AS ${prefix}avatar`;

export function ref(row, prefix = '') {
  if (!row || row[prefix + 'id'] == null) return null;
  return { id: row[prefix + 'id'], name: row[prefix + 'name'], avatar: row[prefix + 'avatar'] };
}

export const refOf = u => (u ? { id: u.id, name: u.name, avatar: u.avatar } : null);

// (never sent to anybody as-is: email and birthdate are private)
const USER_COLS = 'id, name, name_key, email, avatar, birthdate, is_admin, banned, follow_policy, dm_policy, created, last_seen';

export async function userByName(env, name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key || key.length > 40) return null;
  return env.DB.prepare(`SELECT ${USER_COLS} FROM users WHERE name_key = ?`).bind(key).first();
}

// the person named in the URL, as the viewer may see them: missing, banned, or hidden by a block → 404
export async function visibleUser(c, name) {
  const u = await userByName(c.env, name);
  const admin = c.user && c.user.is_admin;
  if (!u || (u.banned && !admin)) fail(404, 'nobody by that name lives here.');
  if (c.user && u.id !== c.user.id && !admin && await blockedBy(c.env, u.id, c.user.id)) fail(404, 'nobody by that name lives here.');
  return u;
}

/* follows: one-way. Two people who follow each other (both accepted) are friends. */

// `follower`'s follow of `followee` ({ status, created, accepted }), or null
export async function followOf(env, follower, followee) {
  return env.DB.prepare('SELECT status, created, accepted FROM follows WHERE follower_id = ? AND followee_id = ?').bind(follower, followee).first();
}

export async function areFriends(env, x, y) {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM follows
    WHERE ((follower_id = ?1 AND followee_id = ?2) OR (follower_id = ?2 AND followee_id = ?1)) AND status = 'accepted'`).bind(x, y).first();
  return r.n === 2;
}

// May the viewer see this person's statuses, blog, Friends' Comments and lists? Yes on an open profile; on a private
// one ("approve"), only its accepted followers, the owner and moderators.
export async function canSeePosts(c, u) {
  if (u.follow_policy !== 'approve') return true;
  if (!c.user) return false;
  if (c.user.id === u.id || c.user.is_admin) return true;
  const f = await followOf(c.env, c.user.id, u.id);
  return !!(f && f.status === 'accepted');
}

// How the viewer and this person are connected, as the profile and every follow answer show it. null when logged out.
export async function relationTo(c, u) {
  if (!c.user) return null;
  const me = c.user.id;
  const { results } = await c.env.DB.prepare(
    'SELECT follower_id, status FROM follows WHERE (follower_id = ?1 AND followee_id = ?2) OR (follower_id = ?2 AND followee_id = ?1)'
  ).bind(me, u.id).all();
  const mine = results.find(r => r.follower_id === me);
  const theirs = results.find(r => r.follower_id === u.id);
  const following = mine ? mine.status : 'none';
  const followsMe = !!(theirs && theirs.status === 'accepted');
  const friends = following === 'accepted' && followsMe;
  const self = me === u.id;
  const blockedByMe = !self && await blockedBy(c.env, me, u.id);
  return {
    following, followsMe, friends, blockedByMe,
    canComment: self || friends,
    canMessage: !self && !blockedByMe && (u.dm_policy === 'everyone' || friends),
  };
}

// has `blocker` blocked `blocked`?
export async function blockedBy(env, blocker, blocked) {
  const r = await env.DB.prepare('SELECT 1 AS x FROM blocks WHERE blocker_id = ? AND blocked_id = ?').bind(blocker, blocked).first();
  return !!r;
}

export async function blockedEither(env, x, y) {
  const r = await env.DB.prepare(
    'SELECT 1 AS x FROM blocks WHERE (blocker_id = ?1 AND blocked_id = ?2) OR (blocker_id = ?2 AND blocked_id = ?1)'
  ).bind(x, y).first();
  return !!r;
}

// SQL: "this person is not hidden from the viewer by a block in either direction". The viewer is bound as ?1 (or is the
// SQL in `viewer`).
export const NOT_BLOCKED = (col, viewer = '?1') =>
  `NOT EXISTS (SELECT 1 FROM blocks bl WHERE (bl.blocker_id = ${viewer} AND bl.blocked_id = ${col}) OR (bl.blocked_id = ${viewer} AND bl.blocker_id = ${col}))`;

// SQL: may the viewer (?1, or the SQL in `viewer`) see the posts of user `u`? canSeePosts for whole lists: an open
// profile, their own, or one they follow (accepted). Moderators get no pass here.
export const SEES = (u, viewer = '?1') => `(${u}.follow_policy != 'approve' OR ${u}.id = ${viewer}
  OR EXISTS (SELECT 1 FROM follows sf WHERE sf.follower_id = ${viewer} AND sf.followee_id = ${u}.id AND sf.status = 'accepted'))`;

// SQL: SEES for a post `p` written by `u`: board threads and comments are public spaces, so a private profile's are
// seen by everyone (whatever else hides a post still does)
export const SEES_POST = (p, u, viewer = '?1') => `(${p}.board_id IS NOT NULL OR ${SEES(u, viewer)})`;

// SQL: the posts `p` (joined to their author as users `a`) the viewer may see: not hidden, not dated in the future, not
// deleted, author not banned and not blocked in either direction. Binds: ?1 viewer, ?2 now. IN_THREAD also keeps the
// tombstones of deleted posts, which hold a conversation together.
export const IN_THREAD = `p.hidden = 0 AND p.created <= ?2 AND a.banned = 0 AND ${NOT_BLOCKED('p.author_id')}`;
export const VISIBLE = `${IN_THREAD} AND p.deleted = 0`;

// SQL: a repost `p` shows only while the viewer may see its original. REPOSTED joins the original as posts `o` (by users
// `oa`), REPOST_OK is the test (privacy included: a profile can go private after it was reposted).
export const REPOSTED = 'LEFT JOIN posts o ON o.id = p.quote_of AND p.kind = \'repost\' LEFT JOIN users oa ON oa.id = o.author_id';
export const REPOST_OK = `(p.kind != 'repost' OR (o.hidden = 0 AND o.deleted = 0 AND oa.banned = 0 AND ${NOT_BLOCKED('o.author_id')} AND ${SEES('oa')}))`;

// SQL: the id of the post of `kind` (SQL) that the logged-in user ?1 wrote at ?2 earlier in the same batch, for the rows
// that point at it (its mentions, tags, notifications). A batch runs on its own, so their newest such post is that one.
export const JUST_WRITTEN = kind => `(SELECT MAX(id) FROM posts WHERE author_id = ?1 AND kind = ${kind} AND created = ?2)`;

// SQL: tombstone `x` is held by nothing but `replies` replies (the ones going with it) and no quote that isn't deleted;
// a board thread also by no comment in it but the `comments` going with it (however deep: a thread holds every comment
// whose root_id it is)
const UNHELD = (replies, comments) => `x.deleted = 1 AND (SELECT COUNT(*) FROM posts r WHERE r.reply_to = x.id) = ${replies}
  AND NOT EXISTS (SELECT 1 FROM posts q WHERE q.quote_of = x.id AND q.kind = 'quote' AND q.deleted = 0)
  AND (x.kind != 'thread' OR (SELECT COUNT(*) FROM posts r WHERE r.root_id = x.id AND r.kind = 'comment') = ${comments})`;

// SQL: removes the tombstones in the JSON list ?1 that nothing holds any more (no replies left, no quotes that aren't
// deleted, for a thread no comments), then the tombstones above them in their conversations that only those held, all
// the way up (`n`: the comments going so far, which a thread may be holding). For the end of a batch that removed a
// reply or a quote, with the post it answered or quoted. No count changes: a tombstone is already out of its parent's
// counts and has none of its own left.
export const CLEAR_TOMBSTONES = `WITH RECURSIVE gone(id, up, n) AS (
    SELECT x.id, x.reply_to, x.kind = 'comment' FROM posts x WHERE x.id IN (SELECT value FROM json_each(?1)) AND ${UNHELD(0, 0)}
    UNION ALL
    SELECT x.id, x.reply_to, g.n + (x.kind = 'comment') FROM gone g JOIN posts x ON x.id = g.up WHERE ${UNHELD(1, 'g.n')})
  DELETE FROM posts WHERE id IN (SELECT id FROM gone)`;

// SQL: board post `x` and everything above it in its thread (the comments it answers, up to the thread itself) show to
// the viewer (SQL, default ?1): none hidden by a moderator or (with `now`) dated in the future, none by someone banned
// or with a block either way. Tombstones don't stop it. The same reach growTree (boards/tree.js) gives a comment tree,
// for votes, replies and the notifications about comments.
export const REACHABLE = (x, viewer = '?1', now = '?2') => `NOT EXISTS (WITH RECURSIVE up(id) AS (
    SELECT ${x} UNION ALL SELECT ux.reply_to FROM up JOIN posts ux ON ux.id = up.id WHERE ux.kind = 'comment')
  SELECT 1 FROM up JOIN posts ux ON ux.id = up.id JOIN users ua ON ua.id = ux.author_id
  WHERE ux.hidden = 1 OR ${now ? `ux.created > ${now} OR ` : ''}ua.banned = 1 OR NOT ${NOT_BLOCKED('ux.author_id', viewer)})`;

// A post in brief, as a quote's box or a notification shows it, with its words cut at 280 characters. The row has
// `prefix` + id, kind, created, subject, subtitle, body and deleted, and the author's REF_COLS under `prefix` + 'a_'.
// deleted: true is a tombstone (no words).
export function lite(r, prefix = '') {
  const body = r[prefix + 'body'];
  return {
    id: r[prefix + 'id'], kind: r[prefix + 'kind'], created: r[prefix + 'created'],
    subject: r[prefix + 'subject'] || null, subtitle: r[prefix + 'subtitle'] || null,
    body: clip(body, 280) ?? body, author: ref(r, prefix + 'a_'), deleted: !!r[prefix + 'deleted'],
  };
}

// SQL: the people on user ?2's followers / following / friends list, as users `x`: accepted follows only, nobody
// banned or hidden from the viewer ?1 by a block. `from` is everything after FROM (it ends inside the WHERE, so more
// conditions can follow with AND); `since` sorts the list newest first.
const LISTED = `x.banned = 0 AND ${NOT_BLOCKED('x.id')}`;
export const LISTS = {
  followers: { from: `follows f JOIN users x ON x.id = f.follower_id WHERE f.followee_id = ?2 AND f.status = 'accepted' AND ${LISTED}`, since: 'f.accepted' },
  following: { from: `follows f JOIN users x ON x.id = f.followee_id WHERE f.follower_id = ?2 AND f.status = 'accepted' AND ${LISTED}`, since: 'f.accepted' },
  friends: {
    from: `follows f JOIN follows g ON g.follower_id = f.followee_id AND g.followee_id = f.follower_id AND g.status = 'accepted'
      JOIN users x ON x.id = f.followee_id WHERE f.follower_id = ?2 AND f.status = 'accepted' AND ${LISTED}`,
    since: 'MAX(f.accepted, g.accepted)',                   // when the second of the two follows was accepted
  },
};

// Count attempts under `key` in each window; refuse when any window can't take `n` more (one by default), else record
// them. windows: [[max, ms], …]. Counting and recording are one statement, so requests racing each other (a burst of
// them at once) can't all slip in under the limit.
export async function limit(c, key, windows, message = 'slow down — try again in a bit', n = 1) {
  const room = windows.map(([max, ms]) => `(SELECT COUNT(*) FROM attempts WHERE k = ?1 AND created > ?2 - ${Number(ms)}) + ${Number(n)} <= ${Number(max)}`);
  const r = await c.env.DB.prepare(`INSERT INTO attempts (k, created) SELECT ?1, ?2 FROM json_each(?3) WHERE ${room.join(' AND ')}`)
    .bind(key, c.now, JSON.stringify(Array(n).fill(0))).run();
  if (!r.meta.changes) fail(429, message);
}

// the profile JSON for a user id ({} if missing or unreadable)
export async function profileData(env, userId) {
  const row = await env.DB.prepare('SELECT data FROM profiles WHERE user_id = ?').bind(userId).first();
  try { return row ? JSON.parse(row.data) : {}; } catch { return {}; }
}

export const isOnline = (u, now) => u.last_seen != null && u.last_seen > now - ONLINE_MS;
