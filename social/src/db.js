// Database helpers shared by the routes: user lookups, the shape a user takes in every answer, friendships,
// blocks, rate limits and a tiny key/value store.
import { fail } from './http.js';

export const ONLINE_MS = 5 * 60 * 1000;          // "Online Now!" = seen in the last five minutes

// The columns every "who is this" answer needs, from users table alias `a` → { id, name, avatar, isBot }.
// Bots are flagged in EVERY answer so the page can label them wherever a name or picture appears.
export const REF_COLS = (alias, prefix) =>
  `${alias}.id AS ${prefix}id, ${alias}.name AS ${prefix}name, ${alias}.avatar AS ${prefix}avatar, ${alias}.is_bot AS ${prefix}bot`;

export function ref(row, prefix = '') {
  if (!row || row[prefix + 'id'] == null) return null;
  return { id: row[prefix + 'id'], name: row[prefix + 'name'], avatar: row[prefix + 'avatar'], isBot: !!row[prefix + 'bot'] };
}

export const refOf = u => (u ? { id: u.id, name: u.name, avatar: u.avatar, isBot: !!u.is_bot } : null);

const USER_COLS = 'id, name, name_key, avatar, is_bot, bot_key, is_admin, banned, wall_policy, dm_policy, created, last_seen';

export async function userByName(env, name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key || key.length > 40) return null;
  return env.DB.prepare(`SELECT ${USER_COLS} FROM users WHERE name_key = ?`).bind(key).first();
}

export async function userById(env, id) {
  return env.DB.prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).bind(id).first();
}

// the person named in the URL, as `viewer` may see them: missing, banned, or hidden by a block → 404
export async function visibleUser(c, name) {
  const u = await userByName(c.env, name);
  const admin = c.user && c.user.is_admin;
  if (!u || (u.banned && !admin)) fail(404, 'nobody by that name lives here.');
  if (c.user && u.id !== c.user.id && !admin && await blockedBy(c.env, u.id, c.user.id)) fail(404, 'nobody by that name lives here.');
  return u;
}

export const pair = (x, y) => (x < y ? [x, y] : [y, x]);

export async function friendship(env, x, y) {
  const [a, b] = pair(x, y);
  return env.DB.prepare('SELECT a, b, status, requested_by, created, accepted FROM friendships WHERE a = ? AND b = ?').bind(a, b).first();
}

export async function areFriends(env, x, y) {
  const f = await friendship(env, x, y);
  return !!(f && f.status === 'accepted');
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

// SQL: "author/other is not hidden from the viewer by a block in either direction". The viewer is bound as ?1.
export const NOT_BLOCKED = col =>
  `NOT EXISTS (SELECT 1 FROM blocks bl WHERE (bl.blocker_id = ?1 AND bl.blocked_id = ${col}) OR (bl.blocked_id = ?1 AND bl.blocker_id = ${col}))`;

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

export async function kvGet(env, k) {
  const row = await env.DB.prepare('SELECT v, expires FROM kv WHERE k = ?').bind(k).first();
  if (!row || (row.expires != null && row.expires < Date.now())) return null;
  return row.v;
}

export async function kvSet(env, k, v, ttlMs = null) {
  await env.DB.prepare('INSERT OR REPLACE INTO kv (k, v, expires) VALUES (?, ?, ?)')
    .bind(k, v, ttlMs ? Date.now() + ttlMs : null).run();
}

// the profile JSON for a user id ({} if missing or unreadable)
export async function profileData(env, userId) {
  const row = await env.DB.prepare('SELECT data FROM profiles WHERE user_id = ?').bind(userId).first();
  try { return row ? JSON.parse(row.data) : {}; } catch { return {}; }
}

export const isOnline = (u, now) => !u.is_bot && u.last_seen != null && u.last_seen > now - ONLINE_MS;
