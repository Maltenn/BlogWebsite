// Accounts: sign-up, log in / out, sessions, password change, deleting an account.
// Passwords are hashed with PBKDF2-SHA256 (100k iterations, the most Workers allows) and a per-user salt.
// A session is a random token in an HttpOnly, SameSite=Lax cookie; the database only keeps its SHA-256.
import { fail, json, readBody, getCookie, sessionCookie, sha256Hex } from './http.js';
import { nameProblem } from './text.js';
import { limit } from './db.js';
import { defaultProfile, isAvatar, DEFAULT_AVATAR } from './profiles.js';
import { BOT_NAME_KEYS, welcome } from './bots.js';

const ITERATIONS = 100000;
const SESSION_DAYS = 30;
const enc = new TextEncoder();
const b64 = bytes => btoa(String.fromCharCode(...bytes));
const unb64 = s => Uint8Array.from(atob(s), ch => ch.charCodeAt(0));

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${ITERATIONS}$${b64(salt)}$${b64(await pbkdf2(password, salt, ITERATIONS))}`;
}

// a hash to verify against when the account doesn't exist, so a wrong name takes as long as a wrong password
const DUMMY = 'pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export async function checkPassword(password, stored) {
  const [scheme, iter, salt, hash] = String(stored || DUMMY).split('$');
  if (scheme !== 'pbkdf2-sha256') return false;
  const got = await pbkdf2(password, unb64(salt), Number(iter));
  const want = unb64(hash);
  let diff = got.length ^ want.length;
  for (let i = 0; i < Math.min(got.length, want.length); i++) diff |= got[i] ^ want[i];
  return diff === 0 && stored != null;
}

function passwordProblem(pw, name) {
  if (typeof pw !== 'string' || pw.length < 8) return 'passwords need at least 8 characters.';
  if (pw.length > 200) return 'that password is too long.';
  if (pw.toLowerCase() === String(name || '').toLowerCase()) return 'your password can\'t be your screen name.';
  if (/^(password\d*|12345678\d*|qwertyui\w*)$/i.test(pw)) return 'that password is on every hacker\'s list. try another one.';
  return '';
}

async function ipKey(c) {
  const ip = c.req.headers.get('CF-Connecting-IP') || '0.0.0.0';
  return (await sha256Hex(`${c.env.IP_SALT || 'ourspace-social'}|${ip}`)).slice(0, 32);
}

async function startSession(c, userId) {
  const token = b64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, ch => ({ '+': '-', '/': '_', '=': '' })[ch]);
  await c.env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created, expires) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), userId, c.now, c.now + SESSION_DAYS * 86400000).run();
  return sessionCookie(c.url, token, SESSION_DAYS * 86400);
}

// The logged-in user for this request, or null. Banned accounts are logged out.
export async function currentUser(c) {
  const token = getCookie(c.req, 'os_sid');
  if (!token || token.length > 100) return null;
  const tokenHash = await sha256Hex(token);
  const u = await c.env.DB.prepare(`
    SELECT u.id, u.name, u.avatar, u.is_admin, u.is_bot, u.banned, u.wall_policy, u.dm_policy, u.last_seen, u.pass_hash, s.expires
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).bind(tokenHash).first();
  if (!u || u.expires < c.now || u.banned) return null;
  if (!u.last_seen || u.last_seen < c.now - 60000) {
    c.ctx.waitUntil(c.env.DB.prepare('UPDATE users SET last_seen = ? WHERE id = ?').bind(c.now, u.id).run());
  }
  return { ...u, tokenHash };
}

// GET /api/me — who am I, plus the numbers the tabs show
export async function me(c) {
  if (!c.user) return json({ user: null, minAge: Number(c.env.MIN_AGE || 13) });
  const id = c.user.id;
  const counts = await c.env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM friendships f WHERE (f.a = ?1 OR f.b = ?1) AND f.status = 'pending' AND f.requested_by != ?1
         AND NOT EXISTS (SELECT 1 FROM users x WHERE x.id = f.requested_by AND x.banned = 1)) AS requests,
      (SELECT COUNT(*) FROM messages m JOIN users x ON x.id = m.from_id
         WHERE m.to_id = ?1 AND m.read_at IS NULL AND m.hidden = 0 AND m.created <= ?2 AND x.banned = 0
         AND NOT EXISTS (SELECT 1 FROM blocks bl WHERE (bl.blocker_id = ?1 AND bl.blocked_id = m.from_id) OR (bl.blocked_id = ?1 AND bl.blocker_id = m.from_id))) AS unread,
      (SELECT COUNT(*) FROM reports WHERE status = 'open') AS reports`).bind(id, c.now).first();
  return json({
    user: { id, name: c.user.name, avatar: c.user.avatar, isBot: false, isAdmin: !!c.user.is_admin },
    counts: { requests: counts.requests, unread: counts.unread, reports: c.user.is_admin ? counts.reports : 0 },
    settings: { wallPolicy: c.user.wall_policy, dmPolicy: c.user.dm_policy },
    minAge: Number(c.env.MIN_AGE || 13),
  });
}

// POST /api/signup { name, password, avatar, ageOk, rulesOk }
export async function signup(c) {
  const b = await readBody(c.req);
  const minAge = Number(c.env.MIN_AGE || 13);
  if (b.ageOk !== true) fail(400, `you need to be ${minAge} or older to join ourspace.`);
  if (b.rulesOk !== true) fail(400, 'please read and agree to the house rules.');
  const name = String(b.name ?? '').trim();
  const nameErr = nameProblem(name, BOT_NAME_KEYS);
  if (nameErr) fail(400, nameErr);
  const pwErr = passwordProblem(b.password, name);
  if (pwErr) fail(400, pwErr);
  const avatar = isAvatar(b.avatar) ? b.avatar : DEFAULT_AVATAR;

  await limit(c, 'signup:ip:' + await ipKey(c), [[Number(c.env.SIGNUPS_PER_IP_PER_HOUR || 5), 3600000]],
    'too many new accounts from your connection. try again in an hour.');
  await limit(c, 'signup:all', [[Number(c.env.SIGNUPS_PER_DAY || 200), 86400000]],
    'ourspace is full for today (we\'re small!). try again tomorrow.');

  const taken = await c.env.DB.prepare('SELECT 1 AS x FROM users WHERE name_key = ?').bind(name.toLowerCase()).first();
  if (taken) fail(409, `"${name}" is taken. try adding some xX's.`);
  let user;
  try {
    user = await c.env.DB.prepare('INSERT INTO users (name, name_key, avatar, pass_hash, created, last_seen) VALUES (?, ?, ?, ?, ?, ?) RETURNING id, name, avatar')
      .bind(name, name.toLowerCase(), avatar, await hashPassword(b.password), c.now, c.now).first();
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) fail(409, `"${name}" is taken. try adding some xX's.`);
    throw e;
  }
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO profiles (user_id, data, updated) VALUES (?, ?, ?)').bind(user.id, JSON.stringify(defaultProfile()), c.now),
    c.env.DB.prepare('INSERT INTO posts (kind, author_id, body, created) VALUES (\'joined\', ?, \'\', ?)').bind(user.id, c.now),
  ]);
  await welcome(c, user);
  const cookie = await startSession(c, user.id);
  return json({ user: { id: user.id, name: user.name, avatar: user.avatar, isBot: false, isAdmin: false } }, 201, { 'Set-Cookie': cookie });
}

// POST /api/login { name, password }
export async function login(c) {
  const b = await readBody(c.req);
  const key = String(b.name ?? '').trim().toLowerCase().slice(0, 40);
  const password = typeof b.password === 'string' ? b.password.slice(0, 200) : '';
  const ip = await ipKey(c);
  // only failures count, but they are checked before the (slow) password check
  const recent = await c.env.DB.prepare(`
    SELECT (SELECT COUNT(*) FROM attempts WHERE k = ?1 AND created > ?3) AS by_name,
           (SELECT COUNT(*) FROM attempts WHERE k = ?2 AND created > ?3) AS by_ip`)
    .bind('loginfail:name:' + key, 'loginfail:ip:' + ip, c.now - 15 * 60000).first();
  if (recent.by_name >= 10 || recent.by_ip >= 30) fail(429, 'too many wrong passwords. wait 15 minutes and try again.');

  const u = await c.env.DB.prepare('SELECT id, name, avatar, is_admin, banned, pass_hash FROM users WHERE name_key = ? AND is_bot = 0').bind(key).first();
  const ok = await checkPassword(password, u ? u.pass_hash : null);
  if (!u || !ok) {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO attempts (k, created) VALUES (?, ?)').bind('loginfail:name:' + key, c.now),
      c.env.DB.prepare('INSERT INTO attempts (k, created) VALUES (?, ?)').bind('loginfail:ip:' + ip, c.now),
    ]);
    fail(401, 'wrong screen name or password.');
  }
  if (u.banned) fail(403, 'this account has been suspended for breaking the house rules.');
  await c.env.DB.prepare('UPDATE users SET last_seen = ? WHERE id = ?').bind(c.now, u.id).run();
  const cookie = await startSession(c, u.id);
  return json({ user: { id: u.id, name: u.name, avatar: u.avatar, isBot: false, isAdmin: !!u.is_admin } }, 200, { 'Set-Cookie': cookie });
}

// POST /api/logout
export async function logout(c) {
  if (c.user) await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(c.user.tokenHash).run();
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(c.url, '', 0) });
}

// POST /api/me/password { current, next } — also logs out every other device
export async function changePassword(c) {
  const b = await readBody(c.req);
  await limit(c, 'pwchange:' + c.user.id, [[5, 15 * 60000]]);
  if (!await checkPassword(String(b.current ?? ''), c.user.pass_hash)) fail(401, 'your current password is wrong.');
  const err = passwordProblem(b.next, c.user.name);
  if (err) fail(400, err);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').bind(await hashPassword(b.next), c.user.id),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(c.user.id, c.user.tokenHash),
  ]);
  return json({ ok: true });
}

// DELETE /api/me { password } — the account and everything it wrote. Reports about it keep their snapshot.
export async function deleteAccount(c) {
  const b = await readBody(c.req);
  await limit(c, 'delete:' + c.user.id, [[5, 15 * 60000]]);
  if (!await checkPassword(String(b.password ?? ''), c.user.pass_hash)) fail(401, 'that password is wrong.');
  const id = c.user.id;
  const DB = c.env.DB;
  await DB.batch([
    DB.prepare('DELETE FROM posts WHERE author_id = ?1 OR target_id = ?1').bind(id),
    DB.prepare('DELETE FROM messages WHERE from_id = ?1 OR to_id = ?1').bind(id),
    DB.prepare('DELETE FROM friendships WHERE a = ?1 OR b = ?1').bind(id),
    DB.prepare('DELETE FROM blocks WHERE blocker_id = ?1 OR blocked_id = ?1').bind(id),
    DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
    DB.prepare('DELETE FROM profiles WHERE user_id = ?').bind(id),
    DB.prepare('UPDATE reports SET reporter_id = NULL WHERE reporter_id = ?').bind(id),
    DB.prepare('UPDATE reports SET target_user_id = NULL WHERE target_user_id = ?').bind(id),
    DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
  ]);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(c.url, '', 0) });
}

