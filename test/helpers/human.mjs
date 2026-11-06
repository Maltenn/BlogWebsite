// Filling in the sign-up form the way the page does, from Node: fetch a form (GET /api/form/:purpose), do its proof of
// work, leave the honeypot empty, wait the form's minimum time, add the Turnstile token. Used by the API tests, the
// bot simulator (tools/bot-sim.mjs) and the demo's seeding.
import { createHash } from 'node:crypto';

// the dummy token Cloudflare's test site keys hand out (the stand-in siteverify accepts it with a 1x… secret)
export const TURNSTILE_TEST_TOKEN = 'XXXX.DUMMY.TOKEN.XXXX';
// what a person's browser sends: a browser User-Agent and a language
export const BROWSER = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9' };

export function leadingZeroBits(buf) {
  let n = 0;
  for (const b of buf) {
    if (b === 0) { n += 8; continue; }
    return n + Math.clz32(b) - 24;
  }
  return n;
}

// the counter that makes SHA-256(token + ":" + counter) start with `bits` zero bits
export function solvePow(token, bits) {
  for (let i = 0; ; i++) {
    if (leadingZeroBits(createHash('sha256').update(`${token}:${i}`).digest()) >= bits) return String(i);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// A filled-in form body: `fields` plus form, pow, the empty honeypot and the Turnstile token. `form` is the answer of
// GET /api/form/:purpose, fetched `fetchedAt` (ms). Options: wait (default true: until the form's minimum time has
// passed, plus `extraMs`), honeypot (a value to put in it), pow (false: leave it out), turnstile (null: leave it out).
export async function fillForm(form, fields, { fetchedAt = Date.now(), wait = true, extraMs = 0, honeypot = '', pow = true, turnstile = TURNSTILE_TEST_TOKEN } = {}) {
  const body = { ...fields, form: form.token, [form.honeypot]: honeypot };
  if (pow) body.pow = solvePow(form.token, form.pow.bits);
  if (turnstile != null) body.turnstile = turnstile;
  if (wait) {
    const left = fetchedAt + form.minMs + 30 + extraMs - Date.now();
    if (left > 0) await sleep(left);
  }
  return body;
}

// a random address in TEST-NET-3 / 2001:db8::, so each simulated person comes from their own network
export const randomIp = (v6 = false) => v6
  ? `2001:db8:${(Math.random() * 65535 | 0).toString(16)}:${(Math.random() * 65535 | 0).toString(16)}::${(Math.random() * 65535 | 0).toString(16)}`
  : `10.${Math.random() * 255 | 0}.${Math.random() * 255 | 0}.${1 + (Math.random() * 253 | 0)}`;

// the newest confirmation link the local server printed for `email` (sendMail prints instead of sending locally)
export function verifyTokenIn(log, email) {
  const at = log.lastIndexOf(`[mail] to=${email} `);
  if (at < 0) return null;
  const m = /\/verify#token=([\w-]+)/.exec(log.slice(at));
  return m ? m[1] : null;
}
