// Database helpers shared by the routes: user lookups, the shape a user takes in every answer, follows (and the
// friends and privacy that come from them), blocks and rate limits.
import { fail } from './http.js';

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

// SQL: "this person is not hidden from the viewer by a block in either direction". The viewer is bound as ?1.
export const NOT_BLOCKED = col =>
  `NOT EXISTS (SELECT 1 FROM blocks bl WHERE (bl.blocker_id = ?1 AND bl.blocked_id = ${col}) OR (bl.blocked_id = ?1 AND bl.blocker_id = ${col}))`;

// SQL: the posts `p` (joined to their author as users `a`) the viewer may see: not hidden, not dated in the future,
// author not banned and not blocked in either direction. Binds: ?1 viewer, ?2 now.
export const VISIBLE = `p.hidden = 0 AND p.created <= ?2 AND a.banned = 0 AND ${NOT_BLOCKED('p.author_id')}`;

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

// Count attempts under `key` in each window; refuse when any window is full, else record this one.
// windows: [[max, ms], …]
export async function limit(c, key, windows, message = 'slow down — try again in a bit') {
  const longest = Math.max(...windows.map(w => w[1]));
  const { results } = await c.env.DB.prepare('SELECT created FROM attempts WHERE k = ? AND created > ?')
    .bind(key, c.now - longest).all();
  for (const [max, ms] of windows) {
    if (results.filter(r => r.created > c.now - ms).length >= max) fail(429, message);
  }
  await c.env.DB.prepare('INSERT INTO attempts (k, created) VALUES (?, ?)').bind(key, c.now).run();
}

// the profile JSON for a user id ({} if missing or unreadable)
export async function profileData(env, userId) {
  const row = await env.DB.prepare('SELECT data FROM profiles WHERE user_id = ?').bind(userId).first();
  try { return row ? JSON.parse(row.data) : {}; } catch { return {}; }
}

export const isOnline = (u, now) => u.last_seen != null && u.last_seen > now - ONLINE_MS;
