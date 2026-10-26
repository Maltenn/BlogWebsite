// Accounts: sign-up (email + password), log in / out, sessions, forgotten passwords, password changes, deleting an
// account. Signing in with Google, Apple & co. is oauth.js; it shares createUser() and startSession() from here.
// Passwords are hashed with PBKDF2-SHA256 (100k iterations, the most Workers allows) and a per-user salt. A session
// is a random token in an HttpOnly, SameSite=Lax cookie; the database only keeps its SHA-256.
import { HttpError, fail, json, readBody, getCookie, sessionCookie, sha256Hex, ipKey } from '../shared/http.js';
import { nameProblem } from '../shared/text.js';
import { limit, CLEAR_TOMBSTONES } from '../shared/db.js';
import { RESORT } from '../shared/ranking.js';
import { defaultProfile, isAvatar, DEFAULT_AVATAR } from '../profiles/profiles.js';
import { checkBirthday } from '../shared/dates.js';
import { sunSign } from '../shared/astro.js';
import { randomToken } from '../shared/seal.js';
import { sendMail, mailReady } from '../shared/mail.js';
import { SHOWN, UNREAD } from '../shared/notify.js';
import { UNREAD_CHATS, HANDOVER } from '../shared/chat.js';
import { dropObjects, keysIn, releaseMedia } from '../shared/media.js';
import { signOut, roomsOf } from '../shared/live.js';

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

// a hash to verify against when there's no password to check, so every failure takes the same time
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

export function passwordProblem(pw, name, email) {
  if (typeof pw !== 'string' || pw.length < 8) return 'passwords need at least 8 characters.';
  if (pw.length > 200) return 'that password is too long.';
  const low = pw.toLowerCase();
  if (low === String(name || '').toLowerCase() || low === String(email || '').toLowerCase()) return 'your password can\'t be your screen name or email.';
  if (/^(password\d*|12345678\d*|qwertyui\w*)$/i.test(pw)) return 'that password is on every hacker\'s list. try another one.';
  return '';
}

export function cleanEmail(raw) {
  const e = String(raw ?? '').trim().toLowerCase();
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return null;
  return e;
}

// (the per-IP rate-limit keys live in shared/http.js, where Browse uses them too)
export { ipGroup, ipKey } from '../shared/http.js';

export async function startSession(c, userId) {
  const token = randomToken();
  await c.env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created, expires) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), userId, c.now, c.now + SESSION_DAYS * 86400000).run();
  return sessionCookie(c.url, token, SESSION_DAYS * 86400);
}

// The age check. Too young → refused, and a cookie stops the same browser from simply trying another year for a day.
const AGE_COOKIE = 'os_agegate';
export function ageGate(c, birthday) {
  if (getCookie(c.req, AGE_COOKIE)) fail(403, 'sorry, you can\'t join ourspace right now.');
  const minAge = Number(c.env.MIN_AGE || 13);
  const b = checkBirthday(birthday, minAge, c.now);
  if (b.tooYoung) {
    const secure = c.url.protocol === 'https:' ? '; Secure' : '';
    const err = new HttpError(403, `sorry, you have to be ${minAge} or older to join ourspace.`);
    err.cookie = `${AGE_COOKIE}=1; Path=/api/signup; HttpOnly; SameSite=Lax; Max-Age=86400${secure}`;
    throw err;
  }
  return b.birthdate;
}

// shared by every way of signing up: checks the screen name, makes the account and its page
export async function createUser(c, { name, email, passHash, birthdate, avatar }) {
  const nameErr = nameProblem(name);
  if (nameErr) fail(400, nameErr);
  const taken = await c.env.DB.prepare('SELECT name_key = ?1 AS n, email = ?2 AS e FROM users WHERE name_key = ?1 OR (?2 IS NOT NULL AND email = ?2) LIMIT 2')
    .bind(name.toLowerCase(), email).all();
  if (taken.results.some(r => r.n)) fail(409, `"${name}" is taken. try adding some xX's.`);
  if (taken.results.some(r => r.e)) fail(409, 'there\'s already an account with that email. log in instead (or reset your password).');
  await limit(c, 'signup:ip:' + await ipKey(c), [[Number(c.env.SIGNUPS_PER_IP_PER_HOUR || 5), 3600000]],
    'too many new accounts from your connection. try again in an hour.');
  await limit(c, 'signup:all', [[Number(c.env.SIGNUPS_PER_DAY || 200), 86400000]],
    'ourspace is full for today (we\'re small!). try again tomorrow.');
  let user;
  try {
    user = await c.env.DB.prepare(`INSERT INTO users (name, name_key, email, avatar, pass_hash, birthdate, created, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, name, avatar, birthdate`)
      .bind(name, name.toLowerCase(), email, isAvatar(avatar) ? avatar : DEFAULT_AVATAR, passHash, birthdate, c.now, c.now).first();
  } catch (e) {
    if (/UNIQUE/i.test(String(e && e.message))) fail(409, 'that screen name or email was just taken. try again.');
    throw e;
  }
  await c.env.DB.prepare('INSERT INTO profiles (user_id, data, updated) VALUES (?, ?, ?)').bind(user.id, JSON.stringify(defaultProfile()), c.now).run();
  return user;
}

export const userOut = u => {
  const s = sunSign(u.birthdate);
  return { id: u.id, name: u.name, avatar: u.avatar, isAdmin: !!u.is_admin, sign: { key: s.key, name: s.name, glyph: s.glyph } };
};

// The logged-in user for this request, or null. Banned accounts are logged out.
export async function currentUser(c) {
  const token = getCookie(c.req, 'os_sid');
  if (!token || token.length > 100) return null;
  const tokenHash = await sha256Hex(token);
  const u = await c.env.DB.prepare(`
    SELECT u.id, u.name, u.email, u.avatar, u.birthdate, u.is_admin, u.banned, u.follow_policy, u.dm_policy, u.last_seen, u.pass_hash, s.expires
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).bind(tokenHash).first();
  if (!u || u.expires < c.now || u.banned) return null;
  if (!u.last_seen || u.last_seen < c.now - 60000) {
    c.ctx.waitUntil(c.env.DB.prepare('UPDATE users SET last_seen = ? WHERE id = ?').bind(c.now, u.id).run());
  }
  return { ...u, tokenHash };
}

// GET /api/me — who am I, plus the numbers the tabs show (notifications: unread ones, up to 99; unread: conversations
// with unread messages, up to 99)
export async function me(c) {
  if (!c.user) return json({ user: null, minAge: Number(c.env.MIN_AGE || 13) });
  const id = c.user.id;
  const counts = await c.env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM follows f JOIN users x ON x.id = f.follower_id
         WHERE f.followee_id = ?1 AND f.status = 'pending' AND x.banned = 0) AS requests,
      ${UNREAD_CHATS} AS unread,
      (SELECT COUNT(*) FROM (SELECT 1 FROM ${SHOWN} AND ${UNREAD} LIMIT 99)) AS notifications,
      (SELECT COUNT(*) FROM reports WHERE status = 'open') AS reports`).bind(id).first();
  return json({
    user: userOut(c.user),
    counts: { requests: counts.requests, unread: counts.unread, notifications: counts.notifications, reports: c.user.is_admin ? counts.reports : 0 },
    settings: { followPolicy: c.user.follow_policy, dmPolicy: c.user.dm_policy },
    minAge: Number(c.env.MIN_AGE || 13),
  });
}

// POST /api/signup { email, password, name, birthday, avatar, rulesOk }
export async function signup(c) {
  const b = await readBody(c.req);
  if (b.rulesOk !== true) fail(400, 'please read and agree to the house rules.');
  const email = cleanEmail(b.email);
  if (!email) fail(400, 'that email address doesn\'t look right.');
  const name = String(b.name ?? '').trim();
  const nameErr = nameProblem(name);
  if (nameErr) fail(400, nameErr);
  const pwErr = passwordProblem(b.password, name, email);
  if (pwErr) fail(400, pwErr);
  const birthdate = ageGate(c, b.birthday);
  const user = await createUser(c, { name, email, passHash: await hashPassword(b.password), birthdate, avatar: b.avatar });
  return json({ user: userOut(user) }, 201, { 'Set-Cookie': await startSession(c, user.id) });
}

// POST /api/login { login (email or screen name), password }
export async function login(c) {
  const b = await readBody(c.req);
  const raw = String(b.login ?? b.email ?? b.name ?? '').trim().toLowerCase().slice(0, 254);
  const password = typeof b.password === 'string' ? b.password.slice(0, 200) : '';
  const ip = await ipKey(c);
  // only failures count, but they are checked before the (slow) password check
  const recent = await c.env.DB.prepare(`
    SELECT (SELECT COUNT(*) FROM attempts WHERE k = ?1 AND created > ?3) AS by_login,
           (SELECT COUNT(*) FROM attempts WHERE k = ?2 AND created > ?3) AS by_ip`)
    .bind('loginfail:' + raw, 'loginfail:ip:' + ip, c.now - 15 * 60000).first();
  if (recent.by_login >= 10 || recent.by_ip >= 30) fail(429, 'too many wrong passwords. wait 15 minutes and try again.');

  const u = await c.env.DB.prepare(`SELECT id, name, avatar, birthdate, is_admin, banned, pass_hash,
      (SELECT GROUP_CONCAT(provider) FROM identities WHERE user_id = users.id) AS providers
    FROM users WHERE ${raw.includes('@') ? 'email' : 'name_key'} = ?`).bind(raw).first();
  const ok = await checkPassword(password, u ? u.pass_hash : null);
  if (!u || !ok) {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO attempts (k, created) VALUES (?, ?)').bind('loginfail:' + raw, c.now),
      c.env.DB.prepare('INSERT INTO attempts (k, created) VALUES (?, ?)').bind('loginfail:ip:' + ip, c.now),
    ]);
    if (u && !u.pass_hash && u.providers) fail(401, 'that account signs in with ' + u.providers.split(',').map(p => p[0].toUpperCase() + p.slice(1)).join(' or ') + '. use "other options".');
    fail(401, 'wrong email, screen name or password.');
  }
  if (u.banned) fail(403, 'this account has been suspended for breaking the house rules.');
  await c.env.DB.prepare('UPDATE users SET last_seen = ? WHERE id = ?').bind(c.now, u.id).run();
  return json({ user: userOut(u) }, 200, { 'Set-Cookie': await startSession(c, u.id) });
}

// POST /api/logout — this session ends, and its chat sockets close (code 4001)
export async function logout(c) {
  if (c.user) {
    await c.env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(c.user.tokenHash).run();
    await signOut(c.env, c.user.id, { only: c.user.tokenHash });
  }
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(c.url, '', 0) });
}

// POST /api/password/forgot { email } — always says "if that's an account, check your email" (no account fishing)
export async function forgotPassword(c) {
  const b = await readBody(c.req);
  const email = cleanEmail(b.email);
  if (!email) fail(400, 'that email address doesn\'t look right.');
  if (!mailReady(c.env, c.url)) fail(503, 'email isn\'t set up on this server yet, so password resets don\'t work. ask a moderator for help.');
  await limit(c, 'forgot:ip:' + await ipKey(c), [[5, 3600000]], 'that\'s a lot of reset emails. try again in an hour.');
  await limit(c, 'forgot:' + email, [[3, 3600000]], 'we already sent a few reset emails to that address. check your spam folder.');
  const u = await c.env.DB.prepare('SELECT id, name, banned FROM users WHERE email = ?').bind(email).first();
  if (u && !u.banned) {
    const token = randomToken();
    await c.env.DB.prepare('INSERT INTO password_resets (token_hash, user_id, created, expires) VALUES (?, ?, ?, ?)')
      .bind(await sha256Hex(token), u.id, c.now, c.now + 3600000).run();
    await sendMail(c, {
      to: email,
      subject: 'reset your OurSpace password',
      text: `hi ${u.name},\n\nsomebody (hopefully you) asked to reset your OurSpace password. this link works for one hour, once:\n\n${c.url.origin}/reset#token=${token}\n\nif it wasn't you, ignore this email and nothing changes.\n\n— ourspace. a place for friends.`,
    });
  }
  return json({ ok: true });
}

// POST /api/password/reset { token, password } — sets the new password, logs out every device, logs this one in
export async function resetPassword(c) {
  const b = await readBody(c.req);
  await limit(c, 'reset:ip:' + await ipKey(c), [[10, 3600000]]);
  const hash = await sha256Hex(String(b.token ?? ''));
  const r = await c.env.DB.prepare(`SELECT p.user_id, p.expires, u.name, u.email, u.avatar, u.birthdate, u.is_admin, u.banned
    FROM password_resets p JOIN users u ON u.id = p.user_id WHERE p.token_hash = ?`).bind(hash).first();
  if (!r || r.expires < c.now || r.banned) fail(400, 'that reset link has expired or was already used. ask for a new one.');
  const err = passwordProblem(b.password, r.name, r.email);
  if (err) fail(400, err);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').bind(await hashPassword(b.password), r.user_id),
    c.env.DB.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(r.user_id),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(r.user_id),
  ]);
  await signOut(c.env, r.user_id);
  return json({ user: userOut({ ...r, id: r.user_id }) }, 200, { 'Set-Cookie': await startSession(c, r.user_id) });
}

// POST /api/me/password { current, next } — change it, or set one on an account that only used Google & co.
// Also logs out every other device.
export async function changePassword(c) {
  const b = await readBody(c.req);
  await limit(c, 'pwchange:' + c.user.id, [[5, 15 * 60000]]);
  if (c.user.pass_hash && !await checkPassword(String(b.current ?? ''), c.user.pass_hash)) fail(401, 'your current password is wrong.');
  const err = passwordProblem(b.next, c.user.name, c.user.email);
  if (err) fail(400, err);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').bind(await hashPassword(b.next), c.user.id),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(c.user.id, c.user.tokenHash),
  ]);
  await signOut(c.env, c.user.id, { except: c.user.tokenHash });
  return json({ ok: true });
}

// SQL (a WITH clause, user ?1): `moved` is every board comment by someone else that answers a comment of ?1's, with the
// post it moves up to when ?1's comments go: the nearest one above it that isn't a comment of theirs (in the end the
// thread). `up` climbs one of their comments at a time.
const MOVED = `WITH RECURSIVE up(id, to_id) AS (
    SELECT x.id, x.reply_to FROM posts x JOIN posts px ON px.id = x.reply_to
      WHERE x.kind = 'comment' AND x.author_id != ?1 AND px.kind = 'comment' AND px.author_id = ?1
    UNION ALL
    SELECT u.id, p.reply_to FROM up u JOIN posts p ON p.id = u.to_id WHERE p.kind = 'comment' AND p.author_id = ?1),
  moved(id, to_id) AS (SELECT u.id, u.to_id FROM up u JOIN posts t ON t.id = u.to_id WHERE t.kind != 'comment' OR t.author_id != ?1)`;

// DELETE /api/me { password } (or { confirm: <screen name> } for accounts without a password)
// The account and everything it wrote, liked, reposted and bookmarked; the counts on other people's posts come down to
// match, and other people's tombstones that only its replies or quotes held go too. Other people's replies to and
// quotes of its posts stay: a reply keeps pointing at the post it answered (so it says "replying to a deleted account"
// and stays in its conversation), a quote shows its original as unavailable. A board comment answering one of its
// comments moves up instead (MOVED), so a thread's tree never has a comment answering nothing. Reports about it keep
// their snapshot. Its photos (and those on the comments that go with its threads) leave R2.
export async function deleteAccount(c) {
  const b = await readBody(c.req);
  await limit(c, 'delete:' + c.user.id, [[5, 15 * 60000]]);
  if (c.user.pass_hash) {
    if (!await checkPassword(String(b.password ?? ''), c.user.pass_hash)) fail(401, 'that password is wrong.');
  } else if (String(b.confirm ?? '').trim().toLowerCase() !== c.user.name.toLowerCase()) {
    fail(400, 'type your screen name to confirm.');
  }
  const id = c.user.id;
  const DB = c.env.DB;
  // the posts its replies and board comments answer and its quotes quote, and the threads its comments are in:
  // tombstones among them may be held by nothing else; and the threads it commented in, whose hot counts the comments
  // from others
  const [{ results: above }, { results: threads }] = await DB.batch([
    DB.prepare(`SELECT reply_to AS id FROM posts WHERE author_id = ?1 AND kind IN ('reply', 'comment') AND reply_to IS NOT NULL
      UNION SELECT quote_of FROM posts WHERE author_id = ?1 AND kind = 'quote' AND quote_of IS NOT NULL
      UNION SELECT root_id FROM posts WHERE author_id = ?1 AND kind = 'comment'`).bind(id),
    DB.prepare('SELECT DISTINCT root_id AS id FROM posts WHERE author_id = ? AND kind = \'comment\'').bind(id),
  ]);
  // the rooms it may have open, read while its memberships are still there: their sockets close once it's gone
  const rooms = await roomsOf(c.env, id);
  const res = await DB.batch([
    // every photo it uploaded, and the photos on other people's comments in its threads (which go with them); those
    // held as evidence (hidden by a moderator, or their post was) stay as hidden photos until a moderator removes them
    ...releaseMedia(DB, `media.owner_id = ?1
      OR media.post_id IN (SELECT id FROM posts WHERE kind = 'comment' AND root_id IN (SELECT id FROM posts WHERE author_id = ?1 AND kind = 'thread'))`, id),
    DB.prepare('UPDATE posts SET like_count = like_count - 1 WHERE id IN (SELECT post_id FROM likes WHERE user_id = ?)').bind(id),
    DB.prepare(`UPDATE posts SET up_count = up_count - (SELECT COUNT(*) FROM votes v WHERE v.post_id = posts.id AND v.user_id = ?1 AND v.value = 1),
        down_count = down_count - (SELECT COUNT(*) FROM votes v WHERE v.post_id = posts.id AND v.user_id = ?1 AND v.value = -1)
      WHERE id IN (SELECT post_id FROM votes WHERE user_id = ?1)`).bind(id),
    DB.prepare(`UPDATE posts SET ${RESORT} WHERE id IN (SELECT post_id FROM votes WHERE user_id = ?)`).bind(id),
    DB.prepare(`UPDATE posts SET
        reply_count = reply_count - (SELECT COUNT(*) FROM posts x WHERE x.reply_to = posts.id AND x.author_id = ?1 AND x.kind IN ('reply', 'comment') AND x.deleted = 0),
        quote_count = quote_count - (SELECT COUNT(*) FROM posts x WHERE x.quote_of = posts.id AND x.author_id = ?1 AND x.kind = 'quote' AND x.deleted = 0),
        repost_count = repost_count - (SELECT COUNT(*) FROM posts x WHERE x.quote_of = posts.id AND x.author_id = ?1 AND x.kind = 'repost'),
        comment_count = comment_count - (SELECT COUNT(*) FROM posts x WHERE x.root_id = posts.id AND x.author_id = ?1 AND x.kind = 'comment' AND x.deleted = 0)
      WHERE id IN (SELECT reply_to FROM posts WHERE author_id = ?1 UNION SELECT quote_of FROM posts WHERE author_id = ?1
        UNION SELECT root_id FROM posts WHERE author_id = ?1 AND kind = 'comment')`).bind(id),
    DB.prepare('DELETE FROM posts WHERE kind = \'repost\' AND quote_of IN (SELECT id FROM posts WHERE author_id = ?)').bind(id),
    // other people's board comments under its comments move up to the nearest post above that isn't its (the comment
    // or thread its comment answered), counted there as replies, so no comment is left answering nothing
    DB.prepare(`${MOVED} UPDATE posts SET reply_count = reply_count + (SELECT COUNT(*) FROM moved m JOIN posts x ON x.id = m.id WHERE m.to_id = posts.id AND x.deleted = 0)
      WHERE id IN (SELECT to_id FROM moved)`).bind(id),
    DB.prepare(`${MOVED} UPDATE posts SET reply_to = (SELECT to_id FROM moved WHERE moved.id = posts.id) WHERE id IN (SELECT id FROM moved)`).bind(id),
    // its threads go with all their comments (without the thread they would have nowhere to show)
    DB.prepare('DELETE FROM posts WHERE kind = \'comment\' AND root_id IN (SELECT id FROM posts WHERE author_id = ? AND kind = \'thread\')').bind(id),
    DB.prepare('DELETE FROM posts WHERE author_id = ?1 OR target_id = ?1').bind(id),
    DB.prepare(CLEAR_TOMBSTONES).bind(JSON.stringify(above.map(r => r.id))),
    DB.prepare(`UPDATE posts SET ${RESORT} WHERE id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(threads.map(r => r.id))),
    DB.prepare('DELETE FROM likes WHERE user_id = ?').bind(id),
    DB.prepare('DELETE FROM votes WHERE user_id = ?').bind(id),
    DB.prepare('DELETE FROM bookmarks WHERE user_id = ?').bind(id),
    DB.prepare('DELETE FROM mentions WHERE user_id = ?').bind(id),
    DB.prepare('DELETE FROM notifications WHERE user_id = ?1 OR actor_id = ?1').bind(id),
    // chat: its DMs go whole; groups it owned pass to their longest-standing member; its messages, memberships,
    // interaction scores and mutes go (reports keep their snapshots)
    DB.prepare('DELETE FROM conversations WHERE kind = \'dm\' AND id IN (SELECT conversation_id FROM conversation_members WHERE user_id = ?)').bind(id),
    DB.prepare(HANDOVER('1')).bind(id),
    DB.prepare('DELETE FROM chat_messages WHERE author_id = ?').bind(id),
    DB.prepare('DELETE FROM conversation_members WHERE user_id = ?').bind(id),
    DB.prepare('DELETE FROM affinity WHERE from_id = ?1 OR to_id = ?1').bind(id),
    DB.prepare('DELETE FROM chat_mutes WHERE user_id = ?').bind(id),
    DB.prepare('DELETE FROM follows WHERE follower_id = ?1 OR followee_id = ?1').bind(id),
    DB.prepare('DELETE FROM markers WHERE user_id = ?').bind(id),
    DB.prepare('DELETE FROM blocks WHERE blocker_id = ?1 OR blocked_id = ?1').bind(id),
    DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
    DB.prepare('DELETE FROM identities WHERE user_id = ?').bind(id),
    DB.prepare('DELETE FROM spotify WHERE user_id = ?').bind(id),
    DB.prepare('DELETE FROM password_resets WHERE user_id = ?').bind(id),
    DB.prepare('DELETE FROM profiles WHERE user_id = ?').bind(id),
    DB.prepare('UPDATE reports SET reporter_id = NULL WHERE reporter_id = ?').bind(id),
    DB.prepare('UPDATE reports SET target_user_id = NULL WHERE target_user_id = ?').bind(id),
    DB.prepare('UPDATE reports SET resolved_by = NULL WHERE resolved_by = ?').bind(id),
    DB.prepare('UPDATE mod_log SET actor_id = NULL WHERE actor_id = ?').bind(id),
    DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
  ]);
  await dropObjects(c.env, keysIn(res[0]));
  await signOut(c.env, id, { rooms });
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(c.url, '', 0) });
}
