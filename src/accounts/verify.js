// Email verification: a new account must confirm its address before it can post, comment, message or follow (the
// gate in src/shared/gate.js). The link (/verify#token=…, in the fragment so it never reaches a server log) opens a
// page with a "Confirm" button that POSTs the token: a link that verified on GET would be clicked by mail scanners,
// which would verify bots for us. Single use, 24 hours; only the token's SHA-256 is stored.
import { fail, json, readBody, sha256Hex, ipKey } from '../shared/http.js';
import { limit } from '../shared/db.js';
import { randomToken } from '../shared/seal.js';
import { sendMail, mailReady } from '../shared/mail.js';

const TOKEN_MS = 24 * 3600000;

// Sends `user` ({ id, name, email }) a fresh link. Answers 'sent' or 'failed' (the account stays; they can resend).
export async function sendVerification(c, user) {
  const token = randomToken();
  await c.env.DB.prepare('INSERT INTO email_tokens (token_hash, user_id, email, created, expires) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256Hex(token), user.id, user.email, c.now, c.now + TOKEN_MS).run();
  try {
    await sendMail(c, {
      to: user.email,
      subject: 'confirm your OurSpace email',
      text: `hi ${user.name},\n\nwelcome to ourspace! confirm this is your email address to start posting and messaging. this link works for 24 hours, once:\n\n${c.url.origin}/verify#token=${token}\n\nif you didn't sign up, ignore this email and nothing happens.\n\n— ourspace. a place for friends.`,
    });
    return 'sent';
  } catch (e) {
    console.error('verification email failed:', e && e.message);
    return 'failed';
  }
}

// POST /api/verify { token } — confirms the address the link was sent to (if it's still the account's address).
// Works logged out or in, on any device. → { ok, verified: true, name }
export async function verifyEmail(c) {
  const b = await readBody(c.req);
  // (only failures count: 20 bad links an hour per network)
  const key = 'verifyfail:ip:' + await ipKey(c);
  const tries = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM attempts WHERE k = ? AND created > ?').bind(key, c.now - 3600000).first();
  if (tries.n >= 20) fail(429, 'that\'s a lot of tries. wait an hour and use the newest link.');
  const hash = await sha256Hex(String(b.token ?? ''));
  const r = await c.env.DB.prepare(`SELECT t.user_id, t.email, t.expires, u.email AS current, u.name, u.banned, u.email_verified_at
    FROM email_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?`).bind(hash).first();
  if (!r || r.expires < c.now || r.banned || r.email !== r.current) {
    await c.env.DB.prepare('INSERT INTO attempts (k, created) VALUES (?, ?)').bind(key, c.now).run();
    fail(400, 'that link has expired or was already used. log in and send yourself a new one.', { code: 'verify_link' });
  }
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?').bind(c.now, r.user_id),
    c.env.DB.prepare('DELETE FROM email_tokens WHERE user_id = ?').bind(r.user_id),
  ]);
  return json({ ok: true, verified: true, name: r.name });
}

// POST /api/me/verify/resend — another link (the older ones still work until they expire). 3 an hour, 10 a day.
export async function resendVerification(c) {
  if (c.user.email_verified_at) fail(409, 'your email is already confirmed.', { code: 'verified' });
  if (!c.user.email) fail(400, 'there\'s no email on this account.');
  if (!mailReady(c.env, c.url)) fail(503, 'email isn\'t set up on this server yet. ask a moderator for help.');
  await limit(c, 'verifymail:' + c.user.id, [[3, 3600000], [10, 86400000]], 'we sent a few already. check your spam folder, or try again in an hour.');
  const sent = await sendVerification(c, c.user);
  if (sent !== 'sent') fail(502, 'we couldn\'t send the email just now. try again in a few minutes.');
  return json({ ok: true, sent: true });
}
