// The sign-up form's token and its proof of work (docs/decisions/003, layer 1, with the owner's choice: proof of work
// on every sign-up). GET /api/form/:purpose hands the page one stateless, HMAC-signed token:
//
//   token = base64url(JSON { p: purpose, n: nonce, t: issued (ms), b: bits }) + "." + base64url(HMAC-SHA256(key, payload))
//
// It carries:
//   · the honeypot's name, different on every load: "f" + the first 6 hex digits of HMAC(key, "hp|" + nonce). The page
//     draws one text input with that name, hidden from people and from assistive tech; anything typed in it refuses the
//     sign-up.
//   · the time the form was opened: under SIGNUP_MIN_MS (default 2 s) it's refused, under SIGNUP_SOFT_MS (6 s) it adds a
//     risk point. A form stays good for 2 hours, so slow typists never lose theirs.
//   · the proof-of-work challenge: the page finds a counter (decimal digits) such that SHA-256(token + ":" + counter)
//     starts with `b` zero bits (POW_BITS, default 18: about 260,000 hashes on average, 1–2 s in a normal browser).
//     Checking it is one hash. Cheap for a person once, costly for whoever makes thousands of accounts.
// The nonce is spent (spent_nonces) once the proof of work checks out, whatever happens next, so a token and its proof
// of work work once.
import { fail, json } from '../shared/http.js';

export const PURPOSES = ['signup', 'finish'];        // email sign-up, and finishing a sign-up through Google & co.
export const FORM_TTL = 2 * 3600000;
const enc = new TextEncoder();

const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), ch => ch.charCodeAt(0));
const hex = bytes => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

const keys = new Map();
async function hmacKey(secret) {
  if (!keys.has(secret)) keys.set(secret, crypto.subtle.importKey('raw', enc.encode('ourspace-form|' + secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']));
  return keys.get(secret);
}
// the signing secret: TOKEN_KEY (a required secret already), else IP_SALT, else a fixed one on a local dev server
export const formSecret = env => String(env.TOKEN_KEY || env.IP_SALT || 'ourspace-local-dev');

async function sign(secret, s) {
  return new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(s)));
}

export async function honeypotName(secret, nonce) {
  return 'f' + hex(await sign(secret, 'hp|' + nonce)).slice(0, 6);
}

export async function issueForm(secret, { purpose, bits, now }) {
  const nonce = hex(crypto.getRandomValues(new Uint8Array(12)));
  const payload = b64url(enc.encode(JSON.stringify({ p: purpose, n: nonce, t: now, b: bits })));
  const token = payload + '.' + b64url(await sign(secret, payload));
  return { token, nonce, honeypot: await honeypotName(secret, nonce) };
}

// the number of leading zero bits of a byte array
export function leadingZeroBits(bytes) {
  let n = 0;
  for (const b of bytes) {
    if (b === 0) { n += 8; continue; }
    return n + Math.clz32(b) - 24;
  }
  return n;
}

export async function powBits(token, counter) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`${token}:${counter}`)));
  return leadingZeroBits(digest);
}

// Reads a submitted form: { ok: false, code } when it isn't a form with its proof of work done (codes: form: missing,
// forged or for another purpose; form_expired; pow), else { ok: true, nonce, formMs, bits, honeypotFilled, tooFast }.
// The cheap-to-fake signals (the honeypot, the time) are read only once the proof of work checks out, so a request
// that didn't pay for it is refused before anything else and costs nobody anything. `body` is the whole request body
// (for the honeypot). The nonce isn't spent here: screenSignup spends it on every outcome after this.
export async function checkForm(secret, { token, pow, body, purpose, now, minMs }) {
  if (typeof token !== 'string' || token.length > 400 || !token.includes('.')) return { ok: false, code: 'form' };
  const [payload, sig] = token.split('.');
  let claims;
  try {
    const good = await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64url(sig), enc.encode(payload));
    if (!good) return { ok: false, code: 'form' };
    claims = JSON.parse(new TextDecoder().decode(unb64url(payload)));
  } catch { return { ok: false, code: 'form' }; }
  if (!claims || claims.p !== purpose || typeof claims.n !== 'string' || !Number.isFinite(claims.t) || !Number.isFinite(claims.b)) return { ok: false, code: 'form' };
  const formMs = now - claims.t;
  if (formMs > FORM_TTL || formMs < -60000) return { ok: false, code: 'form_expired' };
  const counter = String(pow ?? '');
  if (!/^\d{1,16}$/.test(counter) || await powBits(token, counter) < claims.b) return { ok: false, code: 'pow' };
  const field = await honeypotName(secret, claims.n);
  const honeypotFilled = body != null && body[field] != null && String(body[field]) !== '';
  return { ok: true, nonce: claims.n, formMs, bits: claims.b, honeypotFilled, tooFast: formMs < minMs };
}

// Marks a form's nonce used. false when it already was (a replayed form).
export async function spendNonce(env, nonce, now) {
  try {
    const r = await env.DB.prepare('INSERT INTO spent_nonces (nonce, expires) VALUES (?, ?)').bind(nonce, now + FORM_TTL).run();
    return !!r.meta.changes;
  } catch (e) {
    if (/UNIQUE|PRIMARY KEY|constraint/i.test(String(e && e.message))) return false;
    throw e;
  }
}

export async function wasSpent(env, nonce) {
  return !!await env.DB.prepare('SELECT 1 AS x FROM spent_nonces WHERE nonce = ?').bind(nonce).first();
}

export const minFormMs = env => Number(env.SIGNUP_MIN_MS || 2000);
export const softFormMs = env => Number(env.SIGNUP_SOFT_MS || 6000);
export const powDifficulty = env => Math.max(1, Math.min(30, Number(env.POW_BITS || 18)));

// the Turnstile part of a form (null when Turnstile isn't set up here)
export const turnstileFor = (env, action) => (env.TURNSTILE_SITE_KEY ? { siteKey: env.TURNSTILE_SITE_KEY, action } : null);

// GET /api/form/:purpose — signup | finish: a fresh form token with its honeypot name, the proof of work to do and the
// Turnstile widget's settings. login | reset: the Turnstile settings only (no token, no proof of work).
export async function formFor(c) {
  const purpose = c.params.purpose;
  if (purpose === 'login' || purpose === 'reset') return json({ token: null, honeypot: null, pow: null, minMs: 0, turnstile: turnstileFor(c.env, purpose) });
  if (!PURPOSES.includes(purpose)) fail(404, 'no such form.');
  const bits = powDifficulty(c.env);
  const f = await issueForm(formSecret(c.env), { purpose, bits, now: c.now });
  return json({
    token: f.token, honeypot: f.honeypot, minMs: minFormMs(c.env), expiresIn: FORM_TTL,
    pow: { algorithm: 'SHA-256', bits, input: `${f.token}:<counter>` },
    turnstile: turnstileFor(c.env, 'signup'),
  });
}
